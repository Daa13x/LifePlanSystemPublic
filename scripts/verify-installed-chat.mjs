#!/usr/bin/env node
// Browser-driven acceptance for the production dist (and, when provided, the
// portable bundle). It uses a disposable database and records the actual
// browser request so a stale client that omits X-LPS-CSRF cannot pass.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const repoRoot = path.resolve(import.meta.dirname, '..');
const portableRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
const appRoot = portableRoot ? path.join(portableRoot, 'app') : repoRoot;
const nodeCommand = portableRoot ? path.join(portableRoot, 'node', 'node.exe') : process.execPath;
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-installed-chat-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
const evidence = { target: portableRoot ? 'portable' : 'production-dist', pageUrl: '', build: null, request: null, response: null, persisted: null, visible: null, localKnowledgeVisible: false, localSourceCount: 0, reopened: false, setupRecoveryLoaded: false, rejectedTokenSurfaced: false };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startServer(port) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const output = [];
  const child = spawn(nodeCommand, ['server/index.js'], {
    cwd: appRoot,
    env: {
      ...process.env,
      LIFE_PLANNER_PORT: String(port),
      LIFE_PLANNER_DB: dbPath,
      LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing-config.json')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}): ${output.join('')}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base }; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become healthy.');
}

async function stop(child) {
  if (child?.exitCode === null) child.kill();
  for (let i = 0; child?.exitCode === null && i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
}

try {
  assert.ok(fs.existsSync(path.join(appRoot, 'dist', 'index.html')), `Missing built frontend: ${path.join(appRoot, 'dist', 'index.html')}`);
  assert.ok(fs.existsSync(nodeCommand), `Missing runtime: ${nodeCommand}`);
  const port = await freePort();
  const { child, base } = await startServer(port);
  let browser;
  try {
    const csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
    const mutate = async (route, body) => {
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-LPS-CSRF': csrf }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, `fixture request succeeds: ${route}`);
      return (await response.json()).data;
    };
    await mutate('/api/items', { type: 'profile', title: 'Browser coverage profile', body: 'A deterministic browser acceptance profile fact.', status: 'active', confidence: 0.95 });
    await mutate('/api/items', { type: 'preference', title: 'Browser coverage preference', body: 'The user prefers grounded local answers.', status: 'stable', confidence: 0.95 });
    await mutate('/api/projects', { name: 'Browser coverage project', next_action: 'Verify packaged Chat retrieval.' });
    evidence.pageUrl = `${base}/`;
    evidence.build = await (await fetch(`${base}/build-info.json`)).json();
    const page = await (browser = await chromium.launch({ headless: true })).newPage();
    page.on('request', (request) => {
      if (/\/api\/chat\/sessions\/\d+\/messages\/stream$/.test(request.url())) {
        evidence.request = { endpoint: new URL(request.url()).pathname, csrf: request.headers()['x-lps-csrf'] || '' };
      }
    });
    page.on('response', async (response) => {
      if (/\/api\/chat\/sessions\/\d+\/messages\/stream$/.test(response.url())) {
        evidence.response = { status: response.status(), contentType: response.headers()['content-type'] || '' };
      }
    });
    await page.goto(evidence.pageUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByPlaceholder('Tell Life Planner what changed, what is blocked, or what needs review...').fill('Tell me something about myself.');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Send' }).waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(250);
    const sessionId = Number(evidence.request?.endpoint?.match(/\/sessions\/(\d+)\/messages\/stream$/)?.[1]);
    assert.ok(sessionId, 'browser request must identify the Chat session');
    const messages = await (await fetch(`${base}/api/chat/sessions/${sessionId}/messages`)).json();
    evidence.persisted = messages.data.map((message) => ({ role: message.role, content: message.content, metadata: message.metadata }));
    evidence.visible = await page.locator('.message.user .message-body').last().textContent();
    assert.equal(evidence.request?.endpoint, `/api/chat/sessions/${sessionId}/messages/stream`, 'built client must use the streaming Chat endpoint');
    assert.ok(evidence.request?.csrf, 'built client must send X-LPS-CSRF on Chat send');
    assert.equal(evidence.response?.status, 200, 'server must accept the CSRF-protected Chat send');
    assert.equal(evidence.visible?.trim(), 'Tell me something about myself.', 'sent message must remain visibly rendered');
    const localReply = evidence.persisted.find((message) => message.role === 'assistant' && /Browser coverage profile/.test(message.content));
    assert.ok(localReply, 'built Chat visibly persists the deterministic local-knowledge answer');
    const localMetadata = JSON.parse(localReply.metadata || '{}');
    evidence.localKnowledgeVisible = true;
    evidence.localSourceCount = localMetadata.localSources?.length || 0;
    assert.ok(evidence.localSourceCount >= 2, 'grounded reply carries multiple source details');
    assert.ok(evidence.persisted.some((message) => message.role === 'user' && message.content === 'Tell me something about myself.'), 'sent message must persist');
    await page.goto(`${base}/#chat/${sessionId}`, { waitUntil: 'networkidle' });
    await page.getByText('Tell me something about myself.').last().waitFor({ timeout: 15000 });
    evidence.reopened = true;
    await page.getByRole('button', { name: 'System', exact: true }).click();
    await page.getByRole('tab', { name: 'Setup & Recovery' }).click();
    await page.getByRole('heading', { name: 'Setup & Recovery', exact: true }).waitFor({ timeout: 15000 });
    evidence.setupRecoveryLoaded = true;

    // A stale page may have an invalid token after the server restarts. The
    // built UI must surface the structured rejection and leave Send usable,
    // rather than keeping an indefinite spinner.
    const rejected = await browser.newPage();
    await rejected.route('**/api/csrf-token', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { token: 'invalid-token' } }) }));
    await rejected.goto(`${base}/#chat/${sessionId}`, { waitUntil: 'networkidle' });
    await rejected.getByPlaceholder('Tell Life Planner what changed, what is blocked, or what needs review...').fill('Rejected token test.');
    await rejected.getByRole('button', { name: 'Send' }).click();
    await rejected.getByText('Request rejected: missing or invalid mutation token. Reload Life Planner.').waitFor({ timeout: 15000 });
    await assert.doesNotReject(rejected.getByRole('button', { name: 'Send' }).waitFor({ state: 'visible', timeout: 15000 }), 'rejected Chat send must leave the UI responsive');
    evidence.rejectedTokenSurfaced = true;
    await rejected.close();
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await browser?.close();
    await stop(child);
  }
} finally {
  fs.rmSync(probeRoot, { recursive: true, force: true });
}
