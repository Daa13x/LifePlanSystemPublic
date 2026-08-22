import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FAILURE_CATEGORIES } from '../server/failureTaxonomy.js';

// HTTP acceptance for the failure-taxonomy routes on a disposable
// LIFE_PLANNER_DB (never the user's data): CSRF-gated recording, the review
// queue with confirmation-gated proposals, triage, and before/after evaluation.
// Recording a failure must change NO prompt/rule/memory. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-failures-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

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
  // The server binds a fixed port, and freePort() has an open->close->rebind
  // window; under a busy CI runner that port can be taken, so the server exits
  // early on EADDRINUSE. Retry on a fresh port before giving up.
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
async function apiAt(baseUrl, csrfToken, route, { method = 'GET', json, csrf = 'valid' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = baseUrl; if (csrf === 'valid') headers['X-LPS-CSRF'] = csrfToken; }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const api = (route, options) => apiAt(base, token, route, options);

console.log('--- failures HTTP verification ---');
const server = await retryStart();
let secondServer = null;
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  line((await api('/api/failures', { method: 'POST', json: { category: 'repeated-question' }, csrf: 'none' })).status === 403, 'recording a failure without CSRF is rejected (403)');
  line((await api('/api/failures', { method: 'POST', json: { category: 'not-real' } })).status === 400, 'an invalid failure category is rejected (400)');
  line((await api('/api/failures', { method: 'POST', json: { category: 'user-correction', status: 'converted' } })).status === 400, 'a new failure cannot bypass review by starting converted');

  const created = await api('/api/failures', { method: 'POST', json: { category: 'wrong-question-type', source: 'loop-guard', taskRef: 'w1', runId: 'r1', evidence: 'asked completion during execution' } });
  line(created.status === 200 && created.body.data.id && created.body.data.status === 'observed', 'a failure is recorded as observed');
  const id = created.body.data.id;
  const counts = (target, count) => Object.fromEntries(FAILURE_CATEGORIES.map((category) => [category, category === target ? count : 0]));
  const evaluation = (failureId, regressionRef, before, after, csrf = 'valid') => api(`/api/failures/${failureId}/evaluations`, { method: 'POST', json: { regressionRef, before, after }, csrf });

  line((await evaluation(id, 'test:wrong-question', counts('wrong-question-type', 2), counts('wrong-question-type', 1), 'none')).status === 403, 'persisting an evaluation without CSRF is rejected');
  line((await evaluation(id, 'test:wrong-question', counts('wrong-question-type', 2), counts('wrong-question-type', 1))).status === 409, 'an observed failure cannot be evaluated for conversion');

  // Recording a failure must not create a memory candidate.
  const memory = await api('/api/memory');
  const candidateCount = Array.isArray(memory.body?.data?.candidates) ? memory.body.data.candidates.length : (Array.isArray(memory.body?.data) ? memory.body.data.length : 0);
  line(candidateCount === 0, 'recording a failure changes no memory (no auto-promotion)');

  // Observed failures propose nothing; confirming one proposes a reviewed candidate.
  let queue = await api('/api/failures');
  line(queue.body.data.failures.length === 1 && queue.body.data.proposals.length === 0, 'an observed failure yields no remediation proposal');
  line((await api(`/api/failures/${id}`, { method: 'PATCH', json: { status: 'nope' } })).status === 400, 'an invalid failure status is rejected');
  const confirmed = await api(`/api/failures/${id}`, { method: 'PATCH', json: { status: 'confirmed' } });
  line(confirmed.status === 200 && confirmed.body.data.remediation.propose === true && confirmed.body.data.remediation.kind === 'regression-test', 'confirming a mechanical failure proposes a regression test for review');
  line((await api(`/api/failures/${id}`, { method: 'PATCH', json: { status: 'converted', regressionRef: 'bypass' } })).status === 409, 'direct converted triage cannot bypass a stored passing evaluation');
  queue = await api('/api/failures');
  line(queue.body.data.proposals.some((p) => p.id === id && p.requiresReview === true), 'the review queue lists the confirmed failure as a reviewed proposal');
  line(queue.body.data.categoryCounts['wrong-question-type'] === 1, 'failures are summarised by category');

  // Before/after evaluation is required to claim improvement. Durable evaluations
  // require complete maps and atomically bind a passing result to conversion.
  const partial = await api('/api/failures/evaluate', { method: 'POST', json: { target: 'repeated-question', before: { 'repeated-question': 4 }, after: { 'repeated-question': 1 } } });
  line(partial.status === 400, 'a partial count map cannot hide another failure-class regression');
  const good = await api('/api/failures/evaluate', { method: 'POST', json: { target: 'repeated-question', before: counts('repeated-question', 4), after: counts('repeated-question', 1) } });
  line(good.body.data.improved === true, 'a before/after drop in the target class evaluates as improved');
  const tradedAfter = counts('repeated-question', 1); tradedAfter['missing-attachment'] = 3;
  const traded = await api('/api/failures/evaluate', { method: 'POST', json: { target: 'repeated-question', before: counts('repeated-question', 4), after: tradedAfter } });
  line(traded.body.data.improved === false, 'trading one failure class for another does not count as improvement');

  line((await evaluation(id, '', counts('wrong-question-type', 3), counts('wrong-question-type', 2))).status === 400, 'a durable evaluation requires a bounded regression/test reference');
  line((await evaluation(id, 'test:partial', { 'wrong-question-type': 3 }, { 'wrong-question-type': 2 })).status === 400, 'a durable evaluation rejects incomplete snapshots');
  const failedAfter = counts('wrong-question-type', 2); failedAfter['missing-attachment'] = 1;
  const failedEval = await evaluation(id, 'test:trade-regression', counts('wrong-question-type', 3), failedAfter);
  line(failedEval.status === 200 && failedEval.body.data.converted === false && failedEval.body.data.evaluation.improved === false, 'a non-passing evaluation is persisted as negative evidence');
  const failedReplay = await evaluation(id, 'test:trade-regression', counts('wrong-question-type', 3), failedAfter);
  line(failedReplay.status === 200 && failedReplay.body.data.replayed === true && failedReplay.body.data.evaluation.id === failedEval.body.data.evaluation.id, 'an exact non-passing evaluation retry replays the same negative evidence');
  let allQueue = await api('/api/failures?all=1');
  const confirmedWithFailure = allQueue.body.data.failures.find((failure) => failure.id === id);
  line(confirmedWithFailure?.status === 'confirmed', 'a non-passing evaluation leaves the failure confirmed');
  line(confirmedWithFailure?.evaluations?.some((record) => record.id === failedEval.body.data.evaluation.id && record.improved === false && record.reason && record.before?.['wrong-question-type'] === 3 && record.after?.['missing-attachment'] === 1), 'persisted negative evaluation evidence remains reviewable after reload');

  const beforePassing = counts('wrong-question-type', 3);
  const afterPassing = counts('wrong-question-type', 1);
  const passing = await evaluation(id, 'test:wrong-question-fixed', beforePassing, afterPassing);
  line(passing.status === 200 && passing.body.data.converted === true && passing.body.data.evaluation.improved === true && passing.body.data.evaluation.id, 'a passing complete evaluation converts the confirmed failure atomically');
  const passingId = passing.body.data.evaluation.id;
  allQueue = await api('/api/failures?all=1');
  const convertedFailure = allQueue.body.data.failures.find((failure) => failure.id === id);
  line(convertedFailure.status === 'converted' && convertedFailure.regression_ref === 'test:wrong-question-fixed' && convertedFailure.conversion?.evaluationId === passingId && convertedFailure.conversion?.state === 'evaluated', 'the converted failure is bound to the exact passing evaluation and regression reference');
  line((await api(`/api/failures/${id}`, { method: 'PATCH', json: { status: 'dismissed' } })).status === 409, 'an evaluated conversion is terminal and cannot be overwritten by later triage');
  const replay = await evaluation(id, 'test:wrong-question-fixed', beforePassing, afterPassing);
  line(replay.status === 200 && replay.body.data.replayed === true && replay.body.data.evaluation.id === passingId, 'an exact retry replays the same converted evaluation idempotently');
  line((await evaluation(id, 'test:different', beforePassing, afterPassing)).status === 409, 'a conflicting evaluation cannot replace the conversion evidence');

  const evidenceDb = new DatabaseSync(dbPath, { readOnly: true });
  const evaluationRows = evidenceDb.prepare('SELECT * FROM failure_evaluations WHERE failure_event_id = ? ORDER BY id').all(id);
  const candidateRows = evidenceDb.prepare('SELECT COUNT(*) AS count FROM memory_candidates').get().count;
  evidenceDb.close();
  line(evaluationRows.length === 2 && evaluationRows.filter((record) => record.converted_at).length === 1, 'failed and passing evaluations remain append-only with one conversion binding');
  line(candidateRows === 0, 'evaluating and converting a failure creates no memory candidate or automatic behaviour change');

  const legacyDb = new DatabaseSync(dbPath);
  const legacyId = legacyDb.prepare("INSERT INTO failure_events (category, status, source, regression_ref) VALUES ('user-correction','converted','legacy','legacy-ref')").run().lastInsertRowid;
  legacyDb.close();
  allQueue = await api('/api/failures?all=1');
  line(allQueue.body.data.failures.find((failure) => failure.id === Number(legacyId))?.conversion?.state === 'legacy-unlinked', 'historical converted rows are preserved and labelled legacy-unlinked without fabricated evaluation evidence');

  const concurrentFailure = await api('/api/failures', { method: 'POST', json: { category: 'repeated-question', source: 'concurrency-test' } });
  const concurrentId = concurrentFailure.body.data.id;
  await api(`/api/failures/${concurrentId}`, { method: 'PATCH', json: { status: 'confirmed' } });
  secondServer = await retryStart();
  const secondToken = (await (await fetch(`${secondServer.base}/api/csrf-token`)).json()).data.token;
  const concurrentBody = { regressionRef: 'test:concurrent-evaluation', before: counts('repeated-question', 4), after: counts('repeated-question', 1) };
  const concurrentResults = await Promise.all([
    api(`/api/failures/${concurrentId}/evaluations`, { method: 'POST', json: concurrentBody }),
    apiAt(secondServer.base, secondToken, `/api/failures/${concurrentId}/evaluations`, { method: 'POST', json: concurrentBody })
  ]);
  const concurrentIds = concurrentResults.map((result) => result.body?.data?.evaluation?.id);
  const concurrentDb = new DatabaseSync(dbPath, { readOnly: true });
  const concurrentRows = concurrentDb.prepare('SELECT * FROM failure_evaluations WHERE failure_event_id = ?').all(concurrentId);
  concurrentDb.close();
  line(concurrentResults.every((result) => result.status === 200) && new Set(concurrentIds).size === 1 && concurrentRows.length === 1 && Boolean(concurrentRows[0].converted_at), 'two runtimes racing the same passing evaluation converge on one conversion row');

  const raceFailure = await api('/api/failures', { method: 'POST', json: { category: 'stale-attachment', source: 'triage-race-test' } });
  const raceId = raceFailure.body.data.id;
  await api(`/api/failures/${raceId}`, { method: 'PATCH', json: { status: 'confirmed' } });
  const raceBody = { regressionRef: 'test:evaluation-triage-race', before: counts('stale-attachment', 2), after: counts('stale-attachment', 0) };
  const [raceEvaluation, raceDismissal] = await Promise.all([
    api(`/api/failures/${raceId}/evaluations`, { method: 'POST', json: raceBody }),
    apiAt(secondServer.base, secondToken, `/api/failures/${raceId}`, { method: 'PATCH', json: { status: 'dismissed' } })
  ]);
  const raceDb = new DatabaseSync(dbPath, { readOnly: true });
  const raceState = raceDb.prepare('SELECT status FROM failure_events WHERE id = ?').get(raceId).status;
  const raceConvertedRows = raceDb.prepare('SELECT COUNT(*) AS count FROM failure_evaluations WHERE failure_event_id = ? AND converted_at IS NOT NULL').get(raceId).count;
  raceDb.close();
  const evaluationWon = raceEvaluation.status === 200 && raceDismissal.status === 409 && raceState === 'converted' && raceConvertedRows === 1;
  const dismissalWon = raceEvaluation.status === 409 && raceDismissal.status === 200 && raceState === 'dismissed' && raceConvertedRows === 0;
  line(evaluationWon || dismissalWon, 'evaluation and triage serialize to one truthful terminal state across two runtimes');

  const rollbackFailure = await api('/api/failures', { method: 'POST', json: { category: 'no-progress-loop', source: 'rollback-test' } });
  const rollbackId = rollbackFailure.body.data.id;
  await api(`/api/failures/${rollbackId}`, { method: 'PATCH', json: { status: 'confirmed' } });
  const triggerDb = new DatabaseSync(dbPath);
  triggerDb.exec(`CREATE TRIGGER fail_evaluated_conversion BEFORE UPDATE ON failure_events
    WHEN NEW.id = ${Number(rollbackId)} AND NEW.status = 'converted'
    BEGIN SELECT RAISE(ABORT, 'injected conversion failure'); END;`);
  triggerDb.close();
  const rollbackResult = await api(`/api/failures/${rollbackId}/evaluations`, { method: 'POST', json: { regressionRef: 'test:rollback', before: counts('no-progress-loop', 2), after: counts('no-progress-loop', 0) } });
  const rollbackDb = new DatabaseSync(dbPath, { readOnly: true });
  const rollbackState = rollbackDb.prepare('SELECT status FROM failure_events WHERE id = ?').get(rollbackId);
  const rollbackEvaluations = rollbackDb.prepare('SELECT COUNT(*) AS count FROM failure_evaluations WHERE failure_event_id = ?').get(rollbackId).count;
  rollbackDb.close();
  line(rollbackResult.status === 500 && rollbackState.status === 'confirmed' && rollbackEvaluations === 0, 'a conversion-settlement failure rolls back both the passing evaluation and status change');
} finally {
  if (secondServer) await stopServer(secondServer.child);
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll failures HTTP checks passed.');
process.exit(failures ? 1 : 0);
