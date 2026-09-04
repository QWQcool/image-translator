import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * 阶段 18：E2E 冒烟套件（TRIAL_MODE 免登录，跑在 3100 端口的生产构建上）。
 * 用例间通过 describe.serial + 模块级变量串联（前序用例产出的 spaceId/itemId 等），
 * 数据落在 DATA_DIR=.tmp/e2e-data 独立目录，不污染用户数据。
 */

const FIXTURE = path.resolve(__dirname, 'fixtures/sample.png');
// DATA_DIR 跨次运行持久（reuseExistingServer 复用旧服务时不会换库），
// 空间/标签名带上运行标识，保证断言只命中本次创建的资源。
// 注意标签全局截断 12 字（MAX_TAG_LENGTH），后缀必须足够短
const RUN_ID = Date.now();
const RUN_TAG = Date.now().toString(36).slice(-4);
const SPACE_NAME = `E2E 冒烟空间 ${RUN_ID}`;
const TAG_A = `E2E标签甲${RUN_TAG}`;
const TAG_B = `E2E标签乙${RUN_TAG}`;
const TRANSLATION_TEXT = 'E2E 译文第一格';
const TYPESET_TEXT = '嵌字冒烟文本';

let spaceId = 0;
let spaceNo = '';
let itemId = 0;

/** 从当前 URL 里按正则抓取数字 id（/spaces/1、/annotate/2、/typeset/3） */
function idFromUrl(page: Page, pattern: RegExp): number {
  const match = page.url().match(pattern);
  if (!match) throw new Error(`URL 未命中预期模式 ${pattern}：${page.url()}`);
  return Number(match[1]);
}

test.describe.serial('E2E 冒烟', () => {
  test('核心链路：建空间 → 上传 → 标注打点 → 译文 → Ctrl+S 保存', async ({ page }) => {
    // ---- 列表页：新建空间（名称 + 自定义标签） ----
    await page.goto('/spaces');
    await page.getByRole('button', { name: '新建空间' }).click();
    await page.locator('#space-name').fill(SPACE_NAME);
    // TagPicker：用自定义输入加标签，不依赖预设候选的具体内容
    await page.getByPlaceholder(/自定义标签，回车添加/).fill(TAG_A);
    await page.getByPlaceholder(/自定义标签，回车添加/).press('Enter');
    await page.getByRole('button', { name: '保存', exact: true }).click();

    // 卡片出现且序号格式为 YYYYMMDD-NN
    const card = page.locator('.space-card', { hasText: SPACE_NAME });
    await expect(card).toBeVisible();
    const noBadge = card.locator('span.font-mono');
    await expect(noBadge).toHaveText(/^\d{8}-\d{2}$/);
    spaceNo = (await noBadge.textContent()) ?? '';

    // ---- 进详情页并上传 fixture 图 ----
    await card.locator('a', { hasText: SPACE_NAME }).click();
    await expect(page).toHaveURL(/\/spaces\/\d+$/);
    spaceId = idFromUrl(page, /\/spaces\/(\d+)$/);

    // 上传按钮只是触发隐藏 file input，直接对 input 置文件避免打开原生对话框
    // （页面上还有一个 LabelPlus txt 导入的 file input，须用 accept 精确匹配）
    await page.locator('input[type="file"][accept="image/*,.zip"]').setInputFiles(FIXTURE);
    const itemTitle = page.getByRole('button', { name: 'sample', exact: true });
    await expect(itemTitle).toBeVisible({ timeout: 30_000 });

    // ---- 进标注编辑器：标号模式点画布放 pin，弹卡输译文，Ctrl+S 保存 ----
    await page.getByRole('link', { name: '标注', exact: true }).click();
    await expect(page).toHaveURL(/\/annotate\/\d+$/);
    itemId = idFromUrl(page, /\/annotate\/(\d+)$/);

    // 模式按钮可达名含快捷键提示（如「标号W」），用前缀匹配
    await page.getByRole('button', { name: /^标号/ }).click();
    await page.locator('canvas').first().click();
    // 落 pin 后右侧面板弹出，选中标号直接输入译文
    const translation = page.locator('textarea[data-role="translation"]');
    await expect(translation).toBeVisible();
    await translation.fill(TRANSLATION_TEXT);

    await page.keyboard.press('Control+s');
    await expect(page.getByText(/已保存/)).toBeVisible();
    // 无 error 提示且 dirty 清零（不再显示「有未保存的更改」）
    await expect(page.locator('.notice-error')).toHaveCount(0);
    await expect(page.getByText('有未保存的更改')).toHaveCount(0);
  });

  test('空间管理：搜索序号 / 标签筛选 / 进度切换', async ({ page }) => {
    expect(spaceId).toBeGreaterThan(0);

    // ---- 搜索序号命中 ----
    await page.goto('/spaces');
    await page.getByPlaceholder('搜索空间名称 / 描述 / 序号…').fill(spaceNo);
    const card = page.locator('.space-card', { hasText: SPACE_NAME });
    await expect(card).toBeVisible();
    await expect(card.locator('span.font-mono')).toHaveText(spaceNo);
    await page.getByPlaceholder('搜索空间名称 / 描述 / 序号…').fill('');

    // ---- 标签筛选：列表筛选 TAG_A 命中 ----
    await page.getByRole('button', { name: /^筛选/ }).click();
    await page.getByRole('button', { name: TAG_A, exact: true }).click();
    await expect(card).toBeVisible();

    // ---- 详情页改标签（加 TAG_B）→ 列表按 TAG_B 筛选命中 ----
    await page.goto(`/spaces/${spaceId}`);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByPlaceholder(/自定义标签，回车添加/).fill(TAG_B);
    await page.getByPlaceholder(/自定义标签，回车添加/).press('Enter');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('span', { hasText: TAG_B })).toBeVisible();

    await page.goto('/spaces');
    await page.getByRole('button', { name: /^筛选/ }).click();
    await page.getByRole('button', { name: TAG_B, exact: true }).click();
    await expect(page.locator('.space-card', { hasText: SPACE_NAME })).toBeVisible();

    // ---- 进度切换：详情页菜单切「已翻译」→ 徽标变化 + 「已维持」出现 ----
    await page.goto(`/spaces/${spaceId}`);
    await page.locator('button[title="点击切换进度"]').click();
    await page.getByRole('button', { name: '已翻译', exact: true }).click();
    await expect(page.getByText('已翻译', { exact: true })).toBeVisible();
    await expect(page.getByText(/已维持/)).toBeVisible();
  });

  test('嵌字冒烟：加文字层 → 调描边 → 导出 PNG → 保存成品 → 成品视图', async ({ page }) => {
    expect(itemId).toBeGreaterThan(0);
    await page.goto(`/typeset/${itemId}`);

    // 等底图加载完成（导出与文字层定位都依赖它）；
    // 限定 main 内，避免命中顶栏的头像/通知图标
    const canvas = page.locator('main img').first();
    await expect(canvas).toBeVisible();

    // ---- 加文字层：切文字工具，点画布落层 ----
    // 嵌字画布的 img 是 pointer-events-none，事件由 wrapper div 承接
    await page.getByRole('button', { name: '文字', exact: true }).click();
    await page.locator('div.absolute.left-0.top-0').first().click();
    const layerText = page.locator('textarea').first();
    await expect(layerText).toBeVisible();
    await layerText.fill(TYPESET_TEXT);

    // ---- 调描边：启用描边（新层默认关）→ 改描边色 ----
    const strokeToggle = page.locator('button[title="描边已关闭"]');
    if (await strokeToggle.count()) {
      await strokeToggle.click();
    }
    const strokeColor = page.locator('input[type="color"][title="描边颜色"]');
    await expect(strokeColor).toBeVisible();
    await strokeColor.fill('#FF0000');

    // ---- 导出 PNG：断言 download 事件与文件名 ----
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/-嵌字\.png$/);

    // ---- 保存成品 ----
    await page.getByRole('button', { name: '保存成品', exact: true }).click();
    await expect(page.getByText(/已保存，本图共 \d+ 个成品版本/)).toBeVisible();

    // ---- 空间「成品」视图出现条目 ----
    await page.goto(`/spaces/${spaceId}`);
    await page.getByRole('button', { name: '成品', exact: true }).click();
    const outputCard = page.locator('.card', { hasText: 'sample' });
    await expect(outputCard).toBeVisible();
    await expect(outputCard.getByRole('link', { name: '下载' })).toBeVisible();
  });

  test('设置面板：进度项改名联动徽标 + 预设标签增删联动候选', async ({ page }) => {
    const progressInput = page
      .locator('div.flex.items-center.gap-3')
      .filter({ has: page.locator('span.font-mono:text-is("translated")') })
      .locator('input')
      .first();
    const progressSave = () =>
      page
        .locator('section', { hasText: '进度项管理' })
        .getByRole('button', { name: '保存', exact: true });

    // ---- 改「translated」显示名保存 → 列表徽标显示新名 ----
    await page.goto('/settings');
    await progressInput.fill('翻译完成E2E');
    await progressSave().click();
    await expect(page.getByText('进度项设置已保存')).toBeVisible();

    await page.goto('/spaces');
    await expect(page.locator('.space-card', { hasText: SPACE_NAME }).getByText('翻译完成E2E')).toBeVisible();

    // ---- 恢复默认名 ----
    await page.goto('/settings');
    await progressInput.fill('已翻译');
    await progressSave().click();
    await expect(page.getByText('进度项设置已保存')).toBeVisible();

    // ---- 预设标签：加一个 → 新建空间弹窗候选出现 ----
    const tagsInput = page.getByPlaceholder(/自定义标签，回车添加/);
    const tagsSave = () =>
      page
        .locator('section', { hasText: '默认标签管理' })
        .getByRole('button', { name: '保存', exact: true });

    await tagsInput.fill('E2E预设标签');
    await tagsInput.press('Enter');
    await tagsSave().click();
    await expect(page.getByText('默认标签已保存')).toBeVisible();

    await page.goto('/spaces');
    await page.getByRole('button', { name: '新建空间' }).click();
    await expect(
      page.getByRole('button', { name: 'E2E预设标签', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();

    // ---- 删除该标签 → 候选消失（恢复默认） ----
    await page.goto('/settings');
    await page.getByRole('button', { name: 'E2E预设标签 ×' }).click();
    await tagsSave().click();
    await expect(page.getByText('默认标签已保存')).toBeVisible();

    await page.goto('/spaces');
    await page.getByRole('button', { name: '新建空间' }).click();
    await expect(page.getByRole('button', { name: 'E2E预设标签', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
  });

  test('页面切换稳定性：列表↔详情↔标注↔嵌字↔阅读 往返 ×2 无未捕获异常', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    const readerUrl = new RegExp(`/spaces/${spaceId}/reader$`);
    for (let round = 1; round <= 2; round++) {
      await page.goto('/spaces');
      await expect(page.locator('.space-card').first()).toBeVisible();
      await page.goto(`/spaces/${spaceId}`);
      await expect(page.getByRole('button', { name: '图片', exact: true })).toBeVisible();
      await page.goto(`/annotate/${itemId}`);
      await expect(page.getByRole('button', { name: '框选', exact: true })).toBeVisible();
      await page.goto(`/typeset/${itemId}`);
      await expect(page.getByRole('button', { name: '导出 PNG', exact: true })).toBeVisible();
      await page.goto(`/spaces/${spaceId}/reader`);
      await expect(page).toHaveURL(readerUrl);
    }

    // 后退键回到正确页：阅读 → 嵌字
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/typeset/${itemId}$`));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/annotate/${itemId}$`));

    // 断言无未捕获异常；console error 只容忍资源加载噪声（favicon 404、网络中断等）
    const realErrors = consoleErrors.filter(
      (text) => !/Failed to load resource|net::|ERR_ABORTED|ERR_CONNECTION/i.test(text),
    );
    expect(pageErrors, `未捕获异常：${pageErrors.join('\n')}`).toHaveLength(0);
    expect(realErrors, `console error：${realErrors.join('\n')}`).toHaveLength(0);
  });
});
