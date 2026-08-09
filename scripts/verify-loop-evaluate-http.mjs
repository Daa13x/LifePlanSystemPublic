import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// HTTP acceptance for the read-only unattended-loop preparation gate on a
// disposable LIFE_PLANNER_DB. The gate only PROPOSES readiness — it never
// executes or sends. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-loop-'));
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
async function api(route, { method = 'GET', json } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; headers['X-LPS-CSRF'] = token; }
  const res = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const item = { id: 'w1', state: 'execution', scope: ['src/'], requiredEvidence: ['tests'], expectedOutput: 'a patch', stopConditions: ['tests green'] };

console.log('--- loop evaluate HTTP verification ---');
const server = await retryStart();
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  const ready = await api('/api/loop/evaluate', { method: 'POST', json: {
    item, phase: 'execution',
    question: { type: 'evidence-request', text: 'attach the failing test', evidenceHash: 'e1', stateHash: 's1' },
    manifest: [{ path: 'src/a.js', hash: 'h1' }], available: [{ path: 'src/a.js', hash: 'h1' }], attempts: []
  } });
  line(ready.status === 200 && ready.body.data.ready === true && Array.isArray(ready.body.data.reasons), 'a bounded, in-phase, in-scope send is evaluated READY with reasons');

  const wrongPhase = await api('/api/loop/evaluate', { method: 'POST', json: {
    item, phase: 'execution',
    question: { type: 'completion-report', text: 'done', evidenceHash: 'e1', stateHash: 's1' },
    manifest: [], available: [], attempts: []
  } });
  line(wrongPhase.body.data.ready === false && wrongPhase.body.data.questionCheck.valid === false, 'a completion report during execution is not ready');

  const outOfScope = await api('/api/loop/evaluate', { method: 'POST', json: {
    item, phase: 'execution',
    question: { type: 'evidence-request', text: 'attach secret', evidenceHash: 'e1', stateHash: 's1' },
    manifest: [{ path: 'secrets/.env' }], available: [], attempts: []
  } });
  line(outOfScope.body.data.ready === false && outOfScope.body.data.manifestCheck.ok === false, 'an out-of-scope attachment fails the manifest and is not ready');

  const underspecified = await api('/api/loop/evaluate', { method: 'POST', json: {
    item: { id: 'w2', state: 'execution' }, phase: 'execution',
    question: { type: 'evidence-request', text: 'x', evidenceHash: 'e1', stateHash: 's1' }
  } });
  line(underspecified.body.data.ready === false && underspecified.body.data.eligibility.eligible === false, 'an underspecified work item is not eligible and not ready');

  const looping = await api('/api/loop/evaluate', { method: 'POST', json: {
    item, phase: 'execution',
    question: { type: 'evidence-request', text: 'run it', evidenceHash: 'e', stateHash: 's' },
    manifest: [{ path: 'src/a.js', hash: 'h1' }], available: [{ path: 'src/a.js', hash: 'h1' }],
    attempts: [
      { type: 'evidence-request', text: 'run it', evidenceHash: 'e', stateHash: 's' },
      { type: 'evidence-request', text: 'run it', evidenceHash: 'e', stateHash: 's' }
    ], limit: 3
  } });
  line(looping.body.data.ready === false && looping.body.data.progress.blocked === true, 'a no-progress loop is detected and blocks readiness');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll loop-evaluate HTTP checks passed.');
process.exit(failures ? 1 : 0);
