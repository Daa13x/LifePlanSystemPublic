import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-chat-command-ui-'));
const dbPath = path.join(probe, 'chat.sqlite');
const screenshots = {
  default: path.join(probe, 'chat-default.png'),
  command: path.join(probe, 'chat-command-picker.png')
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const port = await freePort();
const syncPort = await freePort();
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_SYNC_PORT: String(syncPort), LIFE_PLANNER_DB: dbPath },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Chat UI server exited early (${child.exitCode}).\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch { /* bounded startup wait */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chat UI server did not become healthy.\n${output}`);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(`http://127.0.0.1:${port}/#chat`, { waitUntil: 'domcontentloaded' });
  await page.locator('.chat-layout').waitFor();
  await page.locator('.composer textarea').waitFor();

  assert.equal(await page.locator('.connection-bar').count(), 0, 'the permanent technical dashboard is absent');
  assert.equal(await page.getByRole('button', { name: 'Open actions and attachments' }).count(), 1, 'one minimal attachment/action entry is visible');
  assert.equal(await page.getByText('Attach Knowledge', { exact: true }).count(), 0, 'context tools are not permanently visible');
  assert.ok(await page.getByRole('heading', { name: /planning chat|chat/i }).first().isVisible(), 'the compact conversation title is visible');
  await page.locator('.chat-rename').waitFor();
  assert.equal(await page.getByRole('button', { name: /^Rename / }).count(), 1, 'the title pencil exposes rename');
  await page.getByRole('button', { name: 'Hide conversations' }).click();
  assert.equal(await page.locator('.chat-sidebar').isVisible(), false, 'conversation sidebar collapses');
  await page.getByRole('button', { name: 'Show conversations' }).click();
  assert.equal(await page.locator('.chat-sidebar').isVisible(), true, 'conversation sidebar expands');
  page.once('dialog', (dialog) => dialog.accept('Command plane proof'));
  await page.locator('.chat-rename').click();
  await page.getByRole('heading', { name: 'Command plane proof', exact: true }).waitFor();
  await page.screenshot({ path: screenshots.default });

  const input = page.locator('.composer textarea');
  await input.fill('/st');
  const picker = page.getByRole('listbox', { name: 'Chat commands' });
  await picker.waitFor();
  assert.equal(await picker.getByRole('option').count(), 1, 'partial command text filters the picker');
  assert.match(await picker.getByRole('option').innerText(), /\/status[\s\S]*System status/, 'the filtered result is the registered status command');
  await page.screenshot({ path: screenshots.command });
  await picker.getByRole('option').click();
  assert.equal(await input.inputValue(), '/status', 'selecting the result fills the explicit command');
  await page.getByRole('button', { name: /Send/ }).click();
  await page.getByRole('heading', { name: 'System status', exact: true }).waitFor();

  await input.fill('/add-task Rendered approval proof');
  await page.getByRole('button', { name: /Send/ }).click();
  await page.getByRole('button', { name: 'Allow', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Decline', exact: true }).count(), 1, 'a consequential command renders the existing Allow/Decline gate');
  await page.getByRole('button', { name: 'Decline', exact: true }).click();

  await page.getByText('Attach Knowledge', { exact: true }).waitFor();
  assert.equal(await page.getByText('Upload text file', { exact: true }).count(), 1, 'desktop file upload is contextual under the paperclip');
  assert.equal(await page.getByText('Diagnostics', { exact: true }).count(), 1, 'diagnostics remains callable without a permanent status card');

  await page.goto(`http://127.0.0.1:${port}/#settings`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Commands', exact: true }).waitFor();
  await page.locator('.command-setting-row code').filter({ hasText: '/status' }).waitFor();
  assert.equal(await page.locator('.command-setting-row code').filter({ hasText: '/status' }).count(), 1, 'Settings lists built-in commands');
  assert.equal(await page.getByText('Custom shortcuts', { exact: true }).count(), 1, 'Settings exposes the constrained custom-command foundation');

  await page.goto(`http://127.0.0.1:${port}/#chat`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('heading', { name: 'New planning chat', exact: true }).waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await page.getByRole('heading', { name: 'Command plane proof', exact: true }).waitFor();

  console.log(`Rendered Chat command UI verification passed. Evidence: ${screenshots.default}; ${screenshots.command}`);
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill();
}
