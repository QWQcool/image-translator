# 推特图片翻译网站 — 方案与 X API 采集规划

## 一、当前状态

**Phase 1 已完成并跑通端到端测试**（42 项断言全通过，生产构建 25 个路由通过）。
Phase 2（X API 自动采集）待接入，数据库字段与去重索引已预留。

已确认的产品决策：

| 决策项 | 结论 |
| --- | --- |
| 采集范围 | 我关注的人（following） |
| 标注形态 | 框选区域 + 文字（能盖住原文） |
| 部署形态 | 公网服务器（国内），多人协作 |
| 协作模式 | 协作空间 + 权限区分（有权限可增删改，无权限只读） |
| 素材来源 | 手动上传 / 全站共享（二选一待定） |
| X API 预算 | 暂不确定 → 先完成不依赖 API 的部分 |

---

## 二、已实现的架构

```
Next.js 15 (App Router) 全栈单进程
├─ SQLite (better-sqlite3, WAL)   ← 数据
├─ 本地磁盘 data/                 ← 图片与缩略图
├─ sharp                          ← 图片处理与缩略图生成
└─ JWT (jose) + httpOnly Cookie   ← 多用户会话
```

选用单机架构的理由：数据模型本身与存储方式解耦，改造点只有三处且都已隔离
（`db.ts` / `storage.ts` / `api/media`），等真的需要横向扩展时再换 Postgres + 对象存储不迟。

### 关键设计决策

1. **坐标全链路归一化（0~1）**，字号存为「相对图片高度的比例」。
   换分辨率、换缩略图、换屏幕尺寸都不会错位。导出时同时输出归一化值与像素值。
2. **缩略图强制生成**（宽 520 的 webp）。图库可能有几百张原图，直接渲染会卡死浏览器。
3. **`assets` 与 `space_items` 分离**。同一张图可进入多个空间，各有独立命名与独立标注；
   从空间移除只解绑，不删磁盘文件。
4. **多用户按 `owner_id` 全表隔离**，所有查询都带 owner 过滤。
5. **图片经 API 路由提供**而非 `public/`——运行时上传的文件在生产模式下不会被静态服务识别。

### 协作权限（Phase 1 已完成）

空间是协作单元，权限三级：

| 角色 | 能做 | 不能做 |
| --- | --- | --- |
| 所有者 | 内容增删改、成员管理、空间设置、删除空间 | —— |
| 可编辑 | 空间内图片与标注的增删改 | 成员管理、空间设置、删除空间 |
| 只读 | 查看、导出 | 任何写操作（403） |

- 权限判定集中在 `src/lib/permissions.ts`，优先级：
  **成员表记录 > 空间所有者 > 公开空间旁观者 > 无权限**
- 无访问权返回 **404**（不泄露空间是否存在），权限不足返回 **403**
- 空间创建者不可被移除或降级

### 共享图库

素材默认私有，勾选「共享到公共图库」后其他用户可取用。
这是让「协作」与「全站共享采集」真正落地的关键：
否则成员只能添加自己图库里的图，看不到别人上传的素材。

他人共享的素材只能使用，不能重命名或删除（接口层按 owner 隔离）。

### 已预留的采集字段

```sql
assets.source_url       -- X 原图直链
assets.source_author    -- 作者用户名
assets.source_post_id   -- 媒体唯一键（media_key）
CREATE UNIQUE INDEX idx_assets_source
  ON assets(owner_id, source_post_id) WHERE source_post_id IS NOT NULL;
```

唯一索引让增量抓取天然幂等，重复抓同一条不会产生脏数据。

---

## 三、Phase 2：X API 采集器

### 3.1 计费模式（重要）

X API 已取消 Basic / Pro 订阅制，改为 **pay-per-use 信用点**：

| 资源 | 单价 |
| --- | --- |
| Post 读取 | **$0.005 / 条** |
| User 读取 | $0.010 / 个 |
| Following 读取 | $0.010 / 个 |
| Owned Read（自己的 App 读自己的数据） | $0.001 / 条 |

- 计费按**返回的资源条数**，不是按请求数
- **24 小时 UTC 内去重**：同一条推文当天重复请求不重复扣费（调试期友好）
- 月上限 300 万条 Post 读取

### 3.2 端点选择

| 用途 | 端点 | 认证 | 速率限制 |
| --- | --- | --- | --- |
| 关注列表 | `GET /2/users/:id/following` | Bearer Token | 300 次 / 15min |
| 用户推文 | `GET /2/users/:id/tweets` | Bearer Token 即可 | **应用级 10,000 次 / 15min** |
| 首页时间线 | `GET /2/users/:id/timelines/reverse_chronological` | **必须用户令牌** | 180 次 / 15min |

**采用「关注列表 + 逐用户拉推文」**，理由：可用 App-only Bearer Token、速率限制高一个数量级、覆盖完整。
首页时间线只能拿到 X 排序后的近期内容，且强制用户令牌，不适合作为主路径。

请求参数：

```
GET /2/users/{userId}/tweets
  ?max_results=100
  &exclude=retweets,replies
  &expansions=attachments.media_keys
  &media.fields=media_key,type,url,preview_image_url,width,height,alt_text
  &tweet.fields=created_at,attachments
  &since_id={lastSeenId}        ← 增量
  &pagination_token={token}     ← 翻页
```

`media.fields=url` 对 `type=photo` 直接返回 `pbs.twimg.com` 直链，下载不额外计费。
`type=video` / `animated_gif` 的 `url` 为空，需要读 `variants`——**建议一期只做 photo**。

### 3.3 成本估算

| 场景 | 条数 | 成本 |
| --- | --- | --- |
| 100 关注者 × 100 条（首次全量） | 10,000 | $50 |
| 500 关注者 × 100 条（首次全量） | 50,000 | **$250** |
| 500 关注者 × 20 条（首次，限近期） | 10,000 | $50 |
| 增量：500 人 × 5 条/天 | 2,500/天 | **$375/月** ⚠️ |

**必须实施的省钱策略：**

1. 首次抓取用 `start_time` 限定时间窗（如近 30 天）+ `max_results=20`，成本降到 1/5
2. 存 `since_id`，之后只拉新推文
3. 白名单机制：只对勾选的重点账号自动增量，其余手动触发
4. 增量频率改为每 2–3 天一次
5. **任务级预算硬上限**：单次任务消耗超过设定金额自动停止
6. 控制台设置 spending limit 兜底

### 3.4 工程要点

- **429 处理**：读 `x-rate-limit-remaining` / `x-rate-limit-reset` 响应头，等待窗口重置 + 指数退避
- **去重落库**：`source_post_id` 唯一索引 + `INSERT OR IGNORE`
- **游标持久化**：`source_accounts.last_post_id` / `last_crawled_at`
- **`possibly_sensitive` 过滤**：可选，避免抓到不想看的内容
- **合规**：保留作者与原文链接，不对外再分发原图

### 3.5 实施建议

采集器做成独立脚本（`crawler/index.ts` + 定时任务），只负责「抓 → 落库到 `assets`」，
与 Web 应用完全解耦。最坏情况下（API 政策再变），手动上传路径依然可用，产品主体不受影响。

---

## 四、导出格式（已定型）

```json
{
  "schema": "twitter-image-translator/export@1",
  "exportedAt": "2026-09-01T12:00:00Z",
  "space": { "id": 1, "name": "空间A", "description": null },
  "images": [
    {
      "itemId": 12,
      "title": "我给这张图起的名字",
      "file": "images/abc123.jpg",
      "originalName": "orig.jpg",
      "sourceUrl": "https://x.com/xxx/status/123456",
      "sourceAuthor": "someone",
      "width": 1200,
      "height": 800,
      "annotations": [
        {
          "index": 1,
          "norm":  { "x": 0.12, "y": 0.34, "w": 0.30, "h": 0.06 },
          "pixel": { "x": 144, "y": 272, "w": 360, "h": 48 },
          "text": "翻译后的文字",
          "fontSize": 24,
          "fontSizeRatio": 0.03,
          "color": "#FFFFFF",
          "background": "#000000B3",
          "align": "left",
          "fontWeight": 700
        }
      ]
    }
  ]
}
```

CSV 列：`图片序号, 图片命名, 文件名, 作者, 原图链接, 图片宽, 图片高, 标注序号, 文字内容,
X/Y/宽/高(比例), X/Y/宽/高(像素), 字号, 文字颜色, 背景色`（带 UTF-8 BOM，Excel 直接打开不乱码）。

ZIP 包含 `annotations.json` + `annotations.csv` + `README.txt`。

---

## 五、主要风险

| 风险 | 对策 |
| --- | --- |
| API 成本失控 | 任务级预算硬上限 + 控制台 spending limit + 默认关闭自动抓取 |
| 429 速率限制 | 响应头驱动的等待 + 指数退避 |
| 图片量大导致前端卡顿 | 缩略图 + 懒加载 + 分页 |
| 标注坐标错位 | 全链路归一化坐标 |
| X API 政策再变 | 采集器与业务库解耦，可退回手动上传 |
| 磁盘增长 | 只存 photo；定期清理未被引用的 asset |
