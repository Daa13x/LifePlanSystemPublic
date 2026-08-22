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
let systemStatusCorrelationId = '';
let systemModelsCorrelationId = '';
let systemRunsCorrelationId = '';
let conversationSearchCorrelationId = '';
let workboardUpdateCorrelationId = '';
let workboardUpdateToken = '';
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
  const insertUpdateFixture = fixtureDb.prepare("INSERT INTO knowledge_items (id, type, title, body, source, status, confidence, evidence, owner, next_action, due_at) VALUES (?, 'goal', ?, ?, 'manual', 'active', 0.7, 'Update evidence', 'user', ?, '2026-08-31')");
  for (const id of [700010, 700011, 700012, 700013, 700014, 700015, 700016, 700017, 700018]) {
    insertUpdateFixture.run(id, `Update fixture ${id}`, `Body ${id}`, `Next ${id}`);
  }
  fixtureDb.prepare("INSERT INTO chat_sessions (id, title, deleted) VALUES (700100, ?, 0)").run('History title '.repeat(40));
  fixtureDb.prepare("INSERT INTO chat_sessions (id, title, deleted) VALUES (700101, 'Deleted history fixture', 1)").run();
  fixtureDb.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (700100, 'user', ?)").run(`history-marker ${'private-body-'.repeat(80)}`);
  fixtureDb.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (700101, 'user', 'history-marker deleted-content-must-not-appear')").run();
  fixtureDb.close();

  const catalog = await api('/api/actions');
  const knowledge = catalog.body?.data?.find((action) => action.id === 'knowledge.search');
  const knowledgeRead = catalog.body?.data?.find((action) => action.id === 'knowledge.read');
  const workboardRead = catalog.body?.data?.find((action) => action.id === 'workboard.read');
  const createProposal = catalog.body?.data?.find((action) => action.id === 'workboard.propose_create');
  const updateProposal = catalog.body?.data?.find((action) => action.id === 'workboard.propose_update');
  const systemStatus = catalog.body?.data?.find((action) => action.id === 'system.status');
  const systemModels = catalog.body?.data?.find((action) => action.id === 'system.models');
  const systemRuns = catalog.body?.data?.find((action) => action.id === 'system.runs');
  const conversationSearch = catalog.body?.data?.find((action) => action.id === 'conversation.search');
  const plannerToday = catalog.body?.data?.find((action) => action.id === 'planner.today');
  const navigationWorkboard = catalog.body?.data?.find((action) => action.id === 'navigation.workboard');
  const navigationSystem = catalog.body?.data?.find((action) => action.id === 'navigation.system');
  const navigationSettings = catalog.body?.data?.find((action) => action.id === 'navigation.settings');
  const navigationPlanner = catalog.body?.data?.find((action) => action.id === 'navigation.planner');
  const plannerCreate = catalog.body?.data?.find((action) => action.id === 'planner.propose_create');
  const plannerUpdate = catalog.body?.data?.find((action) => action.id === 'planner.propose_update');
  line(catalog.status === 200 && Boolean(knowledge), 'neutral action catalog exposes knowledge.search');
  line(catalog.body?.data?.length === 17 && Boolean(knowledgeRead) && Boolean(workboardRead) && Boolean(createProposal) && Boolean(updateProposal) && Boolean(systemStatus) && Boolean(systemModels) && Boolean(systemRuns) && Boolean(conversationSearch) && Boolean(plannerToday) && Boolean(navigationWorkboard) && Boolean(navigationSystem) && Boolean(navigationSettings) && Boolean(navigationPlanner) && Boolean(plannerCreate) && Boolean(plannerUpdate), 'neutral catalog exposes every bounded registered capability');
  line(plannerCreate?.permission === 'planner.propose' && plannerCreate?.risk === 'REVERSIBLE_WRITE' && plannerCreate?.confirmation === 'user_confirmation', 'planner.propose_create advertises its write risk and user-confirmation requirement');
  line(plannerUpdate?.permission === 'planner.propose' && plannerUpdate?.risk === 'REVERSIBLE_WRITE' && plannerUpdate?.confirmation === 'user_confirmation', 'planner.propose_update advertises its write risk and user-confirmation requirement');
  line(navigationWorkboard?.permission === 'navigation.control' && navigationWorkboard?.risk === 'VIEW_NAVIGATION' && navigationWorkboard?.confirmation === 'none', 'navigation.workboard advertises its bounded view-navigation contract');
  line(navigationSystem?.permission === 'navigation.control' && navigationSystem?.risk === 'VIEW_NAVIGATION' && navigationSystem?.confirmation === 'none', 'navigation.system advertises the same bounded view-navigation contract');
  line(navigationSettings?.permission === 'navigation.control' && navigationSettings?.risk === 'VIEW_NAVIGATION' && navigationSettings?.confirmation === 'none', 'navigation.settings advertises the same bounded view-navigation contract');
  line(navigationPlanner?.permission === 'navigation.control' && navigationPlanner?.risk === 'VIEW_NAVIGATION' && navigationPlanner?.confirmation === 'none', 'navigation.planner advertises the same bounded view-navigation contract');
  line(knowledge?.permission === 'knowledge.read' && knowledge?.risk === 'READ_ONLY' && knowledge?.confirmation === 'none', 'catalog exposes permission, risk, and confirmation metadata');
  line(knowledgeRead?.permission === 'knowledge.read' && knowledgeRead?.risk === 'READ_ONLY' && knowledgeRead?.confirmation === 'none', 'Knowledge preview remains read-only and confirmation-free');
  line(workboardRead?.permission === 'workboard.detail.read' && workboardRead?.risk === 'SENSITIVE_DATA' && workboardRead?.confirmation === 'none', 'Workboard preview uses a distinct sensitive-detail scope and remains confirmation-free');
  line(createProposal?.permission === 'workboard.propose' && createProposal?.risk === 'REVERSIBLE_WRITE' && createProposal?.confirmation === 'user_confirmation', 'Workboard create advertises its write risk and user-confirmation requirement');
  line(updateProposal?.permission === 'workboard.propose' && updateProposal?.risk === 'REVERSIBLE_WRITE' && updateProposal?.confirmation === 'user_confirmation', 'Workboard update advertises its write risk and user-confirmation requirement');
  line(systemStatus?.permission === 'system.read' && systemStatus?.risk === 'READ_ONLY' && systemStatus?.confirmation === 'none', 'system.status advertises its read-only no-confirmation contract');
  line(systemModels?.permission === 'models.read' && systemModels?.risk === 'READ_ONLY' && systemRuns?.permission === 'system.read' && systemRuns?.risk === 'READ_ONLY', 'model and run summaries advertise their read-only contracts');
  line(conversationSearch?.permission === 'chat.history.read' && conversationSearch?.risk === 'SENSITIVE_DATA' && conversationSearch?.confirmation === 'none', 'conversation search advertises its sensitive read-only contract');
  line(plannerToday?.permission === 'planner.today.read' && plannerToday?.risk === 'SENSITIVE_DATA' && plannerToday?.confirmation === 'none', 'Daily Planner advertises its sensitive read-only contract');
  line(!('handler' in (knowledge || {})) && !('check' in (knowledge?.availability || {})), 'catalog never exposes executable handler/check functions');

  const inspect = await api('/api/actions/knowledge.search');
  line(inspect.status === 200 && inspect.body?.data?.availability?.available === true && inspect.body?.data?.permitted === true, 'action inspection reports live availability and permission');
  line((await api('/api/actions/missing.action')).status === 404, 'unknown action inspection returns 404');
  line((await api('/api/actions/workboard.propose_create')).status === 200, 'durably bound Workboard create is inspectable');
  line((await api('/api/actions/workboard.read')).status === 200, 'typed Workboard read is inspectable');
  line((await api('/api/actions/workboard.propose_update')).status === 200, 'durably bound Workboard update is inspectable');
  line((await api('/api/actions/system.status')).status === 200, 'bounded system.status is inspectable');
  line((await api('/api/actions/system.models')).status === 200 && (await api('/api/actions/system.runs')).status === 200, 'bounded system model/run actions are inspectable');
  line((await api('/api/actions/conversation.search')).status === 200, 'session-bound conversation search is inspectable');
  line((await api('/api/actions/planner.today')).status === 200, 'session-bound Daily Planner is inspectable');

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

  const statusContextBefore = await api(`/api/chat/sessions/${sessionId}/context-records`);
  const statusItemsBefore = await api('/api/items?all=1');
  const statusConfirmationsBeforeDb = new DatabaseSync(dbPath, { readOnly: true });
  const statusConfirmationsBefore = Number(statusConfirmationsBeforeDb.prepare('SELECT COUNT(*) AS count FROM confirmations').get()?.count || 0);
  statusConfirmationsBeforeDb.close();
  const statusResponse = await api('/api/actions/system.status/invoke', { method: 'POST', json: { session_id: sessionId, caller: 'cloud-agent', scopes: ['*'], args: {} } });
  const statusAction = statusResponse.body?.data;
  systemStatusCorrelationId = statusAction?.correlationId || '';
  const statusContextAfter = await api(`/api/chat/sessions/${sessionId}/context-records`);
  const statusItemsAfter = await api('/api/items?all=1');
  const statusConfirmationsAfterDb = new DatabaseSync(dbPath, { readOnly: true });
  const statusConfirmationsAfter = Number(statusConfirmationsAfterDb.prepare('SELECT COUNT(*) AS count FROM confirmations').get()?.count || 0);
  statusConfirmationsAfterDb.close();
  line(statusResponse.status === 200 && statusAction?.status === 'success' && statusAction?.actionId === 'system.status' && statusAction?.data?.sqlite?.ready === true && typeof statusAction?.data?.browserConnector?.connected === 'boolean', 'system.status returns a structured authoritative local receipt');
  line(JSON.stringify(Object.keys(statusAction?.data || {}).sort()) === JSON.stringify(['browserConnector', 'health', 'model', 'repository', 'runtime', 'sqlite', 'workboard']) && JSON.stringify(statusAction?.data || {}).length < 3000, 'system.status response has a strict bounded top-level shape');
  line(statusContextBefore.body?.data?.length === statusContextAfter.body?.data?.length && statusItemsBefore.body?.data?.length === statusItemsAfter.body?.data?.length && statusConfirmationsBefore === statusConfirmationsAfter, 'checking system status creates no attachment, Workboard item, or confirmation');
  const modelsResponse = await api('/api/actions/system.models/invoke', { method: 'POST', json: { session_id: sessionId, args: { limit: 5 } } });
  const runsResponse = await api('/api/actions/system.runs/invoke', { method: 'POST', json: { session_id: sessionId, args: { limit: 5 } } });
  const modelsAction = modelsResponse.body?.data;
  const runsAction = runsResponse.body?.data;
  systemModelsCorrelationId = modelsAction?.correlationId || '';
  systemRunsCorrelationId = runsAction?.correlationId || '';
  line(modelsResponse.status === 200 && modelsAction?.status === 'success' && modelsAction?.actionId === 'system.models' && Array.isArray(modelsAction?.data?.models) && modelsAction.data.models.length <= 5, 'system.models returns a bounded registry receipt');
  line(runsResponse.status === 200 && runsAction?.status === 'success' && runsAction?.actionId === 'system.runs' && Array.isArray(runsAction?.data?.runs) && runsAction.data.runs.length <= 5, 'system.runs returns a bounded registry receipt');

  const historyContextBefore = await api(`/api/chat/sessions/${sessionId}/context-records`);
  const historyItemsBefore = await api('/api/items?all=1');
  const historyDbBefore = new DatabaseSync(dbPath, { readOnly: true });
  const historyConfirmationsBefore = Number(historyDbBefore.prepare('SELECT COUNT(*) AS count FROM confirmations').get()?.count || 0);
  historyDbBefore.close();
  const historyResponse = await api('/api/actions/conversation.search/invoke', { method: 'POST', json: { session_id: sessionId, caller: 'cloud-agent', scopes: ['*'], args: { query: 'history-marker', limit: 8 } } });
  const historyAction = historyResponse.body?.data;
  conversationSearchCorrelationId = historyAction?.correlationId || '';
  const historyMatch = historyAction?.data?.matches?.[0];
  line(historyResponse.status === 200 && historyAction?.status === 'success' && historyAction?.actionId === 'conversation.search' && historyAction?.data?.matches?.length === 1 && historyMatch?.session_id === 700100, 'explicit history search returns only the matching active Chat identity');
  line(historyMatch?.session_title?.length <= 240 && historyMatch?.snippet?.length <= 200 && /\[truncated \d+ chars\]$/.test(historyMatch?.snippet || '') && JSON.stringify(historyAction?.data || {}).length < 1000, 'history search strictly bounds the title, snippet, and total receipt');
  line(!JSON.stringify(historyAction?.data || {}).includes('deleted-content-must-not-appear') && historyMatch?.role === 'user', 'deleted chats are excluded and the bounded role is preserved');
  const wildcardHistory = await api('/api/actions/conversation.search/invoke', { method: 'POST', json: { session_id: sessionId, args: { query: '%', limit: 8 } } });
  line(wildcardHistory.body?.data?.status === 'success' && wildcardHistory.body?.data?.data?.matches?.length === 0, 'SQL wildcard characters are searched literally rather than broadening history scope');
  const blankHistory = await api('/api/actions/conversation.search/invoke', { method: 'POST', json: { session_id: sessionId, args: { query: '   ', limit: 8 } } });
  line(blankHistory.body?.data?.status === 'blocked' && blankHistory.body?.data?.error?.code === 'INVALID_ARGUMENTS' && !blankHistory.body?.data?.data, 'blank history search is blocked before lookup without content');
  const phantomHistory = await api('/api/actions/conversation.search/invoke', { method: 'POST', json: { session_id: 987654321, args: { query: 'history-marker', limit: 8 } } });
  const legacyPhantomHistory = await api('/api/chat/capability', { method: 'POST', json: { session_id: 987654321, name: 'conversation.search', args: { query: 'history-marker', limit: 8 } } });
  line(phantomHistory.body?.data?.status === 'blocked' && phantomHistory.body?.data?.error?.code === 'INVALID_CHAT_SESSION' && legacyPhantomHistory.body?.data?.status === 'blocked' && legacyPhantomHistory.body?.data?.error?.code === 'INVALID_CHAT_SESSION', 'neutral and compatibility history search both require a real active Chat session');
  const historyContextAfter = await api(`/api/chat/sessions/${sessionId}/context-records`);
  const historyItemsAfter = await api('/api/items?all=1');
  const historyDbAfter = new DatabaseSync(dbPath, { readOnly: true });
  const historyConfirmationsAfter = Number(historyDbAfter.prepare('SELECT COUNT(*) AS count FROM confirmations').get()?.count || 0);
  historyDbAfter.close();
  line(historyContextBefore.body?.data?.length === historyContextAfter.body?.data?.length && historyItemsBefore.body?.data?.length === historyItemsAfter.body?.data?.length && historyConfirmationsBefore === historyConfirmationsAfter, 'history search creates no attachment, Workboard item, or confirmation');

  const plannerResponse = await api('/api/actions/planner.today/invoke', { method: 'POST', json: { session_id: sessionId, caller: 'cloud-agent', scopes: ['*'], args: {} } });
  const plannerAction = plannerResponse.body?.data;
  const plannerData = plannerAction?.data;
  line(plannerResponse.status === 200 && plannerAction?.status === 'success' && plannerAction?.actionId === 'planner.today' && Array.isArray(plannerData?.visible) && Array.isArray(plannerData?.deferred), 'Daily Planner returns the canonical capacity-aware day through the registry');
  line(plannerData?.visible?.length <= 7 && plannerData?.deferred?.length <= 5 && (plannerData?.visible || []).every((task) => task.title.length <= 240 && task.reasons.length <= 5) && JSON.stringify(plannerData || {}).length < 20000, 'Daily Planner result is strictly bounded');
  const phantomPlanner = await api('/api/actions/planner.today/invoke', { method: 'POST', json: { session_id: 987654321, args: {} } });
  const legacyPhantomPlanner = await api('/api/chat/capability', { method: 'POST', json: { session_id: 987654321, name: 'planner.today', args: {} } });
  line(phantomPlanner.body?.data?.status === 'blocked' && phantomPlanner.body?.data?.error?.code === 'INVALID_CHAT_SESSION' && legacyPhantomPlanner.body?.data?.status === 'blocked' && legacyPhantomPlanner.body?.data?.error?.code === 'INVALID_CHAT_SESSION', 'neutral and compatibility Daily Planner reads both require a real active Chat session');
  const plannerContextAfter = await api(`/api/chat/sessions/${sessionId}/context-records`);
  const plannerItemsAfter = await api('/api/items?all=1');
  const plannerDbAfter = new DatabaseSync(dbPath, { readOnly: true });
  const plannerConfirmationsAfter = Number(plannerDbAfter.prepare('SELECT COUNT(*) AS count FROM confirmations').get()?.count || 0);
  plannerDbAfter.close();
  line(historyContextAfter.body?.data?.length === plannerContextAfter.body?.data?.length && historyItemsAfter.body?.data?.length === plannerItemsAfter.body?.data?.length && historyConfirmationsAfter === plannerConfirmationsAfter, 'reading the Daily Planner creates no attachment, Workboard item, or confirmation');

  const readFixture = (id) => {
    const fixture = new DatabaseSync(dbPath, { readOnly: true });
    const value = fixture.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id);
    fixture.close();
    return value;
  };
  const countRevisions = (id) => {
    const fixture = new DatabaseSync(dbPath, { readOnly: true });
    const value = Number(fixture.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?').get(id)?.count || 0);
    fixture.close();
    return value;
  };
  const proposeUpdate = (id, changes, requestedSessionId = sessionId) => api('/api/actions/workboard.propose_update/invoke', {
    method: 'POST',
    json: { session_id: requestedSessionId, caller: 'cloud-agent', scopes: ['*'], args: { type: 'item', id, changes } }
  });
  const confirmWorkboard = (routeSessionId, confirmation) => api(`/api/chat/sessions/${routeSessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId: confirmation?.confirmationId, token: confirmation?.token }
  });

  const updateBefore = readFixture(700010);
  const updatePreview = await proposeUpdate(700010, { title: 'Updated exact title', status: 'stable', next_action: 'Updated exact next action', confidence: 0.91, due_at: '2026-09-15' });
  const updateAction = updatePreview.body?.data;
  const updateConfirmation = updateAction?.confirmation;
  workboardUpdateCorrelationId = updateAction?.correlationId || '';
  workboardUpdateToken = updateConfirmation?.token || '';
  const updateAfterPreview = readFixture(700010);
  line(updatePreview.status === 200 && updateAction?.status === 'needs_confirmation' && updateAction?.data?.target?.type === 'item' && updateAction?.data?.target?.id === 700010 && /^[a-f0-9]{64}$/.test(updateAction?.data?.state_token || '') && updateConfirmation?.confirmationId && updateConfirmation?.token, 'typed Workboard update returns a state-bound durable confirmation');
  line(updateAfterPreview?.title === updateBefore?.title && updateAfterPreview?.status === updateBefore?.status && updateAfterPreview?.next_action === updateBefore?.next_action, 'previewing a Workboard update performs no target mutation');
  const updateStoredDb = new DatabaseSync(dbPath, { readOnly: true });
  const updateStored = updateStoredDb.prepare('SELECT token_hash, session_id, operation, target, before_state, after_state, origin FROM confirmations WHERE id = ?').get(updateConfirmation?.confirmationId);
  updateStoredDb.close();
  const updateStoredBefore = JSON.parse(updateStored?.before_state || '{}');
  const updateStoredAfter = JSON.parse(updateStored?.after_state || '{}');
  line(updateStored?.session_id === `chat:${sessionId}` && updateStored?.operation === 'workboard.update' && updateStored?.target === 'workboard:item:700010' && updateStoredBefore?.identity?.id === 700010 && updateStoredAfter?.identity?.type === 'item', 'update confirmation binds the real chat, typed target, and full canonical before-state');
  line(JSON.stringify(updateStoredAfter?.changes) === JSON.stringify({ title: 'Updated exact title', status: 'stable', next_action: 'Updated exact next action', confidence: 0.91, due_at: '2026-09-15' }), 'the durable update stores only the validated exact changed fields');
  line(updateStored?.token_hash !== updateConfirmation?.token && !JSON.stringify(updateStored).includes(updateConfirmation?.token), 'the Workboard update token is never stored in SQLite');
  line(!String(updateStored?.origin || '').includes('Updated exact title') && JSON.parse(updateStored?.origin || '{}').correlationId === updateAction?.correlationId, 'update origin stores correlation provenance without user content');

  const invalidUpdateEnvelope = await api(`/api/chat/sessions/${sessionId}/workboard/confirm`, {
    method: 'POST',
    json: { confirmationId: updateConfirmation?.confirmationId, token: updateConfirmation?.token, changes: { title: 'Injected replacement' } }
  });
  line(invalidUpdateEnvelope.status === 400 && readFixture(700010)?.title === updateBefore?.title, 'confirmation rejects replacement update fields before mutation');
  const wrongUpdateToken = await api(`/api/chat/sessions/${sessionId}/workboard/confirm`, { method: 'POST', json: { confirmationId: updateConfirmation?.confirmationId, token: '0'.repeat(64) } });
  line(wrongUpdateToken.status === 400 && readFixture(700010)?.title === updateBefore?.title, 'the wrong update token cannot mutate the target');
  const updateOtherSession = await api('/api/chat/sessions', { method: 'POST', json: { title: 'Other update session' } });
  const updateOtherSessionId = Number(updateOtherSession.body?.data?.id);
  const wrongUpdateSession = await confirmWorkboard(updateOtherSessionId, updateConfirmation);
  line(wrongUpdateSession.status === 400 && readFixture(700010)?.title === updateBefore?.title, 'a different chat cannot apply the Workboard update');
  const updateRevisionBefore = countRevisions(700010);
  const appliedUpdate = await confirmWorkboard(sessionId, updateConfirmation);
  const updateAppliedRecord = readFixture(700010);
  line(appliedUpdate.status === 200 && appliedUpdate.body?.data?.operation === 'workboard.update' && updateAppliedRecord?.title === 'Updated exact title' && updateAppliedRecord?.status === 'stable' && updateAppliedRecord?.next_action === 'Updated exact next action' && updateAppliedRecord?.confidence === 0.91 && updateAppliedRecord?.due_at === '2026-09-15' && updateAppliedRecord?.body === updateBefore?.body && updateAppliedRecord?.owner === updateBefore?.owner, 'confirmation applies exactly the staged fields and preserves unrelated state');
  line(countRevisions(700010) === updateRevisionBefore + 1, 'title update records exactly one auditable memory revision');
  const updateReplay = await confirmWorkboard(sessionId, updateConfirmation);
  line(updateReplay.status === 400 && countRevisions(700010) === updateRevisionBefore + 1, 'an update confirmation replay is rejected without a second mutation');
  const immediateUpdateAudit = (await api(`/api/chat/sessions/${sessionId}/audit`)).body?.data?.filter((row) => row.correlation_id === workboardUpdateCorrelationId) || [];
  line(immediateUpdateAudit.some((row) => row.capability === 'workboard.propose_update' && row.outcome === 'proposed') && immediateUpdateAudit.some((row) => row.capability === 'workboard.update' && row.outcome === 'applied'), 'Workboard update proposal and apply receipts share one correlation ID');
  line(immediateUpdateAudit.every((row) => !String(row.detail).includes('Updated exact title') && !String(row.detail).includes('Updated exact next action') && !String(row.detail).includes(workboardUpdateToken)), 'Workboard update audit stores no changed content or confirmation token');

  const noSessionUpdate = await proposeUpdate(700011, { status: 'stable' }, 987654321);
  line(noSessionUpdate.body?.data?.status === 'blocked' && noSessionUpdate.body?.data?.error?.code === 'INVALID_CHAT_SESSION' && !noSessionUpdate.body?.data?.confirmation && readFixture(700011)?.status === 'active', 'an update without a real Chat session cannot stage or mutate');
  for (const [changes, label] of [
    [{}, 'empty'],
    [{ owner: 'app' }, 'identity/ownership'],
    [{ status: 'active' }, 'no-op'],
    [{ due_at: '2026-02-31' }, 'impossible-date'],
    [{ confidence: 2 }, 'out-of-range']
  ]) {
    const invalid = await proposeUpdate(700011, changes);
    line(['blocked', 'failed'].includes(invalid.body?.data?.status) && !invalid.body?.data?.confirmation && readFixture(700011)?.status === 'active', `${label} Workboard update fails closed without mutation`);
  }

  const stalePreview = await proposeUpdate(700011, { next_action: 'Stale proposal value' });
  await api('/api/items/700011', { method: 'PATCH', json: { status: 'blocked' } });
  const staleApply = await confirmWorkboard(sessionId, stalePreview.body?.data?.confirmation);
  line(staleApply.status === 400 && readFixture(700011)?.status === 'blocked' && readFixture(700011)?.next_action === 'Next 700011', 'full-state stale detection rejects an update after another legitimate mutation');

  const deletedPreview = await proposeUpdate(700012, { status: 'stable' });
  const deleteDb = new DatabaseSync(dbPath);
  deleteDb.prepare('DELETE FROM knowledge_items WHERE id = ?').run(700012);
  deleteDb.close();
  const deletedApply = await confirmWorkboard(sessionId, deletedPreview.body?.data?.confirmation);
  line(deletedApply.status === 400 && !readFixture(700012), 'deleted Workboard targets fail closed at confirmation');

  const tamperUpdate = await proposeUpdate(700013, { status: 'stable' });
  const tamperUpdateConfirmation = tamperUpdate.body?.data?.confirmation;
  const tamperUpdateDb = new DatabaseSync(dbPath);
  tamperUpdateDb.prepare('UPDATE confirmations SET after_state = ? WHERE id = ?').run(JSON.stringify({ identity: { type: 'item', id: 700013 }, changes: { status: 'done' } }), tamperUpdateConfirmation.confirmationId);
  tamperUpdateDb.close();
  const tamperedUpdateApply = await confirmWorkboard(sessionId, tamperUpdateConfirmation);
  line(tamperedUpdateApply.status === 400 && readFixture(700013)?.status === 'active', 'tampered stored update payload fails integrity validation before mutation');

  const expiredUpdate = await proposeUpdate(700014, { status: 'stable' });
  const expiredUpdateConfirmation = expiredUpdate.body?.data?.confirmation;
  const expiredUpdateDb = new DatabaseSync(dbPath);
  expiredUpdateDb.prepare('UPDATE confirmations SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expiredUpdateConfirmation.confirmationId);
  expiredUpdateDb.close();
  const expiredUpdateApply = await confirmWorkboard(sessionId, expiredUpdateConfirmation);
  line(expiredUpdateApply.status === 400 && readFixture(700014)?.status === 'active', 'expired Workboard update confirmation fails closed');

  const updateSettlement = await proposeUpdate(700015, { title: 'Must roll back with settlement' });
  const updateSettlementConfirmation = updateSettlement.body?.data?.confirmation;
  const updateSettlementDb = new DatabaseSync(dbPath);
  updateSettlementDb.exec(`
    CREATE TRIGGER reject_update_applied_settlement
    BEFORE UPDATE OF status ON confirmations
    WHEN NEW.status = 'applied'
    BEGIN
      SELECT RAISE(ABORT, 'update settlement rejected');
    END;
  `);
  updateSettlementDb.close();
  const updateSettlementFailure = await confirmWorkboard(sessionId, updateSettlementConfirmation);
  const updateSettlementCleanup = new DatabaseSync(dbPath);
  const updateSettlementStatus = updateSettlementCleanup.prepare('SELECT status FROM confirmations WHERE id = ?').get(updateSettlementConfirmation.confirmationId)?.status;
  updateSettlementCleanup.exec('DROP TRIGGER reject_update_applied_settlement');
  updateSettlementCleanup.close();
  line(updateSettlementFailure.status === 400 && updateSettlementStatus === 'failed' && readFixture(700015)?.title === 'Update fixture 700015', 'failed update settlement rolls back the mutation and records a truthful failed receipt');

  const updateStorage = await proposeUpdate(700016, { title: 'Must roll back on storage error' });
  const updateStorageConfirmation = updateStorage.body?.data?.confirmation;
  const updateStorageDb = new DatabaseSync(dbPath);
  updateStorageDb.exec(`
    CREATE TRIGGER reject_workboard_update_storage
    BEFORE UPDATE ON knowledge_items
    WHEN OLD.id = 700016
    BEGIN
      SELECT RAISE(ABORT, 'update storage rejected');
    END;
  `);
  updateStorageDb.close();
  const updateStorageFailure = await confirmWorkboard(sessionId, updateStorageConfirmation);
  const updateStorageCleanup = new DatabaseSync(dbPath);
  const updateStorageStatus = updateStorageCleanup.prepare('SELECT status FROM confirmations WHERE id = ?').get(updateStorageConfirmation.confirmationId)?.status;
  updateStorageCleanup.exec('DROP TRIGGER reject_workboard_update_storage');
  updateStorageCleanup.close();
  line(updateStorageFailure.status === 400 && updateStorageStatus === 'failed' && readFixture(700016)?.title === 'Update fixture 700016', 'datastore failure leaves the target unchanged with a truthful failed receipt');

  const concurrentUpdate = await proposeUpdate(700017, { status: 'stable' });
  const concurrentUpdateConfirmation = concurrentUpdate.body?.data?.confirmation;
  const concurrentUpdateResults = await Promise.all([1, 2].map(() => confirmWorkboard(sessionId, concurrentUpdateConfirmation)));
  line(concurrentUpdateResults.filter((result) => result.status === 200).length === 1 && concurrentUpdateResults.filter((result) => result.status === 400).length === 1 && readFixture(700017)?.status === 'stable', 'concurrent update confirmation has exactly one winner and one mutation');

  const restartUpdate = await proposeUpdate(700018, { status: 'stable', next_action: 'Survived restart' });
  const restartUpdateConfirmation = restartUpdate.body?.data?.confirmation;
  await stopServer(server.child);
  server = await retryStart();
  base = server.base;
  csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
  const updateAfterRestart = await confirmWorkboard(sessionId, restartUpdateConfirmation);
  line(updateAfterRestart.status === 200 && readFixture(700018)?.status === 'stable' && readFixture(700018)?.next_action === 'Survived restart', 'a durable Workboard update confirmation survives a server restart');

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

  // --- Daily Planner task creation: proposal -> durable confirmation -> atomic create ---
  const plannerCount = () => { const d = new DatabaseSync(dbPath, { readOnly: true }); const n = Number(d.prepare('SELECT COUNT(*) AS c FROM planner_tasks').get()?.c || 0); d.close(); return n; };
  const plannerConfirm = (routeSessionId, confirmation) => api(`/api/chat/sessions/${routeSessionId}/planner/confirm`, { method: 'POST', json: { confirmationId: confirmation?.confirmationId, token: confirmation?.token } });
  const proposePlanner = (args, requestedSessionId = sessionId) => api('/api/actions/planner.propose_create/invoke', { method: 'POST', json: { session_id: requestedSessionId, args } });

  const plannerBefore = plannerCount();
  const plannerProposal = await proposePlanner({ title: 'Draft the LPS quarterly review', next_action: 'Outline sections', importance: 4, effort: 3, estimated_minutes: 90, deadline: '2026-09-30' });
  const plannerDurable = plannerProposal.body?.data;
  const plannerConfirmation = plannerDurable?.confirmation;
  line(plannerProposal.status === 200 && plannerDurable?.status === 'needs_confirmation' && plannerDurable?.data?.confirmation_required === true && /^[a-f0-9]{32}$/.test(plannerConfirmation?.confirmationId || '') && /^[a-f0-9]{64}$/.test(plannerConfirmation?.token || ''), 'a planner task proposal returns a durable, session-bound confirmation');
  line(plannerDurable?.data?.preview?.title === 'Draft the LPS quarterly review' && plannerDurable?.data?.preview?.deadline === '2026-09-30' && plannerDurable?.data?.preview?.importance === 4 && plannerDurable?.data?.preview?.estimated_minutes === 90, 'the proposal preview echoes the exact bounded task fields');
  line(plannerCount() === plannerBefore, 'previewing a planner task creates no planner_tasks row');

  const plannerStoredDb = new DatabaseSync(dbPath, { readOnly: true });
  const plannerStored = plannerStoredDb.prepare('SELECT token_hash, session_id, operation, target, after_state, origin FROM confirmations WHERE id = ?').get(plannerConfirmation?.confirmationId);
  plannerStoredDb.close();
  line(plannerStored?.session_id === `chat:${sessionId}` && plannerStored?.operation === 'planner.create' && plannerStored?.target === `chat:${sessionId}:planner:new` && plannerStored?.token_hash !== plannerConfirmation?.token && !JSON.stringify(plannerStored).includes(plannerConfirmation?.token), 'the planner confirmation binds chat/operation/target and never stores the raw token');
  line(!String(plannerStored?.origin || '').includes('quarterly review') && JSON.parse(plannerStored?.origin || '{}').correlationId === plannerDurable?.correlationId, 'planner origin stores correlation provenance without task content');

  const plannerBadEnvelope = await api(`/api/chat/sessions/${sessionId}/planner/confirm`, { method: 'POST', json: { confirmationId: plannerConfirmation?.confirmationId, token: plannerConfirmation?.token, title: 'Injected replacement' } });
  line(plannerBadEnvelope.status === 400 && plannerCount() === plannerBefore, 'a replacement field in the planner confirm envelope is rejected before mutation');
  const plannerWrongToken = await plannerConfirm(sessionId, { confirmationId: plannerConfirmation?.confirmationId, token: '0'.repeat(64) });
  line(plannerWrongToken.status === 400 && plannerCount() === plannerBefore, 'the wrong planner token cannot create a task');
  const plannerOtherSession = await api('/api/chat/sessions', { method: 'POST', json: { title: 'Other planner session' } });
  const plannerWrongSession = await plannerConfirm(Number(plannerOtherSession.body?.data?.id), plannerConfirmation);
  line(plannerWrongSession.status === 400 && plannerCount() === plannerBefore, 'a different chat session cannot apply the planner confirmation');

  const plannerApplied = await plannerConfirm(sessionId, plannerConfirmation);
  const plannerRecord = plannerApplied.body?.data?.record;
  line(plannerApplied.status === 200 && plannerApplied.body?.data?.operation === 'planner.create' && plannerCount() === plannerBefore + 1 && plannerRecord?.title === 'Draft the LPS quarterly review' && plannerRecord?.importance === 4 && plannerRecord?.effort === 3 && plannerRecord?.estimated_minutes === 90 && plannerRecord?.deadline === '2026-09-30' && plannerRecord?.status === 'active', 'exact confirmation creates one canonical planner_tasks row matching the reviewed payload');
  const plannerReplay = await plannerConfirm(sessionId, plannerConfirmation);
  line(plannerReplay.status === 400 && plannerCount() === plannerBefore + 1, 'a planner confirmation replay is rejected without a second task');

  const plannerList = await api('/api/planner/tasks');
  line(plannerList.body?.data?.some((t) => t.id === plannerRecord?.id && t.title === plannerRecord?.title && t.status === 'active'), 'the created task is visible through the canonical Planner endpoint');
  const plannerTodayAfter = await api('/api/actions/planner.today/invoke', { method: 'POST', json: { session_id: sessionId, args: {} } });
  const plannerTodayData = plannerTodayAfter.body?.data?.data;
  line((plannerTodayData?.visible || []).some((t) => t.id === plannerRecord?.id) || (plannerTodayData?.deferred || []).some((t) => t.id === plannerRecord?.id), 'planner.today observes the newly created task');

  // --- planner.propose_update: proposal -> durable confirmation -> atomic update ---
  const readTask = (id) => { const d = new DatabaseSync(dbPath, { readOnly: true }); const t = d.prepare('SELECT * FROM planner_tasks WHERE id = ?').get(id); d.close(); return t; };
  const proposePlannerUpdate = (id, changes, requestedSessionId = sessionId) => api('/api/actions/planner.propose_update/invoke', { method: 'POST', json: { session_id: requestedSessionId, args: { id, changes } } });
  const targetId = plannerRecord.id;
  const beforeUpdate = readTask(targetId);

  const updateProp = await proposePlannerUpdate(targetId, { title: 'Draft the LPS quarterly review (revised)', status: 'deferred', importance: 5 });
  const updDurable = updateProp.body?.data;
  const updConfirmation = updDurable?.confirmation;
  line(updateProp.status === 200 && updDurable?.status === 'needs_confirmation' && updDurable?.data?.operation === 'planner.update' && updDurable?.data?.target?.id === targetId && /^[a-f0-9]{64}$/.test(updDurable?.data?.state_token || '') && /^[a-f0-9]{32}$/.test(updConfirmation?.confirmationId || ''), 'a planner update proposal returns a state-bound durable confirmation');
  line(JSON.stringify(Object.keys(updDurable?.data?.after || {}).sort()) === JSON.stringify(['importance', 'status', 'title']) && updDurable?.data?.before?.title === 'Draft the LPS quarterly review', 'the update proposal diffs only the changed fields with before/after values');
  line(JSON.stringify(readTask(targetId)) === JSON.stringify(beforeUpdate), 'previewing a planner update performs no mutation');

  const updStoredDb = new DatabaseSync(dbPath, { readOnly: true });
  const updStored = updStoredDb.prepare('SELECT token_hash, session_id, operation, target, after_state FROM confirmations WHERE id = ?').get(updConfirmation?.confirmationId);
  updStoredDb.close();
  line(updStored?.operation === 'planner.update' && updStored?.target === `planner:task:${targetId}` && updStored?.session_id === `chat:${sessionId}` && !JSON.stringify(updStored).includes(updConfirmation?.token) && JSON.parse(updStored?.after_state || '{}').identity?.id === targetId, 'the planner update confirmation binds the typed target and full state without the raw token');

  const updWrongSession = await plannerConfirm(Number(plannerOtherSession.body?.data?.id), updConfirmation);
  line(updWrongSession.status === 400 && readTask(targetId).status === beforeUpdate.status, 'a different chat session cannot apply the planner update');
  const updWrongToken = await plannerConfirm(sessionId, { confirmationId: updConfirmation?.confirmationId, token: '0'.repeat(64) });
  line(updWrongToken.status === 400 && readTask(targetId).status === beforeUpdate.status, 'the wrong planner update token cannot mutate the task');

  const updApplied = await plannerConfirm(sessionId, updConfirmation);
  const updRecord = updApplied.body?.data?.record;
  line(updApplied.status === 200 && updApplied.body?.data?.operation === 'planner.update' && updRecord?.title === 'Draft the LPS quarterly review (revised)' && updRecord?.status === 'deferred' && updRecord?.importance === 5 && updRecord?.next_action === beforeUpdate.next_action && updRecord?.effort === beforeUpdate.effort, 'confirmation applies exactly the staged planner fields and preserves unrelated state');
  const updReplay = await plannerConfirm(sessionId, updConfirmation);
  line(updReplay.status === 400, 'a planner update confirmation replay is rejected');

  const completeBefore = readTask(targetId);
  const completeProp = await proposePlannerUpdate(targetId, { status: 'completed' });
  const completeConfirmation = completeProp.body?.data?.confirmation;
  line(completeProp.body?.data?.status === 'needs_confirmation' && completeProp.body?.data?.data?.after?.status === 'completed' && readTask(targetId).status === 'deferred' && readTask(targetId).completed_at == null, 'Done stages an exact status-only diff without mutating the Planner task');
  const completeApplied = await plannerConfirm(sessionId, completeConfirmation);
  const completedTask = readTask(targetId);
  line(completeApplied.status === 200 && completedTask.status === 'completed', 'confirming Done applies the canonical completed status');
  line(Boolean(completedTask.completed_at), 'confirming Done records the canonical completion timestamp');
  line(completedTask.title === completeBefore.title && completedTask.importance === completeBefore.importance, 'confirming Done preserves unrelated Planner fields');

  const deferProp = await proposePlannerUpdate(targetId, { status: 'deferred' });
  const deferConfirmation = deferProp.body?.data?.confirmation;
  line(deferProp.body?.data?.status === 'needs_confirmation' && readTask(targetId).status === 'completed', 'Not today remains review-only until its explicit confirmation');
  const deferApplied = await plannerConfirm(sessionId, deferConfirmation);
  const deferredTask = readTask(targetId);
  line(deferApplied.status === 200 && deferredTask.status === 'deferred' && deferredTask.completed_at == null && deferredTask.title === completedTask.title, 'confirming Not today applies canonical defer semantics and clears the completion timestamp');

  const plStaleProp = await proposePlannerUpdate(targetId, { next_action: 'stale attempt' });
  await api(`/api/planner/tasks/${targetId}`, { method: 'PATCH', json: { title: 'Changed by another writer' } });
  const plStaleApply = await plannerConfirm(sessionId, plStaleProp.body?.data?.confirmation);
  line(plStaleApply.status === 400 && readTask(targetId).next_action !== 'stale attempt', 'a planner update whose task changed after the proposal is rejected as stale');

  const plTamperProp = await proposePlannerUpdate(targetId, { importance: 1 });
  const plTamperConfirmation = plTamperProp.body?.data?.confirmation;
  const plTamperBefore = readTask(targetId).importance;
  const plTamperDb = new DatabaseSync(dbPath);
  plTamperDb.prepare('UPDATE confirmations SET after_state = ? WHERE id = ?').run(JSON.stringify({ identity: { type: 'planner_task', id: targetId }, changes: { importance: 4 } }), plTamperConfirmation.confirmationId);
  plTamperDb.close();
  const plTamperApply = await plannerConfirm(sessionId, plTamperConfirmation);
  line(plTamperApply.status === 400 && readTask(targetId).importance === plTamperBefore, 'a tampered stored planner update payload fails the integrity digest before mutation');

  const updMissing = await proposePlannerUpdate(999999999, { title: 'nope' });
  line(['failed', 'blocked'].includes(updMissing.body?.data?.status) && !updMissing.body?.data?.confirmation, 'updating a nonexistent planner task fails closed');
  const updForbidden = await proposePlannerUpdate(targetId, { pinned: true });
  line(['failed', 'blocked'].includes(updForbidden.body?.data?.status) && !updForbidden.body?.data?.confirmation, 'a forbidden planner field cannot be updated from Chat');
  const updNoSession = await proposePlannerUpdate(targetId, { title: 'x' }, 987654321);
  line(updNoSession.body?.data?.status === 'blocked' && updNoSession.body?.data?.error?.code === 'INVALID_CHAT_SESSION', 'a planner update without a real chat session cannot stage a confirmation');

  const plannerConcProposal = await proposePlanner({ title: 'Concurrent planner task' });
  const plannerConcConfirmation = plannerConcProposal.body?.data?.confirmation;
  const beforeConc = plannerCount();
  const plannerConcResults = await Promise.all([1, 2].map(() => plannerConfirm(sessionId, plannerConcConfirmation)));
  line(plannerConcResults.filter((r) => r.status === 200).length === 1 && plannerConcResults.filter((r) => r.status === 400).length === 1 && plannerCount() === beforeConc + 1, 'concurrent planner confirmation creates exactly one task');

  const plannerExpProposal = await proposePlanner({ title: 'Expired planner task' });
  const plannerExpConfirmation = plannerExpProposal.body?.data?.confirmation;
  const beforeExp = plannerCount();
  const plannerExpDb = new DatabaseSync(dbPath);
  plannerExpDb.prepare('UPDATE confirmations SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', plannerExpConfirmation.confirmationId);
  plannerExpDb.close();
  const plannerExpApply = await plannerConfirm(sessionId, plannerExpConfirmation);
  line(plannerExpApply.status === 400 && plannerCount() === beforeExp, 'an expired planner confirmation is rejected without a task');

  const plannerTamperProposal = await proposePlanner({ title: 'Tamper planner task' });
  const plannerTamperConfirmation = plannerTamperProposal.body?.data?.confirmation;
  const beforeTamper = plannerCount();
  const plannerTamperDb = new DatabaseSync(dbPath);
  plannerTamperDb.prepare('UPDATE confirmations SET after_state = ? WHERE id = ?').run(JSON.stringify({ title: 'Injected via tamper', why: '', next_action: '', importance: 5, effort: 5, estimated_minutes: null, deadline: null }), plannerTamperConfirmation.confirmationId);
  plannerTamperDb.close();
  const plannerTamperApply = await plannerConfirm(sessionId, plannerTamperConfirmation);
  line(plannerTamperApply.status === 400 && plannerCount() === beforeTamper, 'a tampered stored planner payload fails the integrity digest before mutation');

  const plannerMalformed = await proposePlanner({ title: 'Bad date task', deadline: '2026-02-31' });
  line(['failed', 'blocked'].includes(plannerMalformed.body?.data?.status) && !plannerMalformed.body?.data?.confirmation && plannerCount() === beforeTamper, 'a malformed planner deadline fails closed with no confirmation and no task');
  const plannerNoSession = await proposePlanner({ title: 'No session task' }, 987654321);
  line(plannerNoSession.body?.data?.status === 'blocked' && plannerNoSession.body?.data?.error?.code === 'INVALID_CHAT_SESSION' && !plannerNoSession.body?.data?.confirmation, 'a planner proposal without a real chat session cannot stage a confirmation');

  const legacyRoute = await api('/api/chat/capability', {
    method: 'POST',
    json: { session_id: sessionId, name: 'knowledge.search', args: { query: 'legacy-fixture', limit: 1 } }
  });
  line(legacyRoute.status === 200 && legacyRoute.body?.data?.name === 'knowledge.search' && legacyRoute.body?.data?.status === 'success' && legacyRoute.body?.data?.correlationId, 'Chat compatibility endpoint uses the structured registry result');

  const auditDb = new DatabaseSync(dbPath, { readOnly: true });
  const auditRows = auditDb.prepare('SELECT * FROM chat_audit WHERE session_id = ? ORDER BY id DESC').all(sessionId);
  auditDb.close();
  const correlated = auditRows.find((row) => row.correlation_id === firstResult?.correlationId);
  line(Boolean(correlated) && correlated.capability === 'knowledge.search' && correlated.outcome === 'success', 'audit row links the action, outcome, and correlation ID');
  line(correlated?.detail === 'completed', 'audit detail is a concise receipt rather than the query body');
  const knowledgeReadAudit = auditRows.find((row) => row.correlation_id === knowledgeReadCorrelationId);
  line(Boolean(knowledgeReadAudit) && knowledgeReadAudit.capability === 'knowledge.read' && knowledgeReadAudit.outcome === 'success' && knowledgeReadAudit.detail === 'completed', 'Knowledge preview audit links its correlation ID to a concise success receipt');
  line(!String(knowledgeReadAudit?.detail).includes(knowledgePreviewTitle) && !String(knowledgeReadAudit?.detail).includes('Preview body marker'), 'Knowledge preview audit stores no title or body content');
  const workboardReadAudit = auditRows.find((row) => row.correlation_id === workboardReadCorrelationId);
  line(Boolean(workboardReadAudit) && workboardReadAudit.capability === 'workboard.read' && workboardReadAudit.outcome === 'success' && workboardReadAudit.detail === 'completed', 'Workboard preview audit links its correlation ID to a concise success receipt');
  line(!String(workboardReadAudit?.detail).includes('Typed project fixture') && !String(workboardReadAudit?.detail).includes('Project evidence'), 'Workboard preview audit stores no record title or evidence content');
  const systemStatusAudit = auditRows.find((row) => row.correlation_id === systemStatusCorrelationId);
  line(Boolean(systemStatusAudit) && systemStatusAudit.capability === 'system.status' && systemStatusAudit.outcome === 'success' && systemStatusAudit.detail === 'completed', 'system.status audit stores one concise correlated receipt');
  const systemModelsAudit = auditRows.find((row) => row.correlation_id === systemModelsCorrelationId);
  const systemRunsAudit = auditRows.find((row) => row.correlation_id === systemRunsCorrelationId);
  line(systemModelsAudit?.capability === 'system.models' && systemModelsAudit?.detail === 'completed' && systemRunsAudit?.capability === 'system.runs' && systemRunsAudit?.detail === 'completed', 'system model/run audits store concise correlated receipts');
  const conversationSearchAudit = auditRows.find((row) => row.correlation_id === conversationSearchCorrelationId);
  line(conversationSearchAudit?.capability === 'conversation.search' && conversationSearchAudit?.outcome === 'success' && conversationSearchAudit?.detail === 'completed' && !String(conversationSearchAudit?.detail).includes('history-marker') && !String(conversationSearchAudit?.detail).includes('private-body'), 'conversation search audit is concise, correlated, and content-free');
  const proposalAudit = auditRows.filter((row) => row.correlation_id === durable?.correlationId);
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
