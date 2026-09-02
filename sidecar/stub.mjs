#!/usr/bin/env node
/**
 * 无模型占位进程。只提供 /health，方便主站探测。
 * 真正的 RapidOCR / LaMa 请按 sidecar/README.md 自己接。
 *
 * 注意：本文件扩展名是 .mjs，Node 会按 ES Module 解析，
 * 必须用 import 而不是 require。
 */
import http from 'node:http';

const port = Number(process.env.SIDECAR_PORT || 8765);

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
    // 占位进程不处理大图，超过 32MB 直接拒，避免被当垃圾桶
    if (size > 32 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, models: false });
  }

  if (req.method === 'POST' && (url.pathname === '/ocr' || url.pathname === '/inpaint')) {
    try {
      await readJsonBody(req);
    } catch {
      return send(res, 400, { error: '请求体不是合法 JSON 或过大' });
    }
    // 明确返回 501：主站据此提示「本机识别进程未加载模型」
    return send(res, 501, { error: '此占位进程未加载 OCR / LaMa 模型' });
  }

  return send(res, 501, { error: '此占位进程未加载 OCR / LaMa 模型' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`sidecar stub http://127.0.0.1:${port}  (无模型：仅 /health 可用)`);
});
