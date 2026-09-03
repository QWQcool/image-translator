# 本机识别 / 去字 / 检测 sidecar

主站不把 manga-ocr / LaMa 的几百 MB 权重塞进浏览器。需要 OCR、LaMa或文本块检测时，另开这个进程。

默认地址：`http://127.0.0.1:8765`

```
GET  /health  -> { ok, models, engine, detector }
POST /detect  { image: base64, mimeType } -> { blocks: [{ x, y, w, h, text, confidence }], engine }
POST /ocr     { image: base64, mimeType } -> { blocks: [{ x, y, w, h, text, confidence }] }
POST /inpaint { image: base64, mask: base64 } -> { image: base64 }  # 去字后的图或涂改层 PNG
```

坐标均为 0~1（x/y 左上角）。`/detect` 的 `text` 恒为空字符串——
主站会把空框裁剪后交给视觉模型补提取文字（也可不配 AI，手动录入）。

## 文本块检测（detector.mjs）

```
node sidecar/detector.mjs
```

两种引擎，启动时自动选择：

| 档位 | 条件 | 说明 |
| --- | --- | --- |
| **传统算法档** | 无需模型，开箱即用 | 局部自适应阈值 + 连通域 + 近邻合并，纯 sharp/JS 实现；对黑白漫画「气泡内深色文字」效果好 |
| **ONNX 模型档** | 装了 onnxruntime-node 且模型存在 | 漫画专用 DBNet 检测模型，复杂背景 / 彩色页精度更高 |

启用 ONNX 模型档：

1. 项目根执行 `npm i onnxruntime-node`
2. 下载模型（约几十 MB，Manga 专用）：
   <https://huggingface.co/mayocream/comic-text-detector-onnx/resolve/main/comic-text-detector.onnx>
   （上游：github.com/dmMaze/comic-text-detector）
3. 放到 `sidecar/models/comic-text-detector.onnx`，重启 detector.mjs
4. 验证：`curl http://127.0.0.1:8765/health` 里 `engine` 变为 `onnx`

可调参数（环境变量）：`DETECT_LONG_SIDE`（默认 1024）、`DETECT_BIN_THRESH`（0.4）、
`DETECT_DARK_DELTA`（18，传统档）、`DETECT_UNCLIP`（1.6，模型档）。

主站侧使用：AI 设置 → 文本块检测服务 → 来源选「本机检测进程」。
之后标注页的「OCR 自动标号」即走本地检测，不消耗 API 额度。

## OCR / 去字

`stub.mjs` 是无模型占位（仅探活）。真实 OCR / LaMa 请自行接入本协议：

- 协议友好的优先选择：RapidOCR（Apache）、LaMa ONNX（Apache）、manga-ocr ONNX（MIT）
- Comic Text Detector 若带 GPL 权重，放在这个可关闭进程里，不要链进主站

主站环境变量：`SIDECAR_URL=http://127.0.0.1:8765`
