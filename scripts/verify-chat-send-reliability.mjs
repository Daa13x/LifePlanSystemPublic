import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { awaitChatSendResult, isChatSendOriginActive, isLatestChatConnectionRequest } from '../src/chatSendClient.js';

const root = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-chat-send-'));
const dbPath = path.join(probeRoot, 'chat.sqlite');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const held = [];
let modelCalls = 0;
const modelPort = await freePort();
const modelServer = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    modelCalls += 1;
    const payload = JSON.parse(raw || '{}');
    const prompt = String(payload.messages?.at(-1)?.content || '');
    // The real Chat prompt includes bounded prior history. Match only the
    // CURRENT trailing User line, otherwise an earlier [TEST HOLD] marker makes
    // every later model request hang and turns this verifier into a false five-
    // minute runtime timeout after conversation-history support is enabled.
    const currentTurnHolds = /(?:^|\n)User: \[TEST HOLD\][^\n]*$/.test(prompt);
    const currentTurnFails = /(?:^|\n)User: \[TEST FAIL\][^\n]*$/.test(prompt);
    const answer = `counted reply ${modelCalls}`;
    const finish = () => {
      if (res.writableEnded || res.destroyed) return;
      if (currentTurnFails) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Injected model failure.' } }));
        return;
      }
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': payload.stream ? 'text/event-stream' : 'application/json' });
      if (payload.stream) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
      }
    };
    if (currentTurnHolds) {
      res.writeHead(200, { 'Content-Type': payload.stream ? 'text/event-stream' : 'application/json' });
      res.flushHeaders?.();
      held.push(finish);
    } else finish();
  });
});
await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(modelPort, '127.0.0.1', resolve); });

let app = null;
let base = '';
let csrf = '';
async function startApp() {
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing.json') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const nextBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chat reliability server exited (${child.exitCode}).\n${output.join('')}`);
    try { if ((await fetch(`${nextBase}/api/health`)).ok) return { child, base: nextBase, output }; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chat reliability server did not become healthy.\n${output.join('')}`);
}

async function stopApp() {
  if (!app) return;
  await stopChild(app.child);
  app = null;
}

async function stopChild(child) {
  if (child.exitCode === null) child.kill();
  for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function resetConnection() {
  app = await startApp();
  base = app.base;
  csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
}

async function request(route, { method = 'GET', body, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; headers['X-LPS-CSRF'] = csrf; }
  if (key) headers['X-LPS-Idempotency-Key'] = key;
  const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function releaseHeld() {
  const release = held.shift();
  assert.ok(release, 'a fake model response is held');
  release();
}

try {
  await resetConnection();
  assert.equal((await request('/api/settings', { method: 'POST', body: { localModelEndpoint: `http://127.0.0.1:${modelPort}`, localModelName: 'counted-model' } })).status, 200);
  const session = (await request('/api/chat/sessions', { method: 'POST', body: { title: 'Chat reliability fixture' } })).payload.data;
  const route = `/api/chat/sessions/${session.id}/messages`;
  const streamRoute = `${route}/stream`;

  const jsonKey = 'chat-json-key-0001';
  const first = await request(route, { method: 'POST', key: jsonKey, body: { content: 'A deterministic JSON turn.' } });
  assert.equal(first.status, 200);
  assert.equal(modelCalls, 1, 'first JSON send invokes the model once');
  const replay = await request(route, { method: 'POST', key: jsonKey, body: { content: 'A deterministic JSON turn.' } });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.payload.data.messages.map((item) => item.id), first.payload.data.messages.map((item) => item.id), 'same-key JSON replay returns the exact durable turn');
  assert.equal(modelCalls, 1, 'same-key JSON replay never invokes the model again');
  const conflict = await request(route, { method: 'POST', key: jsonKey, body: { content: 'Changed content must conflict.' } });
  assert.equal(conflict.status, 409);
  assert.equal(modelCalls, 1, 'same-key changed content mutates nothing and invokes no model');
  const malformed = await request(route, { method: 'POST', key: 'bad key', body: { content: 'Malformed keys fail closed.' } });
  assert.equal(malformed.status, 400, 'a supplied malformed key is rejected');
  assert.equal(modelCalls, 1, 'a malformed key writes nothing and invokes no model');

  const streamKey = 'chat-stream-key-0002';
  const streamResponse = await fetch(`${base}${streamRoute}`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-LPS-CSRF': csrf, 'X-LPS-Idempotency-Key': streamKey },
    body: JSON.stringify({ content: '[TEST HOLD] One cross-transport turn.' })
  });
  await waitFor(() => modelCalls === 2, 'held streaming model call did not start');
  const activeConnection = await request(`/api/chat/sessions/${session.id}/connection`);
  assert.equal(activeConnection.payload.data.generating, true, 'connection status exposes the durable active request for remounted Chat views');
  assert.equal(activeConnection.payload.data.generation.state, 'pending');
  const concurrent = await request(route, { method: 'POST', key: streamKey, body: { content: '[TEST HOLD] One cross-transport turn.' } });
  assert.equal(concurrent.status, 202, 'a concurrent cross-transport duplicate reports pending');
  assert.equal(modelCalls, 2, 'concurrent duplicate never starts a second model call');
  const secondApp = await startApp();
  try {
    const secondCsrf = (await (await fetch(`${secondApp.base}/api/csrf-token`)).json()).data.token;
    const crossProcess = await fetch(`${secondApp.base}${route}`, {
      method: 'POST',
      headers: { Origin: secondApp.base, 'Content-Type': 'application/json', 'X-LPS-CSRF': secondCsrf, 'X-LPS-Idempotency-Key': streamKey },
      body: JSON.stringify({ content: '[TEST HOLD] One cross-transport turn.' })
    });
    assert.equal(crossProcess.status, 202, 'a second server process replays the unexpired pending request');
    assert.equal(modelCalls, 2, 'the second process never steals an unexpired lease or invokes the model');
  } finally {
    await stopChild(secondApp.child);
  }
  releaseHeld();
  await streamResponse.text();
  const streamReplay = await request(route, { method: 'POST', key: streamKey, body: { content: '[TEST HOLD] One cross-transport turn.' } });
  assert.equal(streamReplay.status, 200);
  assert.equal(modelCalls, 2, 'completed SSE request replays through JSON without another model call');
  assert.equal((await request(`/api/chat/sessions/${session.id}/connection`)).payload.data.generating, false, 'connection status clears only after durable terminal settlement');

  const jsonFirstKey = 'chat-json-first-0003';
  const jsonFirst = request(route, { method: 'POST', key: jsonFirstKey, body: { content: '[TEST HOLD] JSON owns this cross-transport turn.' } });
  await waitFor(() => modelCalls === 3, 'held JSON model call did not start');
  const distinctWhileActive = await request(route, { method: 'POST', key: 'chat-distinct-active-0001', body: { content: 'A second logical send must not overtake the active turn.' } });
  assert.equal(distinctWhileActive.status, 409, 'a distinct key cannot create another user turn while this session is active');
  assert.equal(modelCalls, 3, 'a distinct active-session conflict invokes no model');
  const sseDuplicate = await fetch(`${base}${streamRoute}`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-LPS-CSRF': csrf, 'X-LPS-Idempotency-Key': jsonFirstKey },
    body: JSON.stringify({ content: '[TEST HOLD] JSON owns this cross-transport turn.' })
  });
  assert.match(await sseDuplicate.text(), /"pending":true/, 'SSE reports the already-active JSON request without invoking the model');
  assert.equal(modelCalls, 3);
  releaseHeld();
  assert.equal((await jsonFirst).status, 200);

  const cancelKey = 'chat-cancel-key-0004';
  const cancelledResponse = await fetch(`${base}${streamRoute}`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-LPS-CSRF': csrf, 'X-LPS-Idempotency-Key': cancelKey },
    body: JSON.stringify({ content: '[TEST HOLD] Cancel this exact turn.' })
  });
  await waitFor(() => modelCalls === 4, 'held cancellation model call did not start');
  assert.equal((await request(`/api/chat/sessions/${session.id}/cancel`, { method: 'POST', body: {} })).payload.data.cancelled, true);
  releaseHeld();
  await cancelledResponse.text();
  const cancelledReplay = await request(route, { method: 'POST', key: cancelKey, body: { content: '[TEST HOLD] Cancel this exact turn.' } });
  assert.equal(cancelledReplay.payload.data.terminalState, 'cancelled');
  assert.equal(modelCalls, 4, 'cancelled request replays without another model call');

  const failureKey = 'chat-failure-key-0005';
  const failed = await request(route, { method: 'POST', key: failureKey, body: { content: '[TEST FAIL] Settle one retryable error.' } });
  assert.equal(failed.status, 200);
  assert.equal(failed.payload.data.terminalState, 'retryable_error');
  assert.equal(modelCalls, 5, 'the failing model is invoked once');
  const failedReplay = await request(route, { method: 'POST', key: failureKey, body: { content: '[TEST FAIL] Settle one retryable error.' } });
  assert.equal(failedReplay.payload.data.terminalState, 'retryable_error');
  assert.equal(modelCalls, 5, 'same-key failure replay does not invoke the model again');
  const deliberateRetry = await request(route, { method: 'POST', key: 'chat-failure-retry-0006', body: { content: 'A deliberate retry uses a fresh logical-send key.' } });
  assert.equal(deliberateRetry.status, 200);
  assert.equal(modelCalls, 6, 'a fresh key represents a deliberate new send');

  const restartKey = 'chat-restart-key-0007';
  const interruptedResponse = await fetch(`${base}${streamRoute}`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-LPS-CSRF': csrf, 'X-LPS-Idempotency-Key': restartKey },
    body: JSON.stringify({ content: '[TEST HOLD] Interrupt this process.' })
  });
  await waitFor(() => modelCalls === 7, 'held restart model call did not start');
  await stopApp();
  await interruptedResponse.text().catch(() => '');
  const recoveryDb = new DatabaseSync(dbPath);
  recoveryDb.prepare("UPDATE chat_send_requests SET lease_expires_at = ? WHERE session_id = ? AND idempotency_key = ? AND state = 'pending'")
    .run(new Date(0).toISOString(), session.id, restartKey);
  recoveryDb.close();
  releaseHeld();
  await resetConnection();
  await waitFor(async () => {
    const history = await request(`/api/chat/sessions/${session.id}/messages`);
    return history.payload.data.some((message) => message.role === 'assistant' && JSON.parse(message.metadata || '{}').terminalState === 'interrupted');
  }, 'restart did not recover the expired request as one interrupted terminal turn');
  const restartReplay = await request(route, { method: 'POST', key: restartKey, body: { content: '[TEST HOLD] Interrupt this process.' } });
  assert.equal(restartReplay.payload.data.terminalState, 'interrupted');
  assert.equal(modelCalls, 7, 'restart replay never invokes the model again');

  const history = (await request(`/api/chat/sessions/${session.id}/messages`)).payload.data;
  const counts = history.reduce((acc, message) => ({ ...acc, [message.role]: (acc[message.role] || 0) + 1 }), {});
  assert.deepEqual(counts, { user: 7, assistant: 7 }, 'seven logical sends persist exactly seven user and seven terminal assistant rows');
  const durable = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(durable.prepare('SELECT COUNT(*) AS n FROM chat_send_requests').get().n, 7);
  assert.equal(durable.prepare("SELECT COUNT(*) AS n FROM chat_send_requests WHERE state IN ('pending','cancel_requested')").get().n, 0);
  durable.close();

  const ui = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8');
  assert.match(ui, /const requestKey = crypto\.randomUUID\(\)\.replaceAll\('-', ''\)/);
  assert.match(ui, /'X-LPS-Idempotency-Key': requestKey/, 'the initial stream sends the generated request key');
  assert.match(ui, /'X-LPS-Idempotency-Key': durableKey/, 'the fallback sends the key retained by the reconciliation helper');
  assert.match(ui, /Streaming was interrupted; reconnecting to the same saved reply/);
  assert.ok((ui.match(/sendViaJson\(outgoing, optimisticId, requestKey, originSessionId\)/g) || []).length >= 2, 'both fallback paths reconcile the originating logical send');
  assert.match(ui, /if \(canRenderOrigin\(\)\) setMessages\(history\)/, 'originating history is never rendered after navigation to another chat');
  assert.match(ui, /return \(\) => \{ chatInstanceActiveRef\.current = false; \}/, 'an unmounted Chat instance invalidates every stale async completion');
  assert.ok((ui.match(/isChatSendOriginActive\(selectedSessionRef\.current, originSessionId, chatInstanceActiveRef\.current\)/g) || []).length >= 2, 'stream and fallback rendering require the live component instance');
  assert.equal(isChatSendOriginActive(12, 12), true);
  assert.equal(isChatSendOriginActive('12', 12), true);
  assert.equal(isChatSendOriginActive(13, 12), false, 'a completed send from chat A cannot render after navigation to chat B');
  assert.equal(isChatSendOriginActive(12, 12, false), false, 'a stale completion cannot render after its Chat instance unmounts');
  assert.equal(isLatestChatConnectionRequest(2, 2, 12, 12), true, 'the latest same-session connection response may update the UI');
  assert.equal(isLatestChatConnectionRequest(2, 1, 12, 12), false, 'an older same-session connection response cannot overwrite a newer result');
  assert.equal(isLatestChatConnectionRequest(2, 2, 13, 12), false, 'the latest response still cannot cross session boundaries');
  const loadConnectionStart = ui.indexOf('async function loadConnection(');
  const loadConnectionEnd = ui.indexOf('\n  async function loadCloudChecks(', loadConnectionStart);
  const loadConnectionSource = ui.slice(loadConnectionStart, loadConnectionEnd);
  assert.ok(loadConnectionStart >= 0 && loadConnectionEnd > loadConnectionStart, 'connection loader has a bounded source slice');
  const obsoleteGuardIndex = loadConnectionSource.indexOf('if (!isChatSendOriginActive(selectedSessionRef.current, sessionId, chatInstanceActiveRef.current)) return;');
  const requestAllocationIndex = loadConnectionSource.indexOf('const requestId = connectionRequestRef.current + 1;');
  assert.ok(obsoleteGuardIndex >= 0, 'connection loader explicitly rejects an obsolete session');
  assert.ok(requestAllocationIndex >= 0, 'connection loader allocates a monotonic request identity');
  assert.ok(obsoleteGuardIndex < requestAllocationIndex, 'an obsolete session is rejected before it can invalidate the active session request counter');
  assert.match(ui, /if \(!originSessionId \|\| !connection\?\.generating/, 'a remounted Chat reattaches only when the durable connection reports an active send');
  assert.match(ui, /setChatBusy\(Boolean\(nextConnection\.generating\)\)/, 'the remounted Chat remains busy until the durable request reaches terminal state');
  assert.match(ui, /setConnection\(next\);\s*setChatBusy\(Boolean\(next\.generating\)\)/, 'switching from active chat A to inactive chat B clears session-scoped busy state');
  assert.match(ui, /if \(canRenderOrigin\(\)\) \{\s*setStreamingText\(null\);\s*setWarmupNote\(''\);\s*setChatBusy\(false\);/, 'a stale completion from chat A cannot clear an active chat B busy state');
  assert.match(ui, /setMessages\(history\);[\s\S]{0,180}saved local reply finished/, 'the remounted Chat renders the eventual terminal history without another manual reopen');

  const clientCalls = [];
  const clientWaits = [];
  const clientTerminal = { messages: [{ id: 10 }, { id: 11 }], terminalState: 'completed' };
  const reconciled = await awaitChatSendResult({
    content: 'One accepted client send.',
    requestKey: 'client-reconcile-key-0001',
    maxAttempts: 4,
    initialDelayMs: 10,
    maxDelayMs: 20,
    wait: async (delayMs) => { clientWaits.push(delayMs); },
    send: async (request) => {
      clientCalls.push(request);
      return clientCalls.length < 3 ? { pending: true, state: 'pending' } : clientTerminal;
    }
  });
  assert.equal(reconciled, clientTerminal, 'the client returns the eventual durable terminal receipt');
  assert.equal(clientCalls.length, 3, 'the client retries pending receipts until terminal');
  assert.deepEqual(new Set(clientCalls.map((call) => call.requestKey)), new Set(['client-reconcile-key-0001']), 'every client retry preserves the original semantic key');
  assert.deepEqual(clientWaits, [10, 15], 'client reconciliation uses bounded backoff without real sleeps in the verifier');
  const exhausted = await awaitChatSendResult({
    content: 'Bound the pending loop.', requestKey: 'client-bounded-key-0002', maxAttempts: 2,
    wait: async () => {}, send: async () => ({ pending: true })
  });
  assert.equal(exhausted, null, 'the client pending loop terminates at its explicit bound');

  console.log('Chat send idempotency, cross-transport retry, cancellation, and restart recovery verification passed.');
} finally {
  await stopApp();
  await new Promise((resolve) => modelServer.close(resolve));
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
