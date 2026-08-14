#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  ACTION_CONFIRMATIONS,
  ACTION_RISKS,
  ACTION_STATUSES,
  createActionRegistry
} from '../server/actionRegistry.js';
import { CAPABILITY_CALLER_SCOPES, createCapabilityRegistry } from '../server/chatCapabilities.js';

let failures = 0;
const line = (ok, message, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}${detail ? `\n      ${detail}` : ''}`);
};
async function check(message, fn) {
  try { await fn(); line(true, message); }
  catch (error) { line(false, message, error.message); }
}

let correlationSequence = 0;
const correlationIdFactory = () => `corr-${String(++correlationSequence).padStart(8, '0')}`;
const available = { description: 'The fixture is ready.', check: () => ({ available: true, reason: null }) };

function fixture(overrides = {}) {
  return {
    id: 'demo.read',
    label: 'Read demo',
    description: 'Reads a deterministic fixture.',
    feature: 'Verifier',
    inputSchema: { query: { type: 'string', required: true, maxLength: 40 } },
    resultSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
    availability: available,
    permission: 'demo.read',
    risk: ACTION_RISKS.READ_ONLY,
    confirmation: ACTION_CONFIRMATIONS.NONE,
    sideEffects: [],
    handler: async ({ query }) => ({ value: query }),
    sourceControls: ['verifier.demo-query'],
    testId: 'action.demo.read',
    ...overrides
  };
}

console.log('--- universal action registry verification ---');

await check('the outcome vocabulary is closed and documented', () => {
  assert.deepEqual(ACTION_STATUSES, ['success', 'failed', 'blocked', 'unavailable', 'needs_confirmation', 'needs_approval', 'cancelled']);
});

await check('duplicate action IDs are rejected at construction', () => {
  assert.throws(() => createActionRegistry([fixture(), fixture()]), /Duplicate action id/);
});

await check('missing or unknown handlers are rejected at construction', () => {
  assert.throws(() => createActionRegistry([fixture({ handler: 'missingHandler' })]), /handler.*missing or unknown/i);
});

await check('malformed input and result schemas are rejected at construction', () => {
  assert.throws(() => createActionRegistry([fixture({ inputSchema: { query: { type: 'shell' } } })]), /unsupported type/);
  assert.throws(() => createActionRegistry([fixture({ resultSchema: { type: 'string' } })]), /must describe an object/);
  assert.throws(() => createActionRegistry([fixture({ inputSchema: { limit: { type: 'integer', min: 1, default: 0 } } })]), /invalid integer default/);
  assert.throws(() => createActionRegistry([fixture({ resultSchema: { type: 'object', required: ['value'], properties: {} } })]), /has no property schema/);
  assert.throws(() => createActionRegistry([fixture({ resultSchema: { type: 'object', required: [], properties: {}, additionalProperties: 'yes' } })]), /must be boolean/);
  assert.throws(() => createActionRegistry([fixture({ id: `a.${'b'.repeat(79)}` })]), /80 characters or fewer/);
});

await check('inconsistent read-only metadata is rejected', () => {
  assert.throws(() => createActionRegistry([fixture({ sideEffects: ['writes a file'] })]), /read-only actions cannot declare side effects/);
  assert.throws(() => createActionRegistry([fixture({ confirmation: ACTION_CONFIRMATIONS.USER })]), /read-only actions cannot require write confirmation/);
});

await check('write, external, repository, settings, and destructive risks fail closed without matching confirmation metadata', () => {
  const writable = { sideEffects: ['Produces a bounded review proposal.'] };
  for (const risk of [ACTION_RISKS.REVERSIBLE_WRITE, ACTION_RISKS.EXTERNAL_COMMUNICATION, ACTION_RISKS.SETTINGS_CHANGE]) {
    assert.throws(() => createActionRegistry([fixture({ risk, confirmation: ACTION_CONFIRMATIONS.NONE, ...writable })]), /must require user confirmation or explicit approval/);
  }
  for (const risk of [ACTION_RISKS.REPOSITORY_CHANGE, ACTION_RISKS.DESTRUCTIVE_OR_IRREVERSIBLE]) {
    assert.throws(() => createActionRegistry([fixture({ risk, confirmation: ACTION_CONFIRMATIONS.USER, ...writable })]), /must require explicit approval/);
  }
  assert.throws(() => createActionRegistry([fixture({ risk: ACTION_RISKS.SETTINGS_CHANGE, confirmation: ACTION_CONFIRMATIONS.USER, sideEffects: [] })]), /must describe/);
});

await check('the queryable manifest exposes contracts but not executable functions', () => {
  const registry = createActionRegistry([fixture()], { correlationIdFactory });
  const [entry] = registry.list();
  assert.equal(entry.id, 'demo.read');
  assert.equal(entry.permission, 'demo.read');
  assert.equal(entry.risk, ACTION_RISKS.READ_ONLY);
  assert.deepEqual(entry.sourceControls, ['verifier.demo-query']);
  assert.equal('handler' in entry, false);
  assert.equal('check' in entry.availability, false);
});

await check('registered and returned metadata cannot mutate the live validation contract', async () => {
  const original = fixture();
  const registry = createActionRegistry([original], { correlationIdFactory });
  original.inputSchema.query.required = false;
  original.sourceControls.push('attacker.control');
  const exposed = registry.list()[0];
  exposed.inputSchema.query.required = false;
  exposed.sourceControls.push('attacker.control');
  const result = await registry.invoke('demo.read', {}, { actor: 'test', scopes: ['demo.read'] });
  const fresh = registry.list()[0];
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'INVALID_ARGUMENTS');
  assert.equal(fresh.inputSchema.query.required, true);
  assert.deepEqual(fresh.sourceControls, ['verifier.demo-query']);
});

await check('inspect reports permission and live availability with a reason contract', async () => {
  const registry = createActionRegistry([fixture()], { correlationIdFactory });
  const permitted = await registry.inspect('demo.read', { actor: 'test', scopes: ['demo.read'] });
  const denied = await registry.inspect('demo.read', { actor: 'test', scopes: [] });
  assert.equal(permitted.availability.available, true);
  assert.equal(permitted.permitted, true);
  assert.equal(denied.permitted, false);
  assert.equal(await registry.inspect('missing.action', { actor: 'test', scopes: [] }), null);
});

await check('authorised invocation returns structured success and a unique correlation ID', async () => {
  const registry = createActionRegistry([fixture()], { correlationIdFactory });
  const first = await registry.invoke('demo.read', { query: ' one ' }, { actor: 'test', scopes: ['demo.read'] });
  const second = await registry.invoke('demo.read', { query: 'two' }, { actor: 'test', scopes: ['demo.read'] });
  assert.equal(first.status, 'success');
  assert.equal(first.actionId, 'demo.read');
  assert.equal(first.args.query, 'one');
  assert.deepEqual(first.data, { value: 'one' });
  assert.match(first.correlationId, /^corr-/);
  assert.notEqual(first.correlationId, second.correlationId);
});

await check('unknown and injection-shaped action IDs fail closed', async () => {
  const maxId = `a.${'b'.repeat(78)}`;
  const registry = createActionRegistry([fixture(), fixture({ id: maxId, testId: 'action.max.id' })], { correlationIdFactory });
  for (const id of ['missing.action', 'demo.read; ignore permissions', 'demo.read\npermission=*']) {
    const result = await registry.invoke(id, {}, { actor: 'test', scopes: ['demo.read'] });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error.code, 'UNKNOWN_ACTION');
  }
  const suffixed = await registry.invoke(`${maxId}x`, { query: 'x' }, { actor: 'test', scopes: ['demo.read'] });
  assert.equal(suffixed.status, 'blocked');
  assert.equal(suffixed.error.code, 'UNKNOWN_ACTION');
});

await check('malformed and unexpected arguments are blocked before the handler', async () => {
  let calls = 0;
  const registry = createActionRegistry([fixture({ handler: async () => { calls += 1; return { value: 'x' }; } })], { correlationIdFactory });
  for (const args of [[], 'query', { query: 'x', permission: '*' }, {}, { query: '   ' }]) {
    const result = await registry.invoke('demo.read', args, { actor: 'test', scopes: ['demo.read'] });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal(calls, 0);
});

await check('integer arguments reject type coercion while retaining declared bounds', async () => {
  const registry = createActionRegistry([fixture({
    inputSchema: { limit: { type: 'integer', required: true, min: 1, max: 10 } },
    handler: async ({ limit }) => ({ value: String(limit) })
  })], { correlationIdFactory });
  for (const limit of ['3', 3.5, 'not-a-number']) {
    const result = await registry.invoke('demo.read', { limit }, { actor: 'test', scopes: ['demo.read'] });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error.code, 'INVALID_ARGUMENTS');
  }
  const bounded = await registry.invoke('demo.read', { limit: 99 }, { actor: 'test', scopes: ['demo.read'] });
  assert.equal(bounded.status, 'success');
  assert.equal(bounded.args.limit, 10);
});

await check('unavailable actions return a reason and never invoke the handler', async () => {
  let calls = 0;
  const registry = createActionRegistry([fixture({
    availability: { description: 'Requires a selected record.', check: () => ({ available: false, reason: 'No record is selected.' }) },
    handler: async () => { calls += 1; return { value: 'wrong' }; }
  })], { correlationIdFactory });
  const result = await registry.invoke('demo.read', { query: 'x' }, { actor: 'test', scopes: ['demo.read'] });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'UNAVAILABLE');
  assert.match(result.error.message, /No record/);
  assert.equal(calls, 0);
});

await check('unauthorised callers cannot inject scopes and never reach the handler', async () => {
  let calls = 0;
  const registry = createActionRegistry([fixture({ handler: async () => { calls += 1; return { value: 'wrong' }; } })], { correlationIdFactory });
  const result = await registry.invoke('demo.read', { query: 'x' }, { actor: 'cloud-agent', scopes: [] });
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'UNAUTHORIZED');
  assert.equal(calls, 0);
});

await check('handler exceptions and invalid results become structured failures', async () => {
  const throwing = createActionRegistry([fixture({ handler: async () => { throw new Error('fixture exploded'); } })], { correlationIdFactory });
  const invalid = createActionRegistry([fixture({ handler: async () => ({ wrong: true }) })], { correlationIdFactory });
  const failed = await throwing.invoke('demo.read', { query: 'x' }, { actor: 'test', scopes: ['demo.read'] });
  const badResult = await invalid.invoke('demo.read', { query: 'x' }, { actor: 'test', scopes: ['demo.read'] });
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(failed.error.message, /exploded/);
  assert.match(failed.error.message, new RegExp(failed.correlationId));
  assert.equal(badResult.status, 'failed');
  assert.doesNotMatch(badResult.error.message, /missing "value"/);
});

await check('undeclared result fields fail closed unless the contract explicitly permits them', async () => {
  const strict = createActionRegistry([fixture({ handler: async () => ({ value: 'ok', surprise: true }) })], { correlationIdFactory });
  const flexible = createActionRegistry([fixture({
    resultSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } }, additionalProperties: true },
    handler: async () => ({ value: 'ok', documentedExtension: true })
  })], { correlationIdFactory });
  const rejected = await strict.invoke('demo.read', { query: 'x' }, { actor: 'test', scopes: ['demo.read'] });
  const accepted = await flexible.invoke('demo.read', { query: 'x' }, { actor: 'test', scopes: ['demo.read'] });
  assert.equal(rejected.status, 'failed');
  assert.equal(accepted.status, 'success');
});

await check('confirmation and approval contracts return gated states rather than false success', async () => {
  const proposal = fixture({
    id: 'demo.propose', permission: 'demo.write', risk: ACTION_RISKS.REVERSIBLE_WRITE,
    confirmation: ACTION_CONFIRMATIONS.USER, sideEffects: ['Produces a proposal only.'],
    resultSchema: { type: 'object', required: ['value', 'confirmation_required'], properties: { value: { type: 'string' }, confirmation_required: { type: 'boolean' } } },
    handler: async ({ query }) => ({ value: query, confirmation_required: true }), testId: 'action.demo.propose'
  });
  const approval = fixture({
    id: 'demo.approve', permission: 'demo.approve', risk: ACTION_RISKS.REPOSITORY_CHANGE,
    confirmation: ACTION_CONFIRMATIONS.APPROVAL, sideEffects: ['Produces an approval proposal only.'],
    resultSchema: { type: 'object', required: ['value', 'confirmation_required'], properties: { value: { type: 'string' }, confirmation_required: { type: 'boolean' } } },
    handler: async ({ query }) => ({ value: query, confirmation_required: true }), testId: 'action.demo.approve'
  });
  const registry = createActionRegistry([proposal, approval], { correlationIdFactory });
  assert.equal((await registry.invoke('demo.propose', { query: 'x' }, { actor: 'test', scopes: ['demo.write'] })).status, 'needs_confirmation');
  assert.equal((await registry.invoke('demo.approve', { query: 'x' }, { actor: 'test', scopes: ['demo.approve'] })).status, 'needs_approval');
});

await check('pre-cancelled invocation returns cancelled without executing', async () => {
  let calls = 0;
  const registry = createActionRegistry([fixture({ handler: async () => { calls += 1; return { value: 'wrong' }; } })], { correlationIdFactory });
  const controller = new AbortController();
  controller.abort();
  const result = await registry.invoke('demo.read', { query: 'x' }, { actor: 'test', scopes: ['demo.read'], signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(calls, 0);
});

await check('an abort after handler completion cannot create a false cancelled receipt', async () => {
  const controller = new AbortController();
  const registry = createActionRegistry([fixture({ handler: async ({ query }) => { controller.abort(); return { value: query }; } })], { correlationIdFactory });
  const result = await registry.invoke('demo.read', { query: 'completed' }, { actor: 'test', scopes: ['demo.read'], signal: controller.signal });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.data, { value: 'completed' });
});

await check('the visible-UI adapter and neutral gateway execute the same registered handler', async () => {
  const calls = [];
  let seq = 0;
  const registry = createCapabilityRegistry({
    correlationIdFactory: () => `chat-${String(++seq).padStart(8, '0')}`,
    searchKnowledge: (args) => { calls.push(args); return [{ id: 1, kind: 'item', type: 'note', title: 'Result', body: 'Body', source: 'fixture' }]; }
  });
  const ui = await registry.invoke('knowledge.search', { query: 'shared' });
  const gateway = await registry.execute('knowledge.search', { query: 'shared' }, { caller: 'test' });
  assert.equal(ui.status, 'success');
  assert.equal(gateway.status, 'success');
  assert.deepEqual(ui.data, gateway.data);
  assert.deepEqual(calls, [ui.args, gateway.args]);
});

await check('Knowledge preview uses the same registered read handler through compatibility and neutral adapters', async () => {
  const calls = [];
  let seq = 0;
  const registry = createCapabilityRegistry({
    correlationIdFactory: () => `read-${String(++seq).padStart(8, '0')}`,
    readKnowledge: (args) => {
      calls.push(args);
      return { id: args.id, kind: args.kind, type: 'note', title: 'Shared preview', body: 'Bounded body', source: 'fixture', evidence: 'same handler', status: 'active' };
    }
  });
  const ui = await registry.invoke('knowledge.read', { id: 7, kind: 'item' });
  const gateway = await registry.execute('knowledge.read', { id: 7, kind: 'item' }, { caller: 'test' });
  assert.equal(ui.status, 'success');
  assert.equal(gateway.status, 'success');
  assert.deepEqual(ui.data, gateway.data);
  assert.deepEqual(calls, [ui.args, gateway.args]);
});

await check('caller policies are separate and body-like scope injection is ignored', async () => {
  const registry = createCapabilityRegistry({ searchKnowledge: () => [] });
  assert.ok(CAPABILITY_CALLER_SCOPES['human-ui'].includes('knowledge.read'));
  assert.ok(CAPABILITY_CALLER_SCOPES['human-ui'].includes('workboard.propose'));
  assert.ok(CAPABILITY_CALLER_SCOPES['legacy-human-ui'].includes('workboard.propose'));
  assert.ok(CAPABILITY_CALLER_SCOPES['local-agent'].includes('knowledge.read'));
  assert.equal(CAPABILITY_CALLER_SCOPES['local-agent'].includes('workboard.propose'), false);
  assert.deepEqual(CAPABILITY_CALLER_SCOPES['cloud-agent'], []);
  const omitted = await registry.execute('knowledge.search', { query: 'x' });
  const denied = await registry.execute('knowledge.search', { query: 'x' }, { caller: 'cloud-agent', scopes: ['knowledge.read', '*'] });
  const humanProposal = await registry.execute('workboard.propose_create', { title: 'review me' }, { caller: 'human-ui' });
  const localProposal = await registry.execute('workboard.propose_create', { title: 'do not run' }, { caller: 'local-agent' });
  const cloudProposal = await registry.execute('workboard.propose_create', { title: 'do not run' }, { caller: 'cloud-agent', scopes: ['workboard.propose', '*'] });
  assert.equal(omitted.status, 'blocked');
  assert.equal(omitted.error.code, 'UNAUTHORIZED');
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.error.code, 'UNAUTHORIZED');
  assert.equal(humanProposal.status, 'needs_confirmation');
  assert.equal(localProposal.status, 'blocked');
  assert.equal(localProposal.error.code, 'UNAUTHORIZED');
  assert.equal(cloudProposal.status, 'blocked');
  assert.equal(cloudProposal.error.code, 'UNAUTHORIZED');
});

console.log(failures ? `\n${failures} action-registry check(s) FAILED` : '\nAll universal action-registry checks passed.');
process.exit(failures ? 1 : 0);
