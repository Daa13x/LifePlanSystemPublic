import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SECTION_TABS } from '../src/navigation.js';
import { runWithFinalizers, stopInstalledChatServer, removeInstalledChatFixture } from './installed-chat-lifecycle.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-module-recovery-'));
const screenshots = process.argv.includes('--screenshots') ? path.join(root, '.cache', 'module-recovery-evidence') : null;
if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
let child, browser, vite;
await runWithFinalizers(async () => {
  const port = await freePort();
  fs.mkdirSync(path.join(fixture, 'private'));
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_DB: path.join(fixture, 'life-planner.sqlite'),
    LIFE_PLANNER_PRIVATE_REPO: path.join(fixture, 'private'), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(fixture, 'connector.json')
  } });
  child.stdout.resume(); child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, 'disposable backend ready');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const waitUsable = () => page.waitForFunction(() => {
    if (document.querySelector('.module-recovery')) return true;
    const text = document.querySelector('.module-content')?.innerText.trim();
    return text && !/^(loading|checking)(?:\s|…|\.)/i.test(text);
  }, null, { timeout: 20000 });
  // Deterministic populated Overview fixture exercises the callback wiring that
  // empty-only tests missed. No personal data or model invocation is involved.
  let broken = false;
  await page.route('**/api/bootstrap', async (r) => {
    const response = await r.fetch(); const json = await response.json();
    json.data.planner.focus = broken ? null : [{ id: 100, title: 'Fixture item', status: 'active', type: 'task' }];
    await r.fulfill({ response, json });
  });
  await page.goto(`${base}/#workboard`);
  await page.getByRole('heading', { name: 'Best Next Action' }).waitFor();
  assert.equal(await page.locator('.module-recovery').count(), 0);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'overview.png'), fullPage: true });
  for (const [section, tabs] of Object.entries(SECTION_TABS)) {
    for (const tab of tabs) {
      await page.goto(`${base}/#${section}/${tab.id}`);
      await waitUsable();
      assert.equal(await page.getByRole('navigation', { name: 'Main navigation' }).count(), 1);
      assert.ok((await page.locator('.module-content').innerText()).trim(), `${section}/${tab.id} not blank`);
      assert.equal(await page.locator('.module-recovery').count(), 0, `${section}/${tab.id} rendered`);
    }
  }
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    for (const route of ['workboard/projects', 'workboard/review', 'system/feedback']) {
      await page.goto(`${base}/#${route}`);
      await waitUsable();
      const buttons = page.locator('.navigation-menu button');
      for (let i = 0; i < await buttons.count(); i++) {
        const rect = await buttons.nth(i).boundingBox();
        assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width + 1, `${route} menu fits ${width}`);
      }
      if (route === 'system/feedback') {
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `feedback-${width}.png`), fullPage: true });
        await page.getByRole('button', { name: 'Quality', exact: true }).click();
      }
    }
  }
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto(`${base}/#system/feedback`);
  broken = true;
  await page.reload();
  await page.getByRole('button', { name: 'Workboard', exact: true }).click();
  await page.getByRole('alert', { name: 'Module recovery' }).waitFor();
  const report = JSON.parse(await page.locator('.module-recovery textarea').inputValue());
  assert.equal(report.code, 'MODULE_RENDER_FAILED');
  assert.equal(report.attemptedLocation, 'Workboard → Overview');
  assert.equal(report.previousLocation, 'System → Feedback');
  assert.ok(report.correlationId && report.timestamp && report.frontendBuildId && report.backendBuildId);
  assert.match(report.frontendBuildId, /^index-[\w-]+\.js$/);
  assert.match(report.backendBuildId, /^[a-f0-9]{40}$/);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'render-recovery.png'), fullPage: true });
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  assert.equal(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).correlationId, report.correlationId);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  assert.equal(new URL(page.url()).hash, '#system/feedback');
  await page.getByRole('button', { name: 'Workboard', exact: true }).click();
  await page.getByRole('alert', { name: 'Module recovery' }).waitFor();
  broken = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('heading', { name: 'Best Next Action' }).waitFor();
  for (const location of ['#bogus/private-secret?token=private-secret', '#%E0%A4%A', '/unrecognised?token=private-secret']) {
    await page.goto(`${base}/${location.startsWith('/') ? location.slice(1) : location}`);
    await page.getByRole('heading', { name: 'Page not found' }).waitFor();
    const text = await page.locator('.module-recovery textarea').inputValue();
    assert.equal(JSON.parse(text).code, 'UNKNOWN_ROUTE');
    assert.ok(!text.includes('private-secret'));
    await page.getByRole('button', { name: 'Home / Chat' }).click();
    await page.locator('.chat-layout').waitFor();
  }
  // Test-only harness imports the actual boundary. No production fault route.
  vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'module-recovery-test', configureServer(server) {
    server.middlewares.use('/recovery-test', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/recovery-test', '<div id="root"></div><script type="module" src="/recovery-fixture.jsx"></script>'));
    });
  }, resolveId(id) { if (id === '/recovery-fixture.jsx') return '\0recovery-fixture.jsx'; }, load(id) {
    if (id !== '\0recovery-fixture.jsx') return;
    return `import React from 'react'; import {createRoot} from 'react-dom/client'; import Recovery from '/src/ModuleRecovery.jsx';
      const mode = new URLSearchParams(location.search).get('mode');
      function Content(){if(mode==='throw')throw Error('private-secret');if(mode==='suspend')throw new Promise(()=>{});return mode==='loading'?React.createElement('div',null,'Loading module...'):null;}
      createRoot(document.getElementById('root')).render(React.createElement(Recovery,{route:{section:'workboard',tab:'overview'},previousRoute:{section:'chat'},backendBuild:'a'.repeat(40),timeoutMs:600},React.createElement(Content)));`;
  } }] });
  await vite.listen();
  const testBase = `http://127.0.0.1:${vite.httpServer.address().port}`;
  for (const mode of ['empty', 'loading', 'suspend', 'throw']) {
    await page.goto(`${testBase}/recovery-test?mode=${mode}`);
    await page.locator('.module-recovery textarea').waitFor();
    const text = await page.locator('.module-recovery textarea').inputValue();
    assert.equal(JSON.parse(text).code, mode === 'throw' ? 'MODULE_RENDER_FAILED' : 'MODULE_LOAD_TIMEOUT');
    assert.ok(!text.includes('private-secret'));
  }
  console.log('Module recovery: populated Overview, all canonical routes, responsive navigation, render error/retry, safe clipboard, unknown routes, empty/loading/suspended watchdog passed.');
}, [
  { name: 'browser cleanup', run: async () => browser?.close() },
  { name: 'test harness cleanup', run: async () => vite?.close() },
  { name: 'server cleanup', run: () => stopInstalledChatServer(child) },
  { name: 'fixture cleanup', run: () => removeInstalledChatFixture(fixture) }
]);
