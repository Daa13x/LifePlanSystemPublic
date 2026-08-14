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
      { identity: { type: 'object' }, category: { type: 'string' }, title: { type: 'string' }, status: { type: ['string', 'null'] }, detail: { type: 'string' }, next_action: { type: ['string', 'null'] }, owner: { type: ['string', 'null'] }, project: { type: ['object', 'null'] }, children: { type: 'array' }, provenance: { type: 'object' }, truncated: { type: 'boolean' } }
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
    sourceControls: [], testId: 'action.workboard.propose_update',
    resultSchema: resultObject(['proposal', 'operation', 'affects', 'target_id', 'before', 'after', 'confirmation_required'], { proposal: { type: 'boolean' }, operation: { type: 'string' }, affects: { type: 'string' }, target_id: { type: 'integer' }, before: { type: 'object' }, after: { type: 'object' }, confirmation_required: { type: 'boolean' } })
  },
  'system.status': {
    label: 'Read system status', feature: 'System', permission: 'system.read', risk: ACTION_RISKS.READ_ONLY,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: [], testId: 'action.system.status',
    resultSchema: resultObject(['health'], { health: { type: 'object' } }, true)
  },
  'system.models': {
    label: 'List local models', feature: 'System models', permission: 'models.read', risk: ACTION_RISKS.READ_ONLY,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: [], testId: 'action.system.models',
    resultSchema: resultObject(['models', 'count', 'truncated'], { models: { type: 'array' }, count: { type: 'integer' }, truncated: { type: 'boolean' } })
  },
  'system.runs': {
    label: 'List local runs', feature: 'System runs', permission: 'system.read', risk: ACTION_RISKS.READ_ONLY,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: [], testId: 'action.system.runs',
    resultSchema: resultObject(['runs', 'count', 'truncated'], { runs: { type: 'array' }, count: { type: 'integer' }, truncated: { type: 'boolean' } })
  },
  'conversation.search': {
    label: 'Search conversations', feature: 'Chat history', permission: 'chat.history.read', risk: ACTION_RISKS.SENSITIVE_DATA,
    confirmation: ACTION_CONFIRMATIONS.NONE, sideEffects: [], sourceControls: [], testId: 'action.conversation.search',
    resultSchema: resultObject(['matches', 'count', 'truncated'], { matches: { type: 'array' }, count: { type: 'integer' }, truncated: { type: 'boolean' } })
  }
});

const ALL_CAPABILITY_SCOPES = Object.freeze([...new Set(Object.values(ACTION_METADATA).map((item) => item.permission))]);
const READ_ONLY_CAPABILITY_SCOPES = Object.freeze([...new Set(Object.values(ACTION_METADATA)
  .filter((item) => item.risk === ACTION_RISKS.READ_ONLY)
  .map((item) => item.permission))]);
export const NEUTRAL_ACTION_NAMES = Object.freeze(['knowledge.search', 'knowledge.read', 'workboard.list', 'workboard.read', 'workboard.propose_create']);
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
        const allowed = ['status', 'title', 'body', 'next_action', 'confidence', 'due_at', 'reviewed'];
        const changes = {};
        for (const [key, value] of Object.entries(args.changes || {})) {
          if (!allowed.includes(key)) throw new Error(`workboard.propose_update: field "${key}" cannot be changed from Chat.`);
          changes[key] = value;
        }
        if (!Object.keys(changes).length) throw new Error('workboard.propose_update: no permitted changes were supplied.');
        const before = {};
        for (const key of Object.keys(changes)) before[key] = current[key] ?? null;
        return {
          proposal: true,
          operation: 'workboard.update',
          affects: `Workboard item ${args.id} (${current.title})`,
          target_id: args.id,
          before,
          after: changes,
          confirmation_required: true
        };
      }
    },

    'system.status': {
      description: 'Report authoritative application/runtime status (health, SQLite, model, runtime, repo, browser, tools). Read-only.',
      readOnly: true,
      schema: {},
      async handler() {
        return await dep('systemStatus')();
      }
    },

    'system.models': {
      description: 'List the local model registry and the assigned Planner Assistant. Read-only.',
      readOnly: true,
      schema: { limit: { type: 'integer', default: LIMITS.maxLimit, min: LIMITS.minLimit, max: LIMITS.maxLimit } },
      async handler(args) {
        const models = await dep('listModels')();
        return { models: models.slice(0, args.limit), count: Math.min(models.length, args.limit), truncated: models.length > args.limit };
      }
    },

    'system.runs': {
      description: 'List recent local execution/coding runs from the authoritative System sources. Read-only.',
      readOnly: true,
      schema: { limit: { type: 'integer', default: LIMITS.defaultLimit, min: LIMITS.minLimit, max: LIMITS.maxLimit } },
      async handler(args) {
        const runs = await dep('listRuns')({ limit: args.limit });
        return { runs: runs.slice(0, args.limit), count: Math.min(runs.length, args.limit), truncated: runs.length > args.limit };
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
        const rows = await dep('searchConversations')({ query: args.query, limit: args.limit });
        return {
          matches: rows.slice(0, args.limit).map((r) => ({ session_id: r.session_id, role: r.role, snippet: truncate(r.content, 200), created_at: r.created_at })),
          count: Math.min(rows.length, args.limit),
          truncated: rows.length > args.limit
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

  async function execute(name, rawArgs, { caller = 'unknown', signal } = {}) {
    return actionRegistry.invoke(name, rawArgs, { ...trustedContext(caller, signal), allowedActionIds: NEUTRAL_ACTION_NAMES });
  }

  // Backward-compatible adapter for the existing Chat UI and verifier. It uses
  // the same registry/handler as the neutral action gateway, while preserving
  // the historical thrown-error and {name, readOnly, args, data} contract.
  async function invoke(name, rawArgs) {
    const result = await actionRegistry.invoke(name, rawArgs, trustedContext('legacy-human-ui'));
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
  'conversation.search'
];
