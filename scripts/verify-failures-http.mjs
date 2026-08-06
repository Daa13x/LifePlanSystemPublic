import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// HTTP acceptance for the failure-taxonomy routes on a disposable
// LIFE_PLANNER_DB (never the user's data): CSRF-gated recording, the review
// queue with confirmation-gated proposals, triage, and before/after evaluation.
// Recording a failure must change NO prompt/rule/memory. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-failures-'));
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

console.log('--- failures HTTP verification ---');
const server = await startServer(await freePort());
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  line((await api('/api/failures', { method: 'POST', json: { category: 'repeated-question' }, csrf: 'none' })).status === 403, 'recording a failure without CSRF is rejected (403)');
  line((await api('/api/failures', { method: 'POST', json: { category: 'not-real' } })).status === 400, 'an invalid failure category is rejected (400)');

  const created = await api('/api/failures', { method: 'POST', json: { category: 'wrong-question-type', source: 'loop-guard', taskRef: 'w1', runId: 'r1', evidence: 'asked completion during execution' } });
  line(created.status === 200 && created.body.data.id && created.body.data.status === 'observed', 'a failure is recorded as observed');
  const id = created.body.data.id;

  // Recording a failure must not create a memory candidate.
  const memory = await api('/api/memory');
  const candidateCount = Array.isArray(memory.body?.data?.candidates) ? memory.body.data.candidates.length : (Array.isArray(memory.body?.data) ? memory.body.data.length : 0);
  line(candidateCount === 0, 'recording a failure changes no memory (no auto-promotion)');

  // Observed failures propose nothing; confirming one proposes a reviewed candidate.
  let queue = await api('/api/failures');
  line(queue.body.data.failures.length === 1 && queue.body.data.proposals.length === 0, 'an observed failure yields no remediation proposal');
  line((await api(`/api/failures/${id}`, { method: 'PATCH', json: { status: 'nope' } })).status === 400, 'an invalid failure status is rejected');
  const confirmed = await api(`/api/failures/${id}`, { method: 'PATCH', json: { status: 'confirmed' } });
  line(confirmed.status === 200 && confirmed.body.data.remediation.propose === true && confirmed.body.data.remediation.kind === 'regression-test', 'confirming a mechanical failure proposes a regression test for review');
  queue = await api('/api/failures');
  line(queue.body.data.proposals.some((p) => p.id === id && p.requiresReview === true), 'the review queue lists the confirmed failure as a reviewed proposal');
  line(queue.body.data.categoryCounts['wrong-question-type'] === 1, 'failures are summarised by category');

  // Before/after evaluation is required to claim improvement.
  const good = await api('/api/failures/evaluate', { method: 'POST', json: { target: 'repeated-question', before: { 'repeated-question': 4 }, after: { 'repeated-question': 1 } } });
  line(good.body.data.improved === true, 'a before/after drop in the target class evaluates as improved');
  const traded = await api('/api/failures/evaluate', { method: 'POST', json: { target: 'repeated-question', before: { 'repeated-question': 4 }, after: { 'repeated-question': 1, 'missing-attachment': 3 } } });
  line(traded.body.data.improved === false, 'trading one failure class for another does not count as improvement');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll failures HTTP checks passed.');
process.exit(failures ? 1 : 0);
