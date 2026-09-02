# 本机识别 / 去字 sidecar

主站不把 manga-ocr / LaMa 的几百 MB 权重塞进浏览器。需要 OCR 或 LaMa 时，另开这个进程。

默认地址：`http://127.0.0.1:8765`

```
GET  /health
POST /ocr      { image: base64, mimeType } -> { blocks: [{ x, y, w, h, text, confidence }] }
POST /inpaint  { image: base64, mask: base64 } -> { image: base64 }  # 去字后的图或涂改层 PNG
```

坐标均为 0~1。Comic Text Detector 若带 GPL 权重，放在这个可关闭进程里，不要链进主站。

协议友好的优先选择：RapidOCR（Apache）、LaMa ONNX（Apache）、manga-ocr ONNX（MIT）。

启动占位（无模型，仅探活）：

```
node sidecar/stub.mjs
```

主站环境变量：`SIDECAR_URL=http://127.0.0.1:8765`
