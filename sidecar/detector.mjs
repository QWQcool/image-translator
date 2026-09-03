#!/usr/bin/env node
/**
 * 本机识别进程（真实实现）：提供文本块检测端点 POST /detect。
 *
 * 两种检测引擎，启动时自动选择：
 *  1. ONNX 模型档：sidecar/models/comic-text-detector.onnx 存在且已安装
 *     onnxruntime-node（在项目根 npm i onnxruntime-node）时启用，精度高。
 *  2. 传统算法档（默认）：无需模型与额外依赖——局部自适应阈值 + 连通域 +
 *     近邻合并，对黑白漫画「气泡内深色文字」效果良好（参考 LabelPlus /
 *     YuzuMarker 的传统检测思路）。
 *
 * 协议（完整定义见 sidecar/README.md）：
 *   GET  /health → { ok, models, engine, detector }
 *   POST /detect { image, mimeType } → { blocks: [{x,y,w,h,text}] }
 *        坐标为 0~1 归一化值（x/y 左上角）；text 恒为空字符串，
 *        由主站裁剪空框后交给视觉模型补提取。
 *   POST /ocr、/inpaint → 501（本进程只做检测；OCR / LaMa 请接其它实现）
 *
 * 启动：node sidecar/detector.mjs
 * 主站 .env.local：SIDECAR_URL=http://127.0.0.1:8765
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SIDECAR_PORT || 8765);
const MODEL_PATH = path.join(__dirname, 'models', 'comic-text-detector.onnx');

// 可调参数（环境变量可覆盖）
const LONG_SIDE = Number(process.env.DETECT_LONG_SIDE || 1024);  // 检测前缩放长边
const BIN_THRESH = Number(process.env.DETECT_BIN_THRESH || 0.4); // 模型概率二值化阈值
const DARK_DELTA = Number(process.env.DETECT_DARK_DELTA || 18);  // 传统档暗像素判定偏移
const UNCLIP_RATIO = Number(process.env.DETECT_UNCLIP || 1.6);   // DBNet unclip 系数
const MAX_BLOCKS = 150;                                          // 单页最多返回的块数

let sharp = null;
let ort = null;
let session = null;

try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('[sidecar] 未找到 sharp（请在项目根 npm install），/detect 不可用');
}
if (sharp) {
  try {
    ort = await import('onnxruntime-node');
  } catch {
    // 可选依赖：没装就走传统算法档
  }
}
if (ort && fs.existsSync(MODEL_PATH)) {
  try {
    session = await ort.InferenceSession.create(MODEL_PATH, { executionMode: 'sequential' });
    console.log(`[sidecar] 已加载本地检测模型 ${path.basename(MODEL_PATH)}（ONNX 档）`);
  } catch (err) {
    console.error('[sidecar] 模型加载失败，退回传统算法档：', err?.message ?? err);
  }
}
if (!session && sharp) {
  console.log('[sidecar] 检测引擎：传统算法档（无模型）。要启用 ONNX 模型档：');
  console.log('  1) 项目根执行 npm i onnxruntime-node');
  console.log('  2) 下载 comic-text-detector.onnx 放到 sidecar/models/ 目录（见 AI 设置页文档）');
}

/* ---------------- 图像工具 ---------------- */

/** 长边限到 size，返回 { W, H }（缩放后的尺寸） */
function scaledSize(meta, size) {
  const scale = Math.min(1, size / Math.max(meta.width ?? size, meta.height ?? size));
  return {
    W: Math.max(32, Math.round((meta.width ?? size) * scale)),
    H: Math.max(32, Math.round((meta.height ?? size) * scale)),
  };
}

/** 灰度原始像素（长边限到 size） */
async function toGray(buffer, size) {
  const meta = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
  const { W, H } = scaledSize(meta, size);
  const gray = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(W, H, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();
  return { gray, W, H };
}

/** 积分图 + 盒滤波：每个像素的局部均值（半径 r），O(W*H) */
function localMean(gray, W, H, r) {
  const iw = W + 1;
  const integral = new Float64Array(iw * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += gray[y * W + x];
      integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] + rowSum;
    }
  }
  const mean = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W - 1, x + r);
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum =
        integral[(y1 + 1) * iw + x1 + 1] -
        integral[y0 * iw + x1 + 1] -
        integral[(y1 + 1) * iw + x0] +
        integral[y0 * iw + x0];
      mean[y * W + x] = sum / area;
    }
  }
  return mean;
}

/** 8 连通域。mask 非 0 为前景。返回 [{x0,y0,x1,y1,npix}] */
function components(mask, W, H) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out = [];
  for (let seed = 0; seed < W * H; seed++) {
    if (!mask[seed] || seen[seed]) continue;
    let top = 0;
    stack[top++] = seed;
    seen[seed] = 1;
    let x0 = seed % W;
    let x1 = x0;
    let y0 = (seed / W) | 0;
    let y1 = y0;
    let npix = 0;
    while (top > 0) {
      const cur = stack[--top];
      const cx = cur % W;
      const cy = (cur / W) | 0;
      npix++;
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy;
      if (cy > y1) y1 = cy;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= W) continue;
          const ni = ny * W + nx;
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack[top++] = ni;
          }
        }
      }
    }
    out.push({ x0, y0, x1, y1, npix });
  }
  return out;
}

/** 把间距 < gap 的矩形合并成块（并查集） */
function mergeRects(rects, gap) {
  const n = rects.length;
  if (n === 0) return [];
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const hit = (a, b) =>
    a.x0 - gap <= b.x1 + gap &&
    b.x0 - gap <= a.x1 + gap &&
    a.y0 - gap <= b.y1 + gap &&
    b.y0 - gap <= a.y1 + gap;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (hit(rects[i], rects[j])) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[rj] = ri;
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (!g) {
      groups.set(root, { ...rects[i] });
    } else {
      g.x0 = Math.min(g.x0, rects[i].x0);
      g.y0 = Math.min(g.y0, rects[i].y0);
      g.x1 = Math.max(g.x1, rects[i].x1);
      g.y1 = Math.max(g.y1, rects[i].y1);
      g.npix += rects[i].npix;
    }
  }
  return [...groups.values()];
}

/** 像素矩形 → 归一化块（外扩 padding，过滤噪点/巨块） */
function toBlocks(rects, W, H, confidence) {
  return rects
    .map((r) => {
      const w = r.x1 - r.x0 + 1;
      const h = r.y1 - r.y0 + 1;
      const off = Math.min(w, h) * 0.1;
      return {
        x: Math.max(0, (r.x0 - off) / W),
        y: Math.max(0, (r.y0 - off) / H),
        w: Math.min(1, (w + off * 2) / W),
        h: Math.min(1, (h + off * 2) / H),
        text: '',
        confidence,
      };
    })
    .filter((b) => b.w > 0.008 && b.h > 0.005 && b.w * b.h < 0.9)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, MAX_BLOCKS)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/* ---------------- 引擎 1：传统算法档 ---------------- */

async function detectTraditional(buffer) {
  const { gray, W, H } = await toGray(buffer, LONG_SIDE);
  const r = Math.max(8, Math.round(Math.min(W, H) / 32));
  const mean = localMean(gray, W, H, r);
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = gray[i] < mean[i] - DARK_DELTA ? 1 : 0;

  let comps = components(bin, W, H);
  const minSide = Math.max(5, Math.round(Math.min(W, H) * 0.006));
  comps = comps.filter((c) => {
    const w = c.x1 - c.x0 + 1;
    const h = c.y1 - c.y0 + 1;
    if (w < minSide || h < minSide) return false; // 噪点
    if (w > W * 0.9 && h > H * 0.9) return false; // 整页暗块（出血/阴影）
    const fill = c.npix / (w * h);
    return fill > 0.12 && fill < 0.97; // 实心块/细线排除
  });
  comps.sort((a, b) => b.npix - a.npix);
  comps = comps.slice(0, 4000);

  // 字符 → 行/段 → 文字块，两级合并
  const lines = mergeRects(comps, Math.round(minSide * 0.6));
  const blocks = mergeRects(lines, minSide * 3);
  return toBlocks(blocks, W, H, 0.5);
}

/* ---------------- 引擎 2：ONNX 模型档（DBNet 语义分割） ---------------- */

async function detectOnnx(buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
  const scale = Math.min(1, LONG_SIDE / Math.max(meta.width ?? LONG_SIDE, meta.height ?? LONG_SIDE));
  const rw = Math.round((meta.width ?? LONG_SIDE) * scale);
  const rh = Math.round((meta.height ?? LONG_SIDE) * scale);
  const W = Math.max(32, Math.round(rw / 32) * 32);
  const H = Math.max(32, Math.round(rh / 32) * 32);

  const { data } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(W, H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // NCHW + ImageNet 均值方差归一化
  const px = W * H;
  const chw = new Float32Array(3 * px);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < px; i++) {
    for (let c = 0; c < 3; c++) {
      chw[c * px + i] = (data[i * 3 + c] / 255 - mean[c]) / std[c];
    }
  }
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor('float32', chw, [1, 3, H, W]);
  const results = await session.run(feeds);
  const out = results[session.outputNames[0]];
  // 输出为 [1,1,H,W] 概率图（若 [1,2,H,W] 取第 0 通道）
  const prob = out.data;

  const bin = new Uint8Array(px);
  for (let i = 0; i < px; i++) bin[i] = prob[i] > BIN_THRESH ? 1 : 0;

  let comps = components(bin, W, H);
  const minSide = Math.max(4, Math.round(Math.min(W, H) * 0.004));
  comps = comps.filter(
    (c) => c.x1 - c.x0 + 1 >= minSide && c.y1 - c.y0 + 1 >= minSide,
  );
  comps.sort((a, b) => b.npix - a.npix);
  comps = comps.slice(0, 4000);

  const rects = mergeRects(comps, minSide * 2);
  // DBNet unclip 近似：offset = area/perimeter * ratio（取一半作 AABB 修正）
  const blocks = rects.map((r) => {
    const w = r.x1 - r.x0 + 1;
    const h = r.y1 - r.y0 + 1;
    const off = ((w * h * UNCLIP_RATIO) / (2 * (w + h))) * 0.5;
    return {
      x0: Math.max(0, r.x0 - off),
      y0: Math.max(0, r.y0 - off),
      x1: Math.min(W, r.x1 + off),
      y1: Math.min(H, r.y1 + off),
    };
  });
  return toBlocks(blocks, W, H, 0.8);
}

/* ---------------- HTTP 服务 ---------------- */

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

let busy = false; // 单机 CPU 保护：同一时刻只跑一张

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      models: Boolean(session),
      engine: session ? 'onnx' : sharp ? 'traditional' : 'unavailable',
      detector: Boolean(sharp),
    });
  }

  if (req.method === 'POST' && url.pathname === '/detect') {
    if (!sharp) return send(res, 503, { error: 'sidecar 缺少 sharp 依赖，无法检测' });
    if (busy) return send(res, 503, { error: '上一次检测尚未完成，请稍后重试' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return send(res, 400, { error: '请求体不是合法 JSON 或过大' });
    }
    if (!body?.image) return send(res, 400, { error: '缺少 image 字段（base64）' });
    busy = true;
    try {
      const image = Buffer.from(body.image, 'base64');
      const started = Date.now();
      const blocks = session ? await detectOnnx(image) : await detectTraditional(image);
      console.log(
        `[sidecar] /detect ${session ? 'onnx' : 'traditional'} → ${blocks.length} 块，${Date.now() - started}ms`,
      );
      return send(res, 200, { blocks, engine: session ? 'onnx' : 'traditional' });
    } catch (err) {
      console.error('[sidecar] /detect 失败：', err?.message ?? err);
      return send(res, 500, { error: '检测失败：' + (err?.message ?? 'unknown') });
    } finally {
      busy = false;
    }
  }

  if (req.method === 'POST' && (url.pathname === '/ocr' || url.pathname === '/inpaint')) {
    try {
      await readJsonBody(req);
    } catch {
      return send(res, 400, { error: '请求体不是合法 JSON 或过大' });
    }
    return send(res, 501, { error: '本进程只提供 /detect；OCR / LaMa 请接其它 sidecar 实现' });
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`sidecar detector http://127.0.0.1:${port}`);
  console.log(`  引擎：${session ? 'ONNX 模型档' : '传统算法档（无模型）'}`);
});
