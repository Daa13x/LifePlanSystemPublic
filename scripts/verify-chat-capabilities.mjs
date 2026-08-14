// Verifies the Chat control-surface capability layer: strict input validation,
// bounded results, read-only-by-default, confirmation-required writes (no
// mutation on propose_*), provenance in returned context, and structural safety
// (the capability module contains no SQL, shell, or filesystem access).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCapabilityRegistry, CAPABILITY_NAMES } from '../server/chatCapabilities.js';

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`ok    ${label}`); }
  catch (error) { failures++; console.log(`FAIL  ${label}\n        ${error.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log(`ok    ${label}`); }
  catch (error) { failures++; console.log(`FAIL  ${label}\n        ${error.message}`); }
}
async function throwsAsync(fn, re, label) {
  await checkAsync(label, async () => {
    let threw = false;
    try { await fn(); } catch (e) { threw = true; if (re) assert.match(e.message, re); }
    assert.equal(threw, true, 'expected the call to throw');
  });
}

// Dependency spy — records every dep call so we can prove propose_* performs no writes.
const calls = [];
const rows = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 'item', type: 'note', title: `t${i + 1}`, body: 'body text', source: 'src', evidence: 'ev', confidence: 0.5, status: 'active', ...extra }));
const deps = {
  searchKnowledge: (a) => { calls.push(['searchKnowledge', a]); return rows(40); },
  readKnowledge: (a) => { calls.push(['readKnowledge', a]); return a.id === 1 ? { id: 1, kind: a.kind, type: 'note', title: 'x', body: 'y', source: 's', status: 'active', confidence: 0.4 } : null; },
  listWorkboard: async (a) => { calls.push(['listWorkboard', a]); return { summary: { projects: 40 }, records: rows(40, { type: 'project' }) }; },
  readWorkboard: async (a) => { calls.push(['readWorkboard', a]); return a.id === 1 ? (a.kind === 'item' ? { kind: 'item', id: 1, title: 'it', status: 'active', next_action: 'n', body: 'b', confidence: 0.5 } : { kind: 'project', project: { id: 1, name: 'proj' }, items: [] }) : null; },
  systemStatus: async () => { calls.push(['systemStatus']); return { health: { db: 'ready' }, model: { assigned: true } }; },
  listModels: async () => { calls.push(['listModels']); return rows(30); },
  listRuns: (a) => { calls.push(['listRuns', a]); return rows(30); },
  searchConversations: (a) => { calls.push(['searchConversations', a]); return Array.from({ length: 20 }, () => ({ session_id: 1, role: 'user', content: 'msg', created_at: 't' })); }
};

const reg = createCapabilityRegistry(deps);

check('registry exposes exactly the documented capabilities', () => {
  assert.deepEqual(reg.list().map((c) => c.name).sort(), [...CAPABILITY_NAMES].sort());
});
check('read capabilities are read-only; propose_* are writes', () => {
  const byName = Object.fromEntries(reg.list().map((c) => [c.name, c.readOnly]));
  for (const n of ['knowledge.search', 'knowledge.read', 'workboard.list', 'workboard.read', 'system.status', 'system.models', 'system.runs', 'conversation.search']) assert.equal(byName[n], true, `${n} must be read-only`);
  assert.equal(byName['workboard.propose_create'], false);
  assert.equal(byName['workboard.propose_update'], false);
});

await checkAsync('knowledge.search returns bounded results with provenance', async () => {
  const r = await reg.invoke('knowledge.search', { query: 'x' });
  assert.ok(r.data.items.length <= 8, 'default limit is 8');
  assert.ok(r.data.items[0].provenance && 'id' in r.data.items[0].provenance, 'provenance included');
});
await checkAsync('knowledge.search clamps oversized limit to the max', async () => {
  const r = await reg.invoke('knowledge.search', { query: 'x', limit: 9999 });
  assert.ok(r.data.items.length <= 25, 'max limit is 25');
});
await checkAsync('system.models bounded', async () => {
  const r = await reg.invoke('system.models', { limit: 5 });
  assert.ok(r.data.models.length <= 5);
});
await checkAsync('conversation.search bounded', async () => {
  const r = await reg.invoke('conversation.search', { query: 'a', limit: 3 });
  assert.ok(r.data.matches.length <= 3);
});

await throwsAsync(() => reg.invoke('knowledge.search', {}), /required/, 'missing required argument is rejected');
await throwsAsync(() => reg.invoke('knowledge.read', { id: 1, kind: 'item', extra: 'x' }), /unexpected/, 'unexpected argument is rejected');
await throwsAsync(() => reg.invoke('workboard.read', { id: 0 }), /positive record id/, 'non-positive id is rejected');
await throwsAsync(() => reg.invoke('knowledge.search', { query: 'x', scope: 'bogus' }), /must be one of/, 'invalid enum is rejected');
await throwsAsync(() => reg.invoke('nope.capability', {}), /Unknown capability/, 'unknown capability is rejected');

await checkAsync('workboard.propose_create returns a confirmation-required proposal and performs no write', async () => {
  calls.length = 0;
  const r = await reg.invoke('workboard.propose_create', { title: 'Task', type: 'note' });
  assert.equal(r.readOnly, false);
  assert.equal(r.data.proposal, true);
  assert.equal(r.data.confirmation_required, true);
  assert.equal(r.data.operation, 'workboard.create');
  assert.deepEqual(calls, [], 'propose_create must call no dependency (no read/write side effects)');
});
await checkAsync('workboard.propose_update returns before/after and performs no write', async () => {
  calls.length = 0;
  const r = await reg.invoke('workboard.propose_update', { id: 1, changes: { status: 'done' } });
  assert.equal(r.data.proposal, true);
  assert.equal(r.data.confirmation_required, true);
  assert.deepEqual(r.data.after, { status: 'done' });
  assert.ok('before' in r.data);
  // Only readWorkboard (a read) may be called to build the diff — never a write.
  assert.deepEqual(calls.map((c) => c[0]), ['readWorkboard'], 'propose_update may only read, never write');
});
await throwsAsync(() => reg.invoke('workboard.propose_update', { id: 1, changes: { owner: 'app' } }), /Action failed safely\. Reference/, 'propose_update rejects disallowed fields without exposing handler internals');
await throwsAsync(() => reg.invoke('workboard.propose_update', { id: 1, changes: {} }), /Action failed safely\. Reference/, 'propose_update rejects empty changes without exposing handler internals');

// Structural safety: the capability module must not contain SQL, shell, or fs access.
await checkAsync('capability module contains no SQL / shell / filesystem access', async () => {
  const src = await readFile(new URL('../server/chatCapabilities.js', import.meta.url), 'utf8');
  const forbidden = [/child_process/, /\bexec(File|Sync)?\s*\(/, /\bspawn\s*\(/, /require\(/, /\bfs\./, /db\.prepare/, /\bINSERT\s+INTO\b/i, /\bDELETE\s+FROM\b/i, /\bDROP\s+/i, /\bUPDATE\s+\w+\s+SET\b/i];
  for (const re of forbidden) assert.ok(!re.test(src), `capability module must not contain ${re}`);
});

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nALL PASS - Chat capability layer is validated, bounded, read-only-by-default, confirmation-gated, and structurally safe.');
