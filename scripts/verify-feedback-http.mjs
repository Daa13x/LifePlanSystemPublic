import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// HTTP acceptance for continuous user feedback on a disposable LIFE_PLANNER_DB
// (never the user's data): CSRF-gated capture, the review queue with theme
// consolidation proposals, triage transitions, and — critically — that
// capturing feedback creates NO memory candidate (no auto-promotion). Exit 0.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-feedback-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Seed the pre-bridge feedback schema so server startup must migrate a real
// existing database rather than only proving fresh-install creation.
const legacyDb = new DatabaseSync(dbPath);
legacyDb.exec(`
  CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sentiment TEXT NOT NULL CHECK (sentiment IN ('useful','wrong','confusing','broken','unnecessary','incomplete')),
    surface TEXT NOT NULL DEFAULT '',
    work_item TEXT,
    run_id TEXT,
    provider TEXT,
    app_version TEXT,
    note TEXT,
    evidence TEXT,
    sensitive INTEGER NOT NULL DEFAULT 0,
    actionable INTEGER NOT NULL DEFAULT 0,
    theme_key TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','routed','dismissed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
legacyDb.close();

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
async function retryStart(attempts = 6) {
  // The server binds a fixed port, and freePort() has an open->close->rebind
  // window; under a busy CI runner that port can be taken, so the server exits
  // early on EADDRINUSE. Retry on a fresh port before giving up.
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await startServer(await freePort()); }
    catch (error) {
      lastError = error;
      if (!/exited early|not become healthy/i.test(String(error && error.message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function stopServer(child) { if (child.exitCode === null) child.kill(); for (let i = 0; i < 40 && child.exitCode === null; i += 1) await new Promise((r) => setTimeout(r, 50)); }

let base = '';
let token = '';
async function apiAt(baseUrl, csrfToken, route, { method = 'GET', json, csrf = 'valid' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = baseUrl; if (csrf === 'valid') headers['X-LPS-CSRF'] = csrfToken; }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const api = (route, options) => apiAt(base, token, route, options);

console.log('--- feedback HTTP verification ---');
const server = await retryStart();
base = server.base;
let secondServer = null;
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
  const routed = await api(`/api/feedback/${id}`, { method: 'PATCH', json: { status: 'routed' } });
  line(routed.status === 200 && routed.body.data.failure_event_id > 0 && routed.body.data.destination.failureEventId === routed.body.data.failure_event_id, 'actionable feedback routes to an explicit Quality review destination');
  const failureId = routed.body.data.failure_event_id;
  let failureQueue = await api('/api/failures?all=1');
  const routedFailure = failureQueue.body.data.failures.find((failure) => failure.id === failureId);
  line(routedFailure?.category === 'user-correction' && routedFailure.status === 'observed' && routedFailure.source === 'user-feedback', 'routing creates one observed user-correction without auto-confirming it');
  line(routedFailure?.task_ref === 'planner' && routedFailure.run_id === 'r1' && routedFailure.correction === 'The Today tab crashed on load', 'the Quality record retains bounded feedback attribution and correction evidence');
  const replay = await api(`/api/feedback/${id}`, { method: 'PATCH', json: { status: 'routed' } });
  failureQueue = await api('/api/failures?all=1');
  line(replay.body.data.failure_event_id === failureId && failureQueue.body.data.failures.filter((failure) => failure.source === 'user-feedback' && failure.run_id === 'r1').length === 1, 'repeating Route to review is idempotent and creates no duplicate failure');
  const memoryAfterRoute = await api('/api/memory');
  const candidateCountAfterRoute = Array.isArray(memoryAfterRoute.body?.data?.candidates) ? memoryAfterRoute.body.data.candidates.length : (Array.isArray(memoryAfterRoute.body?.data) ? memoryAfterRoute.body.data.length : 0);
  line(candidateCountAfterRoute === 0, 'routing feedback still creates no memory candidate or automatic behaviour change');
  const openAfter = (await api('/api/feedback')).body.data.feedback.some((f) => f.id === id);
  line(!openAfter, 'a routed item leaves the open review queue');

  const useful = await api('/api/feedback', { method: 'POST', json: { sentiment: 'useful', surface: 'chat:reply' } });
  line((await api(`/api/feedback/${useful.body.data.id}`, { method: 'PATCH', json: { status: 'routed' } })).status === 400, 'non-actionable feedback cannot fabricate a Quality failure');

  const concurrent = await api('/api/feedback', { method: 'POST', json: { sentiment: 'wrong', surface: 'chat:reply', runId: 'concurrent-route', note: 'One routed correction' } });
  secondServer = await retryStart();
  const secondToken = (await (await fetch(`${secondServer.base}/api/csrf-token`)).json()).data.token;
  const [firstRoute, secondRoute] = await Promise.all([
    api(`/api/feedback/${concurrent.body.data.id}`, { method: 'PATCH', json: { status: 'routed' } }),
    apiAt(secondServer.base, secondToken, `/api/feedback/${concurrent.body.data.id}`, { method: 'PATCH', json: { status: 'routed' } })
  ]);
  const concurrentFailureId = firstRoute.body?.data?.failure_event_id;
  line(firstRoute.status === 200 && secondRoute.status === 200 && concurrentFailureId > 0 && secondRoute.body.data.failure_event_id === concurrentFailureId, 'two runtimes concurrently route to the same single Quality destination');
  const concurrentFailures = (await api('/api/failures?all=1')).body.data.failures.filter((failure) => failure.source === 'user-feedback' && failure.run_id === 'concurrent-route');
  line(concurrentFailures.length === 1 && concurrentFailures[0].id === concurrentFailureId, 'concurrent routing creates exactly one observed failure with no orphan duplicate');
} finally {
  if (secondServer) await stopServer(secondServer.child);
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll feedback HTTP checks passed.');
process.exit(failures ? 1 : 0);
