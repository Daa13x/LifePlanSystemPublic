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
  minLimit: 1,
  maxLimit: 25,
  defaultLimit: 8
});

function asString(value) {
  return value === undefined || value === null ? '' : String(value);
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function truncate(text, max = LIMITS.bodyMaxLength) {
  const s = asString(text);
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;
}

// Minimal, strict argument validator. Rejects unknown behaviour rather than
// coercing silently for anything security relevant (ids, enums).
function validateArgs(name, schema, rawArgs) {
  const input = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const out = {};
  for (const [key, spec] of Object.entries(schema)) {
    let value = input[key];
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (spec.required) throw new Error(`${name}: missing required argument "${key}".`);
      if ('default' in spec) { out[key] = spec.default; }
      continue;
    }
    switch (spec.type) {
      case 'string': {
        if (typeof value !== 'string') throw new Error(`${name}: "${key}" must be a string.`);
        value = value.trim();
        if (spec.maxLength) value = value.slice(0, spec.maxLength);
        if (spec.enum && !spec.enum.includes(value)) {
          throw new Error(`${name}: "${key}" must be one of: ${spec.enum.join(', ')}.`);
        }
        break;
      }
      case 'id': {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}: "${key}" must be a positive record id.`);
        value = n;
        break;
      }
      case 'integer': {
        value = clampInt(value, spec.min ?? -Infinity, spec.max ?? Infinity, spec.default ?? 0);
        break;
      }
      case 'object': {
        if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: "${key}" must be an object.`);
        break;
      }
      default:
        throw new Error(`${name}: unsupported schema type for "${key}".`);
    }
    out[key] = value;
  }
  // Reject unexpected keys so callers cannot smuggle extra fields into handlers.
  for (const key of Object.keys(input)) {
    if (!(key in schema)) throw new Error(`${name}: unexpected argument "${key}".`);
  }
  return out;
}

function provenanceFor(record) {
  return {
    id: record.id,
    kind: record.kind || record.record_kind || 'record',
    source: record.source || 'not recorded',
    evidence: record.evidence || 'not recorded',
    confidence: record.confidence === undefined || record.confidence === null ? null : Number(record.confidence),
    status: record.status || null,
    updated_at: record.updated_at || record.created_at || null
  };
}

// Fields that must never appear in tool arguments/results returned to the model.
const KNOWLEDGE_SCOPES = ['all', 'approved', 'candidates', 'rules'];
const WORKBOARD_VIEWS = ['overview', 'projects', 'roadmap', 'review', 'completed', 'blocked'];

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
          type: r.type || null,
          title: r.title,
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
          type: record.type || null,
          title: record.title,
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
        const records = (data.records || []).slice(0, args.limit).map((r) => ({
          id: r.id,
          type: r.type || r.record_kind || 'record',
          title: r.title || r.name,
          status: r.status || null,
          detail: truncate(r.detail || r.body || r.next_action || '', 240),
          provenance: provenanceFor(r)
        }));
        return { view: args.view, summary: data.summary || null, records, count: records.length, truncated: (data.records || []).length > records.length };
      }
    },

    'workboard.read': {
      description: 'Read one Workboard project (with its items) or one Workboard item. Read-only.',
      readOnly: true,
      schema: {
        id: { type: 'id', required: true },
        kind: { type: 'string', default: 'project', enum: ['project', 'item'] }
      },
      async handler(args) {
        const record = await dep('readWorkboard')({ id: args.id, kind: args.kind });
        if (!record) throw new Error(`Workboard ${args.kind} ${args.id} was not found.`);
        return record;
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
          preview: { type: args.type, title: args.title, body: truncate(args.body, 400), next_action: args.next_action },
          confirmation_required: true
        };
      }
    },

    'workboard.propose_update': {
      description: 'Propose updating an existing Workboard item. Returns a before/after proposal for confirmation; never writes.',
      readOnly: false,
      schema: {
        id: { type: 'id', required: true },
        changes: { type: 'object', required: true }
      },
      async handler(args) {
        const current = await dep('readWorkboard')({ id: args.id, kind: 'item' });
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

  function list() {
    return Object.entries(capabilities).map(([name, cap]) => ({ name, description: cap.description, readOnly: cap.readOnly }));
  }

  async function invoke(name, rawArgs) {
    const cap = capabilities[name];
    if (!cap) throw new Error(`Unknown capability: ${asString(name).slice(0, 60)}`);
    const args = validateArgs(name, cap.schema, rawArgs);
    const data = await cap.handler(args);
    return { name, readOnly: cap.readOnly, args, data };
  }

  return { capabilities, list, invoke, LIMITS, validateArgs };
}

export const CAPABILITY_NAMES = [
  'knowledge.search', 'knowledge.read',
  'workboard.list', 'workboard.read', 'workboard.propose_create', 'workboard.propose_update',
  'system.status', 'system.models', 'system.runs',
  'conversation.search'
];
