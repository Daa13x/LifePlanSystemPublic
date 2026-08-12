import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describeRunLease } from '../server/leaseObservability.js';

// Acceptance for lease-progress observability (MA-Dev audit delta #4). A unit
// section proves the redacted lease view classifies held/expired/absent leases,
// reports remaining time and the latest audit event, and NEVER exposes a raw
// token. An HTTP section proves the coding status route attaches leaseStatus to
// every task and leaks no lease token. Pure/local; no model or browser. Exit 0.

const appRoot = path.resolve(import.meta.dirname, '..');
let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- lease observability verification ---');

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const heldTask = {
  id: 'code-1', phase: 'independent_validation',
  runLease: { acquiredAt: '2026-08-12T11:50:00.000Z', expiresAt: '2026-08-12T12:20:00.000Z', tokenHash: 'd'.repeat(64), token: 'RAWSECRET' },
  audit: [{ at: '2026-08-12T11:59:00.000Z', phase: 'run_lease', verdict: 'allow', detail: 'Durable execution lease acquired.' }]
};
const held = describeRunLease(heldTask, { now: NOW });
line(held.held === true && held.expired === false, 'a lease before expiry is reported held');
line(held.owner === 'code-1' && held.phase === 'independent_validation', 'the view reports the owner task and active phase');
line(held.remainingMs === 20 * 60 * 1000, 'the view reports the remaining lease time');
line(held.tokenBound === true, 'the view reports that a token is bound');
line(held.lastEvent && held.lastEvent.phase === 'run_lease' && held.lastEvent.verdict === 'allow', 'the view surfaces the latest audit event');
line(!JSON.stringify(held).includes('RAWSECRET'), 'the raw lease token is never exposed in the view');
line(!Object.prototype.hasOwnProperty.call(held, 'token') && held.tokenHash === undefined, 'the view carries neither the token nor its hash value');

const expired = describeRunLease({ ...heldTask, runLease: { ...heldTask.runLease, expiresAt: '2026-08-12T11:59:00.000Z' } }, { now: NOW });
line(expired.held === false && expired.expired === true && expired.remainingMs === 0, 'an expired lease is reported not-held and reclaimable');

const none = describeRunLease({ id: 'code-2', phase: 'awaiting_run_approval', audit: [] }, { now: NOW });
line(none.held === false && none.acquiredAt === null && none.tokenBound === false, 'a task with no lease reports no hold');

// ---- HTTP: the status route attaches leaseStatus and leaks no token ----
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-lease-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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
async function api(route, { method = 'GET', json } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; headers['X-LPS-CSRF'] = token; }
  const res = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const server = await retryStart();
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
  const head = await api('/api/source/coding/tasks', { method: 'POST', json: { title: 'Lease view fixture', objective: 'Only inspect the lease observability view; nothing runs.', allowedPaths: ['version.txt'], maxFilesChanged: 1, validation: 'syntax' } });
  line(head.status === 200, 'a coding task can be staged for lease inspection');
  const status = await api('/api/source/coding/status');
  const task = (status.body.data.tasks || []).find((item) => item.id === head.body.data.task.id);
  line(Boolean(task && task.leaseStatus), 'the status route attaches a leaseStatus view to each task');
  line(task.leaseStatus.held === false && task.leaseStatus.owner === task.id, 'a freshly staged task reports no lease hold and its own id as owner');
  line(!JSON.stringify(status.body.data).toLowerCase().includes('"token"'), 'the coding status payload exposes no lease token field');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll lease-observability checks passed.');
process.exit(failures ? 1 : 0);
