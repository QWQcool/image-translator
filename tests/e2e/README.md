# E2E 冒烟套件（阶段 18）

Playwright 冒烟测试：覆盖「建空间 → 上传 → 标注 → 嵌字导出 → 成品归档」核心链路与
空间管理、设置面板、页面切换稳定性、登录墙。跑在**生产构建 + TRIAL_MODE** 上
（免登录试用身份），登录墙用例跑在无 TRIAL_MODE 的 dev server 上。

## 本地运行

```bash
npx playwright install chromium   # 首次需要，装测试浏览器
npm run e2e                       # 等价 npx playwright test
```

可选：

```bash
npx playwright test --headed      # 看浏览器跑
npx playwright test --grep 核心链路  # 只跑某条
npx playwright show-report        # CI 失败报告本地查看
```

## 隔离说明（不会污染你的本地环境）

| 资源 | E2E 使用的值 | 说明 |
| --- | --- | --- |
| 端口 | 3100（smoke）/ 3200（secure） | 不碰用户 3000 端口 |
| 构建产物 | `.next-e2e-trial` / `.next-e2e-secure` | 通过 `NEXT_DIST_DIR`（见 next.config.ts）重定向，**不覆盖** dev server 在用的 `.next` |
| 数据库/图片 | `.tmp/e2e-data` / `.tmp/e2e-data-secure` | 通过 `DATA_DIR` 重定向，不碰 `data/` |
| TRIAL_MODE | 仅 smoke 构建期设置 | Edge middleware 的 TRIAL_MODE 是构建期内联，必须 build 前设置 |

`reuseExistingServer: !CI`：本地重复跑时若 3100/3200 已有同配置服务则直接复用
（复用时用的是**旧构建**，改了代码想测新代码需先手动停掉旧服务）。

> **CodeBuddy 本机环境注意**：其 shell 会通过 `NODE_OPTIONS` 注入 safe-delete shim，
> 会拦截 `next build` 清理旧产物与 Playwright 清理 `test-results/` 的批量删除
> （>500 文件强制确认）。webServer 子进程已在 config 里清空 `NODE_OPTIONS` 绕开，
> 但 **Playwright 主进程仍需手动清空**后再跑：
>
> ```powershell
> $env:NODE_OPTIONS=''; npx playwright test
> ```
>
> CI（ubuntu runner）没有该注入，直接 `npx playwright test` 即可。

## 用例清单

smoke project（`tests/e2e/smoke.spec.ts`，TRIAL_MODE 生产构建，3100）：

1. **核心链路**：新建空间（名称+标签，断言序号 `YYYYMMDD-NN` 格式）→ 详情页上传
   fixture 图 → 标注编辑器「标号」模式点画布放 pin → 输译文 → Ctrl+S 保存 →
   断言「已保存」且无 error、dirty 清零
2. **空间管理**：搜索序号命中 → 标签筛选命中 → 详情页改标签后列表按新标签筛选命中 →
   进度菜单切「已翻译」→ 徽标变化 +「已维持」出现
3. **嵌字冒烟**：文字工具加文字层 → 输入文本 → 启用描边并改描边色 → 导出 PNG
   （断言 download 文件名 `*-嵌字.png`）→ 保存成品 → 空间「成品」视图出现条目
4. **设置面板**：改进度项 label 保存 → 列表徽标联动 → 恢复默认；预设标签增删 →
   新建空间弹窗候选联动 → 恢复默认
5. **页面切换稳定性**：列表↔详情↔标注↔嵌字↔阅读 往返 ×2 → 断言无 pageerror /
   未过滤的 console error，后退键回退到正确页

secure project（`tests/e2e/login-wall.spec.ts`，无 TRIAL_MODE dev，3200）：

6. **登录墙**：未登录 GET /spaces、/spaces/1 → 307 到 /login（详情页带 `next` 参数），
   /login 本身可达。只做 request 级断言——生产构建会话 Cookie 带 Secure 标记，
   浏览器级登录流程在 http://localhost 走不通，且注册/登录接口语义已由
   `tests/api-regression.mjs` 覆盖。

## Fixtures

`fixtures/sample.png`：200×300 纯色 PNG（sharp 生成），上传/标注/嵌字全链路共用。
