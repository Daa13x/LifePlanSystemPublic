import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-browser-connector-'));
const dbPath = path.join(probeRoot, 'connector.sqlite');
const configPath = path.join(probeRoot, 'pairing-config.json');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).\n${output.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for isolated server.\n${output.join('')}`);
}

async function request(baseUrl, route, { token, ...options } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-LPS-Connector-Token': token } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { status: response.status, body };
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    LIFE_PLANNER_DB: dbPath,
    LIFE_PLANNER_PORT: String(port),
    LIFE_PLANNER_CONNECTOR_CONFIG: configPath
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
child.stdout.on('data', (chunk) => output.push(String(chunk)));
child.stderr.on('data', (chunk) => output.push(String(chunk)));

try {
  await waitForServer(baseUrl, child, output);

  const pairing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(pairing.bridgeUrl, baseUrl);
  assert.match(pairing.token, /^[a-f0-9]{64}$/);

  const heartbeatBody = JSON.stringify({
    tabs: [
      { id: 1, title: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 2, title: 'Private bank', url: 'https://bank.example/account' }
    ]
  });
  assert.equal((await request(baseUrl, '/api/browser/extension/heartbeat', { method: 'POST', body: heartbeatBody })).status, 401);
  assert.equal((await request(baseUrl, '/api/browser/extension/heartbeat', { method: 'POST', body: heartbeatBody, token: '0'.repeat(64) })).status, 401);
  assert.equal((await request(baseUrl, '/api/browser/extension/heartbeat', { method: 'POST', body: heartbeatBody, token: pairing.token })).status, 200);

  const tabs = await request(baseUrl, '/api/browser/agent-tabs');
  assert.equal(tabs.status, 200);
  assert.equal(tabs.body.data.agents.ChatGPT.count, 1);
  assert.match(JSON.stringify(tabs.body), /chatgpt\.com/);
  assert.doesNotMatch(JSON.stringify(tabs.body), /bank\.example/);

  assert.equal((await request(baseUrl, '/api/browser/extension/next')).status, 401);
  const next = await request(baseUrl, '/api/browser/extension/next', { token: pairing.token });
  assert.equal(next.status, 200);
  assert.equal(next.body.data.job, null);

  const settings = await request(baseUrl, '/api/settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.body.data.browserConnectorToken, '[redacted]');

  const serverSource = fs.readFileSync(path.join(repoRoot, 'server', 'index.js'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(repoRoot, 'browser-extension', 'lps-browser-agent', 'background.js'), 'utf8');
  assert.match(serverSource, /leaseExpiresAt/);
  assert.match(serverSource, /claimToken/);
  assert.match(extensionSource, /claimToken: job\.claimToken/);

  console.log('Browser connector authentication and privacy verification passed.');
} finally {
  if (child.exitCode === null) child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  fs.rmSync(probeRoot, { recursive: true, force: true });
}
