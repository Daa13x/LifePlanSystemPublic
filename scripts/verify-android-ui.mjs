import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const viewport = { width: 390, height: 844 };
const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false }
});
await server.listen();
const url = server.resolvedUrls?.local?.[0];
assert.ok(url, 'Vite supplied a local verification URL');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport });
  // Capacitor's own platform detector uses androidBridge presence. No plugin
  // methods are faked: native DB errors are allowed to surface while proving
  // that an error state cannot remove or push the composer off-screen.
  await page.addInitScript(() => { window.androidBridge = {}; });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chat-layout');
  await page.waitForTimeout(250);

  assert.equal(await page.evaluate(() => window.Capacitor?.getPlatform?.()), 'android');
  const composer = page.locator('.composer');
  const input = composer.locator('textarea');
  await assert.doesNotReject(() => input.fill('show today'));
  const composerBox = await composer.boundingBox();
  const inputBox = await input.boundingBox();
  assert.ok(composerBox && composerBox.y >= 0 && composerBox.y + composerBox.height <= viewport.height, 'the whole Chat composer is visible at an Android viewport');
  assert.ok(inputBox && inputBox.y >= 0 && inputBox.y + inputBox.height <= viewport.height, 'the editable Chat input is visible at an Android viewport');
  assert.equal(await input.isEnabled(), true, 'database/backend errors do not disable the Chat input');
  assert.equal(await page.locator('.cloud-composer').count(), 0, 'server-only cloud controls are hidden on Android v0.1');
  assert.equal(await page.locator('.context-actions button').count(), 0, 'server-only context actions are hidden rather than left dead');
  await page.getByText('On-device Chat', { exact: true }).waitFor();

  for (const name of ['Refresh', 'Pair with my LifePlanSystem PC', 'Configure optional hosted LifePlanSystem server']) {
    assert.equal(await page.getByRole('button', { name }).count(), 1, `${name} is reachable in the phone top bar`);
  }
  assert.equal(await page.getByRole('radiogroup', { name: 'Theme' }).count(), 1, 'theme control is reachable in the phone top bar');
  await page.getByRole('radio', { name: 'Light' }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'theme control changes and persists the visible theme');

  await page.getByRole('button', { name: 'Pair with my LifePlanSystem PC' }).click();
  await page.getByText('Pairing is optional.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Close sync panel' }).click();
  assert.equal(await page.getByRole('button', { name: 'Close sync panel' }).count(), 0, 'pairing panel opens and closes');

  await page.getByRole('button', { name: 'Configure optional hosted LifePlanSystem server' }).click();
  await page.getByText('Optional hosted LifePlanSystem services', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close server panel' }).click();
  assert.equal(await page.getByRole('button', { name: 'Close server panel' }).count(), 0, 'optional hosted-server panel opens and closes');

  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.locator('.notice-banner').waitFor();
  assert.ok((await composer.boundingBox()).y + (await composer.boundingBox()).height <= viewport.height, 'a visible error/status notice does not remove the composer');
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  assert.equal(await page.locator('.notice-banner').count(), 0, 'error/status notice can be dismissed');

  await page.locator('.nav-trigger').click();
  await page.getByRole('button', { name: /^Workboard/ }).first().click();
  await page.waitForSelector('.nav-subpages');
  for (const name of ['Today', 'Projects', 'Cards', 'Completed']) {
    const tab = page.locator('.nav-subpages').getByRole('button', { name, exact: true });
    assert.equal(await tab.count(), 1, `${name} Workboard tab is visible on Android`);
    await tab.click();
    assert.match(page.url(), new RegExp(`#workboard/${name.toLowerCase()}`), `${name} tab changes the active route`);
  }
} finally {
  await browser.close();
  await server.close();
}

console.log('Android viewport and visible-control verification passed.');
