import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import {
  exchangeSyncChanges,
  isPrivateNetworkHost,
  normalizeNativeServerUrl,
  normalizeSyncBaseUrl,
  PHONE_SYNC_PROTOCOL_VERSION,
  PHONE_SYNC_SERVICE,
  planSyncPairingTransition,
  verifySyncServer
} from '../src/nativeConnection.js';
import { persistSyncPairingTransition } from '../src/localData.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

assert.equal(normalizeNativeServerUrl('https://beta.example.test/'), 'https://beta.example.test');
assert.equal(normalizeNativeServerUrl('http://127.0.0.1:4177'), 'http://127.0.0.1:4177');
assert.throws(() => normalizeNativeServerUrl('http://beta.example.test'), /must use HTTPS/);
assert.throws(() => normalizeNativeServerUrl('https://user:secret@beta.example.test'), /must not contain/);

for (const host of ['192.168.1.20', '10.0.0.5', '172.16.2.4', '169.254.1.2', 'lps.local', '::1']) {
  assert.equal(isPrivateNetworkHost(host), true, `${host} is an allowed private sync host`);
}
assert.equal(normalizeSyncBaseUrl('http://192.168.1.20:4178/'), 'http://192.168.1.20:4178');
assert.equal(normalizeSyncBaseUrl('https://sync.example.test'), 'https://sync.example.test');
assert.throws(() => normalizeSyncBaseUrl('http://sync.example.test:4178'), /local\/private-network/);

function startFakePersonalPc({ serverId, userId, token, label }) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, token: request.headers['x-lps-pairing-token'] || '' });
    const send = (status, body) => {
      const text = JSON.stringify(body);
      response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      response.end(text);
    };
    if (request.headers['x-lps-pairing-token'] !== token) return send(401, { ok: false, error: 'Invalid or missing pairing token.' });
    if (request.method === 'GET' && request.url === '/identity') {
      return send(200, { ok: true, service: PHONE_SYNC_SERVICE, protocolVersion: PHONE_SYNC_PROTOCOL_VERSION, serverId, userId });
    }
    if (request.method === 'POST' && request.url === '/exchange') {
      return send(200, { ok: true, service: PHONE_SYNC_SERVICE, protocolVersion: PHONE_SYNC_PROTOCOL_VERSION, serverId, userId, label, cursor: 0, results: [], changes: [] });
    }
    return send(404, { ok: false, error: 'Not found.' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

const pcA = await startFakePersonalPc({ serverId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: '11111111-1111-4111-8111-111111111111', token: 'pairing-code-a', label: 'PC A' });
const pcB = await startFakePersonalPc({ serverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', userId: '22222222-2222-4222-8222-222222222222', token: 'pairing-code-b', label: 'PC B' });
try {
  const identityA = await verifySyncServer({ baseUrl: pcA.baseUrl, pairingToken: 'pairing-code-a' });
  assert.equal(identityA.serverId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(identityA.userId, '11111111-1111-4111-8111-111111111111');
  const responseA = await exchangeSyncChanges({ baseUrl: pcA.baseUrl, pairingToken: 'pairing-code-a', payload: { deviceId: 'phone', sinceSeq: 0, changes: [] } });
  assert.equal(responseA.label, 'PC A', 'the configured PC A endpoint communicates with PC A');

  await assert.rejects(
    verifySyncServer({ baseUrl: pcB.baseUrl, pairingToken: 'pairing-code-a' }),
    (error) => error.code === 'SYNC_AUTH_FAILED',
    'PC A credentials do not authorize PC B'
  );
  const identityB = await verifySyncServer({ baseUrl: pcB.baseUrl, pairingToken: 'pairing-code-b' });
  const responseB = await exchangeSyncChanges({ baseUrl: pcB.baseUrl, pairingToken: 'pairing-code-b', payload: { deviceId: 'phone', sinceSeq: 0, changes: [] } });
  assert.equal(responseB.label, 'PC B', 'changing the configured endpoint and credential communicates with PC B');

  assert.deepEqual(
    planSyncPairingTransition({}, identityA),
    { mode: 'initial', clearSyncedPlanner: false, preserveProgress: false },
    'a fresh installation can pair with any compatible personal PC'
  );
  assert.deepEqual(
    planSyncPairingTransition({ baseUrl: pcA.baseUrl, pairingToken: 'pairing-code-a', serverId: identityA.serverId }, { ...identityA, baseUrl: 'http://127.0.0.1:49999' }),
    { mode: 'same-server', clearSyncedPlanner: false, preserveProgress: true },
    'the same stable PC identity may move to a new LAN address without resetting sync progress'
  );
  assert.throws(
    () => planSyncPairingTransition({ baseUrl: pcA.baseUrl, pairingToken: 'pairing-code-a', serverId: identityA.serverId }, identityB),
    (error) => error.code === 'SYNC_REPLACEMENT_REQUIRED',
    'switching from PC A to PC B is never implicit'
  );
  assert.deepEqual(
    planSyncPairingTransition({ baseUrl: pcA.baseUrl, pairingToken: 'pairing-code-a', serverId: identityA.serverId }, identityB, { replaceExisting: true }),
    { mode: 'replace-server', clearSyncedPlanner: true, preserveProgress: false },
    'an explicit PC replacement clears the old synced Planner scope'
  );
  assert.equal(pcB.requests.some((request) => request.token === 'pairing-code-a'), true, 'credential-isolation rejection was exercised against the real PC B endpoint');

  // Exercise the real phone persistence helper against SQLite, not only its
  // planning function. All five synced Planner/transport tables must clear on
  // PC replacement while phone-only data remains.
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE local_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE local_tasks (id TEXT PRIMARY KEY);
    CREATE TABLE local_task_events (id TEXT PRIMARY KEY);
    CREATE TABLE sync_outbox (change_id TEXT PRIMARY KEY);
    CREATE TABLE sync_applied_changes (change_id TEXT PRIMARY KEY);
    CREATE TABLE sync_conflicts (id TEXT PRIMARY KEY);
    CREATE TABLE local_notes (id TEXT PRIMARY KEY);
    INSERT INTO local_tasks VALUES ('task-a');
    INSERT INTO local_task_events VALUES ('event-a');
    INSERT INTO sync_outbox VALUES ('outbox-a');
    INSERT INTO sync_applied_changes VALUES ('applied-a');
    INSERT INTO sync_conflicts VALUES ('conflict-a');
    INSERT INTO local_notes VALUES ('phone-only-note');
  `);
  const db = {
    beginTransaction: async () => sqlite.exec('BEGIN IMMEDIATE'),
    commitTransaction: async () => sqlite.exec('COMMIT'),
    rollbackTransaction: async () => sqlite.exec('ROLLBACK'),
    execute: async (sql) => sqlite.exec(sql),
    run: async (sql, values = []) => sqlite.prepare(sql).run(...values)
  };
  const replacement = planSyncPairingTransition(
    { baseUrl: pcA.baseUrl, pairingToken: 'pairing-code-a', serverId: identityA.serverId },
    identityB,
    { replaceExisting: true }
  );
  await persistSyncPairingTransition(db, { candidate: identityB, pairingToken: 'pairing-code-b', transition: replacement, verifiedAt: '2026-09-02T00:00:00.000Z' });
  for (const table of ['local_tasks', 'local_task_events', 'sync_outbox', 'sync_applied_changes', 'sync_conflicts']) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} is cleared when replacing PC A with PC B`);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM local_notes').get().count, 1, 'phone-only data remains when replacing the synced PC');
  const setting = (key) => sqlite.prepare('SELECT value FROM local_settings WHERE key = ?').get(key)?.value;
  assert.equal(setting('sync_base_url'), identityB.baseUrl);
  assert.equal(setting('sync_pairing_token'), 'pairing-code-b');
  assert.equal(setting('sync_server_id'), identityB.serverId);
  assert.equal(setting('sync_user_id'), identityB.userId);
  assert.equal(setting('sync_connection_status'), 'connected');
  assert.equal(setting('sync_cursor'), '0');
  assert.equal(setting('sync_last_pushed_seq'), '0');

  sqlite.exec("INSERT INTO local_tasks VALUES ('task-b'); UPDATE local_settings SET value = '7' WHERE key = 'sync_cursor';");
  const samePcAtNewAddress = { ...identityB, baseUrl: 'http://127.0.0.1:49998' };
  const addressChange = planSyncPairingTransition(
    { baseUrl: identityB.baseUrl, pairingToken: 'pairing-code-b', serverId: identityB.serverId },
    samePcAtNewAddress
  );
  await persistSyncPairingTransition(db, { candidate: samePcAtNewAddress, pairingToken: 'rotated-code-b', transition: addressChange });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM local_tasks').get().count, 1, 'same-PC address changes retain synced Planner data');
  assert.equal(setting('sync_cursor'), '7', 'same-PC address changes retain sync progress');
  assert.equal(setting('sync_base_url'), samePcAtNewAddress.baseUrl, 'same-PC address changes persist the new endpoint');
  sqlite.close();
} finally {
  await Promise.all([pcA, pcB].map(({ server }) => new Promise((resolve) => server.close(resolve))));
}

const networkPolicy = read('android/app/src/main/res/xml/network_security_config.xml');
const ui = read('src/main.jsx');
const server = read('server/index.js');
const localData = read('src/localData.js');
for (const source of [ui, server, localData, read('src/nativeConnection.js'), networkPolicy]) {
  assert.doesNotMatch(source, /192\.168\.0\.14/, 'product source does not embed Alex\'s current LAN address');
}
assert.match(networkPolicy, /base-config cleartextTrafficPermitted="true"/, 'APK permits the user-entered private-LAN HTTP sync bridge');
assert.match(ui, /function NativeBackendPanel/, 'native app has an always-reachable backend configuration panel');
assert.match(ui, /Pair with my LifePlanSystem PC/, 'native top bar exposes generic personal-PC pairing');
assert.match(ui, /if \(!current\.paired\) setSyncPanelOpen\(true\)/, 'a fresh native installation opens pairing on first launch');
assert.match(ui, /Address shown by LifePlanSystem on your PC/, 'pairing UI asks for the current user PC address, not a fixed address');
assert.match(ui, /Replace paired PC and clear synced Planner data/, 'switching personal PCs requires an explicit data-scope reset');
assert.match(ui, /Configure optional hosted LifePlanSystem server/, 'optional hosted services remain distinct from personal-PC pairing');
assert.match(ui, /Save and connect[\s\S]*Use USB default/, 'native backend setup has connect/retry and USB-loopback paths');
const pairingStart = localData.indexOf('export async function localSetSyncPairing');
const pairingEnd = localData.indexOf('\nfunction extractSyncableTaskFieldsPhone', pairingStart);
const pairingFlow = localData.slice(pairingStart, pairingEnd);
assert.ok(pairingFlow.indexOf('await verifySyncServer') < pairingFlow.indexOf('await persistSyncPairingTransition'), 'pairing verifies identity and credential before persistence');
assert.match(localData, /DELETE FROM local_task_events;[\s\S]*DELETE FROM local_tasks;[\s\S]*DELETE FROM sync_outbox;[\s\S]*DELETE FROM sync_applied_changes;[\s\S]*DELETE FROM sync_conflicts;/, 'explicit PC replacement clears every synced Planner and transport table');
assert.match(localData, /sync_server_id[\s\S]*sync_user_id[\s\S]*sync_connection_status/, 'endpoint, credential-associated identities, and connection status persist generically');
const sendStart = ui.indexOf('async function send()');
const sendEnd = ui.indexOf('\n  async function loadMessages', sendStart);
const sendFlow = ui.slice(sendStart, sendEnd > sendStart ? sendEnd : sendStart + 9000);
assert.match(sendFlow, /if \(IS_NATIVE\)/, 'native chat takes its local command path regardless of optional backend reachability');
assert.match(sendFlow, /This Closed Beta keeps phone chat on device for now/, 'native unmatched chat is explicit about the v0.1 boundary');
assert.match(server, /req\.method === 'POST' && req\.path === '\/api\/feedback'/, 'hosted mode allows only the feedback submission method');
assert.match(server, /INSERT INTO feedback \(user_id, sentiment/, 'feedback submissions are attributed to the authenticated tester');
assert.match(server, /Object\.values\(os\.networkInterfaces\(\)\)/, 'desktop pairing addresses derive from the current machine network interfaces');
assert.match(server, /req\.method === 'GET' && req\.url === '\/identity'/, 'desktop exposes an authenticated stable identity handshake');
assert.match(server, /serverId: stableSyncIdentityValue\(SYNC_SERVER_ID_KEY\)/, 'desktop identity is generated and persisted per personal LPS database');

console.log('Android Closed Beta connection and feedback contract verification passed.');
