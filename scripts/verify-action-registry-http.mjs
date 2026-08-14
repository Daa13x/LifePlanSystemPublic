#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// HTTP acceptance for the bounded neutral action-gateway slices. It uses a
// disposable database with the OLD chat_audit schema so correlation-column
// migration, CSRF, manifest inspection, structured outcomes, durable Workboard
// confirmation, compatibility, and audit linkage are exercised without user data.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-action-registry-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const legacy = new DatabaseSync(dbPath);
legacy.exec(`
  CREATE TABLE chat_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    capability TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'ok',
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
legacy.close();

let failures = 0;
const line = (ok, message) => { if (!ok) failures += 1; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`); };

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
    env: {
      ...process.env,
      LIFE_PLANNER_DB: dbPath,
      LIFE_PLANNER_PORT: String(port),
      LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing.json')
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
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base }; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy.\n${output.join('')}`);
}

async function retryStart(attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await startServer(await freePort()); }
    catch (error) {
      lastError = error;
      if (!/exited early|not become healthy/i.test(String(error?.message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function stopServer(child) {
  if (child.exitCode === null) child.kill();
  for (let i = 0; i < 40 && child.exitCode === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
}

let base = '';
let csrf = '';
async function api(route, { method = 'GET', json, includeCsrf = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') {
    headers.Origin = base;
    if (includeCsrf) headers['X-LPS-CSRF'] = csrf;
  }
  const response = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON failure */ }
  return { status: response.status, body };
}

console.log('--- action registry HTTP verification ---');
let server = await retryStart();
base = server.base;
let sessionId = 0;
let phantomCorrelationId = '';
let knowledgeReadCorrelationId = '';
let workboardReadCorrelationId = '';
const knowledgePreviewTitle = 'Knowledge preview fixture';
const knowledgePreviewBody = `Preview body marker ${'z'.repeat(1400)}`;
try {
  csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
  const createdSession = await api('/api/chat/sessions', { method: 'POST', json: { title: 'Action registry verification' } });
  sessionId = Number(createdSession.body?.data?.id);
  line(createdSession.status === 200 && Number.isInteger(sessionId) && sessionId > 0, 'audit verification uses a real persisted chat session');
  const createdKnowledge = await api('/api/items', {
    method: 'POST',
    json: { type: 'note', title: knowledgePreviewTitle, body: knowledgePreviewBody, status: 'active', confidence: 0.77 }
  });
  const knowledgeRecordId = Number(createdKnowledge.body?.data?.id);
  line(createdKnowledge.status === 200 && Number.isInteger(knowledgeRecordId) && knowledgeRecordId > 0, 'disposable Knowledge preview fixture is persisted');
  const fixtureDb = new DatabaseSync(dbPath);
  fixtureDb.prepare("INSERT INTO projects (id, name, status, owner, source, confidence, evidence, next_action) VALUES (700001, 'Typed project fixture', 'active', 'user', 'manual', 0.8, 'Project evidence', 'Project next')").run();
  fixtureDb.prepare("INSERT INTO knowledge_items (id, type, title, body, source, status, confidence, evidence, owner, next_action, project_id) VALUES (700002, 'goal', 'Typed item fixture', 'Item detail', 'manual', 'active', 0.7, 'Item evidence', 'user', 'Item next', 700001)").run();
  fixtureDb.prepare("INSERT INTO roadmap_items (id, title, detail, resume_notes, category, status) VALUES (700003, 'Typed roadmap fixture', 'Roadmap detail', 'Resume detail', 'feature', 'planned')").run();
  fixtureDb.prepare("INSERT INTO approvals (id, action_type, title, payload, status, priority) VALUES (700004, 'update_project', 'Typed approval fixture', '{\"private\":\"must not leak\"}', 'pending', 'P1')").run();
  fixtureDb.prepare("INSERT INTO memory_candidates (id, type, title, body, source, evidence, confidence, status) VALUES (700005, 'note', 'Typed candidate fixture', 'Candidate detail', 'fixture', 'Candidate evidence', 0.5, 'candidate')").run();
  fixtureDb.prepare("INSERT INTO knowledge_items (id, type, title, body, source, status, confidence, evidence, owner, next_action) VALUES (700006, 'note', ?, ?, ?, 'active', 0.5, ?, 'user', ?)")
    .run('T'.repeat(250000), 'B'.repeat(250000), 'S'.repeat(250000), 'E'.repeat(250000), 'N'.repeat(250000));
  fixtureDb.close();

  const catalog = await api('/api/actions');
  const knowledge = catalog.body?.data?.find((action) => action.id === 'knowledge.search');
  const knowledgeRead = catalog.body?.data?.find((action) => action.id === 'knowledge.read');
  const workboardRead = catalog.body?.data?.find((action) => action.id === 'workboard.read');
  const createProposal = catalog.body?.data?.find((action) => action.id === 'workboard.propose_create');
  line(catalog.status === 200 && Boolean(knowledge), 'neutral action catalog exposes knowledge.search');
  line(catalog.body?.data?.length === 5 && Boolean(knowledgeRead) && Boolean(workboardRead) && Boolean(createProposal) && !catalog.body.data.some((action) => action.id === 'workboard.propose_update'), 'neutral catalog adds typed Workboard preview while update remains masked');
  line(knowledge?.permission === 'knowledge.read' && knowledge?.risk === 'READ_ONLY' && knowledge?.confirmation === 'none', 'catalog exposes permission, risk, and confirmation metadata');
  line(knowledgeRead?.permission === 'knowledge.read' && knowledgeRead?.risk === 'READ_ONLY' && knowledgeRead?.confirmation === 'none', 'Knowledge preview remains read-only and confirmation-free');
  line(workboardRead?.permission === 'workboard.detail.read' && workboardRead?.risk === 'SENSITIVE_DATA' && workboardRead?.confirmation === 'none', 'Workboard preview uses a distinct sensitive-detail scope and remains confirmation-free');
  line(createProposal?.permission === 'workboard.propose' && createProposal?.risk === 'REVERSIBLE_WRITE' && createProposal?.confirmation === 'user_confirmation', 'Workboard create advertises its write risk and user-confirmation requirement');
  line(!('handler' in (knowledge || {})) && !('check' in (knowledge?.availability || {})), 'catalog never exposes executable handler/check functions');

  const inspect = await api('/api/actions/knowledge.search');
  line(inspect.status === 200 && inspect.body?.data?.availability?.available === true && inspect.body?.data?.permitted === true, 'action inspection reports live availability and permission');
  line((await api('/api/actions/missing.action')).status === 404, 'unknown action inspection returns 404');
  line((await api('/api/actions/workboard.propose_create')).status === 200, 'durably bound Workboard create is inspectable');
  line((await api('/api/actions/workboard.read')).status === 200, 'typed Workboard read is inspectable');
  line((await api('/api/actions/workboard.propose_update')).status === 404, 'unbound Workboard update remains masked');

  const withoutCsrf = await api('/api/actions/knowledge.search/invoke', { method: 'POST', json: { args: { query: 'fixture' } }, includeCsrf: false });
  line(withoutCsrf.status === 403, 'action invocation without CSRF is rejected');

  const first = await api('/api/actions/knowledge.search/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { query: 'no-such-action-registry-fixture', scope: 'all', limit: 3 } }
  });
  const firstResult = first.body?.data;
  line(first.status === 200 && firstResult?.status === 'success' && Array.isArray(firstResult?.data?.items), 'authorised read action returns structured success');
  line(typeof firstResult?.correlationId === 'string' && firstResult.correlationId.length >= 8, 'success carries a correlation ID');

  const second = await api('/api/actions/knowledge.search/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { query: 'another-empty-fixture', scope: 'all', limit: 1 } }
  });
  line(second.body?.data?.correlationId && second.body.data.correlationId !== firstResult?.correlationId, 'separate invocations receive unique correlation IDs');

  const contextBeforePreview = await api(`/api/chat/sessions/${sessionId}/context-records`);
  const knowledgePreview = await api('/api/actions/knowledge.read/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { id: knowledgeRecordId, kind: 'item' } }
  });
  const previewResult = knowledgePreview.body?.data;
  knowledgeReadCorrelationId = previewResult?.correlationId || '';
  const contextAfterPreview = await api(`/api/chat/sessions/${sessionId}/context-records`);
  line(knowledgePreview.status === 200 && previewResult?.status === 'success' && previewResult?.data?.id === knowledgeRecordId && previewResult?.data?.title === knowledgePreviewTitle, 'Knowledge preview returns the requested typed record');
  line(previewResult?.data?.body?.startsWith('Preview body marker ') && previewResult.data.body.includes('[truncated ') && previewResult.data.body.length <= 1200, 'Knowledge preview body is visibly and strictly bounded');
  line(previewResult?.data?.provenance?.source === 'manual' && previewResult?.data?.provenance?.status === 'active' && previewResult?.data?.provenance?.confidence === 0.77, 'Knowledge preview includes authoritative provenance');
  line(contextBeforePreview.body?.data?.length === 0 && contextAfterPreview.body?.data?.length === 0, 'previewing Knowledge creates no chat attachment');
  const invalidReadKind = await api('/api/actions/knowledge.read/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { id: knowledgeRecordId, kind: 'project' } }
  });
  line(invalidReadKind.body?.data?.status === 'blocked' && invalidReadKind.body?.data?.error?.code === 'INVALID_ARGUMENTS', 'Knowledge preview rejects an invalid record kind before the handler');
  const missingRead = await api('/api/actions/knowledge.read/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { id: 999999999, kind: 'item' } }
  });
  line(missingRead.body?.data?.status === 'failed' && missingRead.body?.data?.error?.code === 'HANDLER_FAILED' && /Reference /.test(missingRead.body?.data?.error?.message || '') && !String(missingRead.body?.data?.error?.message).includes('999999999'), 'missing Knowledge preview fails without exposing handler internals');

  const workboardContextBefore = await api(`/api/chat/sessions/${sessionId}/context-records`);
  const typedFixtures = [
    ['project', 700001, 'Typed project fixture'],
    ['item', 700002, 'Typed item fixture'],
    ['roadmap', 700003, 'Typed roadmap fixture'],
    ['approval', 700004, 'Typed approval fixture'],
    ['candidate', 700005, 'Typed candidate fixture']
  ];
  for (const [type, id, title] of typedFixtures) {
    const readResult = await api('/api/actions/workboard.read/invoke', { method: 'POST', json: { session_id: sessionId, args: { type, id } } });
    const action = readResult.body?.data;
    if (type === 'project') workboardReadCorrelationId = action?.correlationId || '';
    line(readResult.status === 200 && action?.status === 'success' && action?.data?.identity?.type === type && action?.data?.identity?.id === id && action?.data?.title === title, `typed Workboard read resolves only ${type}:${id}`);
  }
  const workboardContextAfter = await api(`/api/chat/sessions/${sessionId}/context-records`);
  line(workboardContextBefore.body?.data?.length === workboardContextAfter.body?.data?.length, 'previewing Workboard records creates no chat attachment');
  const projectCard = await api('/api/workboard/cards/700001');
  const projectRead = await api('/api/actions/workboard.read/invoke', { method: 'POST', json: { session_id: sessionId, args: { type: 'project', id: 700001 } } });
  line(projectCard.body?.data?.pinned?.title === projectRead.body?.data?.data?.title && projectCard.body?.data?.pinned?.status === projectRead.body?.data?.data?.status && projectCard.body?.data?.execution?.subtasks?.[0]?.id === projectRead.body?.data?.data?.children?.[0]?.identity?.id, 'action-registry project read matches the canonical layered Workboard UI projection');
  const crossType = await api('/api/actions/workboard.read/invoke', { method: 'POST', json: { session_id: sessionId, args: { type: 'item', id: 700001 } } });
  line(crossType.body?.data?.status === 'failed' && crossType.body?.data?.error?.code === 'HANDLER_FAILED', 'cross-type substitution fails even when the numeric ID exists');
  const unknownType = await api('/api/actions/workboard.read/invoke', { method: 'POST', json: { session_id: sessionId, args: { type: 'lane', id: 700001 } } });
  line(unknownType.body?.data?.status === 'blocked' && unknownType.body?.data?.error?.code === 'INVALID_ARGUMENTS', 'unsupported Workboard entity types fail before lookup');
  const missingTyped = await api('/api/actions/workboard.read/invoke', { method: 'POST', json: { session_id: sessionId, args: { type: 'roadmap', id: 799999 } } });
  line(missingTyped.body?.data?.status === 'failed' && missingTyped.body?.data?.error?.code === 'HANDLER_FAILED', 'deleted or unavailable typed Workboard identities fail safely');
  const noSessionRead = await api('/api/actions/workboard.read/invoke', { method: 'POST', json: { session_id: 987654321, args: { type: 'project', id: 700001 } } });
  line(noSessionRead.body?.data?.status === 'blocked' && noSessionRead.body?.data?.error?.code === 'INVALID_CHAT_SESSION' && !noSessionRead.body?.data?.data, 'Workboard read rejects a nonexistent Chat session before returning record data');
  const legacyNoSessionRead = await api('/api/chat/capability', { method: 'POST', json: { session_id: 987654321, name: 'workboard.read', args: { type: 'project', id: 700001 } } });
  line(legacyNoSessionRead.body?.data?.status === 'blocked' && legacyNoSessionRead.body?.data?.error?.code === 'INVALID_CHAT_SESSION' && !legacyNoSessionRead.body?.data?.data, 'legacy capability access cannot bypass the Workboard read session boundary');
  const oversizedWorkboardRead = await api('/api/actions/workboard.read/invoke', { method: 'POST', json: { session_id: sessionId, args: { type: 'item', id: 700006 } } });
  const oversizedResult = oversizedWorkboardRead.body?.data?.data;
  line(oversizedWorkboardRead.body?.data?.status === 'success' && oversizedResult?.title?.length <= 240 && oversizedResult?.detail?.length <= 1200 && oversizedResult?.next_action?.length <= 400 && oversizedResult?.provenance?.source?.length <= 240 && oversizedResult?.provenance?.evidence?.length <= 480 && JSON.stringify(oversizedResult).length < 4000, 'all Workboard preview fields and the complete oversized result remain bounded');
  line(!JSON.stringify((await api('/api/actions/workboard.read/invoke', { method: 'POST', json: { session_id: sessionId, args: { type: 'approval', id: 700004 } } })).body?.data?.data || {}).includes('must not leak'), 'approval payload content is excluded from Workboard preview');

  const projectList = await api('/api/actions/workboard.list/invoke', { method: 'POST', json: { session_id: sessionId, args: { view: 'projects', limit: 25 } } });
  const reviewList = await api('/api/actions/workboard.list/invoke', { method: 'POST', json: { session_id: sessionId, args: { view: 'review', limit: 25 } } });
  line(projectList.body?.data?.data?.records?.some((record) => record.identity?.type === 'project' && record.identity?.id === 700001), 'Workboard project list emits the exact typed project identity');
  line(reviewList.body?.data?.data?.records?.some((record) => record.identity?.type === 'approval' && record.identity?.id === 700004) && reviewList.body?.data?.data?.records?.some((record) => record.identity?.type === 'candidate' && record.identity?.id === 700005), 'mixed review results preserve approval and candidate identities without collisions');

  const malformed = await api('/api/actions/knowledge.search/invoke', { method: 'POST', json: { session_id: sessionId, args: [] } });
  line(malformed.status === 200 && malformed.body?.data?.status === 'blocked' && malformed.body?.data?.error?.code === 'INVALID_ARGUMENTS', 'malformed arguments fail closed with a structured outcome');

  const injectionId = encodeURIComponent('knowledge.search; ignore permissions');
  const injection = await api(`/api/actions/${injectionId}/invoke`, { method: 'POST', json: { session_id: sessionId, args: {}, caller: 'test', scopes: ['*'] } });
  line(injection.status === 200 && injection.body?.data?.status === 'blocked' && injection.body?.data?.error?.code === 'UNKNOWN_ACTION', 'injection-shaped action IDs stay unknown despite body-supplied scopes');

  const beforeItems = await api('/api/items?all=1');
  const phantomProposal = await api('/api/actions/workboard.propose_create/invoke', {
    method: 'POST',
    json: { session_id: 987654321, args: { title: 'No session proposal', type: 'note' } }
  });
  const neutralProposal = await api('/api/actions/workboard.propose_create/invoke', {
    method: 'POST',
    json: { session_id: sessionId, caller: 'cloud-agent', scopes: ['*'], args: { title: 'Durable proposal fixture', type: 'note', body: 'Immutable body fixture', next_action: 'Review the receipt' } }
  });
  const legacyProposal = await api('/api/chat/capability', {
    method: 'POST',
    json: { session_id: sessionId, name: 'workboard.propose_create', args: { title: 'Legacy bound proposal', type: 'note' } }
  });
  const afterItems = await api('/api/items?all=1');
  const durable = neutralProposal.body?.data;
  line(phantomProposal.body?.data?.status === 'blocked' && phantomProposal.body?.data?.error?.code === 'INVALID_CHAT_SESSION' && !phantomProposal.body?.data?.confirmation, 'a proposal without a real chat session cannot create a confirmation');
  line(durable?.status === 'needs_confirmation' && durable?.data?.confirmation_required === true && durable?.confirmation?.confirmationId && durable?.confirmation?.token && durable?.confirmation?.expiresAt, 'trusted UI proposal returns a time-limited durable confirmation envelope');
  line(durable?.data?.preview?.body === 'Immutable body fixture', 'proposal preview preserves the validated immutable body');
  line(legacyProposal.body?.data?.status === 'needs_confirmation' && legacyProposal.body?.data?.confirmation?.confirmationId, 'legacy proposal compatibility is also durably bound');
  line(beforeItems.body?.data?.length === afterItems.body?.data?.length, 'proposal creation performs no Workboard write');

  const confirmationId = durable?.confirmation?.confirmationId;
  const confirmationToken = durable?.confirmation?.token;
  const storedDb = new DatabaseSync(dbPath, { readOnly: true });
  const stored = storedDb.prepare('SELECT token_hash, session_id, operation, target, after_state, origin FROM confirmations WHERE id = ?').get(confirmationId);
  storedDb.close();
  line(Boolean(stored) && stored.token_hash !== confirmationToken && !JSON.stringify(stored).includes(confirmationToken), 'the raw confirmation token is never stored in SQLite');
  line(stored?.session_id === `chat:${sessionId}` && stored?.operation === 'workboard.create' && stored?.target === `chat:${sessionId}:workboard:new`, 'the confirmation is bound to the real chat, action, and target');
  line(JSON.parse(stored?.after_state || '{}').body === 'Immutable body fixture', 'the stored payload is the validated action arguments');
  line(!String(stored?.origin || '').includes('Durable proposal fixture') && JSON.parse(stored?.origin || '{}').correlationId === durable?.correlationId, 'origin stores correlation provenance without proposal content');

  const rawConfirm = await api(`/api/chat/sessions/${sessionId}/workboard/confirm`, {
    method: 'POST',
    json: { proposal: durable?.data }
  });
  line(rawConfirm.status === 400, 'a fabricated raw proposal is rejected before mutation');

  const wrongToken = await api(`/api/chat/sessions/${sessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId, token: '0'.repeat(64) }
  });
  line(wrongToken.status === 400, 'the wrong confirmation token is rejected');

  const otherSession = await api('/api/chat/sessions', { method: 'POST', json: { title: 'Other action session' } });
  const otherSessionId = Number(otherSession.body?.data?.id);
  const wrongSession = await api(`/api/chat/sessions/${otherSessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId, token: confirmationToken }
  });
  line(wrongSession.status === 400, 'a different chat session cannot apply the confirmation');

  const applyBefore = (await api('/api/items?all=1')).body?.data?.length;
  const confirmed = await api(`/api/chat/sessions/${sessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId, token: confirmationToken }
  });
  const applyAfter = (await api('/api/items?all=1')).body?.data?.length;
  line(confirmed.status === 200 && confirmed.body?.data?.record?.title === 'Durable proposal fixture' && confirmed.body?.data?.record?.body === 'Immutable body fixture', 'confirmation applies only the immutable stored proposal');
  line(applyAfter === applyBefore + 1, 'one successful confirmation creates exactly one Workboard item');
  const replay = await api(`/api/chat/sessions/${sessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId, token: confirmationToken }
  });
  line(replay.status === 400 && (await api('/api/items?all=1')).body?.data?.length === applyAfter, 'a replay is rejected without a second write');

  const tamperProposal = await api('/api/actions/workboard.propose_create/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { title: 'Tamper target', type: 'note' } }
  });
  const tamperConfirmation = tamperProposal.body?.data?.confirmation;
  const tamperDb = new DatabaseSync(dbPath);
  tamperDb.prepare('UPDATE confirmations SET after_state = ? WHERE id = ?').run(JSON.stringify({ type: 'note', title: 'Changed after staging', body: '', next_action: '' }), tamperConfirmation.confirmationId);
  tamperDb.close();
  const tampered = await api(`/api/chat/sessions/${sessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId: tamperConfirmation.confirmationId, token: tamperConfirmation.token }
  });
  line(tampered.status === 400, 'stored-payload tampering is rejected');

  const expiryProposal = await api('/api/actions/workboard.propose_create/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { title: 'Expiry target', type: 'note' } }
  });
  const expiryConfirmation = expiryProposal.body?.data?.confirmation;
  const expiryDb = new DatabaseSync(dbPath);
  expiryDb.prepare('UPDATE confirmations SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expiryConfirmation.confirmationId);
  expiryDb.close();
  const expired = await api(`/api/chat/sessions/${sessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId: expiryConfirmation.confirmationId, token: expiryConfirmation.token }
  });
  line(expired.status === 400, 'an expired Workboard confirmation is rejected');

  const settlementProposal = await api('/api/actions/workboard.propose_create/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { title: 'Atomic settlement target', type: 'note' } }
  });
  const settlementConfirmation = settlementProposal.body?.data?.confirmation;
  const settlementBefore = (await api('/api/items?all=1')).body?.data?.length;
  const settlementDb = new DatabaseSync(dbPath);
  settlementDb.exec(`
    CREATE TRIGGER reject_workboard_applied_settlement
    BEFORE UPDATE OF status ON confirmations
    WHEN NEW.status = 'applied'
    BEGIN
      SELECT RAISE(ABORT, 'settlement rejected');
    END;
  `);
  settlementDb.close();
  const settlementFailure = await api(`/api/chat/sessions/${sessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId: settlementConfirmation.confirmationId, token: settlementConfirmation.token }
  });
  const settlementCleanup = new DatabaseSync(dbPath);
  const settlementStatus = settlementCleanup.prepare('SELECT status FROM confirmations WHERE id = ?').get(settlementConfirmation.confirmationId)?.status;
  settlementCleanup.exec('DROP TRIGGER reject_workboard_applied_settlement');
  settlementCleanup.close();
  const settlementAfter = (await api('/api/items?all=1')).body?.data?.length;
  line(settlementFailure.status === 400 && settlementStatus === 'failed', 'a failed final receipt returns a truthful failed confirmation');
  line(settlementAfter === settlementBefore, 'a failed final receipt rolls back the Workboard item insert');

  const concurrentProposal = await api('/api/actions/workboard.propose_create/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { title: 'Concurrent target', type: 'note' } }
  });
  const concurrentConfirmation = concurrentProposal.body?.data?.confirmation;
  const concurrentBefore = (await api('/api/items?all=1')).body?.data?.length;
  const concurrentResults = await Promise.all([1, 2].map(() => api(`/api/chat/sessions/${sessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId: concurrentConfirmation.confirmationId, token: concurrentConfirmation.token }
  })));
  const concurrentAfter = (await api('/api/items?all=1')).body?.data?.length;
  line(concurrentResults.filter((result) => result.status === 200).length === 1 && concurrentResults.filter((result) => result.status === 400).length === 1, 'concurrent confirmation has exactly one winner');
  line(concurrentAfter === concurrentBefore + 1, 'concurrent confirmation creates exactly one item');

  const restartProposal = await api('/api/actions/workboard.propose_create/invoke', {
    method: 'POST',
    json: { session_id: sessionId, args: { title: 'Restart persistence target', type: 'note' } }
  });
  const restartConfirmation = restartProposal.body?.data?.confirmation;
  await stopServer(server.child);
  server = await retryStart();
  base = server.base;
  csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
  const afterRestart = await api(`/api/chat/sessions/${sessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId: restartConfirmation.confirmationId, token: restartConfirmation.token }
  });
  line(afterRestart.status === 200 && afterRestart.body?.data?.record?.title === 'Restart persistence target', 'a durable confirmation survives a server restart');

  const legacyRoute = await api('/api/chat/capability', {
    method: 'POST',
    json: { session_id: sessionId, name: 'knowledge.search', args: { query: 'legacy-fixture', limit: 1 } }
  });
  line(legacyRoute.status === 200 && legacyRoute.body?.data?.name === 'knowledge.search' && legacyRoute.body?.data?.status === 'success' && legacyRoute.body?.data?.correlationId, 'Chat compatibility endpoint uses the structured registry result');

  const audit = await api(`/api/chat/sessions/${sessionId}/audit`);
  const correlated = audit.body?.data?.find((row) => row.correlation_id === firstResult?.correlationId);
  line(Boolean(correlated) && correlated.capability === 'knowledge.search' && correlated.outcome === 'success', 'audit row links the action, outcome, and correlation ID');
  line(correlated?.detail === 'completed', 'audit detail is a concise receipt rather than the query body');
  const knowledgeReadAudit = audit.body?.data?.find((row) => row.correlation_id === knowledgeReadCorrelationId);
  line(Boolean(knowledgeReadAudit) && knowledgeReadAudit.capability === 'knowledge.read' && knowledgeReadAudit.outcome === 'success' && knowledgeReadAudit.detail === 'completed', 'Knowledge preview audit links its correlation ID to a concise success receipt');
  line(!String(knowledgeReadAudit?.detail).includes(knowledgePreviewTitle) && !String(knowledgeReadAudit?.detail).includes('Preview body marker'), 'Knowledge preview audit stores no title or body content');
  const workboardReadAudit = audit.body?.data?.find((row) => row.correlation_id === workboardReadCorrelationId);
  line(Boolean(workboardReadAudit) && workboardReadAudit.capability === 'workboard.read' && workboardReadAudit.outcome === 'success' && workboardReadAudit.detail === 'completed', 'Workboard preview audit links its correlation ID to a concise success receipt');
  line(!String(workboardReadAudit?.detail).includes('Typed project fixture') && !String(workboardReadAudit?.detail).includes('Project evidence'), 'Workboard preview audit stores no record title or evidence content');
  const proposalAudit = audit.body?.data?.filter((row) => row.correlation_id === durable?.correlationId) || [];
  line(proposalAudit.some((row) => row.capability === 'workboard.propose_create' && row.outcome === 'proposed') && proposalAudit.some((row) => row.capability === 'workboard.create' && row.outcome === 'applied'), 'proposal and application audits share the action correlation ID');
  line(proposalAudit.every((row) => !String(row.detail).includes('Durable proposal fixture') && !String(row.detail).includes('Immutable body fixture') && !String(row.detail).includes(confirmationToken)), 'correlated audit receipts contain no proposal body, title, or token');

  const phantom = await api('/api/actions/knowledge.search/invoke', {
    method: 'POST',
    json: { session_id: 987654321, args: { query: 'phantom-session-attribution-check', limit: 1 } }
  });
  phantomCorrelationId = phantom.body?.data?.correlationId || '';
  line(phantom.body?.data?.status === 'success' && Boolean(phantomCorrelationId), 'a nonexistent body session cannot affect action execution');
} finally {
  await stopServer(server.child);
  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  const columns = migrated.prepare("PRAGMA table_info('chat_audit')").all().map((column) => column.name);
  const phantomAudit = migrated.prepare('SELECT session_id FROM chat_audit WHERE correlation_id = ?').get(phantomCorrelationId);
  migrated.close();
  line(columns.includes('correlation_id'), 'legacy chat_audit schema migrates correlation_id in place');
  line(Boolean(phantomAudit) && phantomAudit.session_id === null, 'nonexistent session IDs are never trusted as audit provenance');
  const resolvedProbe = path.resolve(probeRoot);
  if (resolvedProbe.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolvedProbe).startsWith('lps-action-registry-')) {
    fs.rmSync(resolvedProbe, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} action-registry HTTP check(s) FAILED` : '\nAll action-registry HTTP checks passed.');
process.exit(failures ? 1 : 0);
