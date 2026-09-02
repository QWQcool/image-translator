#!/usr/bin/env node
/**
 * 无模型占位进程。只提供 /health，方便主站探测。
 * 真正的 RapidOCR / LaMa 请按 sidecar/README.md 自己接。
 */
const http = require('node:http');
const port = Number(process.env.SIDECAR_PORT || 8765);

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health') return send(200, { ok: true, models: false });
  send(501, { error: '此占位进程未加载 OCR / LaMa 模型' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`sidecar stub http://127.0.0.1:${port}`);
});
