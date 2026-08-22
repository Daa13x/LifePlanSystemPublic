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
  systemStatus: async () => {
    calls.push(['systemStatus']);
    return {
      health: { db: 'ready', storageFile: oversizedWorkboardText }, sqlite: { ready: true },
      model: { assigned: true, name: oversizedWorkboardText, available: true, file_error: oversizedWorkboardText },
      runtime: { managedServerRunning: true, managedServerReady: true, endpoint: oversizedWorkboardText, endpointConfigured: true, llamaServerAvailable: true, llamaCliAvailable: false, lastResult: { output: oversizedWorkboardText } },
      workboard: { focus: 2, blockers: 1, waiting: 3, automatic: 4, stale: 5, approvals: 6, candidates: 7, injected: oversizedWorkboardText },
      browserConnector: { connected: true, secret: oversizedWorkboardText },
      repository: { available: true, branch: oversizedWorkboardText, hasChanges: false, hasConflicts: false, ahead: 1, behind: 2, note: oversizedWorkboardText, remote: oversizedWorkboardText }
    };
  },
  listModels: async () => {
    calls.push(['listModels']);
    return Array.from({ length: 30 }, (_, index) => ({ id: index + 1, name: oversizedWorkboardText, assigned_role: oversizedWorkboardText, available: index % 2 === 0, size_gb: 1.25, file_error: oversizedWorkboardText }));
  },
  listRuns: (a) => {
    calls.push(['listRuns', a]);
    return Array.from({ length: 30 }, (_, index) => ({ id: oversizedWorkboardText, title: oversizedWorkboardText, status: oversizedWorkboardText, created_at: oversizedWorkboardText, ignored: oversizedWorkboardText, index }));
  },
  searchConversations: (a) => {
    calls.push(['searchConversations', a]);
    return Array.from({ length: 20 }, () => ({ session_id: 1, session_title: oversizedWorkboardText, role: 'user', content: oversizedWorkboardText, created_at: oversizedWorkboardText, ignored: oversizedWorkboardText }));
  },
  plannerToday: () => {
    calls.push(['plannerToday']);
    const tasks = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, title: oversizedWorkboardText, status: 'active', activeStep: oversizedWorkboardText, deadline: oversizedWorkboardText, blocker: index === 0 ? oversizedWorkboardText : '', pinned: index === 0, reasons: Array(20).fill(oversizedWorkboardText) }));
    return { mode: 'normal', visibleLimit: 7, pinnedCount: 1, visible: tasks, deferred: tasks };
  },
  navigate: async (a) => {
    calls.push(['navigate', a]);
    return { requested: true, status: 'APPLIED', failureCategory: null, route: `#${a.destination}` };
  },
  readPlannerTask: ({ id }) => {
    calls.push(['readPlannerTask', id]);
    return id === 5 ? { id: 5, title: 'Existing task', why: '', next_action: 'do it', importance: 3, effort: 2, estimated_minutes: null, deadline: null, status: 'active', updated_at: '2026-08-19T00:00:00.000Z' } : null;
  }
};

const reg = createCapabilityRegistry(deps);

check('registry exposes exactly the documented capabilities', () => {
  assert.deepEqual(reg.list().map((c) => c.name).sort(), [...CAPABILITY_NAMES].sort());
});
check('read capabilities are read-only; propose_* are writes', () => {
  const byName = Object.fromEntries(reg.list().map((c) => [c.name, c.readOnly]));
  for (const n of ['knowledge.search', 'knowledge.read', 'workboard.list', 'workboard.read', 'system.status', 'system.models', 'system.runs', 'conversation.search', 'planner.today']) assert.equal(byName[n], true, `${n} must be read-only`);
  assert.equal(byName['workboard.propose_create'], false);
  assert.equal(byName['workboard.propose_update'], false);
  assert.equal(byName['planner.propose_create'], false);
  assert.equal(byName['planner.propose_update'], false);
  assert.equal(byName['navigation.workboard'], false);
  assert.equal(byName['navigation.system'], false);
  assert.equal(byName['navigation.settings'], false);
  assert.equal(byName['navigation.planner'], false);
});

await checkAsync('fixed navigation actions use the shared trusted renderer dependency and report only acknowledged success', async () => {
  calls.length = 0;
  const renderer = { rendererId: 'renderer-fixture', token: 'secret-fixture' };
  const workboard = await reg.invoke('navigation.workboard', {}, { renderer });
  const system = await reg.invoke('navigation.system', {}, { renderer });
  const settings = await reg.invoke('navigation.settings', {}, { renderer });
  const planner = await reg.invoke('navigation.planner', {}, { renderer });
  assert.equal(workboard.data.destination, 'workboard');
  assert.equal(system.data.destination, 'system');
  assert.equal(settings.data.destination, 'settings');
  assert.equal(planner.data.destination, 'planner');
  assert.equal(workboard.data.applied, true);
  assert.equal(system.data.applied, true);
  assert.equal(settings.data.applied, true);
  assert.equal(planner.data.applied, true);
  assert.deepEqual(calls.map((entry) => [entry[0], entry[1].renderer, entry[1].destination]), [
    ['navigate', renderer, 'workboard'],
    ['navigate', renderer, 'system'],
    ['navigate', renderer, 'settings'],
    ['navigate', renderer, 'planner']
  ]);
});

await checkAsync('planner.propose_create returns a bounded proposal only and never calls a data dependency', async () => {
  calls.length = 0;
  const r = await reg.invoke('planner.propose_create', { title: 'Write the acceptance tests', why: 'coverage', next_action: 'draft', importance: 4, effort: 2, estimated_minutes: 45, deadline: '2026-12-01' });
  assert.equal(r.status, 'needs_confirmation');
  assert.equal(r.data.operation, 'planner.create');
  assert.equal(r.data.confirmation_required, true);
  assert.equal(r.data.preview.title, 'Write the acceptance tests');
  assert.equal(r.data.preview.importance, 4);
  assert.equal(r.data.preview.estimated_minutes, 45);
  assert.equal(r.data.preview.deadline, '2026-12-01');
  assert.equal(calls.length, 0, 'proposing a planner task calls no data/task dependency');
});

await checkAsync('planner.propose_create rejects a malformed deadline before proposing', async () => {
  await assert.rejects(reg.invoke('planner.propose_create', { title: 'bad date', deadline: '2026-13-40' }));
});

await checkAsync('planner.propose_update returns a bounded before/after proposal with a stale-state token; no mutation', async () => {
  calls.length = 0;
  const r = await reg.invoke('planner.propose_update', { id: 5, changes: { title: 'Renamed task', status: 'completed', importance: 3, effort: 2, next_action: 'do it', deadline: '' } });
  assert.equal(r.status, 'needs_confirmation');
  assert.equal(r.data.operation, 'planner.update');
  assert.deepEqual(r.data.target, { type: 'planner_task', id: 5 });
  assert.match(r.data.state_token, /^[a-f0-9]{64}$/);
  // Only genuinely changed fields appear in the diff (title + status; importance/effort/next_action/deadline were already current).
  assert.deepEqual(Object.keys(r.data.after).sort(), ['status', 'title']);
  assert.equal(r.data.before.title, 'Existing task');
  assert.equal(r.data.after.title, 'Renamed task');
  assert.equal(r.data.after.status, 'completed');
  assert.deepEqual(calls, [['readPlannerTask', 5]], 'the proposal only reads the task; it never writes');
});

await checkAsync('planner.propose_update stages a status-only lifecycle change without mutation', async () => {
  calls.length = 0;
  const r = await reg.invoke('planner.propose_update', { id: 5, changes: { status: 'completed' } });
  assert.equal(r.status, 'needs_confirmation');
  assert.deepEqual(r.data.before, { status: 'active' });
  assert.deepEqual(r.data.after, { status: 'completed' });
  assert.deepEqual(calls, [['readPlannerTask', 5]], 'the status proposal only reads the task');
});

await checkAsync('planner.propose_update fails closed for a missing task, a forbidden field, and a no-op change', async () => {
  await assert.rejects(reg.invoke('planner.propose_update', { id: 999, changes: { title: 'x' } }));
  await assert.rejects(reg.invoke('planner.propose_update', { id: 5, changes: { pinned: true } }));
  await assert.rejects(reg.invoke('planner.propose_update', { id: 5, changes: { title: 'Existing task' } }));
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
  assert.ok(r.data.models.every((model) => model.name.length <= reg.LIMITS.titleMaxLength && model.assigned_role.length <= reg.LIMITS.metadataMaxLength && model.file_error.length <= reg.LIMITS.provenanceEvidenceMaxLength));
  assert.ok(JSON.stringify(r.data).length < 7000, 'complete models receipt stays bounded');
});
await checkAsync('conversation.search bounded', async () => {
  const r = await reg.invoke('conversation.search', { query: 'a', limit: 3 });
  assert.equal(r.data.matches.length, 3);
  for (const match of r.data.matches) {
    assert.deepEqual(Object.keys(match).sort(), ['created_at', 'role', 'session_id', 'session_title', 'snippet']);
    assert.ok(match.session_title.length <= reg.LIMITS.titleMaxLength);
    assert.ok(match.snippet.length <= 200);
    assert.ok(match.created_at.length <= reg.LIMITS.metadataMaxLength);
    assert.match(match.snippet, /\[truncated \d+ chars\]$/);
  }
  assert.ok(JSON.stringify(r.data).length < 3000, 'complete conversation-search receipt stays bounded');
});
await checkAsync('planner.today reuses a strictly bounded canonical day result', async () => {
  const r = await reg.invoke('planner.today', {});
  assert.equal(r.data.visible.length, 7);
  assert.equal(r.data.deferred.length, 5);
  assert.equal(r.data.truncated, true);
  assert.deepEqual(Object.keys(r.data.visible[0]).sort(), ['active_step', 'blocked', 'deadline', 'id', 'pinned', 'reasons', 'status', 'title']);
  assert.ok(r.data.visible[0].title.length <= reg.LIMITS.titleMaxLength);
  assert.ok(r.data.visible[0].active_step.length <= 400);
  assert.ok(r.data.visible[0].reasons.length <= 5 && r.data.visible[0].reasons.every((reason) => reason.length <= 160));
  assert.ok(JSON.stringify(r.data).length < 20000);
});

await throwsAsync(() => reg.invoke('knowledge.search', {}), /required/, 'missing required argument is rejected');
await throwsAsync(() => reg.invoke('knowledge.read', { id: 1, kind: 'item', extra: 'x' }), /unexpected/, 'unexpected argument is rejected');
await throwsAsync(() => reg.invoke('knowledge.read', { id: 999, kind: 'item' }), /Action failed safely\. Reference/, 'missing Knowledge record fails without exposing handler internals');
await throwsAsync(() => reg.invoke('workboard.read', { type: 'item', id: 0 }), /positive record id/, 'non-positive id is rejected');
await throwsAsync(() => reg.invoke('workboard.read', { id: 1 }), /missing required argument "type"/, 'missing Workboard entity type is rejected');
await throwsAsync(() => reg.invoke('workboard.read', { type: 'lane', id: 1 }), /must be one of/, 'unknown Workboard entity type is rejected');
await throwsAsync(() => reg.invoke('workboard.read', { type: 'item', id: 999 }), /Action failed safely\. Reference/, 'correct type with unknown id fails safely');
await throwsAsync(() => reg.invoke('knowledge.search', { query: 'x', scope: 'bogus' }), /must be one of/, 'invalid enum is rejected');
await throwsAsync(() => reg.invoke('conversation.search', { query: '   ' }), /missing required argument "query"/, 'blank conversation search is rejected before the handler runs');
await throwsAsync(() => createCapabilityRegistry({ searchConversations: () => [{ session_id: '1', content: 'coerced identity' }] }).invoke('conversation.search', { query: 'x' }), /Action failed safely\. Reference/, 'conversation search rejects malformed dependency identities');
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
await checkAsync('system.runs returns bounded strict run summaries', async () => {
  const r = await reg.invoke('system.runs', { limit: 5 });
  assert.equal(r.data.runs.length, 5);
  for (const run of r.data.runs) {
    assert.deepEqual(Object.keys(run).sort(), ['created_at', 'id', 'status', 'title']);
    assert.ok(run.id.length <= reg.LIMITS.metadataMaxLength);
    assert.ok(run.title.length <= reg.LIMITS.titleMaxLength);
    assert.ok(run.status.length <= reg.LIMITS.metadataMaxLength);
    assert.ok(run.created_at.length <= reg.LIMITS.metadataMaxLength);
  }
  assert.ok(JSON.stringify(r.data).length < 6000, 'complete runs receipt stays bounded');
});
await checkAsync('system.status returns one strict bounded receipt from the authoritative dependency', async () => {
  calls.length = 0;
  const r = await reg.invoke('system.status', {});
  assert.deepEqual(Object.keys(r.data).sort(), ['browserConnector', 'health', 'model', 'repository', 'runtime', 'sqlite', 'workboard']);
  assert.deepEqual(Object.keys(r.data.runtime).sort(), ['endpoint', 'endpointConfigured', 'llamaCliAvailable', 'llamaServerAvailable', 'managedServerReady', 'managedServerRunning']);
  assert.deepEqual(Object.keys(r.data.repository).sort(), ['ahead', 'available', 'behind', 'branch', 'hasChanges', 'hasConflicts', 'note']);
  assert.equal(r.data.sqlite.ready, true);
  assert.equal(r.data.browserConnector.connected, true);
  for (const value of [r.data.health.storageFile, r.data.model.name, r.data.model.file_error, r.data.runtime.endpoint, r.data.repository.branch, r.data.repository.note]) assert.match(value, /\[truncated \d+ chars\]$/);
  assert.ok(JSON.stringify(r.data).length < 3000, 'complete status receipt stays bounded');
  assert.deepEqual(calls, [['systemStatus']]);
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
