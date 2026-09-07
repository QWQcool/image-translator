import sharp from 'sharp';

export type NormBox = { x: number; y: number; w: number; h: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 纯白/纯色气泡降级去字：在掩膜内用边界颜色填充，输出透明底 PNG 涂改层。
 * 不是完整 Telea，但对 PictureTest 一类白底气泡够用。
 */
export async function teleaFallback(original: Buffer, boxes: NormBox[]): Promise<Buffer> {
  const src = sharp(original).ensureAlpha().rotate();
  const { data, info } = await src.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const paint = Buffer.alloc(width * height * 4, 0);

  for (const box of boxes) {
    const x0 = clamp(Math.floor(box.x * width), 0, width - 1);
    const y0 = clamp(Math.floor(box.y * height), 0, height - 1);
    const x1 = clamp(Math.ceil((box.x + box.w) * width), x0 + 1, width);
    const y1 = clamp(Math.ceil((box.y + box.h) * height), y0 + 1, height);

    const samples: number[] = [0, 0, 0];
    let count = 0;
    const sampleEdge = (x: number, y: number) => {
      const i = (y * width + x) * channels;
      samples[0] += data[i];
      samples[1] += data[i + 1];
      samples[2] += data[i + 2];
      count += 1;
    };
    for (let x = x0; x < x1; x += 1) {
      sampleEdge(x, y0);
      sampleEdge(x, y1 - 1);
    }
    for (let y = y0; y < y1; y += 1) {
      sampleEdge(x0, y);
      sampleEdge(x1 - 1, y);
    }
    const r = count ? Math.round(samples[0] / count) : 255;
    const g = count ? Math.round(samples[1] / count) : 255;
    const b = count ? Math.round(samples[2] / count) : 255;

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 4;
        paint[i] = r;
        paint[i + 1] = g;
        paint[i + 2] = b;
        paint[i + 3] = 255;
      }
    }
  }

  return sharp(paint, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export async function maskPng(width: number, height: number, boxes: NormBox[]): Promise<Buffer> {
  const paint = Buffer.alloc(width * height, 0);
  for (const box of boxes) {
    const x0 = clamp(Math.floor(box.x * width), 0, width - 1);
    const y0 = clamp(Math.floor(box.y * height), 0, height - 1);
    const x1 = clamp(Math.ceil((box.x + box.w) * width), x0 + 1, width);
    const y1 = clamp(Math.ceil((box.y + box.h) * height), y0 + 1, height);
    for (let y = y0; y < y1; y += 1) {
      paint.fill(255, y * width + x0, y * width + x1);
    }
  }
  return sharp(paint, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

/**
 * 解析客户端上传的 dataURL 形态 PNG 蒙版（嵌字编辑器的涂改层/选区光栅化结果）。
 * 防御式清洗：非 data:image/png;base64 形态或解码失败一律返回 null，调用方按「无蒙版」处理。
 */
export function parseMaskDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1], 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * 把蒙版 PNG 对齐到指定尺寸并提取成单通道 0/255 灰度 raw。
 * 判据自适应（两种上游形态都能正确解读）：
 * - 带 alpha 且存在透明像素（客户端涂改层/选区光栅化：任意色笔迹画在透明底上）
 *   → alpha > 16 视为去字区域（低阈值容忍软边笔刷的抗锯齿半透明边）；
 * - 全不透明（maskPng 形态的黑白灰度图，LaMa 惯例）→ 灰度 > 128 视为去字区域。
 * 注意不能对全不透明图取 alpha——那会把整张图判成蒙版。
 */
async function maskGrayRaw(
  mask: Buffer,
  width: number,
  height: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  const base = () => sharp(mask).resize(width, height, { fit: 'fill' });
  // 用 stats 的通道数判形态（stats 反映输入原始通道，extractChannel 组合下的 stats 不可靠）：
  // 4 通道且存在透明像素（min<250）= alpha 语义；其余（不透明 RGB/灰度）= 白色语义
  const stats = await base().stats();
  const alphaMin = stats.channels.length >= 4 ? (stats.channels[3]?.min ?? 255) : 255;
  const data =
    alphaMin < 250
      ? await base().ensureAlpha().extractChannel(3).threshold(16).raw().toBuffer()
      : await base().greyscale().threshold(128).raw().toBuffer();
  return { data, width, height };
}

/**
 * 把任意 PNG 蒙版对齐到原图尺寸并二值化：判据见 maskGrayRaw。
 * 返回二值蒙版 PNG（白=去字、黑=保留）+ 是否存在去字区域。
 */
export async function normalizeMaskPng(
  mask: Buffer,
  width: number,
  height: number,
): Promise<{ png: Buffer; hasArea: boolean }> {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const { data } = await maskGrayRaw(mask, w, h);
  let hasArea = false;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] > 128) {
      hasArea = true;
      break;
    }
  }
  return { png: await sharp(data, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer(), hasArea };
}

/**
 * 蒙版版降级去字（洋葱剥皮扩散填充）：从蒙版边界向内逐层用「已知邻域均色」填充。
 * boxes 版只能填矩形；蒙版版对任意形状（笔迹/套索）都适用，质量不及 LaMa 但确定性、零依赖。
 */
export async function teleaFallbackMask(original: Buffer, maskBinaryPng: Buffer): Promise<Buffer> {
  const src = sharp(original).ensureAlpha().rotate();
  const { data, info } = await src.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  // 蒙版重新对齐一次（防御：调用方传来的蒙版理论上已对齐，这里保证口径一致）
  const m = (await maskGrayRaw(maskBinaryPng, width, height)).data;
  const n = width * height;
  const known = new Uint8Array(n); // 1 = 像素可用作填充采样源
  const inQueue = new Uint8Array(n);
  const queue: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (m[i] > 128) continue;
    known[i] = 1;
  }
  const neighbors = (i: number): number[] => {
    const x = i % width;
    const y = (i / width) | 0;
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        out.push(ny * width + nx);
      }
    }
    return out;
  };
  // BFS 初始化：蒙版内与已知像素相邻的像素先入队（洋葱最外层）
  for (let i = 0; i < n; i += 1) {
    if (known[i]) continue;
    if (neighbors(i).some((j) => known[j])) {
      inQueue[i] = 1;
      queue.push(i);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head];
    head += 1;
    const nb = neighbors(idx);
    let r = 0;
    let g = 0;
    let b = 0;
    let c = 0;
    for (const j of nb) {
      if (!known[j]) continue;
      r += data[j * channels];
      g += data[j * channels + 1];
      b += data[j * channels + 2];
      c += 1;
    }
    if (c > 0) {
      const base = idx * channels;
      data[base] = Math.round(r / c);
      data[base + 1] = Math.round(g / c);
      data[base + 2] = Math.round(b / c);
      if (channels > 3) data[base + 3] = 255;
      known[idx] = 1;
    }
    // 该像素变成已知后，把它身边还没入队的蒙版像素拉进下一层
    for (const j of nb) {
      if (!known[j] && !inQueue[j]) {
        inQueue[j] = 1;
        queue.push(j);
      }
    }
  }
  // 输出「涂改层」形态 PNG：只在蒙版区域有不透明像素，其余全透明（与 boxes 版 teleaFallback 同构）
  const paint = Buffer.alloc(n * 4, 0);
  for (let i = 0; i < n; i += 1) {
    if (m[i] <= 128) continue;
    const s = i * channels;
    const d = i * 4;
    paint[d] = known[i] ? data[s] : 255; // 没被填到的孤立像素兜底白色
    paint[d + 1] = known[i] ? data[s + 1] : 255;
    paint[d + 2] = known[i] ? data[s + 2] : 255;
    paint[d + 3] = 255;
  }
  return sharp(paint, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
