import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// HTTP acceptance for guided first-run capture (Phase 2): on a genuinely fresh
// disposable LIFE_PLANNER_DB (never the user's data), the seeded kickoff
// session asks one guided question; the reply is force-captured as a
// reviewable memory candidate (even when it carries no ordinary durable-signal
// heuristic) and gets a deterministic acknowledgement with no model
// configured; the candidate is never auto-promoted; and the one-shot capture
// does not repeat on a later message in the same session. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-onboarding-'));
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
async function api(route, { method = 'GET', json } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; headers['X-LPS-CSRF'] = token; }
  const res = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

console.log('--- guided first-run capture HTTP verification ---');
const server = await retryStart();
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  const sessions = (await api('/api/chat/sessions')).body.data;
  const kickoff = sessions.find((s) => s.title === 'Life Planner kickoff');
  line(Boolean(kickoff), 'a fresh install seeds exactly one pinned kickoff session');

  const seedMessages = (await api(`/api/chat/sessions/${kickoff.id}/messages`)).body.data;
  line(seedMessages.length === 1 && seedMessages[0].role === 'assistant' && /what's one thing/i.test(seedMessages[0].content), 'the kickoff session opens with the one seeded guided question');

  const candidatesBefore = (await api('/api/memory')).body.data.candidates.length;
  const genericAnswer = 'Trying to keep on top of my freelance invoicing this month';
  const answered = await api(`/api/chat/sessions/${kickoff.id}/messages`, { method: 'POST', json: { content: genericAnswer } });
  line(answered.status === 200, 'the onboarding answer is accepted');
  const assistantReply = answered.body.data.messages.find((m) => m.role === 'assistant');
  line(answered.body.data.runtime === 'onboarding acknowledgment' && /Review Queue/.test(assistantReply?.content || ''), 'a deterministic acknowledgement is returned with no model configured');

  const candidatesAfterAnswer = (await api('/api/memory')).body.data;
  line(candidatesAfterAnswer.candidates.length === candidatesBefore + 1, 'exactly one memory candidate is created from the onboarding answer');
  const candidate = candidatesAfterAnswer.candidates.find((c) => c.body === genericAnswer);
  line(Boolean(candidate) && candidate.status === 'candidate' && candidate.session_id === kickoff.id, 'the candidate holds the exact answer text, is unreviewed, and is bound to the kickoff session');
  line(candidatesAfterAnswer.items.every((item) => item.body !== genericAnswer), 'the onboarding answer is never auto-promoted into active Knowledge');

  // A generic reply like this would normally be dropped by the durable-signal
  // heuristic (no preference/decision/goal/rule keyword) -- proving the force
  // path, not a heuristic match, is what captured it.
  const heuristicWouldSkip = !/\b(prefer|always|never|decided|decision|goal|rule|constraint|deadline|recurring|pattern|remember|save)\b/i.test(genericAnswer);
  line(heuristicWouldSkip, 'the fixture answer deliberately carries no ordinary durable-signal keyword');

  const secondMessage = 'hi';
  const secondCandidatesBefore = (await api('/api/memory')).body.data.candidates.length;
  const second = await api(`/api/chat/sessions/${kickoff.id}/messages`, { method: 'POST', json: { content: secondMessage } });
  line(second.status === 200 && second.body.data.runtime !== 'onboarding acknowledgment', 'the one-shot onboarding acknowledgement does not repeat on a later message');
  const secondCandidatesAfter = (await api('/api/memory')).body.data.candidates.length;
  line(secondCandidatesAfter === secondCandidatesBefore, 'a later low-signal message ("hi") in the same session is not force-captured');
} finally {
  await stopServer(server.child);
  try {
    fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (cleanupError) {
    console.warn(`Temp cleanup warning (${cleanupError.code}): ${probeRoot} left for the OS to reclaim.`);
  }
}

// A separate fresh install: the very first reply to the guided question is
// short (under the ordinary 24-character candidate floor). The forced
// onboarding path must still capture it -- and must never claim it saved a
// candidate that was not actually created.
const probeRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-onboarding-short-'));
const dbPath2 = path.join(probeRoot2, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath2), { recursive: true });
async function startServer2(port) {
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: appRoot,
    env: { ...process.env, LIFE_PLANNER_DB: dbPath2, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot2, 'pairing.json') },
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
const server2 = await startServer2(await freePort());
const base2 = server2.base;
async function api2(route, { method = 'GET', json } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base2; headers['X-LPS-CSRF'] = token2; }
  const res = await fetch(`${base2}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
let token2 = '';
try {
  token2 = (await (await fetch(`${base2}/api/csrf-token`)).json()).data.token;
  const kickoff2 = (await api2('/api/chat/sessions')).body.data.find((s) => s.title === 'Life Planner kickoff');
  const shortAnswer = 'New job';
  line(shortAnswer.length < 24, 'the short-answer fixture is deliberately under the ordinary 24-character candidate floor');
  const candidatesBefore2 = (await api2('/api/memory')).body.data.candidates.length;
  const shortReply = await api2(`/api/chat/sessions/${kickoff2.id}/messages`, { method: 'POST', json: { content: shortAnswer } });
  const candidatesAfter2 = (await api2('/api/memory')).body.data;
  line(candidatesAfter2.candidates.length === candidatesBefore2 + 1, 'a short first reply is still captured as a candidate (the forced path bypasses the ordinary length floor)');
  const shortCandidate = candidatesAfter2.candidates.find((c) => c.body === shortAnswer);
  line(Boolean(shortCandidate), 'the short candidate holds the exact short answer text');
  const shortAssistantReply = shortReply.body.data.messages.find((m) => m.role === 'assistant');
  line(/Review Queue/.test(shortAssistantReply?.content || ''), 'the acknowledgement honestly confirms the short answer was actually saved');
} finally {
  await stopServer(server2.child);
  try {
    fs.rmSync(probeRoot2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (cleanupError) {
    console.warn(`Temp cleanup warning (${cleanupError.code}): ${probeRoot2} left for the OS to reclaim.`);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll guided first-run capture checks passed.');
process.exit(failures ? 1 : 0);
