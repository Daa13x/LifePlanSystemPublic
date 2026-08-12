import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeIdempotencyKey,
  hashRequest,
  runIdempotent,
  IdempotencyConflictError
} from '../server/idempotency.js';

// Acceptance for request idempotency on retry-unsafe multi-row writes. A unit
// section drives runIdempotent against an in-memory database (replay, conflict,
// and the critical rollback-leaves-no-key property); an HTTP section proves the
// live POST /api/import/json route dedups a real retry on a disposable DB. The
// user's data is never touched. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- request idempotency verification ---');

// ---- unit: key validation + request hashing ----
line(normalizeIdempotencyKey('import-2026-08-12-abc123') === 'import-2026-08-12-abc123', 'a well-formed key is accepted');
line(normalizeIdempotencyKey('  spaced-key-value  ') === 'spaced-key-value', 'surrounding whitespace is trimmed');
line(normalizeIdempotencyKey('short') === null, 'a too-short key is rejected');
line(normalizeIdempotencyKey('bad key!') === null, 'a key with illegal characters is rejected');
line(normalizeIdempotencyKey('') === null && normalizeIdempotencyKey(undefined) === null, 'empty/undefined keys are rejected');
line(hashRequest({ a: 1, b: 2 }) === hashRequest({ b: 2, a: 1 }), 'object key order does not change the request hash');
line(hashRequest({ items: [1, 2] }) !== hashRequest({ items: [2, 1] }), 'array order does change the request hash');
line(hashRequest({ a: 1 }) !== hashRequest({ a: 2 }), 'a different payload produces a different hash');

// ---- unit: the runner against an in-memory database ----
const mem = new DatabaseSync(':memory:');
mem.exec(`
  CREATE TABLE request_idempotency (
    idempotency_key TEXT NOT NULL, route TEXT NOT NULL, request_hash TEXT NOT NULL,
    status_code INTEGER NOT NULL, response_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (route, idempotency_key));
  CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);
`);
const memTx = (fn) => { mem.exec('BEGIN IMMEDIATE'); try { const r = fn(); mem.exec('COMMIT'); return r; } catch (e) { try { mem.exec('ROLLBACK'); } catch { /* settled */ } throw e; } };
const thingCount = () => mem.prepare('SELECT COUNT(*) AS n FROM things').get().n;
const insertThing = (label) => mem.prepare('INSERT INTO things (label) VALUES (?)').run(label);
const write = (label, { fail = false } = {}) => ({
  db: mem, transaction: memTx, route: '/things', key: 'thing-key-000001', requestHash: hashRequest({ label }),
  execute: () => { insertThing(label); if (fail) throw new Error('Injected failure.'); return { statusCode: 200, body: { label, count: thingCount() } }; }
});

const first = runIdempotent(write('alpha'));
line(first.replayed === false && thingCount() === 1, 'the first keyed write executes and inserts a row');
const replay = runIdempotent(write('alpha'));
line(replay.replayed === true && replay.body.label === 'alpha' && thingCount() === 1, 'an identical retry replays the stored result and writes nothing new');

let conflicted = false;
try { runIdempotent({ ...write('alpha'), requestHash: hashRequest({ label: 'BETA' }) }); }
catch (error) { conflicted = error instanceof IdempotencyConflictError && error.statusCode === 409; }
line(conflicted && thingCount() === 1, 'the same key with a different request is a 409 conflict and writes nothing');

// Rollback-leaves-no-key: a failed write must store NO idempotency record, so a
// real retry can still succeed rather than being permanently poisoned.
let threw = false;
try { runIdempotent({ ...write('gamma', { fail: true }), key: 'thing-key-000002', requestHash: hashRequest({ label: 'gamma' }) }); }
catch { threw = true; }
const orphanKey = mem.prepare("SELECT COUNT(*) AS n FROM request_idempotency WHERE idempotency_key = 'thing-key-000002'").get().n;
line(threw && orphanKey === 0 && thingCount() === 1, 'a failed keyed write rolls back and leaves no idempotency record');
const retryAfterFail = runIdempotent({ ...write('gamma'), key: 'thing-key-000002', requestHash: hashRequest({ label: 'gamma' }) });
line(retryAfterFail.replayed === false && thingCount() === 2, 'after a rolled-back failure the same key can be retried and succeeds');

const keyless1 = runIdempotent({ ...write('delta'), key: null });
const keyless2 = runIdempotent({ ...write('delta'), key: null });
line(keyless1.replayed === false && keyless2.replayed === false && thingCount() === 4, 'without a key every call runs (backward compatible)');
mem.close();

// ---- HTTP acceptance against the real import route ----
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-idem-'));
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
async function api(route, { method = 'GET', json, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; headers['X-LPS-CSRF'] = token; if (key) headers['X-LPS-Idempotency-Key'] = key; }
  const res = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const projectCount = async () => (await api('/api/projects')).body.data.length;

const server = await retryStart();
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
  // import_all so row counts reflect retry-dedup only, not name-based skip_duplicates.
  const payload = { mode: 'import_all', projects: [{ name: 'Idempotent import project' }], knowledge_items: [{ title: 'Idempotent note', body: 'once' }] };

  line((await api('/api/import/json', { method: 'POST', json: { mode: 'import_all', projects: [{ name: 'reachable' }] } })).status === 200, 'import route is reachable with CSRF');
  const before = await projectCount();

  const k = 'http-import-key-0001';
  const one = await api('/api/import/json', { method: 'POST', json: payload, key: k });
  line(one.status === 200 && one.body.data.projects === 1 && one.body.data.replayed === false, 'first keyed import writes the rows');
  const afterFirst = await projectCount();
  line(afterFirst === before + 1, 'the project row is present after the first import');

  const two = await api('/api/import/json', { method: 'POST', json: payload, key: k });
  line(two.status === 200 && two.body.data.replayed === true, 'an identical retry with the same key replays instead of re-importing');
  line((await projectCount()) === afterFirst, 'the retry did NOT create a duplicate project row');

  const conflict = await api('/api/import/json', { method: 'POST', json: { projects: [{ name: 'Different payload' }] }, key: k });
  line(conflict.status === 409, 'the same key with a different payload is rejected as a 409 conflict');
  line((await projectCount()) === afterFirst, 'the conflicting request wrote nothing');

  const fresh = await api('/api/import/json', { method: 'POST', json: payload, key: 'http-import-key-0002' });
  line(fresh.status === 200 && fresh.body.data.replayed === false && (await projectCount()) === afterFirst + 1, 'a new key imports again');

  const noKeyA = await projectCount();
  await api('/api/import/json', { method: 'POST', json: payload });
  await api('/api/import/json', { method: 'POST', json: payload });
  line((await projectCount()) === noKeyA + 2, 'without a key each import still writes (backward compatible)');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll request-idempotency checks passed.');
process.exit(failures ? 1 : 0);
