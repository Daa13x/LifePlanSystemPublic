import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-loop-attempts-'));
const dbPath = path.join(temp, 'life-planner.sqlite');
let failures = 0;
const line = (condition, message) => { if (!condition) failures += 1; console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`); };
const hash = (character) => character.repeat(64);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function startServer() {
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root, env: { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(temp, `pairing-${port}.json`) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
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

async function stop(child) {
  if (child.exitCode === null) child.kill();
  for (let i = 0; i < 60 && child.exitCode === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function tokenFor(base) { return (await (await fetch(`${base}/api/csrf-token`)).json()).data.token; }
async function request(base, token, route, { method = 'GET', json, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; headers['X-LPS-CSRF'] = token; }
  if (key) headers['X-LPS-Idempotency-Key'] = key;
  const response = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await response.json(); } catch { /* non-JSON */ }
  return { status: response.status, body };
}

const legacySeed = new DatabaseSync(dbPath);
legacySeed.exec("CREATE TABLE legacy_preservation_probe (value TEXT NOT NULL); INSERT INTO legacy_preservation_probe VALUES ('preserve-me');");
legacySeed.close();
const first = await startServer();
const token = await tokenFor(first.base);
let projectId;
try {
  const project = await request(first.base, token, '/api/projects', { method: 'POST', json: { name: 'Loop fixture', status: 'active' } });
  projectId = project.body.data.id;
  const baseAttempt = (runId, overrides = {}) => ({
    runId, workItemType: 'project', workItemId: projectId,
    item: { id: projectId, state: 'active', scope: ['docs'], requiredEvidence: ['current source'], expectedOutput: 'A reviewed answer', stopConditions: ['stop on blocker'] },
    phase: 'intake',
    question: { type: 'clarification', text: 'Which bounded choice applies?', justifiedRetry: false },
    manifest: [{ path: 'docs/source.md', hash: hash('c') }],
    available: [{ path: 'docs/source.md', hash: hash('c'), stale: false }],
    limit: 3,
    ...overrides
  });
  const post = (payload, key, base = first.base, csrf = token) => request(base, csrf, '/api/loop/attempts', { method: 'POST', json: payload, key });

  line((await request(first.base, token, '/api/loop/attempts', { method: 'POST', json: baseAttempt('run:csrf'), key: 'loop-attempt:csrf', })).status === 200, 'a valid durable preparation request is accepted');
  line((await request(first.base, '', '/api/loop/attempts', { method: 'POST', json: baseAttempt('run:no-csrf'), key: 'loop-attempt:no-csrf' })).status === 403, 'durable preparation requires CSRF');
  line((await post(baseAttempt('run:no-key'), null)).status === 400, 'durable preparation requires an idempotency key');
  line((await post({ ...baseAttempt('run:injected'), attempts: [] }, 'loop-attempt:injected')).status === 400, 'callers cannot inject attempt history');
  line((await post({ ...baseAttempt('run:signature'), question: { ...baseAttempt('run:signature').question, _trustedSignature: 'forged' } }, 'loop-attempt:signature')).status === 400, 'callers cannot inject a trusted question signature');
  line((await post({ ...baseAttempt('run:hash-injection'), question: { ...baseAttempt('run:hash-injection').question, evidenceHash: hash('d') } }, 'loop-attempt:hash-injection')).status === 400, 'callers cannot inject evidence or state progress hashes');
  line((await post({ ...baseAttempt('run:duplicate-path'), manifest: [{ path: 'docs/source.md', hash: hash('c') }, { path: 'docs/source.md', hash: hash('d') }] }, 'loop-attempt:duplicate-path')).status === 400, 'duplicate attachment paths are rejected before evidence hashing');
  line((await post({ ...baseAttempt('run:case-collision'), manifest: [{ path: 'docs/A.md', hash: hash('c') }, { path: 'docs/a.md', hash: hash('d') }] }, 'loop-attempt:case-collision')).status === 400, 'Windows case-insensitive attachment collisions are rejected');
  line((await post({ ...baseAttempt('run:missing'), workItemId: 999999, item: { ...baseAttempt('run:missing').item, id: 999999 } }, 'loop-attempt:missing')).status === 404, 'a nonexistent Workboard target is rejected');

  const reorderedRun = 'run:reordered-replay';
  const reorderedPayload = {
    ...baseAttempt(reorderedRun),
    manifest: [{ path: 'docs/a.md', hash: hash('a') }, { path: 'docs/b.md', hash: hash('b') }],
    available: [{ path: 'docs/a.md', hash: hash('a'), stale: false }, { path: 'docs/b.md', hash: hash('b'), stale: false }]
  };
  const reorderedFirst = await post(reorderedPayload, 'loop-attempt:reordered-replay');
  const reorderedAgain = await post({ ...reorderedPayload, manifest: [...reorderedPayload.manifest].reverse(), available: [...reorderedPayload.available].reverse() }, 'loop-attempt:reordered-replay');
  line(reorderedFirst.status === 200 && reorderedAgain.body.data.replayed === true && reorderedAgain.body.data.id === reorderedFirst.body.data.id,
    'semantic attachment reordering replays the same normalized request');

  const replayPayload = baseAttempt('run:replay');
  const replayFirst = await post(replayPayload, 'loop-attempt:replay');
  const replayAgain = await post(replayPayload, 'loop-attempt:replay');
  line(replayFirst.status === 200 && replayAgain.body.data.replayed === true && replayAgain.body.data.id === replayFirst.body.data.id
    && replayAgain.body.data.preparationOnly === true && replayAgain.body.data.authorizationGranted === false
    && replayAgain.body.data.sent === false && replayAgain.body.data.executed === false,
  'an exact retry replays one explicitly non-authorizing preparation receipt');
  line((await post({ ...replayPayload, limit: 4 }, 'loop-attempt:replay')).status === 409, 'same-key payload drift is rejected');

  const contractRun = 'run:contract-drift';
  await post(baseAttempt(contractRun), 'loop-attempt:contract-drift-1');
  const changedContract = baseAttempt(contractRun);
  changedContract.item = { ...changedContract.item, expectedOutput: 'A different bounded answer' };
  line((await post(changedContract, 'loop-attempt:contract-drift-2')).status === 409, 'a changed bounded contract requires a new run');
  const limitRun = 'run:limit-drift';
  await post(baseAttempt(limitRun), 'loop-attempt:limit-drift-1');
  line((await post({ ...baseAttempt(limitRun), question: { ...baseAttempt(limitRun).question, text: 'Another bounded question' }, limit: 10 }, 'loop-attempt:limit-drift-2')).status === 409,
    'the no-progress limit is frozen for the reviewed run');

  const staleDb = new DatabaseSync(dbPath);
  staleDb.prepare("UPDATE projects SET status = 'paused' WHERE id = ?").run(projectId);
  staleDb.close();
  line((await post(baseAttempt('run:stale-state'), 'loop-attempt:stale-state')).status === 409, 'a stale caller state cannot prepare against changed canonical Workboard state');
  const restoreDb = new DatabaseSync(dbPath);
  restoreDb.prepare("UPDATE projects SET status = 'active' WHERE id = ?").run(projectId);
  restoreDb.close();
  const canonicalDriftRun = 'run:canonical-drift';
  await post(baseAttempt(canonicalDriftRun), 'loop-attempt:canonical-drift-1');
  const driftDb = new DatabaseSync(dbPath);
  driftDb.prepare("UPDATE projects SET next_action = 'Changed canonical action', updated_at = '2030-01-01T00:00:00.000Z' WHERE id = ?").run(projectId);
  driftDb.close();
  line((await post({ ...baseAttempt(canonicalDriftRun), question: { ...baseAttempt(canonicalDriftRun).question, text: 'Another bounded question' } }, 'loop-attempt:canonical-drift-2')).status === 409,
    'same-status canonical Workboard drift invalidates the frozen run');

  const duplicateRun = 'run:duplicate';
  const duplicateFirst = await post(baseAttempt(duplicateRun), 'loop-attempt:duplicate-1');
  const duplicateBlocked = await post(baseAttempt(duplicateRun), 'loop-attempt:duplicate-2');
  line(duplicateFirst.body.data.ready === true && duplicateBlocked.body.data.blocked === true && duplicateBlocked.body.data.failureEventId
    && duplicateBlocked.body.data.preparationOnly === true && duplicateBlocked.body.data.authorizationGranted === false
    && duplicateBlocked.body.data.sent === false && duplicateBlocked.body.data.executed === false,
  'persisted history blocks a repeated question and creates an explicitly non-authorizing blocker record');
  const duplicateReplay = await post(baseAttempt(duplicateRun), 'loop-attempt:duplicate-2');
  line(duplicateReplay.body.data.replayed === true && duplicateReplay.body.data.id === duplicateBlocked.body.data.id, 'the blocked receipt itself remains safely replayable');
  line((await post({ ...baseAttempt(duplicateRun), question: { ...baseAttempt(duplicateRun).question, text: 'A new question' } }, 'loop-attempt:duplicate-3')).status === 409, 'a blocked run cannot continue without a new reviewed run');

  const retryRun = 'run:justified';
  await post(baseAttempt(retryRun), 'loop-attempt:justified-1');
  line((await post({ ...baseAttempt(retryRun), question: { ...baseAttempt(retryRun).question, justifiedRetry: true } }, 'loop-attempt:justified-missing')).status === 400, 'a justified retry requires a reason');
  const justified = await post({ ...baseAttempt(retryRun), question: { ...baseAttempt(retryRun).question, justifiedRetry: true }, retryReason: 'New reviewer requested the same bounded clarification.' }, 'loop-attempt:justified-2');
  line(justified.status === 200 && justified.body.data.blocked === false && justified.body.data.retryReason, 'a reasoned retry is persisted and remains within the guard');

  const stagnantRun = 'run:stagnant';
  const stagnantResults = [];
  for (let index = 1; index <= 3; index += 1) {
    stagnantResults.push(await post({
      ...baseAttempt(stagnantRun),
      question: { ...baseAttempt(stagnantRun).question, text: `Distinct bounded question ${index}` }
    }, `loop-attempt:stagnant-${index}`));
  }
  line(stagnantResults[0].body.data.blocked === false && stagnantResults[1].body.data.blocked === false && stagnantResults[2].body.data.blocked === true,
    'persisted non-duplicate stagnant history reaches the configured no-progress limit');
  const evidenceOrderRun = 'run:evidence-order';
  const evidenceManifest = [{ path: 'docs/a.md', hash: hash('a') }, { path: 'docs/b.md', hash: hash('b') }];
  const evidenceAvailable = [{ path: 'docs/a.md', hash: hash('a'), stale: false }, { path: 'docs/b.md', hash: hash('b'), stale: false }];
  const evidenceOrderResults = [];
  evidenceOrderResults.push(await post({ ...baseAttempt(evidenceOrderRun), question: { ...baseAttempt(evidenceOrderRun).question, text: 'Distinct evidence question one' }, manifest: evidenceManifest, available: evidenceAvailable }, 'loop-attempt:evidence-order-1'));
  evidenceOrderResults.push(await post({ ...baseAttempt(evidenceOrderRun), question: { ...baseAttempt(evidenceOrderRun).question, text: 'Distinct evidence question two' }, manifest: [...evidenceManifest].reverse(), available: [...evidenceAvailable].reverse() }, 'loop-attempt:evidence-order-2'));
  evidenceOrderResults.push(await post({ ...baseAttempt(evidenceOrderRun), question: { ...baseAttempt(evidenceOrderRun).question, text: 'Distinct evidence question three' }, manifest: evidenceManifest, available: [...evidenceAvailable, { path: 'docs/unrelated.md', hash: hash('e'), stale: false }] }, 'loop-attempt:evidence-order-3'));
  line(evidenceOrderResults[0].body.data.blocked === false && evidenceOrderResults[1].body.data.blocked === false && evidenceOrderResults[2].body.data.blocked === true,
    'reordering evidence or adding unrelated availability cannot reset persisted stagnation');

  const transitionRun = 'run:transition';
  await post(baseAttempt(transitionRun), 'loop-attempt:transition-1');
  const transitionedPayload = { ...baseAttempt(transitionRun), phase: 'planning', question: { ...baseAttempt(transitionRun).question, text: 'Which plan is approved?' } };
  line((await post(transitionedPayload, 'loop-attempt:transition-missing')).status === 400, 'phase transitions require a reason');
  line((await post({ ...transitionedPayload, transitionReason: 'The intake question was answered and planning began.' }, 'loop-attempt:transition-2')).status === 200, 'a bounded transition reason is persisted');
  const unsafeManifest = await post({ ...baseAttempt('run:manifest'), manifest: [{ path: 'outside/source.md', hash: hash('c') }] }, 'loop-attempt:manifest');
  line(unsafeManifest.body.data.ready === false && unsafeManifest.body.data.preparationOnly === true
    && unsafeManifest.body.data.authorizationGranted === false && unsafeManifest.body.data.sent === false && unsafeManifest.body.data.executed === false,
  'an out-of-scope attachment is durably not ready and never authorizes execution');

  const atomicRun = 'run:atomic-failure';
  await post(baseAttempt(atomicRun), 'loop-attempt:atomic-failure-1');
  const triggerDb = new DatabaseSync(dbPath);
  triggerDb.exec("CREATE TRIGGER fail_loop_blocker BEFORE INSERT ON failure_events WHEN NEW.source = 'unattended-loop-guard' BEGIN SELECT RAISE(ABORT, 'injected blocker failure'); END;");
  triggerDb.close();
  const atomicFailure = await post(baseAttempt(atomicRun), 'loop-attempt:atomic-failure-2');
  const atomicDb = new DatabaseSync(dbPath);
  const atomicCount = atomicDb.prepare('SELECT COUNT(*) AS count FROM unattended_preparation_attempts WHERE run_id = ?').get(atomicRun).count;
  atomicDb.exec('DROP TRIGGER fail_loop_blocker');
  atomicDb.close();
  line(atomicFailure.status === 500 && atomicCount === 1, 'blocker settlement failure rolls back both the blocked receipt and failure event');

  const second = await startServer();
  const secondToken = await tokenFor(second.base);
  const concurrentPayload = baseAttempt('run:concurrent');
  const concurrent = await Promise.all([
    post(concurrentPayload, 'loop-attempt:concurrent', first.base, token),
    post(concurrentPayload, 'loop-attempt:concurrent', second.base, secondToken)
  ]);
  line(concurrent.every((result) => result.status === 200) && new Set(concurrent.map((result) => result.body.data.id)).size === 1, 'two runtimes converge on one persisted attempt receipt');
  const semanticRaceRun = 'run:semantic-race';
  const semanticRacePayload = baseAttempt(semanticRaceRun);
  const semanticRace = await Promise.all([
    post(semanticRacePayload, 'loop-attempt:semantic-race-a', first.base, token),
    post(semanticRacePayload, 'loop-attempt:semantic-race-b', second.base, secondToken)
  ]);
  line(semanticRace.every((result) => result.status === 200)
    && semanticRace.filter((result) => result.body.data.blocked).length === 1
    && semanticRace.filter((result) => !result.body.data.blocked).length === 1,
  'different-key concurrent semantic attempts serialize into one initial receipt and one blocker');
  await stop(second.child);

  const audit = await request(first.base, token, `/api/loop/attempts?runId=${encodeURIComponent(duplicateRun)}&workItemType=project&workItemId=${projectId}`);
  line(audit.status === 200 && audit.body.data.length === 2 && !/attempt_key|request_hash|question_signature|contract_hash|manifest_hash/.test(JSON.stringify(audit.body.data)), 'bounded audit history omits idempotency and internal hash fields');
  const db = new DatabaseSync(dbPath);
  const failure = db.prepare("SELECT * FROM failure_events WHERE source = 'unattended-loop-guard' AND run_id = ?").get(duplicateRun);
  const attempts = db.prepare('SELECT COUNT(*) AS count FROM unattended_preparation_attempts WHERE run_id = ?').get(duplicateRun).count;
  const memoryCount = db.prepare('SELECT COUNT(*) AS count FROM memory_candidates').get().count;
  const legacyProbe = db.prepare('SELECT value FROM legacy_preservation_probe').get();
  db.close();
  line(attempts === 2 && failure?.status === 'observed' && /nothing was sent or executed/i.test(failure.outcome), 'blocked preparation and one observed failure settle atomically without execution');
  line(memoryCount === 0, 'durable preparation creates no memory candidate or automatic promotion');
  line(legacyProbe?.value === 'preserve-me', 'legacy databases migrate without rewriting existing data');
} finally {
  await stop(first.child);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll durable unattended-preparation checks passed.');
process.exit(failures ? 1 : 0);
