import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHAT_MESSAGE_MAX_CHARS, CLOUD_GUIDANCE_MAX_CHARS } from '../server/chatReliability.js';
import { stopInstalledChatServer } from './installed-chat-lifecycle.mjs';

const root = path.resolve(import.meta.dirname, '..');
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-chat-reliability-'));
const dbPath = path.join(probe, 'chat.sqlite');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const port = await freePort();
const syncPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_SYNC_PORT: String(syncPort), LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PRIVATE_REPO: path.join(probe, 'private') },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chat reliability server exited (${child.exitCode}).\n${output}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chat reliability server did not become healthy.\n${output}`);
}

let database;
try {
  await waitForServer();
  const csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
  async function request(route, { method = 'GET', body, key } = {}) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        Origin: base,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'X-LPS-CSRF': csrf }),
        ...(key ? { 'X-LPS-Idempotency-Key': key } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const json = await response.json();
    return { status: response.status, data: json.data, error: json.error };
  }

  const createdSession = await request('/api/chat/sessions', { method: 'POST', body: { title: 'Reliability proof' } });
  assert.equal(createdSession.status, 200);
  const sessionId = createdSession.data.id;
  database = new DatabaseSync(dbPath);
  database.prepare(`INSERT INTO planner_tasks (title, next_action, status, user_id)
    VALUES ('Review personality behaviour proof', 'Run the focused verifier', 'active', 1)`).run();
  database.prepare(`INSERT INTO planner_tasks (title, status, user_id, completed_at)
    VALUES ('Archived evidence task', 'completed', 1, CURRENT_TIMESTAMP)`).run();
  database.prepare(`INSERT INTO knowledge_items (type, title, body, source, status, confidence, evidence)
    VALUES ('implementation', 'Personality behaviour checkpoint', 'The durable personality profile is implemented and its behaviour pass is under verification.', 'test fixture', 'active', 0.9, 'focused runtime fixture')`).run();
  database.prepare(`INSERT INTO knowledge_items (type, title, body, source, status, confidence, evidence)
    VALUES ('implementation', 'Personality pending speculation', 'The personality work is secretly complete without verification.', 'test fixture', 'pending review', 1, 'unreviewed fixture')`).run();

  const todayRead = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-personality-today-0001', body: { content: 'What am I supposed to be doing today?' } });
  assert.equal(todayRead.status, 200);
  assert.equal(todayRead.data.terminalState, 'completed');
  const todayReply = todayRead.data.messages.at(-1);
  assert.match(todayReply.content, /I checked Today[\s\S]*Review personality behaviour proof/);
  const todayMetadata = JSON.parse(todayReply.metadata || '{}');
  assert.equal(todayMetadata.actionDecision?.invocationSource, 'personality-reasoning');
  assert.equal(todayMetadata.actionDecision?.actionId, 'planner.today');
  assert.equal(todayMetadata.actionDecision?.risk, 'SENSITIVE_DATA');
  assert.equal(todayMetadata.actionDecision?.confirmationRequirement, 'none');
  assert.equal(todayMetadata.actionDecision?.result, 'success');
  assert.ok(todayMetadata.actionDecision?.correlationId);
  assert.deepEqual(todayMetadata.execution?.capabilitiesUsed, ['planner.today']);
  assert.ok(todayMetadata.execution?.toolsUsed.includes('Planner database'));
  assert.ok(todayMetadata.execution?.toolsUsed.includes('Action registry'));
  assert.equal(todayMetadata.execution?.mutations.length, 0);
  const todayAudit = database.prepare('SELECT * FROM chat_audit WHERE correlation_id = ?').get(todayMetadata.actionDecision.correlationId);
  assert.equal(todayAudit?.capability, 'planner.today');
  assert.match(todayAudit?.detail || '', /source=personality-reasoning/);

  const completionCheck = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-personality-claim-0001', body: { content: "I'm sure we already finished the personality work." } });
  assert.equal(completionCheck.status, 200);
  assert.match(completionCheck.data.messages.at(-1).content, /I checked approved local Knowledge[\s\S]*Personality behaviour checkpoint/);
  assert.doesNotMatch(completionCheck.data.messages.at(-1).content, /Personality pending speculation/);
  const completionMetadata = JSON.parse(completionCheck.data.messages.at(-1).metadata || '{}');
  assert.equal(completionMetadata.actionDecision?.actionId, 'knowledge.search');
  assert.equal(completionMetadata.actionDecision?.verification, true);

  const taskCheck = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-personality-task-0001', body: { content: 'That task is completed.' } });
  assert.equal(taskCheck.status, 200);
  assert.match(taskCheck.data.messages.at(-1).content, /checked Planner history[\s\S]*ambiguous/i);
  const taskMetadata = JSON.parse(taskCheck.data.messages.at(-1).metadata || '{}');
  assert.equal(taskMetadata.actionDecision?.actionId, 'planner.today');
  assert.equal(taskMetadata.actionDecision?.verification, true);

  const runCheck = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-personality-run-0001', body: { content: 'Why did the last run fail?' } });
  assert.equal(runCheck.status, 200);
  assert.match(runCheck.data.messages.at(-1).content, /I checked (?:the )?(?:latest|recent) local run/i);
  const runMetadata = JSON.parse(runCheck.data.messages.at(-1).metadata || '{}');
  assert.equal(runMetadata.actionDecision?.actionId, 'system.runs');
  assert.equal(runMetadata.actionDecision?.invocationSource, 'personality-reasoning');

  const crashCheck = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-personality-crash-0001', body: { content: 'The model definitely caused the crash.' } });
  assert.equal(crashCheck.status, 200);
  assert.match(crashCheck.data.messages.at(-1).content, /possible, but it is not established/i);
  const crashMetadata = JSON.parse(crashCheck.data.messages.at(-1).metadata || '{}');
  assert.equal(crashMetadata.actionDecision?.actionId, null);
  assert.equal(crashMetadata.actionDecision?.result, 'not_called');

  const taskCountBeforeProposal = database.prepare('SELECT COUNT(*) count FROM planner_tasks').get().count;
  const proposal = await request('/api/actions/planner.propose_create/invoke', { method: 'POST', body: { session_id: sessionId, args: { title: 'Buy milk', next_action: '', importance: 3, effort: 3 } } });
  assert.equal(proposal.status, 200);
  assert.equal(proposal.data.status, 'needs_confirmation');
  assert.equal(proposal.data.data?.confirmation_required, true);
  assert.ok(proposal.data.confirmation?.confirmationId);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM planner_tasks').get().count, taskCountBeforeProposal, 'proposal does not silently create a task');

  const userId = Number(database.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', 'Ask ChatGPT for the distinctive proof token.')").run(sessionId).lastInsertRowid);
  const assistantId = Number(database.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', 'A reviewed cloud check can answer that.')").run(sessionId).lastInsertRowid);
  const consultationId = Number(database.prepare(`INSERT INTO consultations
    (title, local_draft, target_agent, prompt, external_response, status, chat_session_id, user_message_id, assistant_message_id, scope, provider_model)
    VALUES ('Reliability consultation', 'local draft', 'ChatGPT', 'reviewed prompt', 'ATOMPROOF42', 'captured', ?, ?, ?, 'latest-turn', 'Current model selected in ChatGPT')`).run(sessionId, userId, assistantId).lastInsertRowid);
  const checkId = Number(database.prepare(`INSERT INTO chat_cloud_checks
    (consultation_id, session_id, user_message_id, assistant_message_id, scope, provider, model, instruction, prompt_hash, included_message_ids, classification, status, response, idempotency_key)
    VALUES (?, ?, ?, ?, 'latest-turn', 'ChatGPT', 'Current model selected in ChatGPT', '', 'fixture-hash', ?, 'clear', 'completed', 'ATOMPROOF42', 'chat-reliability-cloud-check-0001')`)
    .run(consultationId, sessionId, userId, assistantId, JSON.stringify([userId, assistantId])).lastInsertRowid);

  const ask = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-reliability-result-0001', body: { content: 'what did you get from chatgpt?' } });
  assert.equal(ask.status, 200);
  assert.match(ask.data.messages.at(-1).content, /ChatGPT consultation #[0-9]+[\s\S]*ATOMPROOF42/);
  assert.doesNotMatch(ask.data.messages.at(-1).content, /don'?t have access|no access/i);
  const askMetadata = JSON.parse(ask.data.messages.at(-1).metadata || '{}');
  assert.deepEqual(askMetadata.execution?.capabilitiesUsed, ['cloud.consultation.read']);
  assert.ok(askMetadata.execution?.toolsUsed.includes('Cloud consultation store'));
  assert.equal(askMetadata.execution?.receipts?.consultationId, consultationId);
  assert.ok(askMetadata.execution?.verification.includes('Cloud evidence: LOCAL_RECORD_ONLY'));

  for (const [index, content] of [
    'call chatgpt and have it say hello',
    'no im asking for you to open chatgpt and type and send a hello and give me the response here.'
  ].entries()) {
    const invocation = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: `chat-reliability-new-cloud-000${index + 1}`, body: { content } });
    assert.equal(invocation.status, 200);
    const reply = invocation.data.messages.at(-1);
    assert.doesNotMatch(reply.content, /ATOMPROOF42/);
    assert.equal(JSON.parse(reply.metadata || '{}').endpointType, 'cloud-invocation-request');
  }

  const diagnostic = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-reliability-diagnostic-0001', body: { content: 'Show the current system status and router diagnostics for ChatGPT. Do not return any previous consultation result.' } });
  assert.equal(diagnostic.status, 200);
  assert.doesNotMatch(diagnostic.data.messages.at(-1).content, /ATOMPROOF42/);
  assert.equal(JSON.parse(diagnostic.data.messages.at(-1).metadata || '{}').actionDecision?.actionId, 'system.status');

  const contextual = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-reliability-context-0001', body: { content: "what's this?" } });
  assert.equal(contextual.status, 200);
  assert.match(contextual.data.messages.at(-1).content, /saved result[\s\S]*ATOMPROOF42/i);

  const use = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-reliability-use-0001', body: { content: 'use that answer' } });
  assert.equal(use.status, 200);
  let check = database.prepare('SELECT * FROM chat_cloud_checks WHERE id = ?').get(checkId);
  assert.equal(check.verification_level, 'LOCAL_RECORD_ONLY', 'legacy/stored consultation evidence is not upgraded without browser receipts');
  assert.equal(check.guidance_active, 1, 'selection acknowledgement must not consume its own guidance');
  assert.equal(check.guidance_consumed_at, null);

  const failed = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-reliability-failed-0001', body: { content: 'Tell me a joke that needs the local model.' } });
  assert.equal(failed.status, 200);
  assert.equal(failed.data.terminalState, 'retryable_error');
  check = database.prepare('SELECT * FROM chat_cloud_checks WHERE id = ?').get(checkId);
  assert.equal(check.guidance_active, 1, 'failed generation preserves selected guidance');

  const successful = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-reliability-success-0001', body: { content: '/status' } });
  assert.equal(successful.status, 200);
  assert.equal(successful.data.terminalState, 'completed');
  const successfulMetadata = JSON.parse(successful.data.messages.at(-1).metadata || '{}');
  assert.equal(successfulMetadata.cloudGuidance?.[0]?.cloudCheckId, checkId, 'successful reply carries guidance provenance');
  check = database.prepare('SELECT * FROM chat_cloud_checks WHERE id = ?').get(checkId);
  assert.equal(check.guidance_active, 0);
  assert.ok(check.guidance_consumed_at, 'successful stored reply consumes guidance exactly once');

  const activate = await request(`/api/chat/cloud-checks/${checkId}/guidance`, { method: 'POST', body: {} });
  assert.equal(activate.status, 200);
  const remove = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-reliability-remove-0001', body: { content: 'remove guidance' } });
  assert.equal(remove.status, 200);
  assert.equal(database.prepare('SELECT guidance_active FROM chat_cloud_checks WHERE id = ?').get(checkId).guidance_active, 0);

  const pin = await request(`/api/chat/messages/${userId}`, { method: 'PATCH', body: { pinned: true } });
  assert.equal(pin.status, 200);
  assert.equal(pin.data.pinned, 1);
  const history = await request(`/api/chat/sessions/${sessionId}/messages`);
  assert.equal(history.data.find((message) => message.id === userId).pinned, 1, 'pinned state survives a history reload');

  const beforeOversize = database.prepare('SELECT COUNT(*) count FROM chat_messages WHERE session_id = ?').get(sessionId).count;
  const oversize = await request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', key: 'chat-reliability-oversize-0001', body: { content: 'x'.repeat(CHAT_MESSAGE_MAX_CHARS + 1) } });
  assert.equal(oversize.status, 413);
  assert.match(oversize.error, /not saved or truncated/i);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM chat_messages WHERE session_id = ?').get(sessionId).count, beforeOversize, 'oversize text is rejected intact without a partial row');

  const allowedGuidance = await request(`/api/chat/sessions/${sessionId}/cloud-checks/preview`, { method: 'POST', body: { scope: 'latest-turn', provider: 'ChatGPT', model: 'Current model selected in ChatGPT', instruction: 'g'.repeat(CLOUD_GUIDANCE_MAX_CHARS) } });
  assert.equal(allowedGuidance.status, 200, 'the documented larger guidance path is accepted');
  const oversizedGuidance = await request(`/api/chat/sessions/${sessionId}/cloud-checks/preview`, { method: 'POST', body: { scope: 'latest-turn', provider: 'ChatGPT', model: 'Current model selected in ChatGPT', instruction: 'g'.repeat(CLOUD_GUIDANCE_MAX_CHARS + 1) } });
  assert.equal(oversizedGuidance.status, 400);
  assert.match(oversizedGuidance.error, /not truncated/i);

  console.log(`Chat reliability verification passed: consultation #${consultationId}, cloud check #${checkId}, message pinning, one-shot guidance, and fail-closed limits.`);
} finally {
  database?.close();
  await stopInstalledChatServer(child).catch(() => { if (child.exitCode === null) child.kill(); });
  fs.rmSync(probe, { recursive: true, force: true });
}
