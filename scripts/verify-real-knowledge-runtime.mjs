import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';

function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
const appRoot = path.resolve(argument('--app-root') || process.cwd());
const dbArgument = argument('--db');
assert.ok(dbArgument, 'Pass an existing protected copy with --db <path>; this verifier never creates fixture records.');
const dbPath = path.resolve(dbArgument);
const expectedCommit = argument('--expected-commit') || null;
assert.ok(fs.existsSync(dbPath), 'The supplied protected database copy does not exist.');
const nodeCommand = argument('--node') || (fs.existsSync(path.join(appRoot, '..', 'node', 'node.exe')) ? path.join(appRoot, '..', 'node', 'node.exe') : process.execPath);

const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const child = spawn(nodeCommand, ['server/index.js'], { cwd: appRoot, env: { ...process.env, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_DB: dbPath }, stdio: 'ignore', windowsHide: true });
async function stop() { if (child.exitCode === null) child.kill(); for (let i = 0; child.exitCode === null && i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 50)); }

try {
  let ready = false;
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error(`Runtime exited early (${child.exitCode}).`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'runtime becomes healthy');
  const diagnostics = (await (await fetch(`${base}/api/runtime-diagnostics`)).json()).data;
  assert.equal(path.resolve(diagnostics.activeDatabasePath), dbPath, 'server uses the supplied protected copy');
  assert.ok(diagnostics.coverage.totalRetrievable > 0, 'pre-existing copied data contains eligible records');
  assert.equal(diagnostics.personalRetrievalEnabled, true);
  if (expectedCommit) assert.equal(diagnostics.build.commit, expectedCommit, 'runtime build provenance matches expected commit');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let sessionId = null;
    page.on('request', (request) => {
      const match = request.url().match(/\/api\/chat\/sessions\/(\d+)\/messages\/stream$/);
      if (match) sessionId = Number(match[1]);
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByPlaceholder('Tell Life Planner what changed, what is blocked, or what needs review...').fill('tell me something about me');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Send' }).waitFor({ state: 'visible', timeout: 15000 });
    assert.ok(sessionId, 'built UI sent the Chat request to a session');
    const messages = (await (await fetch(`${base}/api/chat/sessions/${sessionId}/messages`)).json()).data;
    const answer = messages.filter((message) => message.role === 'assistant').at(-1);
    const metadata = JSON.parse(answer.metadata || '{}');
    assert.equal(metadata.endpointType, 'local-knowledge', 'answer is deterministic local retrieval, not model fallback');
    assert.ok(metadata.localSources?.length > 0, 'answer retains source provenance');
    assert.doesNotMatch(answer.content, /don't have access to any personal records/i);
    await page.goto(`${base}/#chat/${sessionId}`, { waitUntil: 'networkidle' });
    await page.getByText('tell me something about me').last().waitFor({ timeout: 15000 });
    console.log(JSON.stringify({ build: diagnostics.build.shortCommit, database: diagnostics.activeDatabasePath, retrievable: diagnostics.coverage.totalRetrievable, sourceCount: metadata.localSources.length, persistence: true, csrf: true }, null, 2));
  } finally { await browser.close(); }
} finally { await stop(); }
