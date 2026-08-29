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

  // Exercise the Chat cloud-check lifecycle through the real HTTP boundary
  // with a deterministic, token-authenticated connector. This proves more
  // than source contracts: provider dispatch, result capture, cancellation,
  // idempotent candidate saving, and the no-egress privacy boundary.
  const csrf = (await (await fetch(`${baseUrl}/api/csrf-token`)).json()).data.token;
  const mutate = async (route, body, method = 'POST') => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { Origin: baseUrl, 'Content-Type': 'application/json', 'X-LPS-CSRF': csrf },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await mutate('/api/items', { type: 'profile', title: 'Cloud workflow fixture', body: 'A deterministic local fact for the cloud connector test.', status: 'active', confidence: 0.9 })).status, 200);
  const session = await mutate('/api/chat/sessions', { title: 'Cloud connector behaviour' });
  assert.equal(session.status, 200);
  const sessionId = session.body.data.id;
  const turn = await mutate(`/api/chat/sessions/${sessionId}/messages`, { content: 'Tell me something about myself.' });
  assert.equal(turn.status, 200);
  assert.equal(turn.body.data.messages.length, 2, 'fixture has a completed user/assistant turn');

  const preview = await mutate(`/api/chat/sessions/${sessionId}/cloud-checks/preview`, {
    scope: 'latest-turn', provider: 'ChatGPT', model: 'Current model selected in ChatGPT', instruction: 'Focus on concrete risks.'
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.messageCount, 2, 'latest turn contains exactly the user/assistant pair');
  assert.match(preview.body.data.prompt, /Focus on concrete risks\./);
  const create = await mutate(`/api/chat/sessions/${sessionId}/cloud-checks`, {
    scope: 'latest-turn', provider: 'ChatGPT', model: 'Current model selected in ChatGPT', instruction: 'Focus on concrete risks.', idempotency_key: 'connector-behaviour-primary-0001'
  });
  assert.equal(create.status, 200);
  const cloudCheckId = create.body.data.check.id;
  const replay = await mutate(`/api/chat/sessions/${sessionId}/cloud-checks`, {
    scope: 'latest-turn', provider: 'ChatGPT', model: 'Current model selected in ChatGPT', instruction: 'Changed text cannot duplicate the record.', idempotency_key: 'connector-behaviour-primary-0001'
  });
  assert.equal(replay.body.data.reused, true, 'creation idempotency reuses the durable cloud check');
  assert.equal(replay.body.data.check.id, cloudCheckId);
  const dispatched = await mutate(`/api/chat/cloud-checks/${cloudCheckId}/send`, {});
  assert.equal(dispatched.status, 200, 'connected matching provider creates a browser job');
  const claimed = await request(baseUrl, '/api/browser/extension/next', { token: pairing.token });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.data.job.targetAgent, 'ChatGPT');
  assert.equal(claimed.body.data.job.prompt, create.body.data.prompt, 'connector receives the exact authorised prompt');
  const answered = await request(baseUrl, `/api/browser/extension/jobs/${claimed.body.data.job.id}`, {
    method: 'POST', token: pairing.token,
    body: JSON.stringify({ status: 'answered', claimToken: claimed.body.data.job.claimToken, answer: 'External advisory response.', title: 'ChatGPT' })
  });
  assert.equal(answered.status, 200);
  const checksAfterAnswer = await (await fetch(`${baseUrl}/api/chat/sessions/${sessionId}/cloud-checks`)).json();
  const completed = checksAfterAnswer.data.find((item) => item.id === cloudCheckId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.response, 'External advisory response.');
  const candidate = await mutate(`/api/chat/cloud-checks/${cloudCheckId}/memory-candidate`, {});
  assert.equal(candidate.status, 200);
  const candidateReplay = await mutate(`/api/chat/cloud-checks/${cloudCheckId}/memory-candidate`, {});
  assert.equal(candidateReplay.body.data.reused, true, 'memory-candidate saving is explicitly idempotent');
  const guidance = await mutate(`/api/chat/cloud-checks/${cloudCheckId}/guidance`, {});
  assert.equal(guidance.status, 200);
  const guidedTurn = await mutate(`/api/chat/sessions/${sessionId}/messages`, { content: 'Tell me something about myself.' });
  assert.equal(guidedTurn.status, 200);
  assert.equal(guidedTurn.body.data.messages.length, 2, 'guidance is retained until an assistant reply is actually stored');
  const checksAfterGuidance = await (await fetch(`${baseUrl}/api/chat/sessions/${sessionId}/cloud-checks`)).json();
  assert.ok(checksAfterGuidance.data.find((item) => item.id === cloudCheckId).guidance_consumed_at, 'guidance is consumed after one persisted assistant reply');

  const cancelledCreate = await mutate(`/api/chat/sessions/${sessionId}/cloud-checks`, {
    scope: 'latest-turn', provider: 'ChatGPT', model: 'Current model selected in ChatGPT', instruction: '', idempotency_key: 'connector-behaviour-cancel-0001'
  });
  const cancelledId = cancelledCreate.body.data.check.id;
  assert.equal((await mutate(`/api/chat/cloud-checks/${cancelledId}/send`, {})).status, 200);
  const cancelledClaim = await request(baseUrl, '/api/browser/extension/next', { token: pairing.token });
  assert.ok(cancelledClaim.body.data.job, 'second check is claimable before cancellation');
  assert.equal((await mutate(`/api/chat/cloud-checks/${cancelledId}/cancel`, {})).status, 200);
  const lateAnswer = await request(baseUrl, `/api/browser/extension/jobs/${cancelledClaim.body.data.job.id}`, {
    method: 'POST', token: pairing.token,
    body: JSON.stringify({ status: 'answered', claimToken: cancelledClaim.body.data.job.claimToken, answer: 'Late answer must not win.' })
  });
  assert.equal(lateAnswer.status, 403, 'cancellation invalidates the connector claim token');
  const checksAfterCancel = await (await fetch(`${baseUrl}/api/chat/sessions/${sessionId}/cloud-checks`)).json();
  assert.equal(checksAfterCancel.data.find((item) => item.id === cancelledId).status, 'cancelled');

  const blockedPreview = await mutate(`/api/chat/sessions/${sessionId}/cloud-checks/preview`, {
    scope: 'latest-turn', provider: 'ChatGPT', model: 'Current model selected in ChatGPT', instruction: 'Include my medical record in the review.'
  });
  assert.equal(blockedPreview.status, 200);
  assert.equal(blockedPreview.body.data.blocked, true, 'sensitive cloud egress is blocked server-side');
  console.log('Chat cloud workflow HTTP verification passed: dispatch, capture, guidance, candidate, cancellation, and privacy boundaries.');

  const settings = await request(baseUrl, '/api/settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.body.data.browserConnectorToken, '[redacted]');

  const serverSource = fs.readFileSync(path.join(repoRoot, 'server', 'index.js'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(repoRoot, 'browser-extension', 'lps-browser-agent', 'background.js'), 'utf8');
  assert.match(serverSource, /leaseExpiresAt/);
  assert.match(serverSource, /claimToken/);
  assert.match(extensionSource, /claimToken: job\.claimToken/);

  // Regression (2026-08-29): a 3-second text-stability window alone falsely
  // finalized a longer, multi-sentence real ChatGPT reply after it happened to
  // pause mid-stream, capturing it truncated. runContentSend must not return
  // an answered result straight off the stability check -- it must take one
  // longer confirmation read first and only finalize if the text held.
  const stableTicksBlockMatch = extensionSource.match(/if \(stableTicks >= 3\) \{[\s\S]*?\n  \}/);
  assert.ok(stableTicksBlockMatch, 'runContentSend must retain its stableTicks >= 3 completion branch');
  const stableTicksBlock = stableTicksBlockMatch[0];
  assert.match(stableTicksBlock, /await sleep\(\d+\)/, 'reaching the stability window must wait for one more confirmation read before finalizing');
  assert.match(stableTicksBlock, /const confirmed = readLatestResponse\(beforeTurnCount\)/, 'the confirmation read must re-derive the answer the same way the polling loop does');
  assert.match(stableTicksBlock, /if \(confirmed === text\)/, "a result may only be returned as 'answered' if the confirmation read matches the already-stable text");
  assert.doesNotMatch(
    stableTicksBlock.slice(0, stableTicksBlock.indexOf('if (confirmed === text)')),
    /status: 'answered'/,
    'runContentSend must not return answered before the post-stability confirmation read'
  );

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
