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
