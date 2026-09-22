import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional UI check: use an existing Playwright installation; not a runtime dependency.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const sdk = await readFile(new URL('./mock-sdk.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const page = await browser.newPage({ viewport: { width: 410, height: 950 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir('artifacts', { recursive: true });
try {
  await page.goto('http://127.0.0.1:5173/');
  await page.getByText('等待在飞书中打开', { exact: true }).waitFor();
  assert.equal(await page.locator('#start').isDisabled(), true);

  await page.route('**/@lark-base-open_js-sdk.js*', route => route.fulfill({ contentType: 'text/javascript', body: sdk }));
  await page.route('**/__test_host__', route => route.fulfill({ contentType: 'text/html', body: '<iframe src="/" style="position:fixed;inset:0;width:100%;height:100%;border:0" allow="clipboard-write"></iframe>' }));
  await page.goto('http://127.0.0.1:5173/__test_host__');
  const frame = page.frameLocator('iframe');
  await frame.getByText('已连接多维表格', { exact: true }).waitFor();
  const app = page.frames().find(frame => frame !== page.mainFrame());
  const clickStart = async () => {
    await frame.locator('#start').click();
    await frame.locator('#cancel').waitFor({ state: 'hidden' });
  };
  await clickStart();
  assert.match(await frame.locator('#result-summary').innerText(), /成功 3 条 \/ 失败 0 条 \/ 共 3 条/);
  await app.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value) { window.__host.clipboard = value; } } });
  });
  await frame.locator('#copy').click();
  assert.equal((await app.evaluate(() => window.__host.clipboard)).split('\n').length, 3);

  await app.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() { throw new Error('denied'); } } });
  });
  await frame.locator('#copy').click();
  await frame.locator('#manual-copy').waitFor({ state: 'visible' });
  assert.equal((await frame.locator('#copy-text').inputValue()).split('\n').length, 3);

  await frame.locator('#scope').selectOption('view');
  await clickStart();
  assert.match(await frame.locator('#result-summary').innerText(), /成功 257 条/);
  assert.equal(await frame.locator('#rows tr').count(), 100);
  const downloadEvent = page.waitForEvent('download');
  await frame.locator('#download').click();
  const download = await downloadEvent;
  await download.saveAs(resolve('artifacts/mock-links.csv'));
  const csv = await readFile('artifacts/mock-links.csv', 'utf8');
  assert.equal(csv.split('\r\n').length, 258);
  assert.ok(csv.includes('rec257'));
  assert.ok(!csv.includes('rec258'));

  await frame.locator('#scope').selectOption('table');
  await clickStart();
  assert.match(await frame.locator('#result-summary').innerText(), /成功 451 条/);
  assert.deepEqual((await app.evaluate(() => window.__host.pageCalls)).slice(-3).map(call => call.pageToken), [undefined, 200, 400]);

  await frame.locator('#scope').selectOption('view');
  await app.evaluate(() => { window.__host.changeSettingsOnPage = true; });
  await clickStart();
  assert.match(await frame.locator('#status').innerText(), /视图筛选或排序发生变化/);
  assert.equal(await frame.locator('#copy').isDisabled(), true);
  await app.evaluate(() => { window.__host.changeSettingsOnPage = false; });

  await frame.locator('#scope').selectOption('selected');
  await app.evaluate(() => { window.__host.selected = []; });
  await clickStart();
  assert.match(await frame.locator('#status').innerText(), /没有记录/);
  assert.equal(await frame.locator('#copy').isDisabled(), true);

  await app.evaluate(() => { window.__host.grid = false; });
  await clickStart();
  assert.match(await frame.locator('#status').innerText(), /仅支持表格视图/);

  await app.evaluate(() => { window.__host.grid = true; window.__host.selected = ['rec001', 'rec002', 'rec003']; window.__host.fail = ['rec002']; });
  await clickStart();
  assert.match(await frame.locator('#result-summary').innerText(), /成功 2 条 \/ 失败 1 条/);

  await app.evaluate(() => { window.__host.fail = []; });
  await clickStart();
  await page.screenshot({ path: 'artifacts/sidebar-light.png', fullPage: true, animations: 'disabled' });
  await app.evaluate(() => window.__host.emit('theme', { theme: 'DARK' }));
  await page.screenshot({ path: 'artifacts/sidebar-dark.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 360, height: 950 });
  assert.equal(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await app.evaluate(() => window.__host.emit('theme', { theme: 'LIGHT' }));
  await page.screenshot({ path: 'artifacts/sidebar-360.png', fullPage: true, animations: 'disabled' });

  await app.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText() {
      return new Promise((resolve, reject) => { window.__rejectCopy = reject; });
    } } });
  });
  await frame.locator('#copy').click();
  await app.evaluate(() => {
    window.__host.selected = ['rec010'];
    window.__host.emit('selection', window.__host.selection);
    window.__rejectCopy(new Error('delayed failure'));
  });
  assert.equal(await frame.locator('#manual-copy').isVisible(), false);
  assert.match(await frame.locator('#status').innerText(), /选中范围已变化/);

  await app.evaluate(() => { window.__host.delay = 50; });
  await frame.locator('#start').click();
  await app.evaluate(() => {
    window.__host.selected = ['rec011'];
    window.__host.emit('selection', window.__host.selection);
  });
  await frame.locator('#cancel').waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#results').isVisible(), false);
  assert.equal(await frame.locator('#copy').isDisabled(), true);
  await app.evaluate(() => { window.__host.delay = 0; });
  await clickStart();

  await app.evaluate(() => window.__host.emit('modify', { recordId: 'rec001', fieldIds: [] }));
  assert.equal(await frame.locator('#results').isVisible(), false);
  assert.equal(await frame.locator('#copy').isDisabled(), true);

  await frame.locator('#scope').selectOption('table');
  await app.evaluate(() => { window.__host.delay = 50; });
  await frame.locator('#start').click();
  await frame.locator('#status').filter({ hasText: '正在提取链接' }).waitFor();
  await frame.locator('#cancel').click();
  await frame.locator('#cancel').waitFor({ state: 'hidden' });
  assert.match(await frame.locator('#status').innerText(), /已停止/);
  assert.ok((await app.evaluate(() => window.__host.calls.length)) < 1000);

  await frame.locator('#start').click();
  await app.evaluate(() => {
    window.__host.selection = { ...window.__host.selection, tableId: 'tblOther' };
    window.__host.emit('selection', window.__host.selection);
  });
  await frame.locator('#cancel').waitFor({ state: 'hidden' });
  await frame.locator('#context').filter({ hasText: '模拟数据' }).waitFor();
  assert.equal(await frame.locator('#results').isVisible(), false);
  assert.equal(await frame.locator('#copy').isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: selected/view/table, 451 records, CSV, copy/fallback, empty/unsupported/error/cancel/switch, 360px and dark theme. Host is simulated; real Feishu acceptance remains pending.');
} finally {
  await browser.close();
}
