#!/usr/bin/env node
// Focused Planner lifecycle acceptance on a disposable database. Completion
// history is append-only and explicitly unverified; no event is treated as
// independent proof of the real-world outcome.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { removeInstalledChatFixture, stopInstalledChatServer } from './installed-chat-lifecycle.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-planner-history-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
let activeDbPath = dbPath;
let server = null;
let base = '';
let csrf = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

async function startServer() {
  fs.mkdirSync(path.dirname(activeDbPath), { recursive: true });
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: appRoot,
    env: { ...process.env, LIFE_PLANNER_DB: activeDbPath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const serverBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Planner history server exited early (${child.exitCode}): ${output.join('')}`);
    try { if ((await fetch(`${serverBase}/api/health`)).ok) return { child, base: serverBase }; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Planner history server did not become healthy: ${output.join('')}`);
}

async function connect(databasePath = activeDbPath) {
  activeDbPath = databasePath;
  server = await startServer();
  base = server.base;
  csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
}

async function restart() {
  await stopInstalledChatServer(server?.child);
  server = null;
  await connect();
}

async function api(route, { method = 'GET', json, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') {
    headers.Origin = base;
    headers['X-LPS-CSRF'] = csrf;
  }
  if (key) headers['X-LPS-Idempotency-Key'] = key;
  const response = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON failure */ }
  return { status: response.status, body };
}

async function createTask(title) {
  const response = await api('/api/planner/tasks', { method: 'POST', json: { title } });
  assert.equal(response.status, 200);
  return response.body.data;
}

async function events(id) {
  const response = await api(`/api/planner/tasks/${id}/events`);
  assert.equal(response.status, 200);
  return response.body.data;
}

async function evidence(id, beforeId = null) {
  const response = await api(`/api/planner/tasks/${id}/evidence${beforeId ? `?beforeId=${beforeId}` : ''}`);
  assert.equal(response.status, 200);
  return response.body.data;
}

try {
  await connect();

  const direct = await createTask('Direct completion history');
  const first = await api(`/api/planner/tasks/${direct.id}/complete`, { method: 'POST', json: {}, key: 'planner-history-direct-0001' });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.status, 'completed');
  assert.ok(first.body.data.completed_at, 'direct completion sets completed_at');
  let directEvents = await events(direct.id);
  assert.equal(directEvents.length, 1);
  assert.deepEqual(
    [directEvents[0].eventType, directEvents[0].fromStatus, directEvents[0].toStatus, directEvents[0].verificationState],
    ['completed', 'active', 'completed', 'unverified']
  );
  assert.equal(directEvents[0].evidenceAvailable, false, 'status history does not fabricate verification evidence');
  assert.equal(directEvents[0].independentlyVerified, false);
  assert.equal(directEvents[0].supportingEvidenceCount, 0);
  assert.deepEqual(Object.keys(directEvents[0]).sort(), [
    'actor', 'createdAt', 'eventType', 'evidenceAvailable', 'fromStatus', 'id', 'independentlyVerified', 'source', 'supportingEvidenceCount', 'toStatus', 'verificationState'
  ], 'public history exposes only the bounded lifecycle DTO');

  const replay = await api(`/api/planner/tasks/${direct.id}/complete`, { method: 'POST', json: {}, key: 'planner-history-direct-0001' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.replayed, true, 'lost-response retry replays its first result');
  assert.equal((await events(direct.id)).length, 1, 'lost-response retry appends no duplicate event');
  await api(`/api/planner/tasks/${direct.id}/complete`, { method: 'POST', json: {}, key: 'planner-history-direct-0002' });
  assert.equal((await events(direct.id)).length, 1, 'already-completed request appends no false second completion');

  const missingKey = await api(`/api/planner/tasks/${direct.id}/evidence`, { method: 'POST', json: { evidenceKind: 'user_assertion', claim: 'I completed the recorded task.' } });
  assert.equal(missingKey.status, 400, 'evidence writes require a durable idempotency key');
  const traversal = await api(`/api/planner/tasks/${direct.id}/evidence`, { method: 'POST', key: 'planner-evidence-invalid-path', json: { evidenceKind: 'artifact_reference', claim: 'A local artifact supports this.', reference: '../private.txt' } });
  assert.equal(traversal.status, 400, 'artifact evidence rejects path traversal');
  const credentialUrl = await api(`/api/planner/tasks/${direct.id}/evidence`, { method: 'POST', key: 'planner-evidence-invalid-url0', json: { evidenceKind: 'external_reference', claim: 'An external record supports this.', reference: 'https://user:secret@example.com/result' } });
  assert.equal(credentialUrl.status, 400, 'external evidence rejects embedded credentials');
  const expandingUrl = 'https://example.com/' + ' '.repeat(499 - 'https://example.com/'.length) + 'x';
  const normalizedOverflow = await api(`/api/planner/tasks/${direct.id}/evidence`, { method: 'POST', key: 'planner-evidence-invalid-url1', json: { evidenceKind: 'external_reference', claim: 'An oversized normalized URL must fail safely.', reference: expandingUrl } });
  assert.equal(normalizedOverflow.status, 400, 'URL canonicalization cannot turn accepted input into a database-length 500');

  const firstEvidence = await api(`/api/planner/tasks/${direct.id}/evidence`, {
    method: 'POST', key: 'planner-evidence-attach-0001',
    json: { completionEventId: directEvents[0].id, evidenceKind: 'user_assertion', claim: 'I completed the recorded task.' }
  });
  assert.equal(firstEvidence.status, 200);
  assert.equal(firstEvidence.body.data.status, 'active');
  assert.equal(firstEvidence.body.data.verificationState, 'unverified');
  assert.equal(firstEvidence.body.data.independentlyVerified, false);
  assert.equal(firstEvidence.body.data.reference, null);
  const boundedEvidence = (await evidence(direct.id)).items[0];
  assert.deepEqual(Object.keys(boundedEvidence).sort(), [
    'actor', 'claim', 'completionEventId', 'createdAt', 'evidenceKind', 'id', 'independentlyVerified', 'reference', 'replacedByEvidenceId', 'revocationReason', 'revokedAt', 'revokedBy', 'source', 'status', 'supersedesEvidenceId', 'verificationState'
  ], 'supporting evidence exposes only the bounded public DTO');
  const evidenceReplay = await api(`/api/planner/tasks/${direct.id}/evidence`, {
    method: 'POST', key: 'planner-evidence-attach-0001',
    json: { completionEventId: directEvents[0].id, evidenceKind: 'user_assertion', claim: 'I completed the recorded task.' }
  });
  assert.equal(evidenceReplay.body.data.replayed, true);
  assert.equal((await evidence(direct.id)).items.length, 1, 'attachment replay does not duplicate evidence');
  const evidenceConflict = await api(`/api/planner/tasks/${direct.id}/evidence`, {
    method: 'POST', key: 'planner-evidence-attach-0001',
    json: { completionEventId: directEvents[0].id, evidenceKind: 'user_assertion', claim: 'A conflicting retry.' }
  });
  assert.equal(evidenceConflict.status, 409, 'same evidence key with a different claim fails closed');

  const replacement = await api(`/api/planner/tasks/${direct.id}/evidence`, {
    method: 'POST', key: 'planner-evidence-replace-001',
    json: { completionEventId: directEvents[0].id, evidenceKind: 'artifact_reference', claim: 'The saved checklist supports completion.', reference: 'records/checklist.md', supersedesEvidenceId: firstEvidence.body.data.id }
  });
  assert.equal(replacement.status, 200);
  let directEvidence = (await evidence(direct.id)).items;
  assert.deepEqual(directEvidence.map((item) => item.status), ['replaced', 'active'], 'replacement preserves and marks the prior evidence');
  directEvents = await events(direct.id);
  assert.equal(directEvents[0].supportingEvidenceCount, 1);
  assert.equal(directEvents[0].evidenceAvailable, true, 'event truthfully reports active supporting evidence without claiming verification');
  let directDay = (await api('/api/planner/day')).body.data.recentlyCompleted.find((task) => task.id === direct.id);
  assert.equal(directDay.supportingEvidenceCount, 1);
  assert.equal(directDay.verificationState, 'unverified');
  assert.equal(directDay.independentlyVerified, false);

  const patchTask = await createTask('PATCH completion history');
  const patched = await api(`/api/planner/tasks/${patchTask.id}`, { method: 'PATCH', json: { status: 'completed' }, key: 'planner-history-patch-0001' });
  assert.equal(patched.status, 200);
  assert.ok(patched.body.data.completed_at, 'ordinary PATCH completion now sets completed_at');
  assert.equal((await events(patchTask.id))[0].eventType, 'completed');

  await api(`/api/planner/tasks/${direct.id}`, { method: 'PATCH', json: { status: 'active' }, key: 'planner-history-reopen-0001' });
  assert.equal((await api('/api/planner/tasks')).body.data.find((task) => task.id === direct.id).completed_at, null, 'reopen clears the current completion timestamp');
  await api(`/api/planner/tasks/${direct.id}/complete`, { method: 'POST', json: {}, key: 'planner-history-direct-0003' });
  directEvents = await events(direct.id);
  assert.deepEqual(directEvents.map((event) => event.eventType), ['completed', 'reopened', 'completed']);
  assert.equal(directEvents.filter((event) => event.eventType === 'completed').length, 2, 're-completion is a separate retained completion');
  directDay = (await api('/api/planner/day')).body.data.recentlyCompleted.find((task) => task.id === direct.id);
  assert.equal(directDay.supportingEvidenceCount, 0, 'evidence for an older completion is not carried into re-completion');
  assert.equal(directDay.evidenceState, 'none-attached');
  const historicalBinding = await api(`/api/planner/tasks/${direct.id}/evidence`, {
    method: 'POST', key: 'planner-evidence-stale-bind1',
    json: { completionEventId: directEvents[0].id, evidenceKind: 'user_assertion', claim: 'This explicitly supports the earlier completion only.' }
  });
  assert.equal(historicalBinding.status, 200, 'evidence may be attached later to an explicit historical completion');
  directDay = (await api('/api/planner/day')).body.data.recentlyCompleted.find((task) => task.id === direct.id);
  assert.equal(directDay.supportingEvidenceCount, 0, 'late historical evidence never leaks into the current completion count');
  const currentCompletion = directEvents.at(-1);
  const currentEvidence = await api(`/api/planner/tasks/${direct.id}/evidence`, {
    method: 'POST', key: 'planner-evidence-current-001',
    json: { completionEventId: currentCompletion.id, evidenceKind: 'external_reference', claim: 'A public result page supports this completion.', reference: 'https://example.com/result' }
  });
  assert.equal(currentEvidence.status, 200);
  const revoked = await api(`/api/planner/tasks/${direct.id}/evidence/${currentEvidence.body.data.id}/revoke`, {
    method: 'POST', key: 'planner-evidence-current-001', json: { reason: 'The linked result is no longer applicable.' }
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.data.status, 'revoked');
  assert.equal(revoked.body.data.independentlyVerified, false);
  assert.equal(revoked.body.data.revocationReason, 'The linked result is no longer applicable.');
  assert.equal(revoked.body.data.revokedBy, 'user');
  assert.ok(revoked.body.data.revokedAt);
  const revokeReplay = await api(`/api/planner/tasks/${direct.id}/evidence/${currentEvidence.body.data.id}/revoke`, {
    method: 'POST', key: 'planner-evidence-current-001', json: { reason: 'The linked result is no longer applicable.' }
  });
  assert.equal(revokeReplay.status, 200, 'a lost-response revocation retry replays after the state becomes visible');
  assert.equal(revokeReplay.body.data.replayed, true);
  assert.equal((await evidence(direct.id)).items.filter((item) => item.id === currentEvidence.body.data.id).length, 1, 'revocation replay appends no second ledger record');
  directDay = (await api('/api/planner/day')).body.data.recentlyCompleted.find((task) => task.id === direct.id);
  assert.equal(directDay.supportingEvidenceCount, 0, 'revoked evidence is not counted as active support');

  const deferred = await createTask('Defer then complete');
  await api(`/api/planner/tasks/${deferred.id}/defer`, { method: 'POST', json: {}, key: 'planner-history-defer-0001' });
  await api(`/api/planner/tasks/${deferred.id}/complete`, { method: 'POST', json: {}, key: 'planner-history-defer-0002' });
  assert.deepEqual((await events(deferred.id)).map((event) => event.eventType), ['deferred', 'completed']);

  const concurrent = await createTask('Concurrent completion history');
  const concurrentResults = await Promise.all([
    api(`/api/planner/tasks/${concurrent.id}/complete`, { method: 'POST', json: {}, key: 'planner-history-concurrent-a' }),
    api(`/api/planner/tasks/${concurrent.id}/complete`, { method: 'POST', json: {}, key: 'planner-history-concurrent-b' })
  ]);
  assert.ok(concurrentResults.every((result) => result.status === 200));
  assert.equal((await events(concurrent.id)).length, 1, 'near-concurrent completion converges on one transition event');

  const sessions = (await api('/api/chat/sessions')).body.data;
  const sessionId = sessions[0].id;
  const chatTask = await createTask('Chat-confirmed completion history');
  const proposed = await api('/api/actions/planner.propose_update/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { id: chatTask.id, changes: { status: 'completed' } } }
  });
  assert.equal(proposed.status, 200);
  assert.equal(proposed.body.data.status, 'needs_confirmation');
  const confirmation = proposed.body.data.confirmation;
  const confirmed = await api(`/api/chat/sessions/${sessionId}/planner/confirm`, {
    method: 'POST',
    json: { confirmationId: confirmation.confirmationId, token: confirmation.token }
  });
  assert.equal(confirmed.status, 200);
  const chatEvents = await events(chatTask.id);
  assert.equal(chatEvents.length, 1);
  assert.equal(chatEvents[0].source, 'chat-confirmation');
  assert.equal(chatEvents[0].verificationState, 'unverified');
  assert.equal((await api(`/api/chat/sessions/${sessionId}/planner/confirm`, { method: 'POST', json: { confirmationId: confirmation.confirmationId, token: confirmation.token } })).status, 400);
  assert.equal((await events(chatTask.id)).length, 1, 'Chat confirmation replay appends no duplicate history');

  const staleTask = await createTask('Stale Chat completion');
  const staleProposal = await api('/api/actions/planner.propose_update/invoke', {
    method: 'POST', json: { session_id: sessionId, args: { id: staleTask.id, changes: { status: 'completed' } } }
  });
  await api(`/api/planner/tasks/${staleTask.id}`, { method: 'PATCH', json: { title: 'Changed after proposal' } });
  const staleConfirmation = staleProposal.body.data.confirmation;
  assert.equal((await api(`/api/chat/sessions/${sessionId}/planner/confirm`, { method: 'POST', json: { confirmationId: staleConfirmation.confirmationId, token: staleConfirmation.token } })).status, 400);
  assert.equal((await events(staleTask.id)).length, 0, 'stale confirmation writes neither state nor history');

  await stopInstalledChatServer(server.child);
  server = null;
  const database = new DatabaseSync(dbPath);
  const legacyId = database.prepare("INSERT INTO planner_tasks (title, status, completed_at, updated_at) VALUES (?, 'completed', ?, ?)")
    .run('Legacy completed task', '2099-12-31T23:59:59.000Z', '2099-12-31T23:59:59.000Z').lastInsertRowid;
  const mixedOlderId = database.prepare("INSERT INTO planner_tasks (title, status, completed_at, updated_at) VALUES (?, 'completed', ?, ?)")
    .run('Mixed timestamp older', '2098-12-31 12:00:00', '2098-12-31 12:00:00').lastInsertRowid;
  const mixedNewerId = database.prepare("INSERT INTO planner_tasks (title, status, completed_at, updated_at) VALUES (?, 'completed', ?, ?)")
    .run('Mixed timestamp newer', '2098-12-31T13:00:00.000Z', '2098-12-31T13:00:00.000Z').lastInsertRowid;
  const boundedTaskId = database.prepare("INSERT INTO planner_tasks (title) VALUES (?)").run('Bounded public history').lastInsertRowid;
  const addEvent = database.prepare(`INSERT INTO planner_task_events
    (task_id, event_type, from_status, to_status, actor, source, reference) VALUES (?, ?, ?, ?, 'user', 'acceptance-probe', ?)`);
  for (let index = 0; index < 55; index += 1) {
    const completed = index % 2 === 0;
    addEvent.run(boundedTaskId, completed ? 'completed' : 'reopened', completed ? 'active' : 'completed', completed ? 'completed' : 'active', `bounded-${index}`);
  }
  const boundedCompletionId = database.prepare("SELECT id FROM planner_task_events WHERE task_id = ? AND event_type = 'completed' ORDER BY id DESC LIMIT 1").get(boundedTaskId).id;
  const addEvidence = database.prepare(`INSERT INTO planner_task_evidence
    (task_id, completion_event_id, record_type, evidence_kind, claim, actor, source, internal_reference)
    VALUES (?, ?, 'attached', 'user_assertion', ?, 'user', 'acceptance-probe', ?)`);
  for (let index = 0; index < 55; index += 1) addEvidence.run(boundedTaskId, boundedCompletionId, `Evidence ${index}`, `evidence-${index}`);
  database.close();
  await connect();
  assert.equal((await events(legacyId)).length, 0, 'migration does not fabricate history for legacy completed tasks');
  const day = (await api('/api/planner/day')).body.data;
  const legacy = day.recentlyCompleted.find((task) => task.id === Number(legacyId));
  assert.equal(legacy?.completionHistoryAvailable, false);
  assert.equal(legacy?.completionEventCount, 0);
  assert.equal(legacy?.evidenceState, 'history-unavailable');
  assert.equal(legacy?.verificationState, 'unknown');
  assert.equal((await api(`/api/planner/tasks/${legacyId}/evidence`, { method: 'POST', key: 'planner-evidence-legacy-0001', json: { evidenceKind: 'user_assertion', claim: 'Do not fabricate a completion binding.' } })).status, 409, 'legacy completion cannot receive evidence without a real completion event');
  assert.ok(day.recentlyCompleted.findIndex((task) => task.id === Number(mixedNewerId)) < day.recentlyCompleted.findIndex((task) => task.id === Number(mixedOlderId)), 'mixed SQLite/ISO timestamps retain chronological ordering');
  const boundedEvents = await events(boundedTaskId);
  assert.equal(boundedEvents.length, 50, 'public lifecycle history is capped to the latest 50 events');
  assert.equal(boundedEvents[0].id < boundedEvents.at(-1).id, true, 'bounded response remains chronological');
  const firstEvidencePage = await evidence(boundedTaskId);
  assert.equal(firstEvidencePage.items.length, 50, 'each evidence page is capped to 50 records');
  assert.ok(firstEvidencePage.nextBeforeId, 'a full page exposes a cursor for retained older evidence');
  const secondEvidencePage = await evidence(boundedTaskId, firstEvidencePage.nextBeforeId);
  assert.equal(secondEvidencePage.items.length, 5, 'the cursor retrieves every retained older evidence record');
  assert.equal(secondEvidencePage.nextBeforeId, null);
  assert.equal((await api(`/api/planner/tasks/${boundedTaskId}/evidence?beforeId=invalid`)).status, 400, 'malformed evidence cursors fail closed');

  await restart();
  assert.deepEqual((await events(direct.id)).map((event) => event.eventType), ['completed', 'reopened', 'completed'], 'ordered lifecycle history survives restart');
  directEvidence = (await evidence(direct.id)).items;
  assert.deepEqual(directEvidence.map((item) => item.status), ['replaced', 'active', 'active', 'revoked'], 'historical attachment, replacement, and revocation survive restart');

  // Real legacy-schema migration: start from the pre-history planner_tasks
  // table, then let current migration add only the event owner. No fabricated
  // event or verification state may appear for the existing completed row.
  await stopInstalledChatServer(server.child);
  server = null;
  const legacyDbPath = path.join(probeRoot, 'legacy', 'life-planner.sqlite');
  fs.mkdirSync(path.dirname(legacyDbPath), { recursive: true });
  const legacyDatabase = new DatabaseSync(legacyDbPath);
  legacyDatabase.exec(`CREATE TABLE planner_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '',
    definition_of_done TEXT NOT NULL DEFAULT '', easier_version TEXT NOT NULL DEFAULT '', pause_point TEXT NOT NULL DEFAULT '', recovery_step TEXT NOT NULL DEFAULT '',
    importance INTEGER NOT NULL DEFAULT 3, effort INTEGER NOT NULL DEFAULT 3, estimated_minutes INTEGER, deadline TEXT, blocker TEXT NOT NULL DEFAULT '',
    needs_others INTEGER NOT NULL DEFAULT 0, is_recovery INTEGER NOT NULL DEFAULT 0, consequence_of_delay TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
  )`);
  const migratedLegacyId = legacyDatabase.prepare("INSERT INTO planner_tasks (title, status, completed_at) VALUES (?, 'completed', CURRENT_TIMESTAMP)").run('Pre-history completed task').lastInsertRowid;
  legacyDatabase.close();
  await connect(legacyDbPath);
  assert.equal((await events(migratedLegacyId)).length, 0, 'pre-history schema migration preserves completed status without fabricating an event');
  const migratedLegacy = (await api('/api/planner/tasks')).body.data.find((task) => task.id === Number(migratedLegacyId));
  assert.equal(migratedLegacy.status, 'completed');
  assert.ok(migratedLegacy.completed_at);

  const atomicTask = await createTask('Atomic event failure');
  const damageDatabase = new DatabaseSync(legacyDbPath);
  damageDatabase.exec('DROP TABLE planner_task_events');
  damageDatabase.close();
  const failedCompletion = await api(`/api/planner/tasks/${atomicTask.id}/complete`, { method: 'POST', json: {}, key: 'planner-history-atomic-fail' });
  assert.equal(failedCompletion.status, 500, 'required event persistence failure remains visible');
  const atomicAfter = (await api('/api/planner/tasks')).body.data.find((task) => task.id === atomicTask.id);
  assert.equal(atomicAfter.status, 'active', 'event failure rolls back the task state mutation');
  assert.equal(atomicAfter.completed_at, null, 'event failure rolls back completed_at');
  console.log('Planner completion history and supporting-evidence acceptance passed: bounded unverified DTOs, attachment/replay/replacement/revocation, completion binding, legacy truth, and restart persistence.');
} finally {
  if (server?.child) await stopInstalledChatServer(server.child);
  await removeInstalledChatFixture(probeRoot);
}
