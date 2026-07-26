import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// HTTP acceptance for the Setup & Recovery routes. Drives the real server across
// three runtimes on a disposable LIFE_PLANNER_DB (never the user's data):
//   * CSRF and confirmation session/token enforcement;
//   * proposal causes no mutation; confirmation stages exactly one restore;
//   * stale live-database rejection; replay cannot re-stage;
//   * the staged swap is applied at the next startup, BEFORE SQLite opens;
//   * a rollback copy is kept; legacy migration copies data only.
// Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-setup-http-'));
const dataDir = path.join(probeRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'life-planner.sqlite');
const legacyDir = path.join(probeRoot, 'legacy-install-data');

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startServer(port) {
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: appRoot,
    env: {
      ...process.env,
      LIFE_PLANNER_DB: dbPath,
      LIFE_PLANNER_PORT: String(port),
      LIFE_PLANNER_LEGACY_DIR: legacyDir,
      // Keep the server's connector pairing output inside the disposable probe;
      // a recovery acceptance test must never write into the checkout.
      LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing-config.json')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).\n${output.join('')}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base, output }; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy.\n${output.join('')}`);
}

async function stopServer(child) {
  if (child.exitCode === null) child.kill();
  for (let i = 0; i < 40 && child.exitCode === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
}

const tokenCache = new Map();
async function csrf(base) {
  if (tokenCache.has(base)) return tokenCache.get(base);
  const body = await (await fetch(`${base}/api/csrf-token`)).json();
  const token = body.ok ? body.data.token : '';
  tokenCache.set(base, token);
  return token;
}

async function api(base, route, { method = 'GET', json, csrf: mode = 'valid' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') {
    headers.Origin = base;
    if (mode === 'valid') headers['X-LPS-CSRF'] = await csrf(base);
    else if (mode !== 'none') headers['X-LPS-CSRF'] = mode;
  }
  const res = await fetch(`${base}${route}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const projectNames = async (base) => (await api(base, '/api/projects')).body.data.map((project) => project.name);

console.log('--- setup & recovery HTTP verification ---');

try {
  // A valid (empty) legacy database file so detection/migration have a source.
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyDb = new DatabaseSync(path.join(legacyDir, 'life-planner.sqlite'));
  legacyDb.exec('CREATE TABLE IF NOT EXISTS marker (k TEXT)');
  legacyDb.close();

  // ================= RUNTIME #1 =================
  let port = await freePort();
  let server = await startServer(port);
  let base = server.base;

  const setup = await api(base, '/api/setup/status');
  line(setup.status === 200 && setup.body.data.ready === true && setup.body.data.firstRun === false, 'GET /api/setup/status reports a ready app');

  line((await api(base, '/api/recovery/backup', { method: 'POST', json: {}, csrf: 'none' })).status === 403, 'backup without CSRF is rejected (403)');
  line((await api(base, '/api/recovery/backup', { method: 'POST', json: {}, csrf: 'deadbeef' })).status === 403, 'backup with an invalid CSRF token is rejected (403)');

  const backup = await api(base, '/api/recovery/backup', { method: 'POST', json: {} });
  line(backup.status === 200 && backup.body?.data?.name, `POST /api/recovery/backup creates a backup (B1)${backup.status === 200 ? '' : `: ${backup.body?.error || `HTTP ${backup.status}`}`}`);
  const b1 = backup.body.data.name;
  line((await api(base, '/api/recovery/backups')).body.data.some((entry) => entry.name === b1), 'GET /api/recovery/backups lists B1');

  const proposeA = await api(base, '/api/recovery/restore/propose', { method: 'POST', json: { backup: b1 } });
  line(proposeA.status === 200 && proposeA.body.data.confirmationId && proposeA.body.data.token, 'restore propose returns a confirmation id + token');
  const pA = proposeA.body.data;
  line((await api(base, '/api/recovery/status')).body.data.pendingRestore === null, 'proposal causes no mutation (nothing staged yet)');
  await stopServer(server.child);

  // ================= RUNTIME #2 (same DB; no swap staged) =================
  port = await freePort();
  server = await startServer(port);
  base = server.base;
  tokenCache.clear();

  const wrongSession = await api(base, '/api/recovery/restore/confirm', { method: 'POST', json: { confirmationId: pA.confirmationId, token: pA.token } });
  line(wrongSession.status === 409 && /different session/i.test(wrongSession.body.error || ''), 'a confirmation from a previous runtime session is rejected');

  line((await api(base, '/api/projects', { method: 'POST', json: { name: 'S2-MARKER' } })).status === 200, 'create a post-backup project S2-MARKER');
  line((await projectNames(base)).includes('S2-MARKER'), 'S2-MARKER exists before restore');

  const proposeB = await api(base, '/api/recovery/restore/propose', { method: 'POST', json: { backup: b1 } });
  const pB = proposeB.body.data;
  const badToken = await api(base, '/api/recovery/restore/confirm', { method: 'POST', json: { confirmationId: pB.confirmationId, token: 'not-the-token' } });
  line(badToken.status === 409 && /verified/i.test(badToken.body.error || ''), 'confirm with the wrong confirmation token is rejected');

  // Drift the live user data, then confirm -> stale.
  await api(base, '/api/projects', { method: 'POST', json: { name: 'DRIFT' } });
  const stale = await api(base, '/api/recovery/restore/confirm', { method: 'POST', json: { confirmationId: pB.confirmationId, token: pB.token } });
  line(stale.status === 409 && /changed after/i.test(stale.body.error || ''), 'a stale live-database (drifted) restore is rejected');
  line((await api(base, '/api/recovery/status')).body.data.pendingRestore === null, 'a stale confirmation stages nothing');

  // Fresh proposal against the drifted state, then confirm -> staged exactly once.
  const proposeC = await api(base, '/api/recovery/restore/propose', { method: 'POST', json: { backup: b1 } });
  const pC = proposeC.body.data;
  const confirmC = await api(base, '/api/recovery/restore/confirm', { method: 'POST', json: { confirmationId: pC.confirmationId, token: pC.token } });
  line(confirmC.status === 200 && confirmC.body.data.staged === true, 'confirmation stages a restore');
  line((await api(base, '/api/recovery/status')).body.data.pendingRestore !== null, 'exactly one restore is now staged');
  const replay = await api(base, '/api/recovery/restore/confirm', { method: 'POST', json: { confirmationId: pC.confirmationId, token: pC.token } });
  line(replay.status === 409, 'replaying the confirmation cannot stage it twice');
  await stopServer(server.child);

  // ================= RUNTIME #3 (startup applies the staged swap) =================
  port = await freePort();
  server = await startServer(port);
  base = server.base;
  tokenCache.clear();

  const applied = /Startup restore applied before database open/.test(server.output.join(''));
  line(applied, 'the staged swap is applied at startup, before SQLite opens');
  const names = await projectNames(base);
  line(!names.includes('S2-MARKER') && !names.includes('DRIFT'), 'restored database no longer contains post-backup changes');
  line((await api(base, '/api/recovery/status')).body.data.pendingRestore === null, 'the pending-restore marker is cleared after the swap');
  line((await api(base, '/api/recovery/backups')).body.data.some((entry) => entry.name.startsWith('pre-restore-rollback')), 'a pre-restore rollback backup is preserved');

  // Legacy data-only migration through the same safe path.
  line((await api(base, '/api/setup/status')).body.data.legacyDetected === true, 'a legacy installation is detected');
  const proposeLegacy = await api(base, '/api/recovery/legacy-migrate/propose', { method: 'POST', json: {} });
  line(proposeLegacy.status === 200 && proposeLegacy.body.data.confirmationId, 'legacy-migrate propose returns a confirmation');
  const pL = proposeLegacy.body.data;
  const confirmLegacy = await api(base, '/api/recovery/legacy-migrate/confirm', { method: 'POST', json: { confirmationId: pL.confirmationId, token: pL.token } });
  line(confirmLegacy.status === 200 && confirmLegacy.body.data.staged === true, 'legacy-migrate confirmation stages the migration');
  line(fs.existsSync(path.join(legacyDir, 'life-planner.sqlite')), 'legacy migration copies data only (source left in place)');
  await stopServer(server.child);

  assert.ok(true);
} finally {
  fs.rmSync(probeRoot, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll setup & recovery HTTP checks passed.');
process.exit(failures ? 1 : 0);
