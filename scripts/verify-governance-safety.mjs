import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-governance-'));
const dbPath = path.join(probeRoot, 'governance.sqlite');
const legacyGithubToken = 'ghp_legacy_plaintext_verifier_secret';

const seedDatabase = new DatabaseSync(dbPath);
seedDatabase.exec(`
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
seedDatabase.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
  .run('githubToken', JSON.stringify(legacyGithubToken));
seedDatabase.close();

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

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
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
    LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing-config.json')
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
child.stdout.on('data', (chunk) => output.push(String(chunk)));
child.stderr.on('data', (chunk) => output.push(String(chunk)));

let database;
try {
  await waitForServer(baseUrl, child, output);
  database = new DatabaseSync(dbPath);

  const migratedGithubValue = JSON.parse(database.prepare("SELECT value FROM settings WHERE key = 'githubToken'").get().value);
  assert.match(migratedGithubValue, /^dpapi:v1:[A-Za-z0-9+/=]+$/);
  assert.equal(migratedGithubValue.includes(legacyGithubToken), false);
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbPath}${suffix}`;
    if (fs.existsSync(candidate)) {
      assert.equal(fs.readFileSync(candidate).includes(Buffer.from(legacyGithubToken)), false, `legacy plaintext survived in ${candidate}`);
    }
  }
  const migratedSettings = await request(baseUrl, '/api/settings');
  assert.equal(migratedSettings.status, 200);
  assert.equal(migratedSettings.body.data.githubToken, '[redacted]');

  const health = await request(baseUrl, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(path.resolve(health.body.data.storage), path.resolve(dbPath));

  const genericSecret = await request(baseUrl, '/api/settings', {
    method: 'POST',
    body: JSON.stringify({ localModelName: 'must-not-partially-save', hfToken: 'hf_not_allowed_here' })
  });
  assert.equal(genericSecret.status, 400);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'localModelName'").get().count, 0);
  assert.equal((await request(baseUrl, '/api/settings/huggingface-token', {
    method: 'POST',
    body: JSON.stringify({ token: `hf_${'A'.repeat(30)}` })
  })).status, 200);
  const encryptedHfToken = JSON.parse(database.prepare("SELECT value FROM settings WHERE key = 'hfToken'").get().value);
  assert.match(encryptedHfToken, /^dpapi:v1:[A-Za-z0-9+/=]+$/);
  assert.equal(encryptedHfToken.includes(`hf_${'A'.repeat(30)}`), false);

  const pairingConfig = JSON.parse(fs.readFileSync(path.join(probeRoot, 'pairing-config.json'), 'utf8'));
  const encryptedConnectorToken = JSON.parse(database.prepare("SELECT value FROM settings WHERE key = 'browserConnectorToken'").get().value);
  assert.match(encryptedConnectorToken, /^dpapi:v1:[A-Za-z0-9+/=]+$/);
  assert.equal(encryptedConnectorToken.includes(pairingConfig.token), false);

  const approvalId = database.prepare(`
    INSERT INTO approvals (action_type, title, payload)
    VALUES ('create_project', 'Create verifier project', ?)
  `).run(JSON.stringify({ name: 'Idempotent verifier project' })).lastInsertRowid;
  assert.equal((await request(baseUrl, `/api/approvals/${approvalId}/approve`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await request(baseUrl, `/api/approvals/${approvalId}/approve`, { method: 'POST', body: '{}' })).status, 409);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM projects WHERE name = 'Idempotent verifier project'").get().count, 1);

  const unknown = await request(baseUrl, '/api/approvals', {
    method: 'POST',
    body: JSON.stringify({ action_type: 'unknown_side_effect', title: 'Unknown', payload: { value: true } })
  });
  assert.equal(unknown.status, 400);

  const memoryId = database.prepare(`
    INSERT INTO memory_candidates (type, title, body, source, evidence)
    VALUES ('note', 'Verifier memory', 'Only one knowledge row may be created.', 'verifier', 'isolated API test')
  `).run().lastInsertRowid;
  assert.equal((await request(baseUrl, `/api/memory/candidates/${memoryId}/approve`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await request(baseUrl, `/api/memory/candidates/${memoryId}/approve`, { method: 'POST', body: '{}' })).status, 409);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM knowledge_items WHERE title = 'Verifier memory'").get().count, 1);

  const roadmapId = database.prepare(`
    INSERT INTO roadmap_candidates (title, detail, category, source_kind, source_ref, signal, dedupe_key)
    VALUES ('Verifier roadmap item', '', 'fix', 'test', 'isolated', 'test', 'governance-verifier-roadmap')
  `).run().lastInsertRowid;
  assert.equal((await request(baseUrl, `/api/roadmap/candidates/${roadmapId}/accept`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await request(baseUrl, `/api/roadmap/candidates/${roadmapId}/accept`, { method: 'POST', body: '{}' })).status, 409);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM roadmap_items WHERE title = 'Verifier roadmap item'").get().count, 1);

  const sessionId = database.prepare("INSERT INTO chat_sessions (title) VALUES ('Context verifier')").run().lastInsertRowid;
  const protectedContext = await request(baseUrl, `/api/chat/sessions/${sessionId}/context`, {
    method: 'POST',
    body: JSON.stringify({ path: '.git/config' })
  });
  assert.equal(protectedContext.status, 403);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM chat_context_files WHERE session_id = ?').get(sessionId).count, 0);

  const replacementGithubToken = 'ghp_replacement_verifier_secret';
  assert.equal((await request(baseUrl, '/api/source/token', {
    method: 'POST',
    body: JSON.stringify({ token: replacementGithubToken })
  })).status, 200);
  const encryptedGithubToken = JSON.parse(database.prepare("SELECT value FROM settings WHERE key = 'githubToken'").get().value);
  assert.match(encryptedGithubToken, /^dpapi:v1:[A-Za-z0-9+/=]+$/);
  assert.equal(encryptedGithubToken.includes(replacementGithubToken), false);
  assert.equal((await request(baseUrl, '/api/settings')).body.data.githubToken, '[redacted]');

  const backup = await request(baseUrl, '/api/export/json?mode=backup&includeSecrets=1');
  assert.equal(backup.status, 200);
  assert.equal(backup.body.settings.githubToken, '[redacted]');
  assert.equal(JSON.stringify(backup.body).includes(replacementGithubToken), false);

  assert.equal((await request(baseUrl, '/api/source/token/clear', { method: 'POST', body: '{}' })).status, 200);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'githubToken'").get().count, 0);
  assert.equal((await request(baseUrl, '/api/settings')).body.data.githubToken, undefined);
  assert.equal((await request(baseUrl, '/api/settings/huggingface-token', {
    method: 'POST',
    body: JSON.stringify({ token: '' })
  })).status, 200);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'hfToken'").get().count, 0);

  console.log('Governance and privacy API verification passed.');
} finally {
  database?.close();
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
