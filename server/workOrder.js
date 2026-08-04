// Canonical layered work-order assembler for the Workboard.
//
// A Workboard card is a layered VIEW of one canonical work item (a project row)
// and the records that reference it — never a second, display-only copy of its
// state. This module is PURE (no DB/IO) so the exact structure the UI renders is
// unit-testable, and every layer is built from canonical inputs the caller reads
// from the database.
//
// Principles enforced here:
//   * No fabricated state: a field is populated only when a canonical record
//     supplies it; otherwise it is null and the layer reports populated:false.
//     A truthful "nothing recorded yet" is required over an invented value.
//   * Append-only history: the History layer is the project_events stream in
//     order; it is never synthesised from the current row.
//   * Pinned identity: title, status, owner, and any critical blocker are the
//     same canonical values on every layer.

export const WORK_ORDER_LAYERS = ['glance', 'context', 'execution', 'proof', 'history'];

const DONE_STATUSES = new Set(['done', 'completed', 'archived']);
const BLOCKED_STATUSES = new Set(['blocked', 'waiting']);

function clean(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || null;
}

// Progress is only claimed when there are linked items to measure; with none we
// report null rather than a misleading 0%.
function computeProgress(items) {
  if (!items.length) return null;
  const done = items.filter((item) => DONE_STATUSES.has(String(item.status || '').toLowerCase())).length;
  return { done, total: items.length, ratio: Math.round((done / items.length) * 100) / 100 };
}

function criticalBlocker(project, items) {
  if (clean(project.blocker)) return clean(project.blocker);
  const blocked = items.find((item) => BLOCKED_STATUSES.has(String(item.status || '').toLowerCase()) || String(item.type || '').toLowerCase() === 'blocker');
  return blocked ? (clean(blocked.next_action) || clean(blocked.title)) : null;
}

// Build the layered work order for one project. Inputs are canonical rows:
//   project — the projects row;
//   events  — the append-only project_events rows (any order; sorted here);
//   items   — knowledge_items linked by project_id.
export function buildWorkOrder(project, { events = [], items = [] } = {}) {
  if (!project || project.id === undefined || project.id === null) return null;
  const linked = Array.isArray(items) ? items : [];
  const history = (Array.isArray(events) ? [...events] : []).sort((a, b) => {
    const byTime = String(a.created_at || '').localeCompare(String(b.created_at || ''));
    return byTime !== 0 ? byTime : Number(a.id || 0) - Number(b.id || 0);
  });

  const blocker = criticalBlocker(project, linked);
  const pinned = {
    id: project.id,
    title: clean(project.name),
    status: clean(project.status) || 'active',
    owner: clean(project.owner) || 'user',
    blocker
  };

  const progress = computeProgress(linked);
  const glance = {
    title: pinned.title, status: pinned.status, owner: pinned.owner,
    // `projects` has no priority column; confidence is the only canonical
    // ranking signal, surfaced as-is rather than invented as a priority.
    priority: null, confidence: typeof project.confidence === 'number' ? project.confidence : null,
    progress
  };
  glance.populated = Boolean(glance.title);

  const subtasks = linked.map((item) => ({ id: item.id, title: clean(item.title), status: clean(item.status), type: clean(item.type) }));
  const evidenceEvents = history.filter((event) => clean(event.evidence) || /evidence|verif|build|test|runtime|browser/i.test(String(event.event_type || '')));

  const context = {
    recap: clean(project.next_action),
    latestEvidence: clean(project.evidence),
    sourceSummary: clean(project.source),
    lastReviewed: clean(project.last_reviewed),
    linkedItemCount: subtasks.length
  };
  context.populated = Boolean(context.recap || context.latestEvidence || context.sourceSummary);

  const execution = {
    activeAction: clean(project.next_action),
    nextStep: clean(project.next_action),
    blocker,
    subtasks
  };
  execution.populated = Boolean(execution.activeAction || execution.blocker || subtasks.length);

  const proof = {
    // No structured per-project build/test/runtime/browser evidence exists in
    // the canonical schema yet, so these stay null until recorded as events.
    build: null, test: null, runtime: null, browser: null,
    verifications: evidenceEvents.map((event) => ({ at: clean(event.created_at), actor: clean(event.actor), kind: clean(event.event_type), detail: clean(event.evidence) || clean(event.detail) }))
  };
  proof.populated = proof.verifications.length > 0;

  const historyLayer = {
    events: history.map((event) => ({
      id: event.id, at: clean(event.created_at), actor: clean(event.actor),
      type: clean(event.event_type), fromStatus: clean(event.from_status), toStatus: clean(event.to_status),
      detail: clean(event.detail), evidence: clean(event.evidence)
    }))
  };
  historyLayer.populated = historyLayer.events.length > 0;

  const layerObjects = { glance, context, execution, proof, history: historyLayer };
  return {
    id: project.id,
    pinned,
    layers: WORK_ORDER_LAYERS,
    glance, context, execution, proof, history: historyLayer,
    // Which layers currently have canonical data — the UI still offers all five,
    // but can honestly mark the empty ones "nothing recorded yet".
    populatedLayers: WORK_ORDER_LAYERS.filter((name) => layerObjects[name].populated)
  };
}
