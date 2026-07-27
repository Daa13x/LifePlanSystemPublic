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
  const candidateMessage = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'when i say my brain i mean the knowledge system in LPS' });
  const candidateId = candidateMessage.body.data.candidateId;
  assert.ok(candidateId, 'direct terminology creates a review candidate');
  assert.equal((await api('/api/memory')).body.data.candidates.find((candidate) => candidate.id === candidateId)?.status, 'candidate', 'terminology remains pending until reviewed');
  const before = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'What preferences have I saved?' });
  assert.match(before.body.data.messages.find((m) => m.role === 'assistant').content, /pending|Tea preference/i);
  await api(`/api/memory/candidates/${candidateId}/approve`, 'POST');
  const after = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'what does my brain mean?' });
  assert.match(after.body.data.messages.find((m) => m.role === 'assistant').content, /knowledge system in lps/i);
  const personal = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'ok well are you going to you know tell me something about myself?' });
  assert.doesNotMatch(personal.body.data.messages.find((m) => m.role === 'assistant').content, /don.?t have access to your personal records/i);
  const sensitiveSession = (await api('/api/chat/sessions', 'POST', { title: 'blocked history verifier' })).body.data;
  const sensitiveTurn = await api(`/api/chat/sessions/${sensitiveSession.id}/messages`, 'POST', { content: 'What health information is in my medical record?' });
  assert.equal(sensitiveTurn.response.status, 200, JSON.stringify(sensitiveTurn.body));
  assert.equal(sensitiveTurn.body.data.messages.filter((message) => message.role === 'assistant').length, 1, JSON.stringify(sensitiveTurn.body));
  const blockedPreview = await api(`/api/chat/sessions/${sensitiveSession.id}/cloud-checks/preview`, 'POST', { scope: 'latest-turn', provider: 'ChatGPT', instruction: 'Assess only.' });
  assert.equal(blockedPreview.response.status, 200, JSON.stringify(blockedPreview.body));
  assert.equal(blockedPreview.body.data.blocked, true, 'sensitive deterministic turn is blocked for cloud egress');
  await api(`/api/chat/sessions/${sensitiveSession.id}/cloud-checks`, 'POST', { scope: 'latest-turn', provider: 'ChatGPT', instruction: 'Assess only.', idempotency_key: 'local-knowledge-sensitive-history-0001' });
  const afterSensitive = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'tell me something about me' });
  assert.doesNotMatch(afterSensitive.body.data.messages.find((m) => m.role === 'assistant').content, /medical record/i, 'sensitive or cloud-blocked Chat history is not eligible local knowledge');
  await api(`/api/memory/items/${profile.body.data.id}`, 'DELETE');
  const deleted = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'What do you know about me?' });
  assert.doesNotMatch(deleted.body.data.messages.find((m) => m.role === 'assistant').content, /Preferred name/);
  console.log('Local knowledge retrieval and reviewed-memory verification passed.');
} finally {
  if (child.exitCode === null) child.kill();
  for (let i = 0; child.exitCode === null && i < 40; i += 1) await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(probe, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
