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
const longKnowledgeBody = `preview marker ${'x'.repeat(1400)}`;
const oversizedKnowledgeText = 'oversized'.repeat(31250);
const oversizedWorkboardText = 'workboard-oversized'.repeat(20000);
const deps = {
  searchKnowledge: (a) => { calls.push(['searchKnowledge', a]); return rows(40); },
  readKnowledge: (a) => {
    calls.push(['readKnowledge', a]);
    if (a.id === 1) return { id: 1, kind: 'item', type: 'note', title: 'Preview item', body: longKnowledgeBody, source: 'manual', evidence: 'fixture evidence', status: 'active', confidence: 0.4 };
    if (a.id === 2) return { id: 2, kind: 'candidate', type: 'preference', title: 'Preview candidate', body: 'candidate body', source: 'chat', evidence: 'candidate fixture', status: 'candidate', confidence: 0.5 };
    if (a.id === 3) return { id: 3, kind: 'item', type: oversizedKnowledgeText, title: oversizedKnowledgeText, body: oversizedKnowledgeText, source: oversizedKnowledgeText, evidence: oversizedKnowledgeText, status: oversizedKnowledgeText, updated_at: oversizedKnowledgeText, confidence: 0.6 };
    return null;
  },
  listWorkboard: async (a) => {
    calls.push(['listWorkboard', a]);
    return { summary: { projects: 40 }, records: rows(40, { type: 'goal', category: 'goal', entity_type: 'item' }) };
  },
  readWorkboard: async (a) => {
    calls.push(['readWorkboard', a]);
    if (a.id !== 1 && a.id !== 3) return null;
    if (a.id === 3 && a.type === 'project') return {
      id: 3, entity_type: 'project', name: oversizedWorkboardText, status: oversizedWorkboardText,
      evidence: oversizedWorkboardText, source: oversizedWorkboardText, next_action: oversizedWorkboardText,
      children: Array.from({ length: 40 }, (_, index) => ({ id: index + 1, entity_type: 'item', type: oversizedWorkboardText, title: oversizedWorkboardText, status: oversizedWorkboardText, next_action: oversizedWorkboardText }))
    };
    if (a.type === 'project') return { id: 1, entity_type: 'project', name: 'proj', status: 'active', next_action: 'next', children: [{ id: 2, entity_type: 'item', type: 'note', title: 'child', status: 'active' }] };
    if (a.type === 'item') return { id: 1, entity_type: 'item', type: 'note', title: 'it', status: 'active', next_action: 'n', body: 'b', confidence: 0.5 };
    if (a.type === 'roadmap') return { id: 1, entity_type: 'roadmap', category: 'feature', title: 'road', status: 'planned', detail: 'road detail' };
    if (a.type === 'approval') return { id: 1, entity_type: 'approval', category: 'update_project', title: 'approve', status: 'pending', detail: 'payload excluded' };
    if (a.type === 'candidate') return { id: 1, entity_type: 'candidate', category: 'note', title: 'candidate', status: 'candidate', detail: 'candidate detail' };
    return null;
  },
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
await checkAsync('knowledge.read returns a bounded item preview with provenance through the declared dependency', async () => {
  calls.length = 0;
  const r = await reg.invoke('knowledge.read', { id: 1, kind: 'item' });
  assert.equal(r.data.title, 'Preview item');
  assert.equal(r.data.kind, 'item');
  assert.ok(r.data.body.startsWith('preview marker '));
  assert.match(r.data.body, /\[truncated \d+ chars\]$/);
  assert.ok(r.data.body.length <= reg.LIMITS.bodyMaxLength);
  assert.deepEqual(r.data.provenance, { id: 1, kind: 'item', source: 'manual', evidence: 'fixture evidence', confidence: 0.4, status: 'active', updated_at: null });
  assert.deepEqual(calls, [['readKnowledge', { id: 1, kind: 'item' }]]);
});
await checkAsync('knowledge.read preserves candidate identity and provenance', async () => {
  calls.length = 0;
  const r = await reg.invoke('knowledge.read', { id: 2, kind: 'candidate' });
  assert.equal(r.data.title, 'Preview candidate');
  assert.equal(r.data.kind, 'candidate');
  assert.equal(r.data.body, 'candidate body');
  assert.equal(r.data.provenance.status, 'candidate');
  assert.deepEqual(calls, [['readKnowledge', { id: 2, kind: 'candidate' }]]);
});
await checkAsync('knowledge.read strictly bounds every caller-controlled text field', async () => {
  const r = await reg.invoke('knowledge.read', { id: 3, kind: 'item' });
  assert.ok(r.data.title.length <= reg.LIMITS.titleMaxLength);
  assert.ok(r.data.type.length <= reg.LIMITS.metadataMaxLength);
  assert.ok(r.data.body.length <= reg.LIMITS.bodyMaxLength);
  assert.ok(r.data.provenance.source.length <= reg.LIMITS.provenanceSourceMaxLength);
  assert.ok(r.data.provenance.evidence.length <= reg.LIMITS.provenanceEvidenceMaxLength);
  assert.ok(r.data.provenance.status.length <= reg.LIMITS.metadataMaxLength);
  assert.ok(r.data.provenance.updated_at.length <= reg.LIMITS.metadataMaxLength);
  for (const value of [r.data.title, r.data.type, r.data.body, r.data.provenance.source, r.data.provenance.evidence, r.data.provenance.status, r.data.provenance.updated_at]) assert.match(value, /\[truncated \d+ chars\]$/);
  assert.ok(JSON.stringify(r.data).length < 3000, 'the complete structured preview remains small');
});
await checkAsync('workboard.list returns explicit typed identities instead of view-guessed IDs', async () => {
  const r = await reg.invoke('workboard.list', { view: 'overview', limit: 3 });
  assert.equal(r.data.records.length, 3);
  assert.deepEqual(r.data.records[0].identity, { type: 'item', id: 1 });
  assert.equal('id' in r.data.records[0], false);
  assert.equal('record_kind' in r.data.records[0], false);
});
await checkAsync('workboard.read supports each exact entity class through one typed contract', async () => {
  for (const type of ['project', 'item', 'roadmap', 'approval', 'candidate']) {
    calls.length = 0;
    const r = await reg.invoke('workboard.read', { type, id: 1 });
    assert.deepEqual(r.data.identity, { type, id: 1 });
    assert.deepEqual(calls, [['readWorkboard', { type, id: 1 }]]);
  }
});
await checkAsync('workboard.read bounds nested children and every caller-controlled string', async () => {
  const r = await reg.invoke('workboard.read', { type: 'project', id: 3 });
  assert.equal(r.data.children.length, reg.LIMITS.workboardChildrenMax);
  assert.equal(r.data.truncated, true);
  assert.ok(r.data.title.length <= reg.LIMITS.titleMaxLength);
  assert.ok(r.data.status.length <= reg.LIMITS.metadataMaxLength);
  assert.ok(r.data.next_action.length <= 400);
  assert.ok(r.data.provenance.source.length <= reg.LIMITS.provenanceSourceMaxLength);
  assert.ok(r.data.provenance.evidence.length <= reg.LIMITS.provenanceEvidenceMaxLength);
  for (const child of r.data.children) {
    assert.ok(child.title.length <= reg.LIMITS.titleMaxLength);
    assert.ok(child.category.length <= reg.LIMITS.metadataMaxLength);
    assert.ok(child.status.length <= reg.LIMITS.metadataMaxLength);
    assert.ok(child.next_action.length <= 400);
  }
  assert.ok(JSON.stringify(r.data).length < 15000, 'the complete nested Workboard preview remains bounded');
});
await throwsAsync(
  () => createCapabilityRegistry({ readWorkboard: () => ({ id: '1', entity_type: 'item', title: 'coerced identity' }) }).invoke('workboard.read', { type: 'item', id: 1 }),
  /Action failed safely\. Reference/,
  'malformed dependency identity is not coerced into a valid Workboard target'
);
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
await throwsAsync(() => reg.invoke('knowledge.read', { id: 999, kind: 'item' }), /Action failed safely\. Reference/, 'missing Knowledge record fails without exposing handler internals');
await throwsAsync(() => reg.invoke('workboard.read', { type: 'item', id: 0 }), /positive record id/, 'non-positive id is rejected');
await throwsAsync(() => reg.invoke('workboard.read', { id: 1 }), /missing required argument "type"/, 'missing Workboard entity type is rejected');
await throwsAsync(() => reg.invoke('workboard.read', { type: 'lane', id: 1 }), /must be one of/, 'unknown Workboard entity type is rejected');
await throwsAsync(() => reg.invoke('workboard.read', { type: 'item', id: 999 }), /Action failed safely\. Reference/, 'correct type with unknown id fails safely');
await throwsAsync(() => reg.invoke('knowledge.search', { query: 'x', scope: 'bogus' }), /must be one of/, 'invalid enum is rejected');
await throwsAsync(() => reg.invoke('nope.capability', {}), /Unknown capability/, 'unknown capability is rejected');

await checkAsync('workboard.propose_create returns a confirmation-required proposal and performs no write', async () => {
  calls.length = 0;
  const body = 'x'.repeat(1000);
  const r = await reg.invoke('workboard.propose_create', { title: 'Task', type: 'note', body });
  assert.equal(r.readOnly, false);
  assert.equal(r.data.proposal, true);
  assert.equal(r.data.confirmation_required, true);
  assert.equal(r.data.operation, 'workboard.create');
  assert.equal(r.data.preview.body, body, 'the immutable write payload is not silently truncated');
  assert.deepEqual(calls, [], 'propose_create must call no dependency (no read/write side effects)');
});
await checkAsync('workboard.propose_update returns before/after and performs no write', async () => {
  calls.length = 0;
  const r = await reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: { status: 'done', title: ' Updated title ', next_action: null, confidence: 0.9, due_at: '2026-08-31' } });
  assert.equal(r.data.proposal, true);
  assert.equal(r.data.confirmation_required, true);
  assert.equal(r.data.operation, 'workboard.update');
  assert.deepEqual(r.data.target, { type: 'item', id: 1 });
  assert.match(r.data.state_token, /^[a-f0-9]{64}$/);
  assert.deepEqual(r.data.after, { status: 'done', title: 'Updated title', next_action: null, confidence: 0.9, due_at: '2026-08-31' });
  assert.deepEqual(r.data.before, { status: 'active', title: 'it', next_action: 'n', confidence: 0.5, due_at: null });
  // Only readWorkboard (a read) may be called to build the diff — never a write.
  assert.deepEqual(calls.map((c) => c[0]), ['readWorkboard'], 'propose_update may only read, never write');
});
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: { owner: 'app' } }), /Action failed safely\. Reference/, 'propose_update rejects disallowed fields without exposing handler internals');
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: {} }), /Action failed safely\. Reference/, 'propose_update rejects empty changes without exposing handler internals');
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'project', id: 1, changes: { status: 'done' } }), /must be one of/, 'propose_update rejects non-item target identities');
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: { status: 'active' } }), /Action failed safely\. Reference/, 'propose_update rejects no-op changes');
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: { status: 'invented' } }), /Action failed safely\. Reference/, 'propose_update rejects unknown statuses');
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: { title: 'x'.repeat(161) } }), /Action failed safely\. Reference/, 'propose_update rejects overlong titles');
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: { body: 'x'.repeat(2001) } }), /Action failed safely\. Reference/, 'propose_update rejects overlong detail');
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: { next_action: 'x'.repeat(401) } }), /Action failed safely\. Reference/, 'propose_update rejects overlong next actions');
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: { confidence: '0.5' } }), /Action failed safely\. Reference/, 'propose_update rejects confidence coercion');
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: { confidence: -0.1 } }), /Action failed safely\. Reference/, 'propose_update rejects confidence outside the canonical range');
await throwsAsync(() => reg.invoke('workboard.propose_update', { type: 'item', id: 1, changes: { due_at: '2026-02-31' } }), /Action failed safely\. Reference/, 'propose_update rejects impossible calendar dates');

// Structural safety: the capability module must not contain SQL, shell, or fs access.
await checkAsync('capability module contains no SQL / shell / filesystem access', async () => {
  const src = await readFile(new URL('../server/chatCapabilities.js', import.meta.url), 'utf8');
  const forbidden = [/child_process/, /\bexec(File|Sync)?\s*\(/, /\bspawn\s*\(/, /require\(/, /\bfs\./, /db\.prepare/, /\bINSERT\s+INTO\b/i, /\bDELETE\s+FROM\b/i, /\bDROP\s+/i, /\bUPDATE\s+\w+\s+SET\b/i];
  for (const re of forbidden) assert.ok(!re.test(src), `capability module must not contain ${re}`);
});

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nALL PASS - Chat capability layer is validated, bounded, read-only-by-default, confirmation-gated, and structurally safe.');
