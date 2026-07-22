import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-source-api-'));
const bare = path.join(probeRoot, 'remote.git');
const seed = path.join(probeRoot, 'seed');
const client = path.join(probeRoot, 'client');
const upstream = path.join(probeRoot, 'upstream');
const port = 43400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
let server;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function api(route, options) {
  const response = await fetch(`${base}${route}`, options);
  const body = await response.json();
  return { response, body };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Source API acceptance server did not become healthy.');
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
  await waitForHealth();

  const initial = await api('/api/source/status');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.data.branch, 'main');
  assert.equal(initial.body.data.behind, 0);

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
