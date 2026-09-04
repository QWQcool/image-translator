import { expect, test } from '@playwright/test';

/**
 * 登录墙（跑在 secure project：3200 端口、无 TRIAL_MODE 的 dev server）。
 *
 * 为什么只用 request 断言、不走浏览器登录流程：
 * 1. 生产构建的会话 Cookie 带 Secure 标记，http://localhost 下浏览器不会保存，
 *    浏览器级登录流程对生产 server 天然走不通（README 已注明 dev 模式才有非安全 Cookie）；
 * 2. 登录后的业务能力已由 TRIAL_MODE smoke 套件覆盖，这里只需验证「未登录被拦」：
 *    中间件/服务端布局把受保护页面 307 重定向到 /login，登录页本身可达。
 * 注册/登录接口的完整语义（邀请码、限流、错误码）由 tests/api-regression.mjs 覆盖。
 */
test.describe('登录墙', () => {
  test('未登录访问 /spaces → 307 到 /login；/login 可达', async ({ request }) => {
    const res = await request.get('/spaces', { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()['location']).toMatch(/^\/login(\?|$)/);

    const login = await request.get('/login');
    expect(login.status()).toBe(200);
  });

  test('未登录访问详情页 → 307 到 /login 且带 next 参数', async ({ request }) => {
    const res = await request.get('/spaces/1', { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()['location']).toBe('/login?next=%2Fspaces%2F1');
  });
});
