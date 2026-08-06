import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// HTTP acceptance for the adaptive cost-routing routes on a disposable
// LIFE_PLANNER_DB (never the user's data): CSRF-gated recording, measured
// recommendation and summary, and evidence-driven escalation. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-routing-'));
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
const observe = (json) => api('/api/routing/observations', { method: 'POST', json });

console.log('--- routing HTTP verification ---');
const server = await startServer(await freePort());
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  line((await api('/api/routing/observations', { method: 'POST', json: { taskClass: 'x', route: 'y' }, csrf: 'none' })).status === 403, 'recording an observation without CSRF is rejected (403)');
  line((await observe({ route: 'local-low' })).status === 400, 'an observation without a task class is rejected (400)');

  // With no evidence, recommendation is the default and flagged unmeasured.
  const cold = await api('/api/routing/recommend?taskClass=summarise');
  line(cold.status === 200 && cold.body.data.measured === false, 'with no observations the recommendation is the unmeasured default');

  // Record cheap-route successes; it should then be recommended (measured).
  for (let i = 0; i < 4; i += 1) await observe({ taskClass: 'summarise', route: 'local-low', cost: 1, verificationPassed: true, accepted: true });
  const warm = await api('/api/routing/recommend?taskClass=summarise');
  line(warm.body.data.route === 'local-low' && warm.body.data.measured === true, 'a cheap route with measured success is recommended');

  // A cheap route that fails should not be recommended over a passing pricier tier.
  for (let i = 0; i < 4; i += 1) await observe({ taskClass: 'code', route: 'local-low', cost: 1, verificationPassed: false, accepted: false });
  for (let i = 0; i < 4; i += 1) await observe({ taskClass: 'code', route: 'local-high', cost: 3, verificationPassed: true, accepted: true });
  const codeRec = await api('/api/routing/recommend?taskClass=code');
  line(codeRec.body.data.route === 'local-high', 'a repeatedly-failing cheap route is skipped for the next tier meeting the bar');
  const highRisk = await api('/api/routing/recommend?taskClass=code&highRisk=code');
  line(highRisk.body.data.requiresDeterministicChecks === true, 'a high-risk task class keeps deterministic checks regardless of tier');

  const summary = await api('/api/routing/summary');
  line(summary.status === 200 && summary.body.data.observationCount === 12 && summary.body.data.routes.some((r) => r.route === 'local-low'), 'the summary reports measured routes and observation count');

  // Escalation endpoint is evidence-driven.
  line((await api('/api/routing/escalation', { method: 'POST', json: { contradictsTests: true } })).body.data.escalate === true, 'a test contradiction escalates via the endpoint');
  line((await api('/api/routing/escalation', { method: 'POST', json: { verificationPassed: true, taskSoundsComplex: true } })).body.data.escalate === false, 'a passing route is not escalated on perceived complexity via the endpoint');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll routing HTTP checks passed.');
process.exit(failures ? 1 : 0);
