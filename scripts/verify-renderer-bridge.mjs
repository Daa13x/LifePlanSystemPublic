#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createRendererBridge,
  buildDestinationCatalog,
  COMMAND_VERB,
  COMMAND_RESOLUTIONS,
  ACK_STATUSES
} from '../server/rendererBridge.js';

let failures = 0;
const line = (ok, message, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}${detail ? `\n      ${detail}` : ''}`);
};
async function check(message, fn) {
  try { await fn(); line(true, message); }
  catch (error) { line(false, message, error.stack || error.message); }
}

// Deterministic, injectable factories + a controllable clock so every timing,
// identity, and single-use property is proven without wall-clock flakiness.
function harness(overrides = {}) {
  let clock = 1_000_000;
  let rid = 0;
  let sec = 0;
  let cid = 0;
  const bridge = createRendererBridge({
    now: () => clock,
    rendererIdFactory: () => `rend-${String(++rid).padStart(8, '0')}`,
    secretFactory: () => `sec-${String(++sec).padStart(24, '0')}`,
    commandIdFactory: () => `cmd-${String(++cid).padStart(8, '0')}`,
    ...overrides
  });
  return { bridge, advance: (ms) => { clock += ms; }, at: () => clock };
}

let corrSeq = 0;
const corr = () => `corr-${String(++corrSeq).padStart(8, '0')}`;

console.log('--- renderer navigation command/ack bridge verification ---');

await check('the resolution and ack vocabularies are closed sets', () => {
  assert.deepEqual(COMMAND_RESOLUTIONS, ['APPLIED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'STALE_RENDERER']);
  assert.deepEqual(ACK_STATUSES, ['APPLIED', 'FAILED', 'CANCELLED']);
  assert.equal(COMMAND_VERB, 'navigate');
});

await check('destination catalog only offers destinations that round-trip through the canonical router', () => {
  const catalog = buildDestinationCatalog();
  const ids = [...catalog.keys()].sort();
  // planner is workboard/today; models has no canonical route and must be absent.
  assert.deepEqual(ids, ['chat', 'knowledge', 'planner', 'settings', 'workboard']);
  assert.equal(catalog.get('workboard').route, '#workboard');
  assert.equal(catalog.get('planner').route, '#workboard/today');
  assert.equal(catalog.get('chat').route, '#chat');
  assert.equal(catalog.get('settings').route, '#settings');
  assert.equal(catalog.has('models'), false);
});

await check('invented, non-canonical, or malformed destinations are dropped from the catalog (fail-closed)', () => {
  const catalog = buildDestinationCatalog({
    workboard: { section: 'workboard', tab: null },
    bogus: { section: 'nope', tab: null },
    badtab: { section: 'workboard', tab: 'not-a-real-tab' },
    Upper: { section: 'chat', tab: null },
    'has space': { section: 'chat', tab: null },
    empty: { section: '', tab: null }
  });
  assert.deepEqual([...catalog.keys()], ['workboard']);
});

await check('construction fails closed when no destination resolves to a real route', () => {
  assert.throws(() => createRendererBridge({ destinations: { models: { section: 'system', tab: 'models' } } }), /No semantic destinations/);
});

await check('registration issues a server-side renderer id and secret token, generation starts at 1', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A', chatSessionId: 7 });
  assert.equal(reg.ok, true);
  assert.match(reg.rendererId, /^rend-/);
  assert.match(reg.token, /^sec-/);
  assert.equal(reg.generation, 1);
  assert.equal(bridge.registerRenderer({}).ok, false); // window id required
});

await check('happy path: issue a navigation command, renderer applies, server correlates to APPLIED', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  bridge.attachStream(reg.rendererId, reg.token);
  const c = corr();
  const issued = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: c });
  assert.equal(issued.ok, true);
  const env = issued.envelope;
  assert.equal(env.command, 'navigate');
  assert.equal(env.destination, 'workboard');
  assert.equal(env.route, '#workboard');
  assert.equal(env.correlationId, c);
  assert.match(env.commandToken, /^sec-/);
  const ack = bridge.acknowledge({
    commandId: env.commandId, correlationId: c, rendererId: reg.rendererId,
    token: reg.token, commandToken: env.commandToken, status: 'APPLIED'
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.resolution.status, 'APPLIED');
  assert.equal(bridge.getCommand(env.commandId).status, 'APPLIED');
});

await check('the wire command is non-programmable: no url/script/opener fields, route is a hash only', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const issued = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: corr() });
  assert.deepEqual(Object.keys(issued.envelope).sort(), ['command', 'commandId', 'commandToken', 'correlationId', 'destination', 'expiresAt', 'rendererId', 'route']);
  const serialized = JSON.stringify(issued.envelope);
  for (const forbidden of ['http://', 'https://', 'file:', 'javascript:', 'shell:', 'executeJavascript', 'window.open']) {
    assert.equal(serialized.includes(forbidden), false, `envelope must not contain ${forbidden}`);
  }
  assert.equal(issued.envelope.route.startsWith('#'), true);
});

await check('url-shaped, script-shaped, and traversal destinations are rejected before any command exists', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  for (const bad of ['http://evil', 'javascript:alert(1)', 'file:///etc/passwd', '../settings', 'system/models', 'models', 'workboard/cards', 'WORKBOARD', '']) {
    const r = bridge.issueCommand({ rendererId: reg.rendererId, destination: bad, correlationId: corr() });
    assert.equal(r.ok, false, `destination ${JSON.stringify(bad)} must be rejected`);
    assert.equal(r.error.code, 'UNKNOWN_DESTINATION');
    assert.equal(r.error.category, 'unknown_destination');
  }
});

await check('a missing/invalid correlation id blocks command issuance', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  assert.equal(bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard' }).error.code, 'INVALID_CORRELATION');
  assert.equal(bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: 'x' }).error.code, 'INVALID_CORRELATION');
});

await check('acknowledgement is single-use: a duplicate ack is rejected as already-resolved', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: c }).envelope;
  const base = { commandId: env.commandId, correlationId: c, rendererId: reg.rendererId, token: reg.token, commandToken: env.commandToken, status: 'APPLIED' };
  assert.equal(bridge.acknowledge(base).ok, true);
  const dup = bridge.acknowledge(base);
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'ALREADY_RESOLVED');
  assert.equal(dup.error.category, 'duplicate_ack');
});

await check('an unsupported ack status is rejected and never applied', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: c }).envelope;
  const r = bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: reg.rendererId, token: reg.token, commandToken: env.commandToken, status: 'DONE' });
  assert.equal(r.error.code, 'INVALID_ACK_STATUS');
  assert.equal(bridge.getCommand(env.commandId).resolved, false);
});

await check('correlation mismatch is rejected and leaves the command open for the real ack', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: c }).envelope;
  const bad = bridge.acknowledge({ commandId: env.commandId, correlationId: corr(), rendererId: reg.rendererId, token: reg.token, commandToken: env.commandToken, status: 'APPLIED' });
  assert.equal(bad.error.code, 'CORRELATION_MISMATCH');
  assert.equal(bridge.getCommand(env.commandId).resolved, false);
  const good = bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: reg.rendererId, token: reg.token, commandToken: env.commandToken, status: 'APPLIED' });
  assert.equal(good.ok, true);
});

await check('multi-window: only the targeted renderer can apply; a second window cannot ack another window\'s command', () => {
  const { bridge } = harness();
  const a = bridge.registerRenderer({ windowId: 'win-A' });
  const b = bridge.registerRenderer({ windowId: 'win-B' });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: a.rendererId, destination: 'workboard', correlationId: c }).envelope;
  // Window B (its own id + token) cannot ack A's command.
  const wrong = bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: b.rendererId, token: b.token, commandToken: env.commandToken, status: 'APPLIED' });
  assert.equal(wrong.error.code, 'WRONG_RENDERER');
  assert.equal(wrong.error.category, 'wrong_renderer');
  // Using A's id but B's token fails authentication.
  const tok = bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: a.rendererId, token: b.token, commandToken: env.commandToken, status: 'APPLIED' });
  assert.equal(tok.error.code, 'TOKEN_MISMATCH');
  assert.equal(bridge.getCommand(env.commandId).resolved, false);
  // The genuine target still applies.
  assert.equal(bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: a.rendererId, token: a.token, commandToken: env.commandToken, status: 'APPLIED' }).ok, true);
});

await check('a forged command token cannot resolve a command', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: c }).envelope;
  const forged = bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: reg.rendererId, token: reg.token, commandToken: 'sec-000000000000000000009999', status: 'APPLIED' });
  assert.equal(forged.error.code, 'COMMAND_TOKEN_MISMATCH');
  assert.equal(bridge.getCommand(env.commandId).resolved, false);
});

await check('a renderer-reported FAILED ack resolves as FAILED with a failure category', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: c }).envelope;
  const ack = bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: reg.rendererId, token: reg.token, commandToken: env.commandToken, status: 'FAILED', detail: 'route apply failed' });
  assert.equal(ack.resolution.status, 'FAILED');
  assert.equal(bridge.getCommand(env.commandId).failureCategory, 'renderer_failed');
});

await check('timeout: an unacknowledged command expires to TIMEOUT and can no longer be applied', () => {
  const { bridge, advance } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: c }).envelope;
  advance(10_000); // reach expiresAt
  const expired = bridge.expireDueCommands();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, 'TIMEOUT');
  const late = bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: reg.rendererId, token: reg.token, commandToken: env.commandToken, status: 'APPLIED' });
  assert.equal(late.error.code, 'ALREADY_RESOLVED');
});

await check('cancellation: a server-side cancel resolves CANCELLED and blocks a later ack', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: c }).envelope;
  const cancel = bridge.cancelCommand(env.commandId, { reason: 'user aborted' });
  assert.equal(cancel.resolution.status, 'CANCELLED');
  assert.equal(bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: reg.rendererId, token: reg.token, commandToken: env.commandToken, status: 'APPLIED' }).error.code, 'ALREADY_RESOLVED');
});

await check('stale renderer via reload/session-switch: re-registering the window supersedes and stales pending commands', () => {
  const { bridge } = harness();
  const r1 = bridge.registerRenderer({ windowId: 'win-A', chatSessionId: 1 });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: r1.rendererId, destination: 'workboard', correlationId: c }).envelope;
  // The same window reloads (or switches session) -> a new generation supersedes r1.
  const r2 = bridge.registerRenderer({ windowId: 'win-A', chatSessionId: 2 });
  assert.equal(r2.generation, 2);
  assert.equal(bridge.getCommand(env.commandId).status, 'STALE_RENDERER');
  // The stale generation can no longer be targeted or acknowledged.
  assert.equal(bridge.issueCommand({ rendererId: r1.rendererId, destination: 'workboard', correlationId: corr() }).error.code, 'RENDERER_STALE');
  assert.equal(bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: r1.rendererId, token: r1.token, commandToken: env.commandToken, status: 'APPLIED' }).error.code, 'ALREADY_RESOLVED');
  // The new generation works.
  assert.equal(bridge.issueCommand({ rendererId: r2.rendererId, destination: 'workboard', correlationId: corr() }).ok, true);
});

await check('closed window: unregistering the renderer stales its pending command and blocks new commands', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: corr() }).envelope;
  bridge.unregisterRenderer(reg.rendererId, reg.token);
  assert.equal(bridge.getCommand(env.commandId).status, 'STALE_RENDERER');
  assert.equal(bridge.getCommand(env.commandId).failureCategory, 'renderer_gone');
  assert.equal(bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: corr() }).error.code, 'RENDERER_UNKNOWN');
});

await check('idle prune: a renderer past the idle ceiling goes stale and its pending command fails', () => {
  const { bridge, advance } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: corr() }).envelope;
  advance(9_999); // command not yet expired, renderer not yet idle
  assert.equal(bridge.pruneStaleRenderers().length, 0);
  advance(60_001); // now well past the idle ceiling
  const pruned = bridge.pruneStaleRenderers();
  assert.equal(pruned.length, 1);
  assert.equal(bridge.getCommand(env.commandId).status, 'STALE_RENDERER');
  assert.equal(bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: corr() }).error.code, 'RENDERER_STALE');
});

await check('issuing to an unknown renderer id fails closed', () => {
  const { bridge } = harness();
  assert.equal(bridge.issueCommand({ rendererId: 'rend-99999999', destination: 'workboard', correlationId: corr() }).error.code, 'RENDERER_UNKNOWN');
});

await check('onResolved fires for both the pending->resolved path and an already-resolved command', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A' });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: c }).envelope;
  const seen = [];
  assert.equal(bridge.onResolved(env.commandId, (r) => seen.push(r.status)), true);
  bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: reg.rendererId, token: reg.token, commandToken: env.commandToken, status: 'APPLIED' });
  assert.deepEqual(seen, ['APPLIED']);
  // Registering a listener after resolution fires immediately.
  bridge.onResolved(env.commandId, (r) => seen.push(`again:${r.status}`));
  assert.deepEqual(seen, ['APPLIED', 'again:APPLIED']);
  assert.equal(bridge.onResolved('cmd-00000000', () => {}), false);
});

await check('the bounded audit record carries identifiers and status only — never tokens, routes, or content', () => {
  const { bridge } = harness();
  const reg = bridge.registerRenderer({ windowId: 'win-A', chatSessionId: 42 });
  const c = corr();
  const env = bridge.issueCommand({ rendererId: reg.rendererId, destination: 'workboard', correlationId: c }).envelope;
  bridge.acknowledge({ commandId: env.commandId, correlationId: c, rendererId: reg.rendererId, token: reg.token, commandToken: env.commandToken, status: 'APPLIED' });
  const audit = bridge.getCommand(env.commandId).audit;
  assert.deepEqual(Object.keys(audit).sort(), ['command', 'correlationId', 'destination', 'failureCategory', 'generation', 'issuedAt', 'rendererSession', 'resolvedAt', 'status', 'windowId']);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(reg.token), false, 'audit must not leak the renderer token');
  assert.equal(serialized.includes(env.commandToken), false, 'audit must not leak the command token');
  assert.equal('route' in audit, false, 'audit must not include a route body');
  assert.equal('commandToken' in audit, false);
  assert.equal('token' in audit, false);
});

await check('a superseded renderer cannot attach a command stream', () => {
  const { bridge } = harness();
  const r1 = bridge.registerRenderer({ windowId: 'win-A' });
  bridge.registerRenderer({ windowId: 'win-A' }); // supersede r1
  assert.equal(bridge.attachStream(r1.rendererId, r1.token).error.code, 'UNKNOWN_RENDERER');
});

console.log(failures ? `\n${failures} renderer-bridge check(s) FAILED` : '\nAll renderer-bridge checks passed.');
process.exit(failures ? 1 : 0);
