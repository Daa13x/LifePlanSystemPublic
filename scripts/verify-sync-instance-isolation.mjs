// Integration proof for the Android companion's personal-PC contract. Two
// real LPS server processes use independent databases, ports, pairing tokens
// and stable identities. The phone-side transport must select the configured
// endpoint, reject the other PC's credential, and never receive PC A's task
// from PC B after an explicit pairing replacement.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { exchangeSyncChanges, planSyncPairingTransition, verifySyncServer } from '../src/nativeConnection.js';

const root = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-sync-instance-isolation-'));
const children = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startPc(label) {
  const [appPort, syncPort] = await Promise.all([freePort(), freePort()]);
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      LIFE_PLANNER_DB: path.join(probeRoot, `${label}.sqlite`),
      LIFE_PLANNER_PORT: String(appPort),
      LIFE_PLANNER_SYNC_PORT: String(syncPort),
      LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, `${label}-pairing.json`)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  children.push(child);
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const appUrl = `http://127.0.0.1:${appPort}`;
  const syncUrl = `http://127.0.0.1:${syncPort}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early (${child.exitCode}).\n${output.join('')}`);
    try {
      if ((await fetch(`${appUrl}/api/health`)).ok && (await fetch(`${syncUrl}/health`)).ok) {
        return { label, appUrl, syncUrl };
      }
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become healthy.\n${output.join('')}`);
}

async function appData(pc, route, options = {}) {
  const response = await fetch(`${pc.appUrl}${route}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${pc.label} ${route}: ${body.error || response.status}`);
  return body.data;
}

async function preparePc(pc, taskTitle) {
  const csrf = await appData(pc, '/api/csrf-token');
  const headers = { 'Content-Type': 'application/json', 'X-LPS-CSRF': csrf.token };
  const pairing = await appData(pc, '/api/sync/pairing/regenerate', { method: 'POST', headers, body: '{}' });
  await appData(pc, '/api/planner/tasks', { method: 'POST', headers, body: JSON.stringify({ title: taskTitle }) });
  return pairing;
}

try {
  const [pcA, pcB] = await Promise.all([startPc('pc-a'), startPc('pc-b')]);
  const [pairA, pairB] = await Promise.all([preparePc(pcA, 'Only on personal PC A'), preparePc(pcB, 'Only on personal PC B')]);

  assert.notEqual(pairA.serverId, pairB.serverId, 'independent LPS PCs have distinct stable server identities');
  assert.notEqual(pairA.userId, pairB.userId, 'independent personal databases have distinct user-scope identities');
  assert.notEqual(pairA.token, pairB.token, 'independent LPS PCs issue distinct pairing credentials');

  const identityA = await verifySyncServer({ baseUrl: pcA.syncUrl, pairingToken: pairA.token });
  const firstA = await exchangeSyncChanges({
    baseUrl: pcA.syncUrl,
    pairingToken: pairA.token,
    payload: { deviceId: 'android-isolation-probe', sinceSeq: 0, changes: [] }
  });
  assert.equal(firstA.serverId, identityA.serverId);
  assert.equal(firstA.changes.some((change) => change.payload?.title === 'Only on personal PC A'), true, 'fresh phone pairing receives PC A data from PC A');
  assert.equal(firstA.changes.some((change) => change.payload?.title === 'Only on personal PC B'), false, 'PC B data is absent from PC A');

  await assert.rejects(
    verifySyncServer({ baseUrl: pcB.syncUrl, pairingToken: pairA.token }),
    (error) => error.code === 'SYNC_AUTH_FAILED',
    'PC A credential cannot authorize PC B'
  );
  const identityB = await verifySyncServer({ baseUrl: pcB.syncUrl, pairingToken: pairB.token });
  assert.throws(
    () => planSyncPairingTransition({ baseUrl: pcA.syncUrl, pairingToken: pairA.token, serverId: identityA.serverId }, identityB),
    (error) => error.code === 'SYNC_REPLACEMENT_REQUIRED',
    'the phone cannot silently change personal PCs'
  );
  const replacement = planSyncPairingTransition(
    { baseUrl: pcA.syncUrl, pairingToken: pairA.token, serverId: identityA.serverId },
    identityB,
    { replaceExisting: true }
  );
  assert.equal(replacement.clearSyncedPlanner, true, 'explicit PC replacement requires clearing PC A Planner/transport state');

  const firstB = await exchangeSyncChanges({
    baseUrl: pcB.syncUrl,
    pairingToken: pairB.token,
    payload: { deviceId: 'android-isolation-probe', sinceSeq: 0, changes: [] }
  });
  assert.equal(firstB.serverId, identityB.serverId);
  assert.equal(firstB.changes.some((change) => change.payload?.title === 'Only on personal PC B'), true, 're-paired phone receives PC B data from PC B');
  assert.equal(firstB.changes.some((change) => change.payload?.title === 'Only on personal PC A'), false, 'PC A data is absent from PC B');

  console.log('Two-PC Android pairing identity, credential, endpoint, and data isolation verification passed.');
} finally {
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  })));
  fs.rmSync(probeRoot, { recursive: true, force: true });
}
