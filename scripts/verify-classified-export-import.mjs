import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-classified-export-'));
const dbPath = path.join(probe, 'fixture.sqlite');
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_TEST_IMPORT_FAIL_AFTER: 'project' },
  stdio: 'ignore', windowsHide: true
});

async function wait() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited (${child.exitCode}).`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('Fixture server did not become healthy.');
}
let csrf = '';
async function request(route, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (!csrf && method !== 'GET') csrf = (await (await fetch(`${baseUrl}/api/csrf-token`)).json()).data.token;
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'X-LPS-CSRF': csrf, Origin: baseUrl }), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
}

let database;
try {
  await wait();
  database = new DatabaseSync(dbPath);
  const publicProject = database.prepare("INSERT INTO projects (name, shareability) VALUES (?, 'unknown')").run('Public fixture project').lastInsertRowid;
  const publicKnowledge = database.prepare("INSERT INTO knowledge_items (type, title, body, source, shareability) VALUES (?, ?, ?, ?, 'unknown')")
    .run('note', 'Public fixture knowledge', 'safe fixture body', 'test').lastInsertRowid;
  database.prepare("INSERT INTO knowledge_items (type, title, body, source, shareability) VALUES (?, ?, ?, ?, 'private')")
    .run('note', 'Private fixture', 'PRIVATE_EXPORT_CANARY', 'test');

  assert.equal((await request(`/api/shareability/project/${publicProject}`, { method: 'PATCH', body: JSON.stringify({ shareability: 'public-shareable' }) })).status, 200);
  assert.equal((await request(`/api/shareability/knowledge_item/${publicKnowledge}`, { method: 'PATCH', body: JSON.stringify({ shareability: 'public-shareable' }) })).status, 200);
  assert.equal((await request(`/api/shareability/project/${publicProject}`, { method: 'PATCH', body: JSON.stringify({ shareability: 'unbounded' }) })).status, 400);

  const directPublic = await request('/api/export/json?mode=public');
  assert.equal(directPublic.status, 409, 'public export cannot bypass preview confirmation');
  const preview = await request('/api/export/public/preview', { method: 'POST', body: '{}' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.included, 2);
  assert.equal(preview.body.data.blocked, 1);
  assert.ok(preview.body.data.unknown >= 0, 'pre-existing records default to unknown and stay excluded');
  assert.equal(JSON.stringify(preview.body.data).includes('PRIVATE_EXPORT_CANARY'), false, 'preview never includes sensitive bodies');
  const exported = await request('/api/export/public/confirm', { method: 'POST', body: JSON.stringify({ confirmationId: preview.body.data.confirmationId, token: preview.body.data.token }) });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.format, 'life-planner-public-export');
  assert.equal(JSON.stringify(exported.body).includes('PRIVATE_EXPORT_CANARY'), false, 'public export excludes private canary');
  assert.equal(exported.body.projects[0].shareability, 'public-shareable');
  assert.equal(exported.body.knowledge_items[0].shareability, 'public-shareable');

  const beforeProjects = database.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
  const beforeKnowledge = database.prepare('SELECT COUNT(*) AS count FROM knowledge_items').get().count;
  const failedImport = await request('/api/import/json', { method: 'POST', body: JSON.stringify({ projects: [{ name: 'Rollback project' }], knowledge_items: [{ title: 'Rollback knowledge', body: 'must not persist' }] }) });
  assert.equal(failedImport.status, 500);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM projects').get().count, beforeProjects, 'failed import rolls back project insert');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM knowledge_items').get().count, beforeKnowledge, 'failed import rolls back knowledge insert');
  assert.equal((await request('/api/import/json', { method: 'POST', body: JSON.stringify({ projects: [{}] }) })).status, 400, 'validation fails before writes');
  console.log('Classified export and transactional JSON import acceptance passed.');
} finally {
  database?.close();
  if (child.exitCode === null) child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  fs.rmSync(probe, { recursive: true, force: true });
}
