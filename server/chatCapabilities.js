import crypto from 'node:crypto';
import {
  ACTION_CONFIRMATIONS,
  ACTION_RISKS,
  createActionRegistry,
  validateActionArgs
} from './actionRegistry.js';

// Bounded, schema-validated capability layer for the central Chat control
// surface. This module is intentionally PURE and dependency-injected: it never
// touches SQLite, the filesystem, a shell, or the network directly. All data
// access happens through the injected `deps` functions, which wrap the existing
// authoritative repositories/APIs. This keeps the capability layer testable and
// makes it structurally impossible for a capability to run arbitrary SQL, shell
// commands, or filesystem/network access.
//
// Read capabilities run immediately. Write capabilities (propose_*) NEVER
// mutate anything — they only return a structured, human-reviewable proposal.
// The actual write happens elsewhere, after explicit user confirmation, through
// the authoritative Workboard API.

const LIMITS = Object.freeze({
  queryMaxLength: 200,
  bodyMaxLength: 1200,
  titleMaxLength: 240,
  provenanceSourceMaxLength: 240,
  provenanceEvidenceMaxLength: 480,
  metadataMaxLength: 80,
  workboardChildrenMax: 12,
  minLimit: 1,
  maxLimit: 25,
  defaultLimit: 8
});

function asString(value) {
  return value === undefined || value === null ? '' : String(value);
}

function truncate(text, max = LIMITS.bodyMaxLength) {
  const s = asString(text);
  if (s.length <= max) return s;
  let keep = max;
  let suffix = '';
  for (let i = 0; i < 3; i += 1) {
    suffix = `… [truncated ${s.length - keep} chars]`;
    keep = Math.max(0, max - suffix.length);
  }
  return `${s.slice(0, keep)}${suffix}`;
}

function provenanceFor(record) {
  return {
    id: record.id,
    kind: truncate(record.kind || record.record_kind || 'record', LIMITS.metadataMaxLength),
    source: truncate(record.source || 'not recorded', LIMITS.provenanceSourceMaxLength),
    evidence: truncate(record.evidence || 'not recorded', LIMITS.provenanceEvidenceMaxLength),
    confidence: record.confidence === undefined || record.confidence === null ? null : Number(record.confidence),
    status: record.status ? truncate(record.status, LIMITS.metadataMaxLength) : null,
    updated_at: record.updated_at || record.created_at ? truncate(record.updated_at || record.created_at, LIMITS.metadataMaxLength) : null
  };
}

// Fields that must never appear in tool arguments/results returned to the model.
const KNOWLEDGE_SCOPES = ['all', 'approved', 'candidates', 'rules'];
const WORKBOARD_VIEWS = ['overview', 'projects', 'roadmap', 'review', 'completed', 'blocked'];
export const WORKBOARD_ENTITY_TYPES = Object.freeze(['project', 'item', 'roadmap', 'approval', 'candidate']);
export const WORKBOARD_ITEM_STATUSES = Object.freeze(['active', 'stable', 'blocked', 'stale', 'pending review', 'done', 'archived', 'deprecated', 'superseded']);

export function canonicalWorkboardItemState(record) {
  if (!record || record.entity_type !== 'item' || !Number.isInteger(record.id) || record.id <= 0) {
    throw new Error('A canonical Workboard item is required.');
  }
  return {
    identity: { type: 'item', id: record.id },
    type: asString(record.type),
    title: asString(record.title),
    body: asString(record.body),
    source: asString(record.source),
    status: asString(record.status),
    confidence: Number.isFinite(record.confidence) ? Number(record.confidence) : null,
    last_reviewed: record.last_reviewed == null ? null : asString(record.last_reviewed),
    evidence: record.evidence == null ? null : asString(record.evidence),
    owner: asString(record.owner),
    next_action: record.next_action == null ? null : asString(record.next_action),
    project_id: Number.isInteger(record.project_id) && record.project_id > 0 ? record.project_id : null,
    due_at: record.due_at == null ? null : asString(record.due_at),
    shareability: asString(record.shareability),
    updated_at: asString(record.updated_at)
  };
}

export function workboardItemStateToken(record) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalWorkboardItemState(record))).digest('hex');
}

export function normalizeWorkboardItemChanges(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workboard item changes must be a plain object.');
  const allowed = new Set(['status', 'title', 'body', 'next_action', 'confidence', 'due_at']);
  const changes = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`workboard.propose_update: field "${key}" cannot be changed from Chat.`);
    if (key === 'status') {
      if (typeof raw !== 'string' || !WORKBOARD_ITEM_STATUSES.includes(raw)) throw new Error('Workboard item status is invalid.');
      changes.status = raw;
    } else if (key === 'title') {
      if (typeof raw !== 'string') throw new Error('Workboard item title must be a string.');
      const title = raw.trim();
      if (!title || title.length > 160) throw new Error('Workboard item title must be 1-160 characters.');
      changes.title = title;
    } else if (key === 'body') {
      if (typeof raw !== 'string' || raw.length > 2000) throw new Error('Workboard item detail must be a string of at most 2000 characters.');
      changes.body = raw;
    } else if (key === 'next_action') {
      if (raw !== null && typeof raw !== 'string') throw new Error('Workboard item next action must be a string or null.');
      const nextAction = raw === null ? null : raw.trim() || null;
      if (nextAction && nextAction.length > 400) throw new Error('Workboard item next action must be at most 400 characters.');
      changes.next_action = nextAction;
    } else if (key === 'confidence') {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) throw new Error('Workboard item confidence must be a number from 0 to 1.');
      changes.confidence = raw;
    } else if (key === 'due_at') {
      if (raw !== null && typeof raw !== 'string') throw new Error('Workboard item due date must be YYYY-MM-DD or null.');
      const dueAt = raw === null || raw.trim() === '' ? null : raw.trim();
      if (dueAt && (
        !/^\d{4}-\d{2}-\d{2}$/.test(dueAt)
        || Number.isNaN(Date.parse(`${dueAt}T00:00:00.000Z`))
        || new Date(`${dueAt}T00:00:00.000Z`).toISOString().slice(0, 10) !== dueAt
      )) throw new Error('Workboard item due date must be a real YYYY-MM-DD date or null.');
      changes.due_at = dueAt;
    }
  }
  if (!Object.keys(changes).length) throw new Error('workboard.propose_update: no permitted changes were supplied.');
  return changes;
}

function boundedUpdatePreviewValue(key, value) {
  if (typeof value !== 'string') return value;
  if (key === 'body') return truncate(value, LIMITS.bodyMaxLength);
  if (key === 'title') return truncate(value, LIMITS.titleMaxLength);
  if (key === 'next_action') return truncate(value, 400);
  return truncate(value, LIMITS.metadataMaxLength);
}

function boundedSystemStatusResult(value) {
  const status = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const count = (input) => Number.isSafeInteger(input) && input >= 0 ? input : 0;
  const nullableCount = (input) => Number.isSafeInteger(input) && input >= 0 ? input : null;
  const nullableText = (input, max = LIMITS.metadataMaxLength) => input == null || input === '' ? null : truncate(input, max);
  const workboard = status.workboard && typeof status.workboard === 'object'
    ? {
        focus: count(status.workboard.focus), blockers: count(status.workboard.blockers), waiting: count(status.workboard.waiting),
        automatic: count(status.workboard.automatic), stale: count(status.workboard.stale), approvals: count(status.workboard.approvals),
        candidates: count(status.workboard.candidates)
      }
    : null;
  return {
    health: {
      db: status.health?.db === 'ready' ? 'ready' : 'unavailable',
      storageFile: nullableText(status.health?.storageFile)
    },
    sqlite: { ready: Boolean(status.sqlite?.ready) },
    model: {
      assigned: Boolean(status.model?.assigned),
      name: nullableText(status.model?.name, LIMITS.titleMaxLength),
      available: typeof status.model?.available === 'boolean' ? status.model.available : null,
      file_error: nullableText(status.model?.file_error, LIMITS.provenanceEvidenceMaxLength)
    },
    runtime: {
      managedServerRunning: Boolean(status.runtime?.managedServerRunning),
      managedServerReady: Boolean(status.runtime?.managedServerReady),
      endpoint: nullableText(status.runtime?.endpoint, LIMITS.provenanceSourceMaxLength),
      endpointConfigured: Boolean(status.runtime?.endpointConfigured),
      llamaServerAvailable: Boolean(status.runtime?.llamaServerAvailable),
      llamaCliAvailable: Boolean(status.runtime?.llamaCliAvailable)
    },
    workboard,
    browserConnector: { connected: Boolean(status.browserConnector?.connected) },
    repository: {
      available: Boolean(status.repository?.available),
      branch: nullableText(status.repository?.branch),
      hasChanges: Boolean(status.repository?.hasChanges),
      hasConflicts: Boolean(status.repository?.hasConflicts),
      ahead: nullableCount(status.repository?.ahead),
      behind: nullableCount(status.repository?.behind),
      note: nullableText(status.repository?.note, LIMITS.provenanceEvidenceMaxLength)
    }
  };
}

function boundedModelResult(model) {
  return {
    id: Number.isSafeInteger(model?.id) && model.id > 0 ? model.id : truncate(model?.id || 'unknown', LIMITS.metadataMaxLength),
    name: truncate(model?.name || 'Unnamed model', LIMITS.titleMaxLength),
    assigned_role: model?.assigned_role ? truncate(model.assigned_role, LIMITS.metadataMaxLength) : null,
    available: Boolean(model?.available),
    size_gb: Number.isFinite(model?.size_gb) && model.size_gb >= 0 ? Number(model.size_gb) : null,
    file_error: model?.file_error ? truncate(model.file_error, LIMITS.provenanceEvidenceMaxLength) : null
  };
}

function boundedRunResult(run) {
  return {
    id: truncate(run?.id || 'unknown', LIMITS.metadataMaxLength),
    title: truncate(run?.title || 'run', LIMITS.titleMaxLength),
    status: truncate(run?.status || 'unknown', LIMITS.metadataMaxLength),
    created_at: run?.created_at ? truncate(run.created_at, LIMITS.metadataMaxLength) : null
  };
}

function boundedConversationMatch(record) {
  if (!Number.isSafeInteger(record?.session_id) || record.session_id <= 0) throw new Error('Conversation search returned an invalid session identity.');
  return {
    session_id: record.session_id,
    session_title: truncate(record.session_title || `Chat ${record.session_id}`, LIMITS.titleMaxLength),
    role: ['user', 'assistant', 'system'].includes(record.role) ? record.role : 'unknown',
    snippet: truncate(record.content || '', 200),
    created_at: record.created_at ? truncate(record.created_at, LIMITS.metadataMaxLength) : null
  };
}

function boundedPlannerTask(task) {
  if (!Number.isSafeInteger(task?.id) || task.id <= 0) throw new Error('Planner dependency returned an invalid task identity.');
  return {
    id: task.id,
    title: truncate(task.title || 'Untitled task', LIMITS.titleMaxLength),
    status: truncate(task.status || 'active', LIMITS.metadataMaxLength),
    active_step: task.activeStep ? truncate(task.activeStep, 400) : null,
    deadline: task.deadline ? truncate(task.deadline, LIMITS.metadataMaxLength) : null,
    blocked: Boolean(task.blocker),
    pinned: Boolean(task.pinned),
    reasons: (Array.isArray(task.reasons) ? task.reasons : []).slice(0, 5).map((reason) => truncate(reason, 160))
  };
}

function boundedPlannerToday(value) {
  const day = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const visible = (Array.isArray(day.visible) ? day.visible : []).slice(0, 7).map(boundedPlannerTask);
  const deferred = (Array.isArray(day.deferred) ? day.deferred : []).slice(0, 5).map(boundedPlannerTask);
  return {
    mode: truncate(day.mode || 'normal', LIMITS.metadataMaxLength),
    visible_limit: Number.isSafeInteger(day.visibleLimit) && day.visibleLimit >= 0 ? Math.min(day.visibleLimit, 7) : visible.length,
    pinned_count: Number.isSafeInteger(day.pinnedCount) && day.pinnedCount >= 0 ? Math.min(day.pinnedCount, 999) : 0,
    visible,
    deferred,
    truncated: (Array.isArray(day.visible) && day.visible.length > visible.length) || (Array.isArray(day.deferred) && day.deferred.length > deferred.length)
  };
}

function workboardIdentity(record) {
  const type = asString(record?.entity_type);
  const id = record?.id;
  if (!WORKBOARD_ENTITY_TYPES.includes(type) || !Number.isInteger(id) || id <= 0) {
    throw new Error('Workboard dependency returned an invalid typed identity.');
  }
  return { type, id };
}

function boundedWorkboardSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const bounded = {};
  for (const [key, value] of Object.entries(summary).slice(0, 12)) {
    if (/^[a-z][a-z0-9_]{0,39}$/.test(key) && Number.isFinite(value)) bounded[key] = Number(value);
  }
  return bounded;
}

function boundedWorkboardListRecord(record) {
  return {
    identity: workboardIdentity(record),
    category: truncate(record.category || record.type || record.entity_type, LIMITS.metadataMaxLength),
    title: truncate(record.title || record.name || `${record.entity_type} ${record.id}`, LIMITS.titleMaxLength),
    status: record.status ? truncate(record.status, LIMITS.metadataMaxLength) : null,
    detail: truncate(record.detail || record.body || record.next_action || '', 240),
    provenance: provenanceFor(record)
  };
}

function boundedWorkboardReadResult(record) {
  const identity = workboardIdentity(record);
  const children = Array.isArray(record.children)
    ? record.children.slice(0, LIMITS.workboardChildrenMax).map((child) => ({
      identity: workboardIdentity(child),
      category: truncate(child.category || child.type || child.entity_type, LIMITS.metadataMaxLength),
      title: truncate(child.title || child.name || `${child.entity_type} ${child.id}`, LIMITS.titleMaxLength),
      status: child.status ? truncate(child.status, LIMITS.metadataMaxLength) : null,
      next_action: child.next_action ? truncate(child.next_action, 400) : null
    }))
    : [];
  const project = record.project && typeof record.project === 'object'
    ? {
      identity: workboardIdentity(record.project),
      title: truncate(record.project.title || record.project.name || `project ${record.project.id}`, LIMITS.titleMaxLength)
    }
    : null;
  return {
    identity,
    category: truncate(record.category || record.type || identity.type, LIMITS.metadataMaxLength),
    title: truncate(record.title || record.name || `${identity.type} ${identity.id}`, LIMITS.titleMaxLength),
    status: record.status ? truncate(record.status, LIMITS.metadataMaxLength) : null,
    detail: truncate(record.detail || record.body || '', LIMITS.bodyMaxLength),
    next_action: record.next_action ? truncate(record.next_action, 400) : null,
    confidence: Number.isFinite(record.confidence) ? Number(record.confidence) : null,
    due_at: record.due_at ? truncate(record.due_at, LIMITS.metadataMaxLength) : null,
    owner: record.owner ? truncate(record.owner, LIMITS.metadataMaxLength) : null,
    project,
    children,
    provenance: provenanceFor(record),
    truncated: Boolean(record.children?.length > children.length)
  };
}

const ALWAYS_AVAILABLE = Object.freeze({
  description: 'The local application runtime and its authoritative repositories are ready.',
  check: () => ({ available: true, reason: null })
});

const resultObject = (required, properties = {}, additionalProperties = false) => ({ type: 'object', required, properties, additionalProperties });

const ACTION_METADATA = Object.freeze({
  'knowledge.search': {
    label: 'Search Knowledge', feature: 'Chat context picker', permission: 'knowledge.read', risk: ACTION_RISKS.READ_ONLY,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: ['chat.context-toolbar.open-knowledge', 'chat.context-picker.knowledge-query', 'chat.context-picker.knowledge-scope'],
    testId: 'action.knowledge.search', resultSchema: resultObject(['items', 'count', 'truncated', 'scope'], { items: { type: 'array' }, count: { type: 'integer' }, truncated: { type: 'boolean' }, scope: { type: 'string' } })
  },
  'knowledge.read': {
    label: 'Preview Knowledge record', feature: 'Chat context picker', permission: 'knowledge.read', risk: ACTION_RISKS.READ_ONLY,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: ['chat.context-picker.knowledge-preview'], testId: 'action.knowledge.read',
    resultSchema: resultObject(['id', 'kind', 'title', 'body', 'provenance'], { id: { type: 'integer' }, kind: { type: 'string' }, type: { type: ['string', 'null'] }, title: { type: 'string' }, body: { type: 'string' }, provenance: { type: 'object' } })
  },
  'workboard.list': {
    label: 'List Workboard records', feature: 'Chat context picker', permission: 'workboard.read', risk: ACTION_RISKS.READ_ONLY,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: ['chat.context-toolbar.open-workboard', 'chat.context-picker.workboard-view'], testId: 'action.workboard.list',
    resultSchema: resultObject(['view', 'records', 'count', 'truncated'], { view: { type: 'string' }, summary: { type: ['object', 'null'] }, records: { type: 'array' }, count: { type: 'integer' }, truncated: { type: 'boolean' } })
  },
  'workboard.read': {
    label: 'Preview Workboard record', feature: 'Chat context picker', permission: 'workboard.detail.read', risk: ACTION_RISKS.SENSITIVE_DATA,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: ['chat.context-picker.workboard-preview'], testId: 'action.workboard.read',
    resultSchema: resultObject(
      ['identity', 'category', 'title', 'status', 'detail', 'next_action', 'owner', 'project', 'children', 'provenance', 'truncated'],
      { identity: { type: 'object' }, category: { type: 'string' }, title: { type: 'string' }, status: { type: ['string', 'null'] }, detail: { type: 'string' }, next_action: { type: ['string', 'null'] }, confidence: { type: ['number', 'null'] }, due_at: { type: ['string', 'null'] }, owner: { type: ['string', 'null'] }, project: { type: ['object', 'null'] }, children: { type: 'array' }, provenance: { type: 'object' }, truncated: { type: 'boolean' } }
    )
  },
  'workboard.propose_create': {
    label: 'Preview new Workboard item', feature: 'Chat task proposal', permission: 'workboard.propose', risk: ACTION_RISKS.REVERSIBLE_WRITE,
    confirmation: ACTION_CONFIRMATIONS.USER, sideEffects: ['Persists a time-limited review proposal; no Workboard item is changed until the user confirms it.'],
    sourceControls: ['chat.workboard-proposal.open', 'chat.workboard-proposal.preview', 'chat.workboard-proposal.confirm'], testId: 'action.workboard.propose_create',
    resultSchema: resultObject(['proposal', 'operation', 'affects', 'preview', 'confirmation_required'], { proposal: { type: 'boolean' }, operation: { type: 'string' }, affects: { type: 'string' }, preview: { type: 'object' }, confirmation_required: { type: 'boolean' } })
  },
  'workboard.propose_update': {
    label: 'Preview Workboard update', feature: 'Chat task proposal', permission: 'workboard.propose', risk: ACTION_RISKS.REVERSIBLE_WRITE,
    confirmation: ACTION_CONFIRMATIONS.USER, sideEffects: ['Reads the current item and produces a review-only proposal; no Workboard data is changed.'],
    sourceControls: ['chat.context-picker.workboard-update', 'chat.workboard-update.confirm'], testId: 'action.workboard.propose_update',
    resultSchema: resultObject(['proposal', 'operation', 'affects', 'target', 'state_token', 'before', 'after', 'confirmation_required'], { proposal: { type: 'boolean' }, operation: { type: 'string' }, affects: { type: 'string' }, target: { type: 'object' }, state_token: { type: 'string' }, before: { type: 'object' }, after: { type: 'object' }, confirmation_required: { type: 'boolean' } })
  },
  'system.status': {
    label: 'Read system status', feature: 'System', permission: 'system.read', risk: ACTION_RISKS.READ_ONLY,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: ['chat.connection.system-status-check'], testId: 'action.system.status',
    resultSchema: resultObject(
      ['health', 'sqlite', 'model', 'runtime', 'workboard', 'browserConnector', 'repository'],
      { health: { type: 'object' }, sqlite: { type: 'object' }, model: { type: 'object' }, runtime: { type: 'object' }, workboard: { type: ['object', 'null'] }, browserConnector: { type: 'object' }, repository: { type: 'object' } }
    )
  },
  'system.models': {
    label: 'List local models', feature: 'System models', permission: 'models.read', risk: ACTION_RISKS.READ_ONLY,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: ['chat.connection.system-models-check'], testId: 'action.system.models',
    resultSchema: resultObject(['models', 'count', 'truncated'], { models: { type: 'array' }, count: { type: 'integer' }, truncated: { type: 'boolean' } })
  },
  'system.runs': {
    label: 'List local runs', feature: 'System runs', permission: 'system.read', risk: ACTION_RISKS.READ_ONLY,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: ['chat.connection.system-runs-check'], testId: 'action.system.runs',
    resultSchema: resultObject(['runs', 'count', 'truncated'], { runs: { type: 'array' }, count: { type: 'integer' }, truncated: { type: 'boolean' } })
  },
  'conversation.search': {
    label: 'Search conversations', feature: 'Chat history', permission: 'chat.history.read', risk: ACTION_RISKS.SENSITIVE_DATA,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: ['chat.history-search.submit'], testId: 'action.conversation.search',
    resultSchema: resultObject(['matches', 'count', 'truncated'], { matches: { type: 'array' }, count: { type: 'integer' }, truncated: { type: 'boolean' } })
  },
  'planner.today': {
    label: 'Read today plan', feature: 'Daily Planner', permission: 'planner.today.read', risk: ACTION_RISKS.SENSITIVE_DATA,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: ['chat.connection.planner-today-check'], testId: 'action.planner.today',
    resultSchema: resultObject(['mode', 'visible_limit', 'pinned_count', 'visible', 'deferred', 'truncated'], { mode: { type: 'string' }, visible_limit: { type: 'integer' }, pinned_count: { type: 'integer' }, visible: { type: 'array' }, deferred: { type: 'array' }, truncated: { type: 'boolean' } })
  },
  'navigation.workboard': {
    label: 'Open the Workboard', feature: 'Chat navigation', permission: 'navigation.control', risk: ACTION_RISKS.VIEW_NAVIGATION,
    confirmation: ACTION_CONFIRMATIONS.NONE,
    sideEffects: ['Changes the active view of the requesting window to the Workboard section; no stored data is modified and it is immediately reversible.'],
    sourceControls: ['chat.navigation.open-workboard'], testId: 'action.navigation.workboard',
    resultSchema: resultObject(
      ['destination', 'requested', 'applied', 'status'],
      { destination: { type: 'string' }, requested: { type: 'boolean' }, applied: { type: 'boolean' }, status: { type: 'string' }, route: { type: ['string', 'null'] }, failure_category: { type: ['string', 'null'] } }
    )
  },
  'navigation.system': {
    label: 'Open System', feature: 'Chat navigation', permission: 'navigation.control', risk: ACTION_RISKS.VIEW_NAVIGATION,
    confirmation: ACTION_CONFIRMATIONS.NONE,
    sideEffects: ['Changes the active view of the requesting window to the System section; no stored data is modified and it is immediately reversible.'],
    sourceControls: ['chat.navigation.open-system'], testId: 'action.navigation.system',
    resultSchema: resultObject(
      ['destination', 'requested', 'applied', 'status'],
      { destination: { type: 'string' }, requested: { type: 'boolean' }, applied: { type: 'boolean' }, status: { type: 'string' }, route: { type: ['string', 'null'] }, failure_category: { type: ['string', 'null'] } }
    )
  }
});

const ALL_CAPABILITY_SCOPES = Object.freeze([...new Set(Object.values(ACTION_METADATA).map((item) => item.permission))]);
const READ_ONLY_CAPABILITY_SCOPES = Object.freeze([...new Set(Object.values(ACTION_METADATA)
  .filter((item) => item.risk === ACTION_RISKS.READ_ONLY)
  .map((item) => item.permission))]);
export const NEUTRAL_ACTION_NAMES = Object.freeze(['knowledge.search', 'knowledge.read', 'workboard.list', 'workboard.read', 'workboard.propose_create', 'workboard.propose_update', 'system.status', 'system.models', 'system.runs', 'conversation.search', 'planner.today', 'navigation.workboard', 'navigation.system']);
const NEUTRAL_ACTION_SET = new Set(NEUTRAL_ACTION_NAMES);
const NEUTRAL_ACTION_SCOPES = Object.freeze([...new Set(NEUTRAL_ACTION_NAMES.map((name) => ACTION_METADATA[name].permission))]);

// Caller names are selected only by trusted application code. HTTP request
// bodies are never allowed to supply or extend these scopes.
export const CAPABILITY_CALLER_SCOPES = Object.freeze({
  'human-ui': NEUTRAL_ACTION_SCOPES,
  'legacy-human-ui': ALL_CAPABILITY_SCOPES,
  'local-agent': READ_ONLY_CAPABILITY_SCOPES,
  'cloud-agent': Object.freeze([]),
  test: ALL_CAPABILITY_SCOPES
});

function trustedContext(caller, signal) {
  const actor = Object.hasOwn(CAPABILITY_CALLER_SCOPES, caller) ? caller : 'unknown';
  return { actor, scopes: [...(CAPABILITY_CALLER_SCOPES[actor] || [])], signal };
}

export function createCapabilityRegistry(deps) {
  const dep = (fn) => {
    if (typeof deps[fn] !== 'function') throw new Error(`Capability dependency "${fn}" is not available.`);
    return deps[fn];
  };

  const capabilities = {
    'knowledge.search': {
      description: 'Search approved memory, candidates, and rules by text. Read-only.',
      readOnly: true,
      schema: {
        query: { type: 'string', required: true, maxLength: LIMITS.queryMaxLength },
        scope: { type: 'string', default: 'all', enum: KNOWLEDGE_SCOPES },
        limit: { type: 'integer', default: LIMITS.defaultLimit, min: LIMITS.minLimit, max: LIMITS.maxLimit }
      },
      async handler(args) {
        const rows = await dep('searchKnowledge')({ query: args.query, scope: args.scope, limit: args.limit });
        const items = rows.slice(0, args.limit).map((r) => ({
          id: r.id,
          kind: r.kind,
          type: r.type ? truncate(r.type, LIMITS.metadataMaxLength) : null,
          title: truncate(r.title, LIMITS.titleMaxLength),
          snippet: truncate(r.body, 240),
          provenance: provenanceFor(r)
        }));
        return { items, count: items.length, truncated: rows.length > items.length, scope: args.scope };
      }
    },

    'knowledge.read': {
      description: 'Read one Knowledge record (approved memory, candidate, or rule) with full provenance. Read-only.',
      readOnly: true,
      schema: {
        id: { type: 'id', required: true },
        kind: { type: 'string', default: 'item', enum: ['item', 'candidate'] }
      },
      async handler(args) {
        const record = await dep('readKnowledge')({ id: args.id, kind: args.kind });
        if (!record) throw new Error(`Knowledge record ${args.kind}:${args.id} was not found.`);
        return {
          id: record.id,
          kind: record.kind || args.kind,
          type: record.type ? truncate(record.type, LIMITS.metadataMaxLength) : null,
          title: truncate(record.title, LIMITS.titleMaxLength),
          body: truncate(record.body),
          provenance: provenanceFor(record)
        };
      }
    },

    'workboard.list': {
      description: 'List authoritative Workboard data (projects, roadmap, review, completed, blocked, or overview). Read-only.',
      readOnly: true,
      schema: {
        view: { type: 'string', default: 'overview', enum: WORKBOARD_VIEWS },
        limit: { type: 'integer', default: LIMITS.defaultLimit, min: LIMITS.minLimit, max: LIMITS.maxLimit }
      },
      async handler(args) {
        const data = await dep('listWorkboard')({ view: args.view, limit: args.limit });
        const records = (data.records || []).slice(0, args.limit).map(boundedWorkboardListRecord);
        return { view: args.view, summary: boundedWorkboardSummary(data.summary), records, count: records.length, truncated: (data.records || []).length > records.length };
      }
    },

    'workboard.read': {
      description: 'Read one precisely typed Workboard entity with bounded detail and relationships. Read-only.',
      readOnly: true,
      schema: {
        type: { type: 'string', required: true, enum: WORKBOARD_ENTITY_TYPES },
        id: { type: 'id', required: true },
      },
      async handler(args) {
        const record = await dep('readWorkboard')({ id: args.id, type: args.type });
        if (!record) throw new Error(`Workboard ${args.type} ${args.id} was not found.`);
        const result = boundedWorkboardReadResult(record);
        if (result.identity.type !== args.type || result.identity.id !== args.id) throw new Error('Workboard dependency returned a different identity.');
        return result;
      }
    },

    'workboard.propose_create': {
      description: 'Propose creating a new Workboard item. Returns a proposal for confirmation; never writes.',
      readOnly: false,
      schema: {
        type: { type: 'string', default: 'note', enum: ['goal', 'project', 'decision', 'reminder', 'blocker', 'waiting', 'rule', 'note'] },
        title: { type: 'string', required: true, maxLength: 160 },
        body: { type: 'string', default: '', maxLength: 2000 },
        next_action: { type: 'string', default: '', maxLength: 400 }
      },
      async handler(args) {
        // No mutation here — only a structured proposal for explicit confirmation.
        return {
          proposal: true,
          operation: 'workboard.create',
          affects: 'new Workboard item',
          preview: { type: args.type, title: args.title, body: args.body, next_action: args.next_action },
          confirmation_required: true
        };
      }
    },

    'workboard.propose_update': {
      description: 'Propose updating an existing Workboard item. Returns a before/after proposal for confirmation; never writes.',
      readOnly: false,
      schema: {
        type: { type: 'string', required: true, enum: ['item'] },
        id: { type: 'id', required: true },
        changes: { type: 'object', required: true }
      },
      async handler(args) {
        const current = await dep('readWorkboard')({ id: args.id, type: args.type });
        if (!current) throw new Error(`Workboard item ${args.id} was not found.`);
        const state = canonicalWorkboardItemState(current);
        const changes = normalizeWorkboardItemChanges(args.changes);
        const before = {};
        const after = {};
        for (const [key, value] of Object.entries(changes)) {
          const currentValue = state[key] ?? null;
          if (Object.is(currentValue, value)) continue;
          before[key] = boundedUpdatePreviewValue(key, currentValue);
          after[key] = value;
        }
        if (!Object.keys(after).length) throw new Error('workboard.propose_update: the requested changes are already present.');
        return {
          proposal: true,
          operation: 'workboard.update',
          affects: `Workboard item ${args.id} (${truncate(current.title, LIMITS.titleMaxLength)})`,
          target: { type: 'item', id: args.id },
          state_token: workboardItemStateToken(current),
          before,
          after,
          confirmation_required: true
        };
      }
    },

    'system.status': {
      description: 'Report bounded authoritative application/runtime status (health, SQLite, model, runtime, Workboard counts, repository, and browser connector). Read-only.',
      readOnly: true,
      schema: {},
      async handler() {
        return boundedSystemStatusResult(await dep('systemStatus')());
      }
    },

    'system.models': {
      description: 'List the local model registry and the assigned Planner Assistant. Read-only.',
      readOnly: true,
      schema: { limit: { type: 'integer', default: LIMITS.maxLimit, min: LIMITS.minLimit, max: LIMITS.maxLimit } },
      async handler(args) {
        const models = await dep('listModels')();
        return { models: models.slice(0, args.limit).map(boundedModelResult), count: Math.min(models.length, args.limit), truncated: models.length > args.limit };
      }
    },

    'system.runs': {
      description: 'List recent local execution/coding runs from the authoritative System sources. Read-only.',
      readOnly: true,
      schema: { limit: { type: 'integer', default: LIMITS.defaultLimit, min: LIMITS.minLimit, max: LIMITS.maxLimit } },
      async handler(args) {
        const runs = await dep('listRuns')({ limit: args.limit });
        return { runs: runs.slice(0, args.limit).map(boundedRunResult), count: Math.min(runs.length, args.limit), truncated: runs.length > args.limit };
      }
    },

    'conversation.search': {
      description: 'Search the local chat history for messages matching text. Read-only.',
      readOnly: true,
      schema: {
        query: { type: 'string', required: true, maxLength: LIMITS.queryMaxLength },
        limit: { type: 'integer', default: LIMITS.defaultLimit, min: LIMITS.minLimit, max: LIMITS.maxLimit }
      },
      async handler(args) {
        const query = args.query.trim();
        if (!query) throw new Error('Conversation search query must not be blank.');
        const rows = await dep('searchConversations')({ query, limit: args.limit });
        return {
          matches: rows.slice(0, args.limit).map(boundedConversationMatch),
          count: Math.min(rows.length, args.limit),
          truncated: rows.length > args.limit
        };
      }
    },

    'planner.today': {
      description: 'Read the current capacity-aware Daily Planner ordering and explanations. Read-only.',
      readOnly: true,
      schema: {},
      async handler() {
        return boundedPlannerToday(await dep('plannerToday')());
      }
    },

    'navigation.workboard': {
      description: 'Open the Workboard section in the requesting window. A bounded, reversible view navigation to a fixed semantic destination; it changes no stored data.',
      readOnly: false,
      navigation: true,
      schema: {},
      async handler(_args, context) {
        // The renderer binding and the navigation transport are supplied by trusted
        // server code, never by the model/client arguments. This handler only names
        // a fixed semantic destination and reports the correlated resolution.
        const outcome = await dep('navigate')({ renderer: context.renderer, destination: 'workboard', correlationId: context.correlationId });
        return {
          destination: 'workboard',
          requested: Boolean(outcome?.requested),
          applied: outcome?.status === 'APPLIED',
          status: asString(outcome?.status || 'REJECTED') || 'REJECTED',
          route: outcome?.route ? truncate(outcome.route, LIMITS.metadataMaxLength) : null,
          failure_category: outcome?.failureCategory ? truncate(outcome.failureCategory, LIMITS.metadataMaxLength) : null
        };
      }
    },

    'navigation.system': {
      description: 'Open the System section in the requesting window. A bounded, reversible view navigation to a fixed semantic destination; it changes no stored data.',
      readOnly: false,
      navigation: true,
      schema: {},
      async handler(_args, context) {
        const outcome = await dep('navigate')({ renderer: context.renderer, destination: 'system', correlationId: context.correlationId });
        return {
          destination: 'system',
          requested: Boolean(outcome?.requested),
          applied: outcome?.status === 'APPLIED',
          status: asString(outcome?.status || 'REJECTED') || 'REJECTED',
          route: outcome?.route ? truncate(outcome.route, LIMITS.metadataMaxLength) : null,
          failure_category: outcome?.failureCategory ? truncate(outcome.failureCategory, LIMITS.metadataMaxLength) : null
        };
      }
    }
  };

  const actions = Object.entries(capabilities).map(([id, cap]) => {
    const metadata = ACTION_METADATA[id];
    if (!metadata) throw new Error(`Capability metadata is missing for ${id}.`);
    return {
      id,
      label: metadata.label,
      description: cap.description,
      feature: metadata.feature,
      inputSchema: cap.schema,
      resultSchema: metadata.resultSchema,
      availability: ALWAYS_AVAILABLE,
      permission: metadata.permission,
      risk: metadata.risk,
      confirmation: metadata.confirmation,
      sideEffects: metadata.sideEffects,
      handler: cap.handler,
      sourceControls: metadata.sourceControls,
      testId: metadata.testId
    };
  });
  const actionRegistry = createActionRegistry(actions, { correlationIdFactory: deps.correlationIdFactory });

  function list() {
    return actionRegistry.list().map((action) => ({
      ...action,
      name: action.id,
      readOnly: Boolean(capabilities[action.id]?.readOnly)
    }));
  }

  function listActions() {
    return list().filter((action) => NEUTRAL_ACTION_SET.has(action.id));
  }

  async function inspect(name, { caller = 'unknown', signal } = {}) {
    if (!NEUTRAL_ACTION_SET.has(name)) return null;
    return actionRegistry.inspect(name, trustedContext(caller, signal));
  }

  async function execute(name, rawArgs, { caller = 'unknown', signal, renderer } = {}) {
    // `renderer` is a trusted per-request binding ({ rendererId, token }) supplied
    // only by server code, never by the model/client arguments. It reaches the
    // handler via context for view-navigation actions and is ignored by all others.
    return actionRegistry.invoke(name, rawArgs, { ...trustedContext(caller, signal), allowedActionIds: NEUTRAL_ACTION_NAMES, renderer });
  }

  // Backward-compatible adapter for the existing Chat UI and verifier. It uses
  // the same registry/handler as the neutral action gateway, while preserving
  // the historical thrown-error and {name, readOnly, args, data} contract.
  async function invoke(name, rawArgs, { renderer } = {}) {
    const result = await actionRegistry.invoke(name, rawArgs, { ...trustedContext('legacy-human-ui'), renderer });
    if (!['success', 'needs_confirmation', 'needs_approval'].includes(result.status)) {
      const message = result.error?.code === 'UNKNOWN_ACTION'
        ? `Unknown capability: ${asString(name).slice(0, 60)}`
        : result.error?.message || `Action ${asString(name).slice(0, 60)} failed.`;
      const error = new Error(message);
      error.code = result.error?.code || 'ACTION_FAILED';
      error.actionStatus = result.status;
      error.correlationId = result.correlationId;
      throw error;
    }
    return {
      name: result.actionId,
      actionId: result.actionId,
      readOnly: Boolean(capabilities[result.actionId]?.readOnly),
      status: result.status,
      correlationId: result.correlationId,
      args: result.args,
      data: result.data
    };
  }

  return { capabilities, actionRegistry, list, listActions, inspect, execute, invoke, LIMITS, validateArgs: validateActionArgs };
}

export const CAPABILITY_NAMES = [
  'knowledge.search', 'knowledge.read',
  'workboard.list', 'workboard.read', 'workboard.propose_create', 'workboard.propose_update',
  'system.status', 'system.models', 'system.runs',
  'conversation.search', 'planner.today', 'navigation.workboard', 'navigation.system'
];
