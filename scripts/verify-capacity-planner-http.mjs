import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// HTTP acceptance for the Capacity-Aware Daily Planner routes, on a disposable
// LIFE_PLANNER_DB (never the user's data): CSRF enforcement, capacity mode
// get/set + validation, the transparent day view, pin override, complete/defer,
// and persistence across a restart. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-capacity-'));
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
async function api(route, { method = 'GET', json, csrf = 'valid' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; if (csrf === 'valid') headers['X-LPS-CSRF'] = token; else if (csrf !== 'none') headers['X-LPS-CSRF'] = csrf; }
  const res = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const addTask = (task) => api('/api/planner/tasks', { method: 'POST', json: task });

console.log('--- capacity planner HTTP verification ---');
let server = await retryStart();
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  line((await api('/api/planner/tasks', { method: 'POST', json: { title: 'x' }, csrf: 'none' })).status === 403, 'creating a task without CSRF is rejected (403)');

  const day0 = await api('/api/planner/day');
  line(day0.status === 200 && day0.body.data.mode === 'normal' && Array.isArray(day0.body.data.modes) && day0.body.data.modes.length === 7, 'day view defaults to normal mode and lists the seven modes');

  // Seed a spread of tasks.
  await addTask({ title: 'Taxes', importance: 5, deadline: new Date(Date.now() + 2 * 86400000).toISOString(), effort: 4 });
  await addTask({ title: 'Emails', importance: 2, effort: 2 });
  await addTask({ title: 'Deep report', importance: 4, effort: 5, easierVersion: 'Draft one paragraph' });
  await addTask({ title: 'Tidy desk', importance: 1, effort: 1 });
  await addTask({ title: 'Rest / walk', importance: 2, isRecovery: true });
  const lowPriority = await addTask({ title: 'Read', importance: 1, effort: 2 });
  line(lowPriority.status === 200 && lowPriority.body.data.id, 'a task is created via the CSRF-protected route');

  const normalDay = (await api('/api/planner/day')).body.data;
  line(normalDay.visible.length <= 7 && normalDay.visible.every((t) => Array.isArray(t.reasons) && t.reasons.length), 'the day view returns transparently-reasoned visible tasks');
  line(normalDay.visible[0].title === 'Taxes', 'the deadline/high-importance task leads the day');

  // Capacity mode: invalid rejected, valid persisted and applied.
  line((await api('/api/planner/capacity', { method: 'POST', json: { mode: 'exhausted' } })).status === 400, 'an unknown capacity mode is rejected');
  line((await api('/api/planner/capacity', { method: 'POST', json: { mode: 'overwhelmed' } })).status === 200, 'setting a valid capacity mode succeeds');
  line((await api('/api/planner/capacity')).body.data.mode === 'overwhelmed', 'the capacity mode is read back');
  const overwhelmedDay = (await api('/api/planner/day')).body.data;
  line(overwhelmedDay.mode === 'overwhelmed' && overwhelmedDay.visibleLimit === 2 && overwhelmedDay.visible.length <= 2, 'overwhelmed mode shows far fewer tasks');
  line(overwhelmedDay.deferred.length >= 1 && overwhelmedDay.deferred.every((t) => /not a failure/i.test(t.deferReason)), 'the rest of the day is deferred as a choice, not a failure');
  const deepInMode = overwhelmedDay.visible.concat(overwhelmedDay.deferred).find((t) => t.title === 'Deep report');
  line(deepInMode.presentedAs === 'easier' && deepInMode.activeStep === 'Draft one paragraph', 'a big task is offered as its easier version in a low-capacity mode');

  // Pin override: a low-priority pinned task stays visible even in overwhelmed.
  line((await api(`/api/planner/tasks/${lowPriority.body.data.id}/pin`, { method: 'POST', json: {} })).status === 200, 'pinning a task succeeds');
  line((await api('/api/planner/day')).body.data.visible.some((t) => t.title === 'Read'), 'a pinned task overrides the mode limit and stays visible');

  // Complete and defer remove a task from the day.
  const emailsId = (await api('/api/planner/tasks')).body.data.find((t) => t.title === 'Emails').id;
  await api(`/api/planner/tasks/${emailsId}/complete`, { method: 'POST', json: {} });
  const taxesId = (await api('/api/planner/tasks')).body.data.find((t) => t.title === 'Taxes').id;
  await api(`/api/planner/tasks/${taxesId}/defer`, { method: 'POST', json: {} });
  const afterDay = (await api('/api/planner/day')).body.data;
  const stillListed = afterDay.visible.concat(afterDay.deferred).map((t) => t.title);
  line(!stillListed.includes('Emails') && !stillListed.includes('Taxes'), 'completed and deferred tasks leave the active day');

  await stopServer(server.child);
  // Persistence across restart: mode + tasks + pin survive.
  server = await retryStart();
  base = server.base;
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
  line((await api('/api/planner/capacity')).body.data.mode === 'overwhelmed', 'the capacity mode persists across a restart');
  const persisted = (await api('/api/planner/tasks')).body.data;
  line(persisted.some((t) => t.title === 'Read' && t.pinned) && persisted.length >= 6, 'planner tasks and pin state persist across a restart');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll capacity-planner HTTP checks passed.');
process.exit(failures ? 1 : 0);
