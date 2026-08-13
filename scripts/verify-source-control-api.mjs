import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const packageSource = fs.readFileSync(path.join(appRoot, 'scripts', 'package-portable.ps1'), 'utf8');
assert.match(packageSource, /npmCommand ci --include=dev --cache \$npmCacheRoot/);
assert.doesNotMatch(packageSource, /npmCommand install --no-save/);
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-source-api-'));
const bare = path.join(probeRoot, 'remote.git');
const seed = path.join(probeRoot, 'seed');
const client = path.join(probeRoot, 'client');
const upstream = path.join(probeRoot, 'upstream');
async function reserveLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const port = await reserveLoopbackPort();
const base = `http://127.0.0.1:${port}`;
let server;
const serverOutput = [];

function captureServerOutput(stream, label) {
  stream?.on('data', (chunk) => {
    serverOutput.push(`[${label}] ${String(chunk)}`);
    if (serverOutput.length > 80) serverOutput.shift();
  });
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

let csrfToken = '';
async function mutationToken() {
  if (csrfToken) return csrfToken;
  const body = await (await fetch(`${base}/api/csrf-token`)).json();
  if (body.ok) csrfToken = body.data.token;
  return csrfToken;
}

// Authenticate mutations exactly as the real SPA does: same-origin request with
// the per-runtime CSRF token. GETs are unaffected.
async function api(route, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['X-LPS-CSRF'] = await mutationToken();
    headers.Origin = base;
  }
  const response = await fetch(`${base}${route}`, { ...options, headers });
  const body = await response.json();
  return { response, body };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Source API acceptance server exited with code ${server.exitCode}.\n${serverOutput.join('')}`);
    }
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Source API acceptance server did not become healthy on ${base}.\n${serverOutput.join('')}`);
}

try {
  git(['init', '--bare', '--initial-branch=main', bare], probeRoot);
  fs.mkdirSync(seed);
  git(['init', '--initial-branch=main'], seed);
  git(['config', 'user.name', 'Source Verifier'], seed);
  git(['config', 'user.email', 'source-verifier@example.invalid'], seed);
  fs.writeFileSync(path.join(seed, 'SANITISATION_POLICY.md'), '# Public policy\n');
  fs.writeFileSync(path.join(seed, 'version.txt'), 'one\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'browser-extension/lps-browser-agent/pairing-config.json\ndata/\n.lps/\n');
  git(['add', '.'], seed);
  git(['commit', '-m', 'seed'], seed);
  git(['remote', 'add', 'origin', bare], seed);
  git(['push', '-u', 'origin', 'main'], seed);
  git(['clone', bare, client], probeRoot);
  git(['clone', bare, upstream], probeRoot);
  git(['config', 'user.name', 'Source Verifier'], upstream);
  git(['config', 'user.email', 'source-verifier@example.invalid'], upstream);

  server = spawn(process.execPath, [path.join(appRoot, 'server', 'index.js')], {
    cwd: client,
    env: { ...process.env, LIFE_PLANNER_DB: path.join(probeRoot, 'source.sqlite'), LIFE_PLANNER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  captureServerOutput(server.stdout, 'stdout');
  captureServerOutput(server.stderr, 'stderr');
  await waitForHealth();

  fs.mkdirSync(path.join(client, '.lps'), { recursive: true });
  fs.mkdirSync(path.join(client, 'source_of_truth'), { recursive: true });
  fs.mkdirSync(path.join(client, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(client, 'safe-context.md'), 'safe context\n');
  fs.writeFileSync(path.join(client, '.lps', 'runtime.json'), '{"private":true}\n');
  fs.writeFileSync(path.join(client, 'source_of_truth', 'private.md'), 'private\n');
  fs.writeFileSync(path.join(client, 'rules', 'private.md'), 'private\n');
  const contextFiles = await api('/api/repo/files?q=');
  assert.equal(contextFiles.response.status, 200, JSON.stringify(contextFiles.body));
  assert.ok(contextFiles.body.data.some((file) => file.path === 'safe-context.md'));
  assert.ok(!contextFiles.body.data.some((file) => /(^|\/)(?:\.lps|source_of_truth|rules)(?:\/|$)/.test(file.path)), 'protected paths never appear as selectable chat/browser context');
  fs.rmSync(path.join(client, '.lps'), { recursive: true, force: true });
  fs.rmSync(path.join(client, 'source_of_truth'), { recursive: true, force: true });
  fs.rmSync(path.join(client, 'rules'), { recursive: true, force: true });
  fs.unlinkSync(path.join(client, 'safe-context.md'));

  const initial = await api('/api/source/status');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.data.branch, 'main');
  assert.equal(initial.body.data.behind, 0);

  // Native coding run authority is durable and token-bound: proposing it does
  // not invoke a model or mutate the checkout, and a wrong one-time token
  // cannot consume the proposal.
  const codingTask = await api('/api/source/coding/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Verify durable run confirmation', objective: 'Prepare a bounded source task without invoking a coding model.', allowedPaths: ['version.txt'], maxFilesChanged: 1, validation: 'syntax' })
  });
  assert.equal(codingTask.response.status, 200, JSON.stringify(codingTask.body));
  const preparedCoding = await api(`/api/source/coding/tasks/${codingTask.body.data.task.id}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(preparedCoding.response.status, 200, JSON.stringify(preparedCoding.body));
  assert.equal(preparedCoding.body.data.task.status, 'prepared');
  const sealed = preparedCoding.body.data.task;
  const runProposal = await api(`/api/source/coding/tasks/${sealed.id}/run/propose`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskHash: sealed.taskHash, evidenceHash: sealed.preparation.evidenceHash, adviceHash: '' })
  });
  assert.equal(runProposal.response.status, 200, JSON.stringify(runProposal.body));
  assert.ok(/^[a-f0-9]{64}$/i.test(runProposal.body.data.token), 'run proposal returns one raw token only to its proposer');
  assert.equal(fs.readFileSync(path.join(client, 'version.txt'), 'utf8').trim(), 'one', 'proposing a coding run does not mutate the checkout');
  const wrongRunConfirm = await api(`/api/source/coding/tasks/${sealed.id}/run/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmationId: runProposal.body.data.confirmationId, token: 'wrong' })
  });
  assert.equal(wrongRunConfirm.response.status, 409, JSON.stringify(wrongRunConfirm.body));
  const codingAfterWrongToken = await api('/api/source/coding/status');
  assert.equal(codingAfterWrongToken.body.data.tasks.find((task) => task.id === sealed.id)?.status, 'prepared', 'a wrong confirmation token does not start the local worker');

  fs.writeFileSync(path.join(upstream, 'version.txt'), 'two\n');
  git(['add', 'version.txt'], upstream);
  git(['commit', '-m', 'remote update'], upstream);
  git(['push', 'origin', 'main'], upstream);

  const fetched = await api('/api/source/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(fetched.response.status, 200, JSON.stringify(fetched.body));
  assert.match(fetched.body.data.output, /origin/);
  const behind = await api('/api/source/status');
  assert.equal(behind.body.data.behind, 1);

  const pulled = await api('/api/source/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(pulled.response.status, 200, JSON.stringify(pulled.body));
  assert.equal(fs.readFileSync(path.join(client, 'version.txt'), 'utf8').trim(), 'two');
  const current = await api('/api/source/status');
  assert.equal(current.body.data.behind, 0);

  git(['switch', '-c', 'feature/remote-proof'], upstream);
  fs.writeFileSync(path.join(upstream, 'remote-proof.txt'), 'tracked\n');
  git(['add', 'remote-proof.txt'], upstream);
  git(['commit', '-m', 'remote branch'], upstream);
  git(['push', '-u', 'origin', 'feature/remote-proof'], upstream);
  await api('/api/source/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const beforeTrack = await api('/api/source/status');
  assert.deepEqual(beforeTrack.body.data.changedFiles, [], `Unexpected runtime-created source changes: ${JSON.stringify(beforeTrack.body.data.changedFiles)}`);
  const tracked = await api('/api/source/checkout-remote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: 'origin/feature/remote-proof' })
  });
  assert.equal(tracked.response.status, 200, JSON.stringify(tracked.body));
  assert.equal(tracked.body.data.branch, 'feature/remote-proof');
  assert.equal(fs.readFileSync(path.join(client, 'remote-proof.txt'), 'utf8').trim(), 'tracked');
  const switchedBack = await api('/api/source/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: 'main' })
  });
  assert.equal(switchedBack.response.status, 200, JSON.stringify(switchedBack.body));

  git(['remote', 'set-url', 'origin', 'https://github.com/Daa13x/LifePlanSystemPublic.git'], client);
  const publication = await api('/api/source/publication-check');
  assert.equal(publication.response.status, 200, JSON.stringify(publication.body));
  assert.equal(publication.body.data.allowed, true);

  const protectedPush = await api('/api/source/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
  assert.equal(protectedPush.response.status, 428);
  assert.match(protectedPush.body.error, /branch-bound confirmation/);

  const installer = await api('/api/source/build-installer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(installer.response.status, 200);
  assert.equal(installer.body.data.status, 'failed');
  assert.match(installer.body.data.output, /script not found/i);

  console.log('Source Control API fetch, pull, publication, push gate, and installer status acceptance passed.');
} finally {
  if (server && !server.killed) server.kill();
  for (let attempt = 0; attempt < 30 && server?.exitCode === null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(probeRoot, { recursive: true, force: true });
}
