import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'scripts', 'fixtures', 'android-local-data-fixture.mjs');
const viewports = [
  { width: 320, height: 720 },
  { width: 360, height: 800 },
  { width: 390, height: 844 }
];

const server = await createServer({
  root,
  logLevel: 'error',
  plugins: [{
    name: 'android-local-data-fixture',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './localData.js' && importer?.replaceAll('\\', '/').endsWith('/src/main.jsx')) return fixture;
      return null;
    }
  }],
  server: { host: '127.0.0.1', port: 0, strictPort: false }
});
await server.listen();
const url = server.resolvedUrls?.local?.[0];
assert.ok(url, 'Vite supplied a local verification URL');

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function assertWithinWidth(locator, width, label) {
  const boxes = await locator.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { tag: node.tagName, className: node.className, x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  assert.ok(boxes.length > 0, `${label} is populated`);
  for (const box of boxes) assert.ok(box.x >= -0.5 && box.x + box.width <= width + 0.5, `${label} stays inside the ${width}px viewport: ${JSON.stringify(box)}`);
}

async function assertNoOverlap(locator, label) {
  const boxes = await locator.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      assert.equal(intersects(boxes[left], boxes[right]), false, `${label} controls ${left + 1} and ${right + 1} do not overlap`);
    }
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const attemptedDesktopRequests = [];
    await page.route('http://127.0.0.1:4177/**', (route) => {
      attemptedDesktopRequests.push(route.request().url());
      return route.abort('connectionrefused');
    });
    await page.addInitScript(() => { window.androidBridge = {}; });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-layout');
    await page.getByText('Your phone-native task', { exact: false }).waitFor();
    await page.waitForTimeout(150);

    assert.equal(await page.evaluate(() => window.Capacitor?.getPlatform?.()), 'android');
    assert.equal(await page.locator('.notice-banner').filter({ hasText: 'Failed to fetch' }).count(), 0, `no global fetch failure is shown at ${viewport.width}px`);
    assert.equal(attemptedDesktopRequests.some((request) => /\/api\/(?:renderer|repo\/files|models\/runtime|chat\/sessions\/[^/]+\/(?:context|context-records|connection|cloud-checks)|chat\/cloud-providers)/.test(request)), false, `Android does not start desktop Chat/renderer probes at ${viewport.width}px`);

    // A fresh zero-PC fixture opens pairing help automatically. Closing it must
    // leave the normal phone-native app usable; pairing can still be reopened.
    const closeSync = page.getByRole('button', { name: 'Close sync panel' });
    if (await closeSync.count()) await closeSync.click();

    const composer = page.locator('.composer');
    const input = composer.locator('textarea');
    await input.fill('/');
    await page.getByRole('listbox', { name: 'Chat commands' }).waitFor();
    assert.equal(await page.getByRole('option').count(), 5, 'slash opens native command discovery');
    await input.fill('/to');
    assert.equal(await page.getByRole('option').count(), 1, 'partial slash command filters discovery');
    await page.getByRole('option').click();
    assert.equal(await input.inputValue(), '/today', 'choosing a command fills the authoritative command text');
    await input.fill('show today');
    const composerBox = await composer.boundingBox();
    assert.ok(composerBox && composerBox.y >= 0 && composerBox.y + composerBox.height <= viewport.height + 0.5, `the whole Chat composer is visible at ${viewport.width}px`);
    assert.equal(await input.isEnabled(), true, 'zero-PC operation does not disable the Chat input');
    await assertWithinWidth(composer.locator('textarea, button'), viewport.width, 'Chat composer controls');
    await assertNoOverlap(composer.locator('textarea, button'), 'Chat composer');
    assert.equal(await page.locator('.cloud-composer').count(), 0, 'server-only cloud controls are hidden on Android v0.1');
    assert.equal(await page.locator('.context-actions button').count(), 0, 'server-only context actions are hidden rather than left dead');
    assert.equal(await page.getByText('On-device Chat', { exact: true }).count(), 0, 'technical mobile help is not permanently shown in the conversation');
    await page.getByRole('button', { name: 'Open actions and attachments' }).click();
    await page.getByText('On-device Chat', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close actions and attachments' }).click();

    const messageActions = page.locator('.message.assistant .message-actions');
    await assertWithinWidth(messageActions.locator('button'), viewport.width, 'message feedback controls');
    await assertNoOverlap(messageActions.locator('button'), 'message feedback');
    await messageActions.getByRole('button', { name: 'Flag a problem with this reply' }).click();
    await assertWithinWidth(messageActions.locator('button, input, select'), viewport.width, 'expanded message feedback controls');
    await assertNoOverlap(messageActions.locator('button, input, select'), 'expanded message feedback');

    await page.locator('.nav-trigger').click();
    await page.getByRole('button', { name: /^Workboard/ }).first().click();
    await page.locator('.nav-subpages').getByRole('button', { name: 'Today', exact: true }).click();
    await page.getByRole('heading', { name: 'Today', exact: true }).waitFor();
    await page.getByText('Test', { exact: true }).waitFor();
    const taskActions = page.locator('.table-list .item-row').filter({ hasText: 'Test' }).locator(':scope > .button-row button');
    assert.equal(await taskActions.count(), 4, 'the populated Today task exposes Done, Pin, Not today, and Edit');
    await assertWithinWidth(taskActions, viewport.width, 'Today task action buttons');
    await assertNoOverlap(taskActions, 'Today task actions');

    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    const addForm = page.locator('.wide-panel .propose-form');
    await addForm.waitFor();
    await assertWithinWidth(addForm.locator('input, select, button'), viewport.width, 'Add Task fields and controls');
    await assertNoOverlap(addForm.locator('.quick-add-row').first().locator('input, select'), 'Add Task compact fields');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, `populated Today has no horizontal page overflow at ${viewport.width}px`);

    if (viewport.width === 390) {
      await page.locator('.nav-trigger').click();
      await page.getByRole('button', { name: /^Workboard/ }).first().click();
      await page.locator('.nav-subpages').getByRole('button', { name: 'Projects', exact: true }).click();
      await page.getByText('Android beta', { exact: true }).waitFor();
      await page.locator('.nav-trigger').click();
      assert.equal(await page.getByPlaceholder('New project name').isEnabled(), true, 'Projects stays usable without a PC');

      for (const name of ['Refresh', 'Pair with my LifePlanSystem PC', 'Configure optional hosted LifePlanSystem server']) assert.equal(await page.getByRole('button', { name }).count(), 1, `${name} is reachable in the phone top bar`);
      assert.equal(await page.getByRole('radiogroup', { name: 'Theme' }).count(), 1, 'theme control is reachable in the phone top bar');
      await page.getByRole('radio', { name: 'Light' }).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'theme control changes the visible theme');

      await page.getByRole('button', { name: 'Pair with my LifePlanSystem PC' }).click();
      await page.getByText('Pairing is optional.', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Close sync panel' }).click();
      await page.getByRole('button', { name: 'Configure optional hosted LifePlanSystem server' }).click();
      await page.getByText('Optional hosted LifePlanSystem services', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Close server panel' }).click();
    }
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log('Populated Android UI verification passed at 320px, 360px, and 390px.');
