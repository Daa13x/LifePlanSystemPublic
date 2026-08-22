import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// HTTP acceptance for the adaptive cost-routing routes on a disposable
// LIFE_PLANNER_DB (never the user's data): CSRF-gated recording, measured
// recommendation and summary, and evidence-driven escalation. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-routing-'));
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
async function startServer(port, databasePath = dbPath) {
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: appRoot,
    env: { ...process.env, LIFE_PLANNER_DB: databasePath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing.json') },
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
async function retryStart(databasePath = dbPath, attempts = 6) {
  // The server binds a fixed port, and freePort() has an open->close->rebind
  // window; under a busy CI runner that port can be taken, so the server exits
  // early on EADDRINUSE. Retry on a fresh port before giving up.
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await startServer(await freePort(), databasePath); }
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
async function api(route, { method = 'GET', json, csrf = 'valid', idempotencyKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; if (csrf === 'valid') headers['X-LPS-CSRF'] = token; }
  if (idempotencyKey) headers['X-LPS-Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
let observationSequence = 0;
const completeObservation = (overrides = {}) => {
  observationSequence += 1;
  const value = {
    taskClass: 'fixture', route: 'local-low', model: 'local/qwen-fixture', effort: 'low',
    runRef: `run:${observationSequence}`, taskRef: 'task:fixture', costUnit: 'lps-effective-unit-v1',
    cost: 1, verificationPassed: true, verificationRef: `verification:${observationSequence}`,
    accepted: true, ...overrides
  };
  if (value.verificationPassed === false && !Object.hasOwn(overrides, 'verificationRef') && !Object.hasOwn(overrides, 'verification_ref')) value.verificationRef = null;
  return value;
};
const observe = (json, { key = `routing-observation:${++observationSequence}`, raw = false } = {}) => api('/api/routing/observations', {
  method: 'POST', json: raw ? json : completeObservation(json), idempotencyKey: key
});

console.log('--- routing HTTP verification ---');
const server = await retryStart();
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  line((await api('/api/routing/observations', { method: 'POST', json: { taskClass: 'x', route: 'y' }, csrf: 'none' })).status === 403, 'recording an observation without CSRF is rejected (403)');
  line((await observe({ route: 'local-low', model: 'local/qwen', effort: 'low', runRef: 'run:missing-task', taskRef: 'task:fixture', costUnit: 'lps-effective-unit-v1', cost: 1, verificationPassed: false }, { raw: true })).status === 400, 'an observation without a task class is rejected (400)');
  line((await api('/api/routing/observations', { method: 'POST', json: completeObservation(), idempotencyKey: 'bad' })).status === 400, 'a malformed observation idempotency key is rejected');

  // With no evidence, recommendation is the default and flagged unmeasured.
  const cold = await api('/api/routing/recommend?taskClass=summarise');
  line(cold.status === 200 && cold.body.data.measured === false, 'with no observations the recommendation is the unmeasured default');

  // Record cheap-route successes; it should then be recommended (measured).
  for (let i = 0; i < 4; i += 1) await observe({ taskClass: 'summarise', route: 'local-low', cost: 1, verificationPassed: true, accepted: true });
  const warm = await api('/api/routing/recommend?taskClass=summarise');
  line(warm.body.data.route === 'local-low' && warm.body.data.measured === true, 'a cheap route with measured success is recommended');

  // A cheap route that fails should not be recommended over a passing pricier tier.
  for (let i = 0; i < 4; i += 1) await observe({ taskClass: 'code', route: 'local-low', cost: 1, verificationPassed: false, accepted: false });
  for (let i = 0; i < 4; i += 1) await observe({ taskClass: 'code', route: 'local-high', cost: 3, verificationPassed: true, accepted: true });
  const codeRec = await api('/api/routing/recommend?taskClass=code');
  line(codeRec.body.data.route === 'local-high', 'a repeatedly-failing cheap route is skipped for the next tier meeting the bar');
  const highRisk = await api('/api/routing/recommend?taskClass=code&highRisk=code');
  line(highRisk.body.data.requiresDeterministicChecks === true, 'a high-risk task class keeps deterministic checks regardless of tier');

  const summary = await api('/api/routing/summary');
  line(summary.status === 200 && summary.body.data.observationCount === 12 && summary.body.data.routes.some((r) => r.route === 'local-low'), 'the summary reports measured routes and observation count');
  line(summary.body.data.routes.every((route) => Object.hasOwn(route, 'costPerSuccessfulTask')), 'the summary exposes measured cost per successful task without removing compatibility fields');

  const invalidObservations = [
    { taskClass: 'x', route: 'unknown', cost: 1, verificationPassed: true },
    { taskClass: 'x', route: 'local-low', cost: '1', verificationPassed: true },
    { taskClass: 'x', route: 'local-low', cost: -1, verificationPassed: true },
    { taskClass: 'x', route: 'local-low', cost: 1, verificationPassed: 'false' },
    { taskClass: 'x', route: 'local-low', cost: 1, verificationPassed: true, accepted: 1 },
    { taskClass: 'x', route: 'local-low', cost: 1, verificationPassed: true, retries: 1.5 },
    { taskClass: 'x', route: 'local-low', cost: 1, verificationPassed: true, reviewMinutes: -1 },
    { taskClass: 'x', task_class: 'different', route: 'local-low', cost: 1, verificationPassed: true },
    { taskClass: 'x', route: 'local-low', cost: 1, verificationPassed: true, invented: true },
    { taskClass: 'x'.repeat(101), route: 'local-low', cost: 1, verificationPassed: true },
    { taskClass: 'x', route: 'local-low', model: 'C:\\models\\qwen.gguf', cost: 1, verificationPassed: true },
    { taskClass: 'x', route: 'local-low', effort: 'ultra', cost: 1, verificationPassed: true },
    { taskClass: 'x', route: 'local-low', runRef: 'contains spaces', cost: 1, verificationPassed: true },
    { taskClass: 'x', route: 'local-low', taskRef: '', cost: 1, verificationPassed: true },
    { taskClass: 'x', route: 'local-low', costUnit: 'GBP', cost: 1, verificationPassed: true },
    { taskClass: 'x', route: 'local-low', cost: 1, verificationPassed: true, verificationRef: null }
  ];
  for (const invalid of invalidObservations) line((await observe(invalid)).status === 400, 'malformed or coercion-shaped routing evidence is rejected');
  const snake = await observe({ task_class: 'snake-case', route: 'local-low', model: 'local/qwen-snake', effort: 'low', run_ref: 'run:snake', task_ref: 'task:snake', cost_unit: 'lps-effective-unit-v1', cost: 2, latency_ms: 10, retries: 0, review_minutes: 0.5, verification_passed: true, verification_ref: 'verification:snake', accepted: null }, { raw: true });
  line(snake.status === 200, 'bounded snake_case observation aliases remain compatible');

  const replayKey = 'routing-observation:stable-replay';
  const replayPayload = completeObservation({ taskClass: 'replay', runRef: 'run:replay', taskRef: 'task:replay' });
  const firstReplay = await observe(replayPayload, { raw: true, key: replayKey });
  const exactReplay = await observe({ task_class: replayPayload.taskClass, route: replayPayload.route, model: replayPayload.model, effort: replayPayload.effort, run_ref: replayPayload.runRef, task_ref: replayPayload.taskRef, cost_unit: replayPayload.costUnit, cost: replayPayload.cost, verification_passed: replayPayload.verificationPassed, verification_ref: replayPayload.verificationRef, accepted: replayPayload.accepted }, { raw: true, key: replayKey });
  line(firstReplay.status === 200 && exactReplay.status === 200 && exactReplay.body.data.replayed === true && exactReplay.body.data.id === firstReplay.body.data.id, 'a semantically identical retry replays the same routing observation');
  line((await observe({ ...replayPayload, cost: 2 }, { raw: true, key: replayKey })).status === 409, 'the same observation key with changed evidence is rejected');
  const alternateKeyReplay = await observe(replayPayload, { raw: true, key: 'routing-observation:alternate-key' });
  line(alternateKeyReplay.status === 200 && alternateKeyReplay.body.data.replayed === true && alternateKeyReplay.body.data.id === firstReplay.body.data.id, 'a new key cannot duplicate the same run and route variant');
  line((await observe({ ...replayPayload, cost: 3 }, { raw: true, key: 'routing-observation:alternate-conflict' })).status === 409, 'a new key cannot contradict an existing run and route variant');

  const concurrentKey = 'routing-observation:concurrent';
  const concurrentPayload = completeObservation({ taskClass: 'concurrent', runRef: 'run:concurrent', taskRef: 'task:concurrent' });
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => observe(concurrentPayload, { raw: true, key: concurrentKey })));
  line(concurrent.every((result) => result.status === 200) && new Set(concurrent.map((result) => result.body.data.id)).size === 1, 'concurrent identical retries store and return exactly one observation');

  const secondServer = await retryStart();
  const secondToken = (await (await fetch(`${secondServer.base}/api/csrf-token`)).json()).data.token;
  const crossProcessPayload = completeObservation({ taskClass: 'cross-process', runRef: 'run:cross-process', taskRef: 'task:cross-process' });
  const postAt = (targetBase, targetToken, key) => fetch(`${targetBase}/api/routing/observations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: targetBase, 'X-LPS-CSRF': targetToken, 'X-LPS-Idempotency-Key': key }, body: JSON.stringify(crossProcessPayload)
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const crossProcess = await Promise.all([
    postAt(base, token, 'routing-observation:cross-process-a'),
    postAt(secondServer.base, secondToken, 'routing-observation:cross-process-b')
  ]);
  await stopServer(secondServer.child);
  line(crossProcess.every((result) => result.status === 200) && new Set(crossProcess.map((result) => result.body.data.id)).size === 1, 'two runtimes using different keys persist exactly one run and route variant');

  for (let i = 0; i < 4; i += 1) await observe({ taskClass: 'measured-cost', route: 'local-low', cost: 10, verificationPassed: true, accepted: true });
  for (let i = 0; i < 4; i += 1) await observe({ taskClass: 'measured-cost', route: 'local-high', cost: 3, verificationPassed: true, accepted: true });
  const measuredCost = await api('/api/routing/recommend?taskClass=measured-cost');
  line(measuredCost.body.data.route === 'local-high' && measuredCost.body.data.costPerSuccessfulTask === 3 && /lowest measured cost per successful task/.test(measuredCost.body.data.reason), 'HTTP recommendation uses measured cost per successful task rather than a static tier label');

  const legacyDb = new DatabaseSync(dbPath);
  const insertLegacy = legacyDb.prepare('INSERT INTO routing_observations (task_class, route, cost, verification_passed, accepted) VALUES (?, ?, ?, 1, 1)');
  for (let i = 0; i < 4; i += 1) insertLegacy.run('legacy-invalid-cost', 'local-low', 2);
  for (let i = 0; i < 4; i += 1) insertLegacy.run('legacy-invalid-cost', 'local-high', -5);
  legacyDb.close();
  const legacyRecommendation = await api('/api/routing/recommend?taskClass=legacy-invalid-cost');
  const legacySummary = await api('/api/routing/summary');
  const invalidRoute = legacySummary.body.data.routes.find((route) => route.taskClass === 'legacy-invalid-cost' && route.route === 'local-high');
  line(legacyRecommendation.body.data.measured === false && invalidRoute.provenanceComplete === false && invalidRoute.costEvidenceValid === false && invalidRoute.costPerSuccessfulTask === null, 'legacy invalid or unattributed evidence is visible as incomplete and cannot influence measured selection');
  line(!/runRef|run_ref|taskRef|task_ref|verificationRef|verification_ref|observationKey|observation_key|requestHash|request_hash/.test(JSON.stringify(legacySummary.body.data)), 'aggregate routing summaries expose no run, task, verification, idempotency, or request-hash identifiers');

  // Escalation endpoint is evidence-driven.
  line((await api('/api/routing/escalation', { method: 'POST', json: { contradictsTests: true } })).body.data.escalate === true, 'a test contradiction escalates via the endpoint');
  line((await api('/api/routing/escalation', { method: 'POST', json: { verificationPassed: true, taskSoundsComplex: true } })).body.data.escalate === false, 'a passing route is not escalated on perceived complexity via the endpoint');

  const legacyPath = path.join(probeRoot, 'legacy', 'life-planner.sqlite');
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  const legacySchema = new DatabaseSync(legacyPath);
  legacySchema.exec(`CREATE TABLE routing_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_class TEXT NOT NULL, route TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0, latency_ms INTEGER, retries INTEGER NOT NULL DEFAULT 0,
    review_minutes REAL NOT NULL DEFAULT 0, verification_passed INTEGER NOT NULL DEFAULT 0,
    accepted INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ); INSERT INTO routing_observations (task_class, route, cost, verification_passed, accepted) VALUES ('legacy-schema', 'local-low', 1, 1, 1);`);
  legacySchema.close();
  const migratedServer = await retryStart(legacyPath);
  const migratedSummary = await (await fetch(`${migratedServer.base}/api/routing/summary`)).json();
  await stopServer(migratedServer.child);
  const migratedDb = new DatabaseSync(legacyPath);
  const migratedColumns = new Set(migratedDb.prepare('PRAGMA table_info(routing_observations)').all().map((column) => column.name));
  migratedDb.close();
  line(['model', 'effort', 'run_ref', 'task_ref', 'cost_unit', 'verification_ref', 'observation_key', 'request_hash'].every((column) => migratedColumns.has(column)), 'legacy routing schema migrates every nullable provenance and idempotency column in place');
  line(migratedSummary.data.routes.some((route) => route.taskClass === 'legacy-schema' && route.provenanceComplete === false && route.costPerSuccessfulTask === null), 'migrated legacy evidence remains visible but excluded from measured recommendations');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll routing HTTP checks passed.');
process.exit(failures ? 1 : 0);
