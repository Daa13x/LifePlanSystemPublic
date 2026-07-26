import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-local-knowledge-'));
const db = path.join(probe, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(db), { recursive: true });
const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, LIFE_PLANNER_DB: db, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probe, 'pairing.json') }, stdio: 'ignore', windowsHide: true });
let ready = false;
for (let i = 0; i < 150; i += 1) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} if (child.exitCode !== null) throw new Error(`Verifier server exited early (${child.exitCode}).`); await new Promise((r) => setTimeout(r, 100)); }
assert.ok(ready, 'verifier server became healthy');
const csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
async function api(route, method = 'GET', json) { const response = await fetch(`${base}${route}`, { method, headers: method === 'GET' ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-LPS-CSRF': csrf }, body: json === undefined ? undefined : JSON.stringify(json) }); return { response, body: await response.json() }; }
try {
  const profile = await api('/api/items', 'POST', { type: 'profile', title: 'Preferred name', body: 'Alex prefers to be called Alex.', status: 'active', confidence: 0.95 });
  const preference = await api('/api/items', 'POST', { type: 'rule', title: 'Tea preference', body: 'Alex prefers tea over coffee.', status: 'stable', confidence: 0.95 });
  const project = await api('/api/projects', 'POST', { name: 'Local Knowledge Foundation' });
  assert.equal(profile.response.status, 200); assert.equal(preference.response.status, 200); assert.equal(project.response.status, 200);
  const session = (await api('/api/chat/sessions', 'POST', { title: 'knowledge verifier' })).body.data;
  const send = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'What do you know about me?' });
  const assistant = send.body.data.messages.find((m) => m.role === 'assistant');
  assert.match(assistant.content, /Alex prefers to be called Alex/);
  assert.match(assistant.content, /Tea preference/);
  const metadata = JSON.parse(assistant.metadata);
  assert.ok(metadata.localSources?.length, 'local retrieval carries source provenance');
  const candidateMessage = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'I prefer quiet mornings for focused work.' });
  const candidateId = candidateMessage.body.data.candidateId;
  assert.ok(candidateId, 'durable preference creates a review candidate');
  const before = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'What preferences have I saved?' });
  assert.match(before.body.data.messages.find((m) => m.role === 'assistant').content, /pending|Tea preference/i);
  await api(`/api/memory/candidates/${candidateId}/approve`, 'POST');
  const after = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'What preferences have I saved?' });
  assert.match(after.body.data.messages.find((m) => m.role === 'assistant').content, /quiet mornings/i);
  await api(`/api/memory/items/${profile.body.data.id}`, 'DELETE');
  const deleted = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'What do you know about me?' });
  assert.doesNotMatch(deleted.body.data.messages.find((m) => m.role === 'assistant').content, /Preferred name/);
  console.log('Local knowledge retrieval and reviewed-memory verification passed.');
} finally {
  if (child.exitCode === null) child.kill();
  for (let i = 0; child.exitCode === null && i < 40; i += 1) await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(probe, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
