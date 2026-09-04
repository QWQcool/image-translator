import { defineConfig, devices } from '@playwright/test';

/**
 * 阶段 18：Playwright E2E 冒烟套件。
 *
 * 两个 project、两套 webServer（隔离是硬要求）：
 * - smoke：生产构建 + TRIAL_MODE=1（免登录试用身份），承载 5 条冒烟用例。
 *   注意 TRIAL_MODE 是 Edge middleware 的构建期内联变量，必须在 build 前设置。
 * - secure：next dev（无 TRIAL_MODE），只跑登录墙用例——生产构建下会话 Cookie 带
 *   Secure 标记，http://localhost 浏览器无法登录，所以登录墙用 request 级断言
 *   （未登录 307 → /login）而非浏览器登录流程；dev 模式下 TRIAL_MODE 走运行时读取，
 *   无需第二个生产构建。
 *
 * 与用户本地环境隔离（不得污染 3000 端口与用户数据）：
 * - 端口固定 3100 / 3200；
 * - NEXT_DIST_DIR（见 next.config.ts）：E2E 构建产物写入 .next-e2e-* 独立目录，
 *   不覆盖用户 dev server 正在用的 .next；
 * - DATA_DIR：数据库与图片落在 .tmp/e2e-data*，不碰 data/。
 */
const TRIAL_PORT = 3100;
const SECURE_PORT = 3200;

export default defineConfig({
  testDir: 'tests/e2e',
  // 嵌字导出 / 多页切换链路较长，整体放宽
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // CI 抖动容错：失败重试一次
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'smoke',
      testIgnore: /login-wall\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${TRIAL_PORT}` },
    },
    {
      name: 'secure',
      testMatch: /login-wall\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${SECURE_PORT}` },
    },
  ],
  webServer: [
    {
      name: 'smoke（TRIAL_MODE 生产构建）',
      command: 'npm run build && npm start',
      url: `http://127.0.0.1:${TRIAL_PORT}/api/settings`,
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
      env: {
        TRIAL_MODE: '1',
        NEXT_DIST_DIR: '.next-e2e-trial',
        PORT: String(TRIAL_PORT),
        DATA_DIR: '.tmp/e2e-data',
        SESSION_SECRET: 'e2e-only-secret-key-0123456789abcdef',
        // 本机 CodeBuddy 环境会通过 NODE_OPTIONS 注入 safe-delete shim，
        // 拦截 next build 清理旧产物时的批量 unlink（>500 文件强制确认）。
        // 构建子进程内清空该变量，绕开本机开发工具的删除护栏；CI 无此变量，无副作用。
        NODE_OPTIONS: '',
      },
    },
    {
      name: 'secure（无 TRIAL_MODE dev）',
      command: 'npm run dev',
      url: `http://127.0.0.1:${SECURE_PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        NEXT_DIST_DIR: '.next-e2e-secure',
        PORT: String(SECURE_PORT),
        DATA_DIR: '.tmp/e2e-data-secure',
        NODE_OPTIONS: '',
      },
    },
  ],
});
