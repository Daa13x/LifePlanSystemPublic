import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// HTTP acceptance for continuous user feedback on a disposable LIFE_PLANNER_DB
// (never the user's data): CSRF-gated capture, the review queue with theme
// consolidation proposals, triage transitions, and — critically — that
// capturing feedback creates NO memory candidate (no auto-promotion). Exit 0.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-feedback-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
async function startServer(port) {
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: appRoot,
    env: { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing.json') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  child.stdout.on('data', (c) => output.push(String(c)));
  child.stderr.on('data', (c) => output.push(String(c)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).\n${output.join('')}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become healthy.\n${output.join('')}`);
}
async function stopServer(child) { if (child.exitCode === null) child.kill(); for (let i = 0; i < 40 && child.exitCode === null; i += 1) await new Promise((r) => setTimeout(r, 50)); }

let base = '';
let token = '';
async function api(route, { method = 'GET', json, csrf = 'valid' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; if (csrf === 'valid') headers['X-LPS-CSRF'] = token; }
  const res = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

console.log('--- feedback HTTP verification ---');
const server = await startServer(await freePort());
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  line((await api('/api/feedback', { method: 'POST', json: { sentiment: 'wrong' }, csrf: 'none' })).status === 403, 'capturing feedback without CSRF is rejected (403)');
  line((await api('/api/feedback', { method: 'POST', json: { sentiment: 'meh' } })).status === 400, 'an invalid sentiment is rejected (400)');

  const created = await api('/api/feedback', { method: 'POST', json: { sentiment: 'broken', surface: 'planner', note: 'The Today tab crashed on load', runId: 'r1', provider: 'local', appVersion: '1.0.0' } });
  line(created.status === 200 && created.body.data.id && created.body.data.status === 'open' && created.body.data.actionable === 1, 'a valid feedback item is captured, open, and marked actionable');

  // Capturing feedback must NOT create a memory candidate (no auto-promotion).
  const memory = await api('/api/memory');
  const candidateCount = Array.isArray(memory.body?.data?.candidates) ? memory.body.data.candidates.length : (Array.isArray(memory.body?.data) ? memory.body.data.length : 0);
  line(candidateCount === 0, 'capturing feedback creates no memory candidate (no auto-promotion)');

  // A second, reworded report about the same surface consolidates into one theme.
  await api('/api/feedback', { method: 'POST', json: { sentiment: 'broken', surface: 'planner', note: 'today tab crashed again when loading' } });
  const queue = await api('/api/feedback');
  line(queue.status === 200 && queue.body.data.feedback.length === 2, 'the review queue lists open feedback');
  const theme = queue.body.data.themes.find((t) => t.surface === 'planner' && t.sentiment === 'broken');
  line(theme && theme.count === 2 && theme.proposeConsolidation === true, 'two reports about the same surface consolidate and propose a regression/issue');

  // Sensitive feedback is captured but never proposed for consolidation.
  await api('/api/feedback', { method: 'POST', json: { sentiment: 'wrong', surface: 'chat', note: 'it showed my medication list' } });
  await api('/api/feedback', { method: 'POST', json: { sentiment: 'wrong', surface: 'chat', note: 'showed my medication list again' } });
  const queue2 = await api('/api/feedback');
  const sensitiveTheme = queue2.body.data.themes.find((t) => t.surface === 'chat');
  line(sensitiveTheme && sensitiveTheme.sensitive === true && sensitiveTheme.proposeConsolidation === false, 'a repeated sensitive theme stays local and is never proposed for consolidation');

  // Triage transitions the item and removes it from the open queue.
  const id = created.body.data.id;
  line((await api(`/api/feedback/${id}`, { method: 'PATCH', json: { status: 'nope' } })).status === 400, 'an invalid triage status is rejected');
  line((await api(`/api/feedback/${id}`, { method: 'PATCH', json: { status: 'routed' } })).status === 200, 'feedback can be triaged to routed');
  const openAfter = (await api('/api/feedback')).body.data.feedback.some((f) => f.id === id);
  line(!openAfter, 'a routed item leaves the open review queue');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll feedback HTTP checks passed.');
process.exit(failures ? 1 : 0);
