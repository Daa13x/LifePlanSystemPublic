// Acceptance for the Phase 4 transport itself (server/index.js's "Phone<->
// desktop sync bridge" section): pairing generation, push/pull in one round
// trip, conflict detection, idempotent replay, and in-batch task-before-
// event ordering. Spawns the real server against a disposable database, the
// same pattern scripts/verify-sync-outbox.mjs uses, so this exercises the
// actual bridge HTTP server, not a reimplementation of its logic.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-sync-exchange-'));
const dbPath = path.join(probeRoot, 'life-planner.sqlite');

let child;
async function startServer(port, syncPort) {
  const output = [];
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_SYNC_PORT: String(syncPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (c) => output.push(String(c)));
  child.stderr.on('data', (c) => output.push(String(c)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).\n${output.join('')}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return base; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become healthy.\n${output.join('')}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

let failures = 0;
const line = (ok, message) => { if (!ok) failures += 1; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`); };

try {
  const port = await freePort();
  const syncPort = await freePort();
  const base = await startServer(port, syncPort);
  const bridge = `http://127.0.0.1:${syncPort}`;
  const json = (r) => r.json().then((b) => b.data);
  const csrfToken = await fetch(`${base}/api/csrf-token`).then(json).then((d) => d.token);
  const mutHeaders = { 'Content-Type': 'application/json', 'X-LPS-CSRF': csrfToken };

  // --- bridge health is reachable even before any pairing exists ---------
  const health = await fetch(`${bridge}/health`).then((r) => r.json());
  line(health.ok && health.service === 'lifeplansystem-phone-sync' && health.protocolVersion === 1, 'sync bridge /health identifies a compatible protocol without exposing a credential');
  const identityNoToken = await fetch(`${bridge}/identity`);
  line(identityNoToken.status === 401, 'stable desktop identity is not exposed without the pairing credential');
  const exchangeNoToken = await fetch(`${bridge}/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'x', sinceSeq: 0, changes: [] }) });
  line(exchangeNoToken.status === 401, '/exchange refuses every request before a pairing token exists');

  // --- generate pairing from the desktop's own (loopback) settings route --
  const pairing = await fetch(`${base}/api/sync/pairing/regenerate`, { method: 'POST', headers: mutHeaders }).then(json);
  line(typeof pairing.token === 'string' && pairing.token.length >= 20, 'regenerating pairing returns a real token');
  const authHeaders = { 'Content-Type': 'application/json', 'X-LPS-Pairing-Token': pairing.token };
  const identity = await fetch(`${bridge}/identity`, { headers: authHeaders }).then((r) => r.json());
  line(identity.ok && identity.serverId === pairing.serverId && identity.userId === pairing.userId, 'authenticated pairing returns the same stable PC/user identity shown by desktop Settings');

  const badToken = await fetch(`${bridge}/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LPS-Pairing-Token': 'wrong' }, body: JSON.stringify({ deviceId: 'x', sinceSeq: 0, changes: [] }) });
  line(badToken.status === 401, 'a wrong pairing token is refused even once one is configured');

  // --- desktop-created task is visible to a phone pulling from seq 0 -----
  const desktopTask = await fetch(`${base}/api/planner/tasks`, { method: 'POST', headers: mutHeaders, body: JSON.stringify({ title: 'Desktop task' }) }).then(json);
  const pull1 = await fetch(`${bridge}/exchange`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ deviceId: 'phone-1', sinceSeq: 0, changes: [] }) }).then((r) => r.json()).then((b) => b);
  line(pull1.ok === true, 'first exchange call succeeds');
  line(pull1.serverId === identity.serverId && pull1.userId === identity.userId, 'every exchange is bound to the authenticated personal PC/user identity');
  const pulledDesktopTask = pull1.changes.find((c) => c.entitySyncId === desktopTask.sync_id);
  line(Boolean(pulledDesktopTask), 'a task created on desktop before pairing is included in the phone\'s first pull');
  line(pulledDesktopTask?.payload?.title === 'Desktop task', 'the pulled task payload carries the real title');

  // --- phone creates a task; desktop applies it and can be read back -----
  const phoneTaskSyncId = crypto.randomUUID();
  const push1 = await fetch(`${bridge}/exchange`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ deviceId: 'phone-1', sinceSeq: pull1.cursor, changes: [
      { changeId: crypto.randomUUID(), entityType: 'planner_task', entitySyncId: phoneTaskSyncId, op: 'upsert', payload: { title: 'Phone task', status: 'active' }, revision: 1, deviceId: 'phone-1' }
    ] })
  }).then((r) => r.json());
  line(push1.results?.[0]?.status === 'applied', 'a phone-created task is applied on desktop');
  const desktopTasks = await fetch(`${base}/api/planner/tasks`).then(json);
  line(Boolean(desktopTasks.find((t) => t.sync_id === phoneTaskSyncId && t.title === 'Phone task')), 'the phone-created task is now a real row on the desktop');

  // --- idempotent replay: the exact same batch a second time changes nothing new, no error ---
  const replay = await fetch(`${bridge}/exchange`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ deviceId: 'phone-1', sinceSeq: pull1.cursor, changes: [
      { changeId: push1.results[0].changeId, entityType: 'planner_task', entitySyncId: phoneTaskSyncId, op: 'upsert', payload: { title: 'Phone task', status: 'active' }, revision: 1, deviceId: 'phone-1' }
    ] })
  }).then((r) => r.json());
  line(replay.results?.[0]?.status === 'duplicate', 'replaying the identical change is recognised as a duplicate, not re-applied');
  const desktopTasksAfterReplay = await fetch(`${base}/api/planner/tasks`).then(json);
  line(desktopTasksAfterReplay.filter((t) => t.sync_id === phoneTaskSyncId).length === 1, 'the replayed change did not create a second row');

  // --- conflict: desktop edits the same task independently, then a stale phone edit must NOT overwrite it ---
  const localId = desktopTasksAfterReplay.find((t) => t.sync_id === phoneTaskSyncId).id;
  await fetch(`${base}/api/planner/tasks/${localId}`, { method: 'PATCH', headers: mutHeaders, body: JSON.stringify({ title: 'Edited on desktop' }) }).then(json);
  const staleEdit = await fetch(`${bridge}/exchange`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ deviceId: 'phone-1', sinceSeq: pull1.cursor, changes: [
      { changeId: crypto.randomUUID(), entityType: 'planner_task', entitySyncId: phoneTaskSyncId, op: 'upsert', payload: { title: 'Stale phone edit' }, revision: 2, deviceId: 'phone-1' }
    ] })
  }).then((r) => r.json());
  line(staleEdit.results?.[0]?.status === 'conflict', 'a stale phone edit against a task the desktop already advanced is flagged as a conflict, not applied');
  const stillDesktopTitle = (await fetch(`${base}/api/planner/tasks`).then(json)).find((t) => t.id === localId)?.title;
  line(stillDesktopTitle === 'Edited on desktop', "the desktop's own edit survives the conflicting phone push untouched");

  // --- task + its completion event in ONE batch: task must apply before the event that references it ---
  const orderedTaskId = crypto.randomUUID();
  const orderedEventId = crypto.randomUUID();
  const ordered = await fetch(`${bridge}/exchange`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ deviceId: 'phone-1', sinceSeq: pull1.cursor, changes: [
      { changeId: crypto.randomUUID(), entityType: 'planner_task', entitySyncId: orderedTaskId, op: 'upsert', payload: { title: 'Order test', status: 'active' }, revision: 1, deviceId: 'phone-1' },
      { changeId: crypto.randomUUID(), entityType: 'planner_task_event', entitySyncId: orderedEventId, op: 'upsert', payload: { taskSyncId: orderedTaskId, eventType: 'completed', fromStatus: 'active', toStatus: 'completed' }, revision: 1, deviceId: 'phone-1' }
    ] })
  }).then((r) => r.json());
  line(ordered.results.every((r) => r.status === 'applied'), 'a task and its own lifecycle event in one batch both apply (task-before-event ordering holds)');
  const orderedTaskLocal = (await fetch(`${base}/api/planner/tasks`).then(json)).find((t) => t.sync_id === orderedTaskId);
  const orderedEvents = orderedTaskLocal ? await fetch(`${base}/api/planner/tasks/${orderedTaskLocal.id}/events`).then(json) : [];
  line(orderedEvents.some((e) => e.eventType === 'completed'), "the event actually landed against the right task's own event history");

  if (failures) {
    console.error(`${failures} sync-exchange check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('All sync-exchange checks passed.');
  }
} catch (error) {
  console.error('Sync-exchange verification crashed:', error);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  try { fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
  catch { /* best-effort temp cleanup; a locked handle here must never mask the real test result above */ }
}
