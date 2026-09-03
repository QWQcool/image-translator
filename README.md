# 图译空间

图片收集 · 空间分组 · 图上文字标注 · 嵌字 · 坐标与内容导出。

为「收集图片 → 按空间归类 → 在图上框选区域填写译文 → 嵌字合成 → 导出坐标与文本」这一流程而建。
二期已加入 **AI 能力**（视觉 OCR / 翻译 / 图像去字 / 批量处理）、**多人实时协作编辑**与 **LabelPlus 工程互转**。

---

## 快速开始

```bash
npm install
cp .env.example .env.local     # Windows: copy .env.example .env.local
npm run dev                    # http://localhost:3000
```

首次启动会自动创建 `data/` 目录（SQLite 数据库 + 上传的图片）。注册账号需要**邀请码**（`.env.local` 里的 `INVITE_CODE`，留空则关闭注册）。

> **生产环境必须修改 `.env.local` 中的 `SESSION_SECRET`**，否则启动会直接报错。
> 生成方式：`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

---

## 功能

| 模块 | 能力 |
| --- | --- |
| **空间（公共文件夹）** | 新建 / 改名 / 改描述 / 删除；**上传图片直接进空间**（多选 + 拖拽 + `Ctrl+V` 粘贴，单次 ≤20 张、单张 ≤20MB）；自动生成缩略图 |
| **空间内图片** | 每张图可单独命名（点击标题改名）；**上移 / 下移排序**；**右上角搜索框**（按标题 / 原始文件名模糊过滤） |
| **删除即删除** | 单选 / 多选批量**彻底删除**（条目 + 标注 + 不再被引用的素材与磁盘文件），无回收站、不可撤销；被其它空间共用的素材自动保留 |
| **全局查找** | 空间列表右上角搜索框，按空间名 / 描述模糊匹配 |
| **标注编辑器** | 在图上拖拽画框 → 输入文字 → 实时预览覆盖效果；拖动移动、8 向手柄缩放、字号/颜色/底色/对齐/粗细/不透明度；**文字分段渲染**：选中标注内部分文字单独改颜色/字号倍率(0.5x~2x)/粗细，可清除段落样式；**文字不透明度**（0~100%，底色透明度独立）；空格 / 中键 / `Alt` + 拖动平移画布，**图片外空白处拖动也可平移** |
| **阅读模式** | 空间详情页「阅读」进入全屏阅读器；`←`/`→`/空格/滚轮/点击左右半屏翻页，`Esc` 退出；设置（右上角，本地持久化）：纵向/横向对页、正序/倒序（漫画从后往前）、适应宽度/适应屏幕、显示译文（按标注样式叠加，纯预览不合成）；按空间记住上次读到的页码 |
| **实时协作** | 同一条目的标注编辑支持多人共编（编辑锁 + 房间共享 + SSE 实时推送，断线自动轮询降级） |
| **嵌字页** | 涂改层 + 文字层合成，导出已嵌字 PNG；打开自动适应窗口居中（可随时一键恢复），支持 LabelPlus 工程导入 / 导出、标注分组样式预设 |
| **导出** | 空间级 JSON（完整结构）/ CSV（Excel 可开）/ ZIP（两者打包） |
| **AI 能力** | 每用户独立配置视觉对话（OCR+翻译）、图像编辑（去字）等服务；**文本块检测服务（可选）**：配置后 OCR 走「检测出框 → 空框裁剪补提取」两步链路，框更准更省 token；单张 OCR / 翻译 / 去字，或空间级 **AI 批量处理**；`/ai` 页含完整「使用说明」（服务类型 / 获取渠道 / 推荐组合 / 费用 / 隐私 / 常见问题） |
| **操作日志** | 上传 / 排序 / 删除 / 改名 / 空间操作 / AI 调用全程留痕，可查 |

> 独立「图库」与「回收站」已在二期移除：上传一律进空间文件夹，删除一律彻底删除（历史软删除字段保留但不再写入）。

---

## 界面设计

蔚蓝档案学院风：纸蓝画布（`paper`）+ 云白面板（`cloud`）+ 晴空主色（`sky`）+ 光环黄点缀（`halo`）+ 墨色文字（`ink`），
令牌定义见 `tailwind.config.ts`，通用组件（`card / btn / input / seg`）见 `src/app/globals.css`。

- 签名元素是**光带动势条**——登录卡与空间卡顶部的斜向细条纹（`.momentum-stripes`）
- 动效由 GSAP 驱动（`src/lib/motion.ts`）：登录页光环呼吸 + 吉祥物滑入的编排入场、顶栏下滑、页面淡入上浮、卡片错开入场
- 全部动效遵循 `prefers-reduced-motion`；**编辑器（标注 / 嵌字 / 阅读器）保持零动效**，保证操作稳定

---

## 权限模型（开放空间）

站点采用**开放空间**模型：没有私人文件夹，所有登录用户对所有空间都有**编辑权**；
只有空间**创建者**保留管理权（改名 / 改描述 / 删除空间）。

| 角色 | 能做 |
| --- | --- |
| **所有者**（创建者） | 全部操作：增删改内容 + 改空间信息 + 删除空间 |
| **编辑者**（其他所有登录用户） | 上传、改名、排序、删除图片，编辑标注 |

- 权限判定集中在 `src/lib/permissions.ts`，所有写接口统一校验：无访问权返回 **404**（不暴露空间是否存在），权限不足返回 **403**
- `space_members` 表保留仅为兼容历史数据，不再参与鉴权

### 编辑器快捷键

| 操作 | 快捷键 |
| --- | --- |
| 保存 | `Ctrl` / `Cmd` + `S` |
| 删除选中标注 | `Delete` / `Backspace`（焦点不在输入框时；二次确认后生效） |
| 缩放画布 | 滚轮 |
| 平移画布 | 空格 + 拖动，或按住中键拖动，或 `Alt` + 拖动 |
| 适应窗口 / 100% | 编辑器顶部工具栏 |

---

## 数据模型要点

- **所有坐标都是归一化值（0~1）**，字号存为「相对图片高度的比例」。换分辨率、换缩略图、换屏幕都不会错位。
- 导出时**同时给出归一化值和像素值**，方便下游程序直接消费。
- `assets`（素材公共池）与 `space_items`（空间内的图）分离：同一张素材可进入多个空间，各自有独立命名和独立标注。
- 删除是**彻底删除**：条目 + 标注（外键级联）+ 不再被任何空间引用的素材行与磁盘文件（`src/lib/hard-delete.ts`）；被共用素材自动保留。`assets.deleted_at` 仅作历史兼容，不再写入。
- 实时协作数据落在 `edit_rooms`（编辑锁 + 共享标记）与 `room_ops`（房间操作流，SSE 推送）。

---

## 本地部署（单机体验）

给 AI 的部署提示词——把下面整段复制给任意 AI 助手（CodeBuddy / Claude / ChatGPT 等），
它就能在一台干净的电脑上把项目跑起来：

```text
请帮我把开源项目「图译空间」部署到这台电脑上做本地体验。

项目信息：
- 技术栈：Next.js 15（App Router）+ TypeScript + better-sqlite3 + sharp，需要 Node.js ≥ 20
- 数据库与上传的图片都存在项目根目录的 data/ 文件夹（首次运行自动创建，无需手动建库）
- 本地体验请用开发模式运行（npm run dev）：此模式下登录 Cookie 不要求 HTTPS，
  而 npm start（生产模式）的 Cookie 带 Secure 标记，http://localhost 下会无法登录

请按以下步骤执行：
1. 确认本机 Node.js ≥ 20 且 npm 可用，没有就先安装
2. 进入项目目录（若未克隆，先 git clone 仓库地址：<在此填入仓库地址>）
3. 执行 npm install
4. 在项目根目录创建 .env.local，内容至少包含：
   SESSION_SECRET=<运行 node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" 生成随机串>
   DATA_DIR=data
   INVITE_CODE=<自定义一个邀请码，注册页面需要填写；留空则关闭注册>
5. 运行 npm run dev，确认 http://localhost:3000 能打开登录页
6. 用页面上的「注册」创建账号（填写第 4 步的邀请码）并登录
7. 验证核心流程：新建空间 → 上传一张图片 → 进入标注编辑器画框填写译文并保存 → 空间详情页点「阅读」翻页
8. 全部通过后汇报：访问地址、邀请码、data/ 目录位置，以及过程中遇到的问题与解决方式

常见问题：
- 3000 端口被占用：npm run dev -- -p 3001
- better-sqlite3 安装失败：需要本机 C++ 构建工具链（Windows 装 VS Build Tools，Ubuntu 装 build-essential），
  或删除 node_modules 后重试 npm install 让它下载预编译产物
- 数据备份 = 直接复制整个 data/ 目录；.env.local 与 data/ 都不要提交进 git（已在 .gitignore）
- AI 功能（OCR / 翻译 / 去字）是可选项：登录后进「AI 设置」填自己的 OpenAI 兼容服务即可，不填不影响其它功能
```

### 本机识别进程（可选）

不配置 AI token 时的离线兜底。两种启动方式：

- `node sidecar/detector.mjs` —— **文本块检测**（推荐）：传统算法档开箱即用，
  下载 comic-text-detector.onnx 模型后自动启用更高精度的 ONNX 档；
  AI 设置 → 文本块检测 → 来源选「本机检测进程」即可使用（免费、离线）
- `node sidecar/stub.mjs` —— 仅探活占位，供接真实 OCR / LaMa 时替换

完整协议、模型下载链接与可调参数见 `sidecar/README.md`。

---

## 部署到公网

### 1. 构建与启动

```bash
npm install
npm run build
npm start                      # 默认 3000 端口
```

设置环境变量（生产环境必须）：

```bash
SESSION_SECRET=<随机长字符串>   # 必填，缺失会直接抛错
DATA_DIR=data                   # 可选，数据库与图片的存放目录
PORT=3000                       # 可选
TRUST_PROXY=1                   # 可选；部署在 Nginx 等反代后时置 1，注册/登录限流按真实 IP 分桶
SIDECAR_URL=http://127.0.0.1:8765  # 可选；本机识别进程（离线 OCR / 去字兜底）
```

### 2. 数据持久化

`DATA_DIR` 指向的目录包含 `app.db`（SQLite）与 `images/`、`thumbs/` 两个图片目录。
**这个目录必须持久化**——容器化部署时挂一个 volume 到该路径，否则重启即丢失。

```bash
docker run -d -p 3000:3000 \
  -e SESSION_SECRET=你的密钥 \
  -v /srv/tximg-data:/app/data \
  你的镜像
```

### 3. 反向代理

用 Nginx / Caddy 反代到 3000 端口并启用 HTTPS。注意不要缓冲导出接口的大响应。

Nginx 参考：

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 50m;      # 与上传限制保持一致
}
```

### 4. HTTPS 是必需的

登录 Cookie 在 `NODE_ENV=production` 下带 `Secure` 属性，**没有 HTTPS 将无法登录**。

### 5. 多人使用的容量边界

当前实现为单机架构（SQLite + 本地磁盘），适合个人与小团队（并发用户数 < 20、图片数万级）。
若后续需要水平扩展，改造点已隔离：

- 数据库：换 Postgres（SQL 已在 `src/lib/db.ts` 集中管理）
- 图片存储：`src/lib/storage.ts` 是唯一的文件读写出口，替换为对象存储即可
- 图片读取：`src/app/api/media/[...path]/route.ts` 是唯一的对外文件服务出口

---

## 项目结构

```
src/
├─ app/
│  ├─ login/                     # 登录 / 注册（邀请码）
│  ├─ library/                   # 旧 /library 链接 → 307 重定向到 /spaces
│  ├─ (app)/                     # 需登录访问
│  │  ├─ spaces/                 # 空间列表与详情（直传 / 排序 / 搜索 / 硬删除）
│  │  ├─ annotate/[itemId]/      # 标注编辑器（实时协作）
│  │  ├─ typeset/[itemId]/       # 嵌字页（涂改层 + 文字层）
│  │  ├─ ai/                     # AI 服务配置
│  │  ├─ logs/                   # 操作日志
│  │  └─ profile/                # 个人资料
│  └─ api/                       # 后端接口
│     ├─ auth/                   # 注册 / 登录 / 登出
│     ├─ assets/                 # 素材公共池（内部兼容）
│     ├─ spaces/                 # 空间 + 条目 + 直传 + 排序 + 导出
│     ├─ items/                  # 条目 + 标注 + OCR/翻译/去字
│     ├─ ai/                     # AI 配置
│     └─ media/                  # 图片文件服务
├─ components/                   # 通用 UI
└─ lib/
   ├─ db.ts                      # SQLite 连接与建表（迁移集中在此，幂等）
   ├─ auth.ts                    # 密码哈希与会话
   ├─ permissions.ts             # 开放空间鉴权
   ├─ storage.ts                 # 图片落盘与缩略图
   ├─ hard-delete.ts             # 彻底删除（条目 / 素材 / 磁盘文件）
   ├─ ai.ts                      # AI 服务调用（每用户配置）
   ├─ use-collab-room.ts         # 实时协作客户端（SSE + 轮询降级）
   ├─ annotation.ts              # 标注数据结构与文本排版
   └─ types.ts                   # 共享类型
```

---

## 图片来源

**全部零 API 成本**：

1. **上传文件**：进入空间后点击「上传图片」、拖拽文件、或 `Ctrl+V` 粘贴剪贴板里的图片；
   支持**整话 zip 压缩包**（自动解包、按文件名自然排序建条目，过滤 `__MACOSX` 等垃圾文件，
   限制：zip ≤ 200MB、单图 ≤ 20MB、单包 ≤ 200 张）
2. **图片链接导入**：粘贴 `pbs.twimg.com` 等图片直链，服务器直接下载
   （含 SSRF 防护：拦截内网地址、限制协议/大小/类型/重定向跳转）

导出侧提供 **LabelPlus 官方 txt 文本**（空间详情 → 导出菜单），
格式与官方 [PS-Script](https://github.com/LabelPlus/PS-Script) 导入脚本对齐
（`>>>>>>[文件名]<<<<<<` 图片块 + `------[序号]------[x,y,组]` 标号块，坐标为中心点归一化值），
可直接用 PS 脚本导入 Photoshop 嵌字。

## 下一步：接入 X API 采集器（Phase 2）

数据库已预留采集所需字段：`assets.source_url`、`source_author`、`source_post_id`，
且 `(owner_id, source_post_id)` 上有唯一索引，天然支持增量去重。
采集下来的图片可直接写入素材公共池（`visibility = 'shared'`），供各空间取用。

计划接入的端点（`GET /2/users/{id}/following` + `GET /2/users/{id}/tweets`，
配合 `expansions=attachments.media_keys` 与 `media.fields=url`）。
采集下来的图片可直接写入素材公共池（`visibility = 'shared'`），供各空间取用。

⚠️ **成本提示**：X API 现为按次计费，**读取一条推文 $0.005**。
500 个关注者各抓 100 条 = $50,000 条 = **$250**。
必须限制首次抓取深度（用 `start_time` 限定时间窗）、之后靠 `since_id` 增量，
并在抓取器内置预算硬上限。详见 `docs` 中的方案文档。
