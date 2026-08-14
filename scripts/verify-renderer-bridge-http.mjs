#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// End-to-end HTTP acceptance for the authenticated server -> renderer navigation
// bridge. It spins up the real server, registers a renderer, subscribes to its
// authenticated SSE command channel, invokes the navigation.workboard action, and
// proves the full loop: REQUEST -> COMMAND CREATED -> the CORRECT RENDERER
// RECEIVES it -> RENDERER ACKNOWLEDGES -> SERVER CORRELATES -> SUCCESS, plus the
// failure paths (no renderer, wrong token, timeout, duplicate ack, multi-window
// targeting, unregistered/stale renderer).

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-renderer-bridge-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const TTL_MS = 900;

let failures = 0;
const line = (ok, message, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}${detail ? `\n      ${detail}` : ''}`); };

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
      LIFE_PLANNER_RENDERER_TTL_MS: String(TTL_MS),
      LIFE_PLANNER_RENDERER_IDLE_MS: String(TTL_MS),
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
  if (method !== 'GET') { headers.Origin = base; if (includeCsrf) headers['X-LPS-CSRF'] = csrf; }
  const response = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null;
  try { body = await response.json(); } catch { /* streaming or empty */ }
  return { status: response.status, body };
}

// Minimal SSE consumer: opens the authenticated command channel and parses
// `event:`/`data:` frames into a growing `commands` array.
async function openStream(rendererId, token) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/renderer/${encodeURIComponent(rendererId)}/commands?token=${encodeURIComponent(token)}`, { signal: controller.signal });
  const commands = [];
  const events = [];
  if (response.ok && response.body) {
    (async () => {
      try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
            let event = 'message'; let data = '';
            for (const raw of frame.split('\n')) {
              if (raw.startsWith('event:')) event = raw.slice(6).trim();
              else if (raw.startsWith('data:')) data += raw.slice(5).trim();
            }
            events.push(event);
            if (event === 'command') { try { commands.push(JSON.parse(data)); } catch { /* ignore */ } }
          }
        }
      } catch { /* aborted on close */ }
    })();
  }
  return { status: response.status, commands, events, close: () => controller.abort() };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

console.log('--- renderer navigation bridge HTTP verification ---');
let server = await retryStart();
base = server.base;
let sessionId = 0;
const openStreams = [];
try {
  csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
  const createdSession = await api('/api/chat/sessions', { method: 'POST', json: { title: 'Renderer bridge verification' } });
  sessionId = Number(createdSession.body?.data?.id);
  line(createdSession.status === 200 && sessionId > 0, 'a real persisted chat session backs the acceptance run');

  // --- registration + authenticated channel ---
  const reg = await api('/api/renderer/register', { method: 'POST', json: { windowId: 'window-A', chatSessionId: sessionId } });
  const rendererId = reg.body?.data?.rendererId;
  const token = reg.body?.data?.token;
  line(reg.status === 200 && typeof rendererId === 'string' && typeof token === 'string' && Array.isArray(reg.body?.data?.destinations) && reg.body.data.destinations.includes('workboard'), 'registration issues a renderer id, secret token, and the semantic destination allowlist');

  const badStream = await openStream(rendererId, 'not-the-real-token');
  badStream.close();
  line(badStream.status === 401, 'the command channel rejects an invalid renderer token');

  const stream = await openStream(rendererId, token);
  openStreams.push(stream);
  line(stream.status === 200 && Boolean(await waitFor(() => stream.events.includes('ready'))), 'the authenticated command channel opens and greets the renderer');

  // --- happy path: request -> command -> correct renderer -> ack -> success ---
  const invokePromise = api('/api/actions/navigation.workboard/invoke', { method: 'POST', json: { session_id: sessionId, args: {}, renderer: { rendererId, token } } });
  const command = await waitFor(() => stream.commands[0]);
  line(Boolean(command) && command.command === 'navigate' && command.destination === 'workboard' && command.route === '#workboard' && typeof command.commandToken === 'string', 'the correct renderer receives a non-programmable navigate command for the canonical Workboard route');
  const ack = await api(`/api/renderer/${encodeURIComponent(rendererId)}/ack`, { method: 'POST', json: { commandId: command.commandId, correlationId: command.correlationId, token, commandToken: command.commandToken, status: 'APPLIED' } });
  line(ack.status === 200 && ack.body?.data?.accepted === true && ack.body?.data?.resolution?.status === 'APPLIED', 'the renderer acknowledgement is accepted and resolves APPLIED');
  const invoked = await invokePromise;
  const navData = invoked.body?.data?.data;
  line(invoked.status === 200 && invoked.body?.data?.status === 'success' && navData?.applied === true && navData?.status === 'APPLIED' && navData?.destination === 'workboard' && navData?.route === '#workboard', 'the navigation action reports an APPLIED, correlated success only after the renderer confirms');
  line(invoked.body?.data?.correlationId === command.correlationId, 'the action, command, and acknowledgement share one correlation id');

  // --- single-use ack / replay protection ---
  const replay = await api(`/api/renderer/${encodeURIComponent(rendererId)}/ack`, { method: 'POST', json: { commandId: command.commandId, correlationId: command.correlationId, token, commandToken: command.commandToken, status: 'APPLIED' } });
  line(replay.status === 200 && replay.body?.data?.accepted === false && replay.body?.data?.error?.code === 'ALREADY_RESOLVED', 'a duplicate acknowledgement is rejected as already resolved (single-use)');

  // --- no renderer binding: the server never navigates on its own ---
  const noRenderer = await api('/api/actions/navigation.workboard/invoke', { method: 'POST', json: { session_id: sessionId, args: {} } });
  line(noRenderer.body?.data?.data?.applied === false && noRenderer.body?.data?.data?.status === 'REJECTED' && noRenderer.body?.data?.data?.failure_category === 'no_renderer', 'a navigation request without a renderer binding is rejected, never silently "succeeded"');

  // --- forged token cannot target a renderer ---
  const forged = await api('/api/actions/navigation.workboard/invoke', { method: 'POST', json: { session_id: sessionId, args: {}, renderer: { rendererId, token: 'f'.repeat(48) } } });
  line(forged.body?.data?.data?.applied === false && forged.body?.data?.data?.status === 'REJECTED' && forged.body?.data?.data?.failure_category === 'renderer_unknown', 'a forged renderer token cannot trigger navigation');

  // --- timeout: a delivered-but-unacknowledged command resolves TIMEOUT ---
  const timeoutInvoke = await api('/api/actions/navigation.workboard/invoke', { method: 'POST', json: { session_id: sessionId, args: {}, renderer: { rendererId, token } } });
  line(timeoutInvoke.body?.data?.data?.applied === false && timeoutInvoke.body?.data?.data?.status === 'TIMEOUT', 'an unacknowledged navigation command resolves TIMEOUT rather than false success');

  // --- multi-window targeting: only the addressed window receives the command ---
  const regB = await api('/api/renderer/register', { method: 'POST', json: { windowId: 'window-B', chatSessionId: sessionId } });
  const rendererIdB = regB.body?.data?.rendererId;
  const tokenB = regB.body?.data?.token;
  const streamB = await openStream(rendererIdB, tokenB);
  openStreams.push(streamB);
  await waitFor(() => streamB.events.includes('ready'));
  const beforeA = stream.commands.length;
  const invokeBPromise = api('/api/actions/navigation.workboard/invoke', { method: 'POST', json: { session_id: sessionId, args: {}, renderer: { rendererId: rendererIdB, token: tokenB } } });
  const commandB = await waitFor(() => streamB.commands[streamB.commands.length - 1] && streamB.commands.length > 0 ? streamB.commands[streamB.commands.length - 1] : null);
  const aGotNothingNew = stream.commands.length === beforeA;
  line(Boolean(commandB) && commandB.rendererId === rendererIdB && aGotNothingNew, 'a command for window B is delivered only to window B, never to window A');
  await api(`/api/renderer/${encodeURIComponent(rendererIdB)}/ack`, { method: 'POST', json: { commandId: commandB.commandId, correlationId: commandB.correlationId, token: tokenB, commandToken: commandB.commandToken, status: 'APPLIED' } });
  const invokedB = await invokeBPromise;
  line(invokedB.body?.data?.data?.applied === true, 'window B applies its own command independently');

  // --- unregistered renderer is stale and cannot be targeted ---
  await api(`/api/renderer/${encodeURIComponent(rendererIdB)}/unregister`, { method: 'POST', json: { token: tokenB } });
  const afterUnregister = await api('/api/actions/navigation.workboard/invoke', { method: 'POST', json: { session_id: sessionId, args: {}, renderer: { rendererId: rendererIdB, token: tokenB } } });
  line(afterUnregister.body?.data?.data?.applied === false && afterUnregister.body?.data?.data?.status === 'REJECTED' && afterUnregister.body?.data?.data?.failure_category === 'renderer_unknown', 'an unregistered (closed) window can no longer be navigated');

  // --- bounded, correlated audit without content ---
  const auditDb = new DatabaseSync(dbPath, { readOnly: true });
  const auditRows = auditDb.prepare("SELECT * FROM chat_audit WHERE capability = 'navigation.workboard' ORDER BY id ASC").all();
  auditDb.close();
  const appliedAudit = auditRows.find((rowItem) => rowItem.correlation_id === command.correlationId);
  line(Boolean(appliedAudit) && appliedAudit.outcome === 'APPLIED', 'the applied navigation is audited under its shared correlation id');
  line(auditRows.every((rowItem) => !String(rowItem.detail || '').includes(token) && !String(rowItem.detail || '').includes('#workboard')), 'navigation audit rows carry no renderer token or route body');
} finally {
  for (const stream of openStreams) { try { stream.close(); } catch { /* ignore */ } }
  await stopServer(server.child);
  const resolvedProbe = path.resolve(probeRoot);
  if (resolvedProbe.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolvedProbe).startsWith('lps-renderer-bridge-')) {
    fs.rmSync(resolvedProbe, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} renderer-bridge HTTP check(s) FAILED` : '\nAll renderer-bridge HTTP checks passed.');
process.exit(failures ? 1 : 0);
