#!/usr/bin/env node
// Verify the canonical layered work-order assembler using the REAL
// server/workOrder.js module. Local-only: no network, server, or DB.
// Exit 0 = pass.

import { WORK_ORDER_LAYERS, buildWorkOrder } from '../server/workOrder.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- work-order assembler verification ---');

line(WORK_ORDER_LAYERS.join(',') === 'glance,context,execution,proof,history', 'the five canonical layers are defined in order');
line(buildWorkOrder(null) === null && buildWorkOrder({}) === null, 'a missing/idless project yields no work order');

// A bare project with no linked records: every layer exists, pinned identity is
// present, and the empty layers report themselves as empty (never fabricated).
{
  const wo = buildWorkOrder({ id: 7, name: 'Move house', status: 'active', owner: 'user', source: 'manual', confidence: 0.8 });
  line(wo.id === 7 && wo.pinned.title === 'Move house' && wo.pinned.status === 'active' && wo.pinned.owner === 'user', 'pinned identity comes straight from the canonical row');
  line(WORK_ORDER_LAYERS.every((name) => wo[name] && typeof wo[name].populated === 'boolean'), 'all five layers are present with an honest populated flag');
  line(wo.glance.progress === null, 'progress is null when there are no linked items to measure (no invented 0%)');
  line(wo.proof.build === null && wo.proof.verifications.length === 0 && wo.proof.populated === false, 'the proof layer is empty and says so when no evidence is recorded');
  line(wo.history.events.length === 0 && wo.history.populated === false, 'history is empty for a project with no events');
  line(!wo.populatedLayers.includes('proof') && !wo.populatedLayers.includes('history'), 'populatedLayers honestly omits the empty layers');
}

// Linked knowledge items drive progress, subtasks, and a surfaced blocker.
{
  const items = [
    { id: 1, title: 'Book removals', type: 'task', status: 'done' },
    { id: 2, title: 'Pack kitchen', type: 'task', status: 'active' },
    { id: 3, title: 'Deposit stuck', type: 'blocker', status: 'blocked', next_action: 'Chase the letting agent' }
  ];
  const wo = buildWorkOrder({ id: 7, name: 'Move house', status: 'active', owner: 'user' }, { items });
  line(wo.glance.progress && wo.glance.progress.done === 1 && wo.glance.progress.total === 3, 'progress is computed from linked item completion');
  line(wo.execution.subtasks.length === 3, 'execution lists linked items as subtasks');
  line(wo.pinned.blocker === 'Chase the letting agent' && wo.execution.blocker === 'Chase the letting agent', 'a blocked linked item surfaces as the pinned blocker on every layer');
  line(wo.execution.populated === true, 'the execution layer is populated when there are subtasks');
}

// The history layer is the append-only event stream, in order, never synthesised.
{
  const events = [
    { id: 2, event_type: 'status_changed', from_status: 'active', to_status: 'blocked', actor: 'user', detail: 'hit a snag', created_at: '2026-08-02T10:00:00Z' },
    { id: 1, event_type: 'created', to_status: 'active', actor: 'user', detail: 'Card created', created_at: '2026-08-01T09:00:00Z' },
    { id: 3, event_type: 'verification', evidence: 'npm run check passed', actor: 'user', created_at: '2026-08-03T11:00:00Z' }
  ];
  const wo = buildWorkOrder({ id: 7, name: 'Move house', status: 'blocked', owner: 'user' }, { events });
  line(wo.history.events.map((e) => e.id).join(',') === '1,2,3', 'history events are ordered by time then id (append-only stream)');
  line(wo.history.events[1].fromStatus === 'active' && wo.history.events[1].toStatus === 'blocked', 'a state transition preserves from/to status and the responsible actor');
  line(wo.proof.populated === true && wo.proof.verifications.some((v) => /check passed/.test(v.detail || '')), 'evidence events populate the proof layer verifications');
  line(wo.populatedLayers.includes('history') && wo.populatedLayers.includes('proof'), 'populatedLayers reports the layers that now have canonical data');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll work-order checks passed.');
process.exit(failures ? 1 : 0);
