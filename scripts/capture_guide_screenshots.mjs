import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('docs', 'screenshots');
const artifactDir = 'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\57ad767e-edc9-4d42-a53a-8e623b2f9740\\screenshots';
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(artifactDir, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
  });

  const page = await context.newPage();

  async function saveScreenshot(name) {
    const file1 = path.join(outDir, name);
    const file2 = path.join(artifactDir, name);
    await page.screenshot({ path: file1 });
    fs.copyFileSync(file1, file2);
    console.log(`Saved ${name}`);
  }

  // 1. 空间列表页
  console.log('Capturing 01_space_list.png...');
  await page.goto('http://localhost:3000/spaces', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await saveScreenshot('01_space_list.png');

  // 2. 空间详情页
  console.log('Capturing 02_space_detail.png...');
  await page.goto('http://localhost:3000/spaces/1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await saveScreenshot('02_space_detail.png');

  // 3. 导出弹窗/操作
  console.log('Capturing 03_export_dialog.png...');
  try {
    const exportBtn = page.getByRole('button', { name: /导出/ });
    if (await exportBtn.isVisible()) {
      await exportBtn.click();
      await page.waitForTimeout(1000);
      await saveScreenshot('03_export_dialog.png');
      await page.keyboard.press('Escape');
    }
  } catch (e) {
    console.error('Export modal error:', e.message);
  }

  // 4. 在线标注与翻译编辑器
  console.log('Capturing 04_annotation_editor.png...');
  await page.goto('http://localhost:3000/annotate/1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await saveScreenshot('04_annotation_editor.png');

  // 5. 在线 Web 嵌字与去字工作台
  console.log('Capturing 05_web_typeset.png...');
  await page.goto('http://localhost:3000/typeset/1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await saveScreenshot('05_web_typeset.png');

  // 6. AI 接口与模型配置页
  console.log('Capturing 06_ai_config.png...');
  await page.goto('http://localhost:3000/ai', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await saveScreenshot('06_ai_config.png');

  await browser.close();
  console.log('All screenshots captured successfully!');
}

main().catch(console.error);
