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
// A controlled private repository so repository-knowledge retrieval is
// deterministic. MEMORY_ARCHITECTURE carries the distinctive topic token
// "zephyrmemory"; RECENT_RELEASE carries only source-indicator words ("github",
// "knowledge base", "documentation") and a newer mtime. Without topic-aware
// ranking the recent generic document would outrank the on-topic one.
const privateRepo = path.join(probe, 'private-repo');
fs.mkdirSync(path.join(privateRepo, 'docs'), { recursive: true });
fs.writeFileSync(path.join(privateRepo, 'docs', 'MEMORY_ARCHITECTURE.md'), '# Memory architecture\n\nThe zephyrmemory architecture uses layered retrieval and reviewed-memory promotion before a fact becomes trusted.\n');
fs.writeFileSync(path.join(privateRepo, 'docs', 'RECENT_RELEASE.md'), '# Release notes\n\nGitHub knowledge base release. Documentation for the repository knowledge base and its github mirror.\n');
fs.utimesSync(path.join(privateRepo, 'docs', 'RECENT_RELEASE.md'), new Date(), new Date());
// A newer document that only MENTIONS the topic in its body under a generic
// title. Without a title-relevance signal its recency would let it outrank the
// document actually named after the subject.
fs.writeFileSync(path.join(privateRepo, 'docs', 'RECENT_MENTIONS.md'), '# Weekly notes\n\nThe zephyrmemory architecture came up again this week and was briefly discussed.\n');
fs.utimesSync(path.join(privateRepo, 'docs', 'RECENT_MENTIONS.md'), new Date(), new Date());
// Broad identity overviews have a deliberately narrow canonical source set.
// Include tempting generic, operational, and sensitive records so this HTTP
// verifier proves they do not enter the answer or its persisted provenance.
fs.writeFileSync(path.join(privateRepo, 'career-profile.md'), '# Generic career profile\n\nThis non-canonical profile must not ground a broad identity overview.\n');
const canonicalRoot = path.join(privateRepo, 'source_of_truth');
fs.mkdirSync(canonicalRoot, { recursive: true });
fs.writeFileSync(path.join(canonicalRoot, 'profile.md'), '# Profile\n\n## Confirmed facts\n\n### FACT-900001 - Practical constraint\n- Fact: The fixture user uses public transport.\n');
fs.writeFileSync(path.join(canonicalRoot, 'career.md'), '# Career\n\n## Education\n\n### FACT-900002 - Education\n- Fact: The fixture user completed a business degree.\n\n## Work history\n\n### FACT-900003 - Work\n- Fact: The fixture user has procurement experience.\n');
fs.writeFileSync(path.join(canonicalRoot, 'current_location_2026-06-27.md'), '# Current Location\n\n## Confirmed update\n\nThe fixture user lives in a connected city.\n');
fs.writeFileSync(path.join(canonicalRoot, 'career_direction_2026-06-27.md'), '# Career Direction\n\n## Current direction\n\nThe fixture user is exploring operations roles.\n');
fs.writeFileSync(path.join(canonicalRoot, 'current_state.md'), '# Current State\n\nInternal app maintenance must not define the fixture user.\n');
fs.writeFileSync(path.join(canonicalRoot, 'health_accessibility.md'), '# Health\n\nA sensitive health record must not appear in a broad identity overview.\n');
const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, LIFE_PLANNER_DB: db, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probe, 'pairing.json'), LIFE_PLANNER_PRIVATE_REPO: privateRepo }, stdio: 'ignore', windowsHide: true });
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
  assert.match(assistant.content, /public transport|connected city|business degree|procurement experience/i, 'identity answer renders canonical facts, not headings alone');
  const metadata = JSON.parse(assistant.metadata);
  assert.ok(metadata.localSources?.length, 'local retrieval carries source provenance');
  const identityQuestionIds = [send.body.data.messages.find((message) => message.role === 'user').id];
  for (const content of ['Do you know who I am?', 'Tell me something you know about me.', 'What information can you access about me?', 'ok what can you access give me any info about me']) {
    const turn = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content });
    const userTurn = turn.body.data.messages.find((message) => message.role === 'user');
    const assistantTurn = turn.body.data.messages.find((message) => message.role === 'assistant');
    identityQuestionIds.push(userTurn.id);
    const turnMetadata = JSON.parse(assistantTurn.metadata || '{}');
    assert.equal(turnMetadata.endpointType, 'local-knowledge', `natural identity wording stays on deterministic local knowledge: ${content}`);
    assert.ok(turnMetadata.localSources?.length, `natural identity wording retains curated sources: ${content}`);
    assert.ok(!turnMetadata.localSources.some((source) => source.sourceId === `chat:${userTurn.id}`), `the just-saved request is not its own evidence: ${content}`);
  }
  const exactWhoAmI = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'who am i?' });
  const exactWhoUser = exactWhoAmI.body.data.messages.find((message) => message.role === 'user');
  const exactWhoAssistant = exactWhoAmI.body.data.messages.find((message) => message.role === 'assistant');
  identityQuestionIds.push(exactWhoUser.id);
  const exactWhoMetadata = JSON.parse(exactWhoAssistant.metadata || '{}');
  assert.equal(exactWhoMetadata.endpointType, 'local-knowledge', 'exact who am i? uses the deterministic local-knowledge endpoint');
  assert.match(exactWhoAssistant.content, /public transport|connected city|business degree|procurement experience/i, 'exact who am i? renders canonical facts');
  const allowedCanonicalSources = new Set([
    'private-canonical:source_of_truth/profile.md',
    'private-canonical:source_of_truth/career.md',
    'private-canonical:source_of_truth/current_location_2026-06-27.md',
    'private-canonical:source_of_truth/career_direction_2026-06-27.md',
  ]);
  const allowedKnowledgeSources = new Set([`knowledge:${profile.body.data.id}`, `knowledge:${preference.body.data.id}`]);
  const assertIdentitySourceBoundary = (sources, label) => {
    assert.ok(sources.length, `${label} retains identity provenance`);
    assert.ok(sources.every((source) => allowedCanonicalSources.has(source.sourceId) || allowedKnowledgeSources.has(source.sourceId)), `${label} uses only the explicit canonical/profile/preference allowlist`);
    assert.ok(!sources.some((source) => /^(chat|workboard|project|task):/i.test(String(source.sourceId || ''))), `${label} excludes raw Chat and workboard records`);
    assert.ok(!sources.some((source) => /career-profile|current_state|health_accessibility/i.test(JSON.stringify(source))), `${label} excludes generic, operational, and sensitive private records`);
    assert.ok(!sources.some((source) => Object.values(source).some((value) => typeof value === 'string' && path.win32.isAbsolute(value))), `${label} exposes no absolute host path in provenance`);
  };
  assertIdentitySourceBoundary(exactWhoMetadata.localSources || [], 'returned exact identity answer');
  for (const id of identityQuestionIds) assert.ok(!exactWhoMetadata.localSources.some((source) => source.sourceId === `chat:${id}`), `later exact identity answer excludes prior question chat:${id}`);
  const persistedIdentityMessages = (await api(`/api/chat/sessions/${session.id}/messages`)).body.data;
  const persistedIdentityAnswer = persistedIdentityMessages.find((message) => message.id === exactWhoAssistant.id);
  assert.equal(persistedIdentityAnswer.content, exactWhoAssistant.content, 'exact who am i? answer persists unchanged');
  const persistedIdentitySources = JSON.parse(persistedIdentityAnswer.metadata || '{}').localSources || [];
  assert.deepEqual(persistedIdentitySources, exactWhoMetadata.localSources, 'exact who am i? provenance persists unchanged');
  assertIdentitySourceBoundary(persistedIdentitySources, 'reloaded exact identity answer');
  for (const id of identityQuestionIds) assert.ok(!persistedIdentitySources.some((source) => source.sourceId === `chat:${id}`), `persisted identity answer excludes question chat:${id}`);
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
  // Repository-topic ranking: a question about a subject must surface the
  // on-topic document, not a generic or merely-recent one that only shares the
  // source-indicator words ("github", "knowledge base").
  const repoQuestion = await api(`/api/chat/sessions/${session.id}/messages`, 'POST', { content: 'What does the GitHub knowledge base say about zephyrmemory architecture?' });
  const repoAnswer = repoQuestion.body.data.messages.find((m) => m.role === 'assistant');
  const repoMeta = JSON.parse(repoAnswer.metadata || '{}');
  assert.equal(repoMeta.endpointType, 'local-knowledge', 'repository question is answered from local knowledge');
  assert.match(repoAnswer.content, /zephyrmemory/i, 'the on-topic repository document leads the answer');
  const repoTitles = (repoMeta.localSources || []).map((s) => s.title);
  const memoryIndex = repoTitles.findIndex((t) => /MEMORY_ARCHITECTURE/i.test(t));
  const genericIndex = repoTitles.findIndex((t) => /RECENT_RELEASE/i.test(t));
  const mentionIndex = repoTitles.findIndex((t) => /RECENT_MENTIONS/i.test(t));
  assert.equal(memoryIndex, 0, 'the document named after the topic is the top-ranked source, not a generic or merely-recent one');
  assert.ok(genericIndex === -1 || memoryIndex < genericIndex, 'the on-topic document outranks the recent generic document that only shares source-indicator words');
  assert.ok(mentionIndex === -1 || memoryIndex < mentionIndex, 'a document named after the topic outranks a newer document that only mentions it in passing');
  // A correction to a memory is auditable, like a deletion: the revision history
  // must reflect edits, not only deletes.
  const auditItem = await api('/api/items', 'POST', { type: 'note', title: 'Audit edit item', body: 'Original body.', status: 'active' });
  assert.equal(auditItem.response.status, 200);
  await api(`/api/items/${auditItem.body.data.id}`, 'PATCH', { body: 'Corrected body.' });
  const auditHistory = (await api(`/api/memory/items/${auditItem.body.data.id}/history`)).body.data;
  assert.ok(auditHistory.some((revision) => revision.action === 'edited'), 'editing a memory records an auditable revision');
  console.log('Local knowledge retrieval and reviewed-memory verification passed.');
} finally {
  if (child.exitCode === null) child.kill();
  for (let i = 0; child.exitCode === null && i < 40; i += 1) await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(probe, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
