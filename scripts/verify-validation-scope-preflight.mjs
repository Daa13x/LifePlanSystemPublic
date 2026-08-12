import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { assessValidationScope, classifyCodingPath, VALIDATION_CAPABILITIES } from '../server/validationScopePreflight.js';

// Acceptance for the validation-scope preflight (MA-Dev audit delta #3). A unit
// section proves the deterministic coverage policy; an HTTP section proves the
// live run-confirmation route refuses an under-covered sealed task and admits a
// covered one, and that task creation reports coverage. The worker's own
// human-selected command is never chosen or run here. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- validation-scope preflight verification ---');

// ---- unit: path classification ----
line(classifyCodingPath('src/main.jsx') === 'ui', 'a src/ file is UI');
line(classifyCodingPath('components/Widget.css') === 'ui', 'a .css file anywhere is UI');
line(classifyCodingPath('server/index.js') === 'server', 'a server/ file is server');
line(classifyCodingPath('scripts/verify-x.mjs') === 'server', 'a scripts/ file is server');
line(classifyCodingPath('docs/NOTES.md') === 'other', 'a docs file is other');
line(classifyCodingPath('version.txt') === 'other', 'a root text file is other');

// ---- unit: capability table ----
line(VALIDATION_CAPABILITIES.syntax.build === false && VALIDATION_CAPABILITIES.syntax.runtime === false, 'syntax covers neither build nor runtime');
line(VALIDATION_CAPABILITIES.frontend.build === true && VALIDATION_CAPABILITIES.frontend.runtime === false, 'frontend covers build only');
line(VALIDATION_CAPABILITIES.runtime.runtime === true && VALIDATION_CAPABILITIES.runtime.build === false, 'runtime covers the safety suite only');
line(VALIDATION_CAPABILITIES.project.build === true && VALIDATION_CAPABILITIES.project.runtime === true, 'project covers both');

// ---- unit: coverage policy ----
line(assessValidationScope({ allowedPaths: ['version.txt'], validation: 'syntax' }).ok, 'a plain file with syntax validation is covered');
line(!assessValidationScope({ allowedPaths: ['src/main.jsx'], validation: 'syntax' }).ok, 'a UI change with syntax validation is NOT covered');
line(assessValidationScope({ allowedPaths: ['src/main.jsx'], validation: 'frontend' }).ok, 'a UI change with frontend validation is covered');
line(assessValidationScope({ allowedPaths: ['src/main.jsx'], validation: 'project' }).ok, 'a UI change with project validation is covered');
line(!assessValidationScope({ allowedPaths: ['src/main.jsx'], validation: 'runtime' }).ok, 'a UI change with runtime-only validation is NOT covered');
line(!assessValidationScope({ allowedPaths: ['server/index.js'], validation: 'syntax' }).ok, 'a server change with syntax validation is NOT covered');
line(!assessValidationScope({ allowedPaths: ['server/index.js'], validation: 'frontend' }).ok, 'a server change with frontend-only validation is NOT covered');
line(assessValidationScope({ allowedPaths: ['server/index.js'], validation: 'runtime' }).ok, 'a server change with runtime validation is covered');
const both = assessValidationScope({ allowedPaths: ['src/main.jsx', 'server/index.js'], validation: 'runtime' });
line(!both.ok && both.required.build && both.required.runtime, 'a mixed UI+server task needs both capabilities and runtime-only is rejected');
line(assessValidationScope({ allowedPaths: ['src/main.jsx', 'server/index.js'], validation: 'project' }).ok, 'a mixed UI+server task with project validation is covered');
line(!assessValidationScope({ allowedPaths: ['src/x.jsx'], validation: 'nonsense' }).ok, 'an unknown validation profile is rejected');
line(assessValidationScope({ allowedPaths: ['src/main.jsx'], validation: 'syntax' }).reason.includes('production build'), 'the rejection reason names the missing build coverage');

// ---- HTTP acceptance: the live run-confirmation gate + create coverage ----
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-vscope-'));
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
const createTask = (allowedPaths, validation) => api('/api/source/coding/tasks', { method: 'POST', json: { title: 'Scope fixture', objective: 'Assess validation coverage only; nothing runs.', allowedPaths, maxFilesChanged: 1, validation } });
const proposeRun = (id) => api(`/api/source/coding/tasks/${id}/run/propose`, { method: 'POST', json: { taskHash: 'x', evidenceHash: 'y' } });

const server = await retryStart();
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  const underCovered = await createTask(['src/main.jsx'], 'syntax');
  line(underCovered.status === 200 && underCovered.body.data.validationScope.ok === false, 'creating a UI task with syntax validation reports uncovered scope');
  const blocked = await proposeRun(underCovered.body.data.task.id);
  line(blocked.status === 400 && /Validation scope insufficient/.test(blocked.body.error), 'a run confirmation for the under-covered task is refused with a scope reason');

  const covered = await createTask(['src/main.jsx'], 'frontend');
  line(covered.status === 200 && covered.body.data.validationScope.ok === true, 'creating a UI task with frontend validation reports covered scope');
  const notScopeBlocked = await proposeRun(covered.body.data.task.id);
  line(notScopeBlocked.status !== 400 || !/Validation scope insufficient/.test(notScopeBlocked.body.error || ''), 'the covered task is NOT rejected by the scope gate (fails later on hashes instead)');

  const plainFile = await createTask(['version.txt'], 'syntax');
  const plainRun = await proposeRun(plainFile.body.data.task.id);
  line(plainFile.body.data.validationScope.ok === true && (plainRun.status !== 400 || !/Validation scope insufficient/.test(plainRun.body.error || '')), 'a plain-file task with syntax validation is not scope-blocked');

  const serverTask = await createTask(['server/index.js'], 'syntax');
  const serverBlocked = await proposeRun(serverTask.body.data.task.id);
  line(serverBlocked.status === 400 && /runtime-safety/.test(serverBlocked.body.error || ''), 'a server task with syntax validation is refused, naming the runtime gap');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll validation-scope preflight checks passed.');
process.exit(failures ? 1 : 0);
