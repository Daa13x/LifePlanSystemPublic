import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// HTTP acceptance for the read-only local-answerability probe on a disposable
// LIFE_PLANNER_DB (never the user's data): the endpoint is local-first and
// policy-gated, it only ever *offers* a reviewed cloud check (never sends), and
// it writes nothing. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-answerability-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
// Isolate retrieval from this machine's real private repo (default
// ~/Documents/LifePlanSystem) so "no local records" is deterministic.
const emptyPrivateRepo = path.join(probeRoot, 'empty-private-repo');
fs.mkdirSync(emptyPrivateRepo, { recursive: true });

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
    env: { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing.json'), LIFE_PLANNER_PRIVATE_REPO: emptyPrivateRepo },
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
async function stopServer(child) { if (child.exitCode === null) child.kill(); for (let i = 0; i < 40 && child.exitCode === null; i += 1) await new Promise((r) => setTimeout(r, 50)); }

let base = '';
let token = '';
async function api(route, { method = 'GET', json } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; headers['X-LPS-CSRF'] = token; }
  const res = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

console.log('--- chat answerability HTTP verification ---');

// Static wiring: the model-generation path can't be exercised without a model,
// so assert the assessment is imported, computed local-first, policy-gated, and
// carried into the reply metadata (never triggering a send).
{
  const server = fs.readFileSync(path.join(appRoot, 'server', 'index.js'), 'utf8');
  line(/import \{ assessLocalAnswerability \} from '\.\/localAnswerability\.js'/.test(server), 'the answerability engine is imported by the server');
  line(/function chatCloudPolicy\(\)[\s\S]*getSetting\('cloudEnabledProviders'/.test(server), 'the cloud policy gate reads cloudEnabledProviders');
  line(/const answerability = grounded\s*\?\s*assessLocalAnswerability\(retrieved, \{ question: userMessage, cloudPolicy: chatCloudPolicy\(\) \}\)/.test(server), 'the conversation prompt computes answerability local-first (only when grounded)');
  line(/localSources: retrieved\.items\.map\(\(item\) => \(\{[^}]*sourceId: item\.canonicalId[^}]*sourceType: item\.sourceType/.test(server), 'the grounded model path preserves stable source IDs and source types');
  line(/localAnswerability: assistant\.answerability \|\| null/.test(server), 'the reply metadata carries the local-answerability decision');
}

const server = await startServer(await freePort());
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  // A substantive question made only of nonsense tokens: it matches nothing in
  // the bundled public-sanitized knowledge, so local coverage is deterministically
  // "none" regardless of what ships in the checkout.
  const NOMATCH = '/api/chat/answerability?q=' + encodeURIComponent('xyzzy plughquux frobnitz zbufflewick');
  const HEALTH = '/api/chat/answerability?q=' + encodeURIComponent('what medication am i currently taking');

  line((await api('/api/chat/answerability')).status === 400, 'a missing question is rejected (400)');

  // Cloud disabled by default: local-first, no evidence, and NO escalation offered.
  const off = (await api(NOMATCH)).body.data;
  line(off.coverage === 'none' && off.answerable === false, 'with no matching local records the question is not locally answerable');
  line(off.escalation.permitted === false && off.escalation.suggested === false, 'cloud escalation is not offered while no provider is enabled (policy gate)');
  line(off.escalation.requiresApproval === true, 'escalation always records that it requires explicit user approval');
  line(Array.isArray(off.reasons) && off.reasons.length > 0, 'the decision is explained in plain language');

  // Enable a provider: now escalation may be OFFERED (still approval-gated, still no send).
  line((await api('/api/settings', { method: 'POST', json: { cloudEnabledProviders: ['chatgpt'] } })).status === 200, 'a cloud provider can be enabled in settings');
  const on = (await api(NOMATCH)).body.data;
  line(on.escalation.permitted === true && on.escalation.suggested === true, 'with a provider enabled and thin local evidence, a reviewed cloud check is offered');
  line(on.escalation.requiresApproval === true, 'the offered escalation still requires explicit approval');

  // Privacy: a sensitive question is never nudged toward the cloud, even enabled.
  const health = (await api(HEALTH)).body.data;
  line(health.sensitive === true && health.escalation.suggested === false, 'a sensitive health question is never auto-suggested for cloud');

  // Memory-storage provenance is runtime data, not a model guess. The answer
  // must name the exact disposable paths supplied to this server and preserve
  // the review-before-promotion boundary.
  const session = (await api('/api/chat/sessions', { method: 'POST', json: { title: 'Memory storage fixture' } })).body.data;
  const storageTurn = await api(`/api/chat/sessions/${session.id}/messages`, { method: 'POST', json: { content: 'Where are my memories stored locally?' } });
  const storageAnswer = storageTurn.body.data.messages.find((message) => message.role === 'assistant');
  const storageMetadata = JSON.parse(storageAnswer.metadata);
  line(storageTurn.status === 200 && storageMetadata.runtime === 'memory storage (local data)' && storageMetadata.endpointType === 'local-data', 'memory-storage questions use deterministic local runtime data');
  line(storageAnswer.content.includes(dbPath) && storageAnswer.content.includes(emptyPrivateRepo), 'the memory-storage answer names the exact active database and private-repository paths');
  line(/review candidates[\s\S]*explicitly approve promotion/i.test(storageAnswer.content), 'the memory-storage answer preserves review-before-promotion governance');

  // The probe is READ-ONLY: it must not have created any cloud check.
  const checks = await api('/api/chat/sessions/1/cloud-checks');
  line(checks.status === 200 && Array.isArray(checks.body.data) && checks.body.data.length === 0, 'the read-only probe never created a cloud check or sent anything');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll chat-answerability HTTP checks passed.');
process.exit(failures ? 1 : 0);
