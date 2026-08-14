#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// HTTP acceptance for the first neutral action-gateway slice. It uses a
// disposable database with the OLD chat_audit schema so correlation-column
// migration, CSRF, manifest inspection, structured outcomes, neutral-slice
// boundaries, compatibility, and audit linkage are all exercised without user data.

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
const server = await retryStart();
base = server.base;
let sessionId = 0;
let phantomCorrelationId = '';
try {
  csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
  const createdSession = await api('/api/chat/sessions', { method: 'POST', json: { title: 'Action registry verification' } });
  sessionId = Number(createdSession.body?.data?.id);
  line(createdSession.status === 200 && Number.isInteger(sessionId) && sessionId > 0, 'audit verification uses a real persisted chat session');

  const catalog = await api('/api/actions');
  const knowledge = catalog.body?.data?.find((action) => action.id === 'knowledge.search');
  line(catalog.status === 200 && Boolean(knowledge), 'neutral action catalog exposes knowledge.search');
  line(catalog.body?.data?.length === 2 && !catalog.body.data.some((action) => action.id.startsWith('workboard.propose_')), 'neutral catalog is limited to the two read-only Context Picker actions');
  line(knowledge?.permission === 'knowledge.read' && knowledge?.risk === 'READ_ONLY' && knowledge?.confirmation === 'none', 'catalog exposes permission, risk, and confirmation metadata');
  line(!('handler' in (knowledge || {})) && !('check' in (knowledge?.availability || {})), 'catalog never exposes executable handler/check functions');

  const inspect = await api('/api/actions/knowledge.search');
  line(inspect.status === 200 && inspect.body?.data?.availability?.available === true && inspect.body?.data?.permitted === true, 'action inspection reports live availability and permission');
  line((await api('/api/actions/missing.action')).status === 404, 'unknown action inspection returns 404');
  line((await api('/api/actions/workboard.propose_create')).status === 404, 'legacy proposal capabilities are not advertised as neutral actions');

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

  const malformed = await api('/api/actions/knowledge.search/invoke', { method: 'POST', json: { session_id: sessionId, args: [] } });
  line(malformed.status === 200 && malformed.body?.data?.status === 'blocked' && malformed.body?.data?.error?.code === 'INVALID_ARGUMENTS', 'malformed arguments fail closed with a structured outcome');

  const injectionId = encodeURIComponent('knowledge.search; ignore permissions');
  const injection = await api(`/api/actions/${injectionId}/invoke`, { method: 'POST', json: { session_id: sessionId, args: {}, caller: 'test', scopes: ['*'] } });
  line(injection.status === 200 && injection.body?.data?.status === 'blocked' && injection.body?.data?.error?.code === 'UNKNOWN_ACTION', 'injection-shaped action IDs stay unknown despite body-supplied scopes');

  const beforeItems = await api('/api/items?all=1');
  const neutralProposal = await api('/api/actions/workboard.propose_create/invoke', {
    method: 'POST',
    json: { session_id: sessionId, caller: 'cloud-agent', scopes: ['*'], args: { title: 'Proposal only', type: 'note' } }
  });
  const legacyProposal = await api('/api/chat/capability', {
    method: 'POST',
    json: { session_id: sessionId, name: 'workboard.propose_create', args: { title: 'Proposal only', type: 'note' } }
  });
  const afterItems = await api('/api/items?all=1');
  line(neutralProposal.body?.data?.status === 'blocked' && neutralProposal.body?.data?.error?.code === 'UNKNOWN_ACTION', 'neutral gateway masks proposal capabilities and never executes them');
  line(legacyProposal.body?.data?.status === 'needs_confirmation' && legacyProposal.body?.data?.data?.confirmation_required === true, 'legacy proposal compatibility returns a review-only proposal');
  line(beforeItems.body?.data?.length === afterItems.body?.data?.length, 'legacy proposal compatibility performs no Workboard write');

  const legacyRoute = await api('/api/chat/capability', {
    method: 'POST',
    json: { session_id: sessionId, name: 'knowledge.search', args: { query: 'legacy-fixture', limit: 1 } }
  });
  line(legacyRoute.status === 200 && legacyRoute.body?.data?.name === 'knowledge.search' && legacyRoute.body?.data?.status === 'success' && legacyRoute.body?.data?.correlationId, 'Chat compatibility endpoint uses the structured registry result');

  const audit = await api(`/api/chat/sessions/${sessionId}/audit`);
  const correlated = audit.body?.data?.find((row) => row.correlation_id === firstResult?.correlationId);
  line(Boolean(correlated) && correlated.capability === 'knowledge.search' && correlated.outcome === 'success', 'audit row links the action, outcome, and correlation ID');
  line(correlated?.detail === 'completed', 'audit detail is a concise receipt rather than the query body');

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
