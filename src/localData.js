// Local-first data layer for the standalone Android app. A phone with this
// app installed must be able to run the whole Planner/Today/task lifecycle
// with zero server, zero API key, and zero network -- this module is where
// that state actually lives, in an on-device SQLite database via
// @capacitor-community/sqlite.
//
// Every function here mirrors the JSON shape the equivalent server route
// (server/index.js's /api/planner/*) returns, so the existing UI components
// (DailyPlanner, etc.) can call these instead of `api(...)` on native with
// no other change. server/capacityPlanner.js is pure (no DB/IO) and is
// reused directly rather than re-implemented, so day-ranking behaves
// identically to the desktop/hosted server.
//
// Every row carries sync metadata (revision, deleted, sync_status). The v0.1
// transport below can synchronise Planner tasks/lifecycle events with an
// optional authenticated personal LPS PC. That PC is a capability endpoint,
// never the owner of the phone's Planner: removing or replacing it preserves
// ordinary phone data. Notes, memory candidates and Chat remain phone-local.

import { planDay, CAPACITY_MODES, DEFAULT_CAPACITY_MODE, normalizeCapacityMode } from '../server/capacityPlanner.js';
import { exchangeSyncChanges, planSyncPairingTransition, verifySyncServer } from './nativeConnection.js';

const DB_NAME = 'lps_local';
let dbPromise = null;
let sqliteConn = null;

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

// SCHEMA VERSIONING: every table's own `id` column IS the canonical
// cross-device sync identity (a UUID, generated at creation) -- not a
// separate "server_id" needing later translation. The desktop keeps its own
// integer primary keys as an internal implementation detail; Phase 4 adds a
// `sync_id` column there (backfilled, additive) holding the SAME UUID this
// phone already generated, so identity never has to be translated between a
// phone-space ID and a server-space ID. See docs note in Phase 4 planning.
//
// Migrations are numbered and replay-safe: SCHEMA_MIGRATIONS runs in order,
// every statement is idempotent (CREATE ... IF NOT EXISTS / try-catch'd ADD
// COLUMN), and local_settings.schema_version records the highest one already
// applied so re-running on an already-migrated database is a safe no-op.
const SCHEMA_MIGRATIONS = [
  `
CREATE TABLE IF NOT EXISTS local_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  definition_of_done TEXT NOT NULL DEFAULT '',
  easier_version TEXT NOT NULL DEFAULT '',
  pause_point TEXT NOT NULL DEFAULT '',
  recovery_step TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 3,
  effort INTEGER NOT NULL DEFAULT 3,
  estimated_minutes INTEGER,
  deadline TEXT,
  blocker TEXT NOT NULL DEFAULT '',
  needs_others INTEGER NOT NULL DEFAULT 0,
  is_recovery INTEGER NOT NULL DEFAULT 0,
  consequence_of_delay TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'local_only'
);
CREATE INDEX IF NOT EXISTS idx_local_tasks_status ON local_tasks(status, deleted);

CREATE TABLE IF NOT EXISTS local_task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_task_events_task ON local_task_events(task_id, created_at);

CREATE TABLE IF NOT EXISTS local_notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'local_only'
);

CREATE TABLE IF NOT EXISTS local_memory_candidates (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Standalone Chat: a phone with no configured/reachable server still needs
-- somewhere to keep its conversation. This is intentionally the same shape
-- as the server's chat_sessions/chat_messages (server/db.js) so a future
-- sync can reconcile them directly.
CREATE TABLE IF NOT EXISTS local_chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'local_only'
);
CREATE TABLE IF NOT EXISTS local_chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_chat_messages_session ON local_chat_messages(session_id, created_at);
`,
  // Phase 4 groundwork (bidirectional phone<->desktop sync; first slice is
  // tasks/lifecycle-events only, NOT chat). Mirrors server/db.js's
  // sync_outbox/sync_applied_changes/sync_conflicts exactly, so the same
  // apply/conflict logic works on either side once a transport exists.
  `
CREATE TABLE IF NOT EXISTS sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('planner_task', 'planner_task_event')),
  entity_sync_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'tombstone')),
  payload TEXT,
  revision INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity ON sync_outbox(entity_type, entity_sync_id);

CREATE TABLE IF NOT EXISTS sync_applied_changes (
  change_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  local_payload TEXT NOT NULL,
  incoming_payload TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
`,
  // Bind queued phone mutations to the specific PC identity they are allowed
  // to reach. Existing v0.1 rows are deliberately nullable until the already
  // configured PC verifies its stable identity; they are then bound once.
  `
ALTER TABLE sync_outbox ADD COLUMN server_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_server_seq ON sync_outbox(server_id, seq);
`,
  // Projects are ordinary phone-native planning state. They intentionally do
  // not require or belong to a paired PC; transport support can be added later
  // without changing their local ownership.
  `
CREATE TABLE IF NOT EXISTS local_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  owner TEXT NOT NULL DEFAULT 'user',
  confidence REAL NOT NULL DEFAULT 0.75,
  next_action TEXT NOT NULL DEFAULT '',
  shareability TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_projects_status ON local_projects(status, updated_at);
`
];

async function runMigrations(db) {
  const appliedRaw = await getSetting(db, 'schema_version');
  const parsed = Number(appliedRaw);
  // A corrupt/unexpected schema_version value must fail loudly, never be
  // silently treated as "everything applied" (Number(garbage) is NaN, and
  // NaN < SCHEMA_MIGRATIONS.length is always false, which would skip every
  // migration on a database that actually needs them).
  const applied = appliedRaw === null ? 0 : Number.isInteger(parsed) && parsed >= 0 ? parsed : (() => { throw new Error(`Corrupt local schema_version: ${JSON.stringify(appliedRaw)}`); })();
  for (let version = applied; version < SCHEMA_MIGRATIONS.length; version += 1) {
    await db.execute(SCHEMA_MIGRATIONS[version]);
    await setSetting(db, 'schema_version', String(version + 1));
  }
}

async function getDb() {
  // Deliberately does NOT cache a rejected promise: a transient failure
  // (the native plugin briefly unavailable, a migration hiccup) must not
  // permanently disable every local read/write for the rest of the app's
  // process lifetime -- the next caller should get a fresh attempt, not the
  // same cached rejection forever.
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
    sqliteConn = new SQLiteConnection(CapacitorSQLite);
    const consistent = await sqliteConn.checkConnectionsConsistency();
    const alreadyOpen = (await sqliteConn.isConnection(DB_NAME, false)).result;
    const db = consistent.result && alreadyOpen
      ? await sqliteConn.retrieveConnection(DB_NAME, false)
      : await sqliteConn.createConnection(DB_NAME, false, 'no-encryption', 1, false);
    await db.open();
    // WAL mode (matching server/db.js's desktop connection) lets a reader
    // and a writer touch the database concurrently instead of the default
    // rollback journal's single-writer exclusivity. Required for the
    // planned Phase 5 watch bridge: a native WearableListenerService will
    // open its own connection to this same file to answer "what's my next
    // task" even while the WebView's own connection is mid-write.
    await db.execute('PRAGMA journal_mode=WAL;');
    // local_settings must exist before runMigrations can read/write
    // schema_version, so it is created unconditionally up front rather than
    // as part of the numbered migrations it tracks.
    await db.execute('CREATE TABLE IF NOT EXISTS local_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    await runMigrations(db);
    let deviceId = (await getSetting(db, 'device_id'));
    if (!deviceId) {
      deviceId = uuid();
      await setSetting(db, 'device_id', deviceId);
    }
    return db;
  })().catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

async function getSetting(db, key) {
  const result = await db.query('SELECT value FROM local_settings WHERE key = ?', [key]);
  return result.values?.[0]?.value ?? null;
}

async function deviceId(db) {
  return getSetting(db, 'device_id');
}

async function setSetting(db, key, value) {
  const db2 = db;
  await db2.run('INSERT INTO local_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

function rowToEngine(row, completionSummary = null) {
  const hasHistory = Boolean(completionSummary?.completionEventCount);
  return {
    id: row.id, title: row.title, importance: row.importance, effort: row.effort,
    deadline: row.deadline || null, blocker: row.blocker || null,
    needsOthers: Boolean(row.needs_others), isRecovery: Boolean(row.is_recovery),
    nextAction: row.next_action || null, easierVersion: row.easier_version || null,
    pausePoint: row.pause_point || null, recoveryStep: row.recovery_step || null,
    definitionOfDone: row.definition_of_done || null, why: row.why || null,
    estimatedMinutes: row.estimated_minutes ?? null, consequenceOfDelay: row.consequence_of_delay || null,
    pinned: Boolean(row.pinned), status: row.status,
    completedAt: row.completed_at || null,
    // Local completion evidence/verification is a not-yet-built feature
    // (server/planner_task_evidence has no local equivalent yet), but
    // whether a real completion EVENT exists is knowable and must not be
    // reported as false when local_task_events actually has one.
    completionHistoryAvailable: hasHistory,
    completionEventCount: completionSummary?.completionEventCount || 0,
    latestCompletionEventId: completionSummary?.latestCompletionEventId || null,
    supportingEvidenceCount: 0,
    evidenceState: hasHistory ? 'none-attached' : 'history-unavailable',
    verificationState: hasHistory ? 'unverified' : 'unknown',
    independentlyVerified: false
  };
}

const TASK_FIELD_SETTERS = {
  title: (v) => String(v || '').trim(),
  why: (v) => String(v || ''),
  next_action: (v) => String(v || ''),
  definition_of_done: (v) => String(v || ''),
  easier_version: (v) => String(v || ''),
  pause_point: (v) => String(v || ''),
  recovery_step: (v) => String(v || ''),
  importance: (v) => Math.min(5, Math.max(1, Number(v) || 3)),
  effort: (v) => Math.min(5, Math.max(1, Number(v) || 3)),
  estimated_minutes: (v) => (v === null || v === undefined || v === '' ? null : Math.max(0, Number(v) || 0)),
  deadline: (v) => (v ? String(v) : null),
  blocker: (v) => String(v || ''),
  needs_others: (v) => (v ? 1 : 0),
  is_recovery: (v) => (v ? 1 : 0),
  consequence_of_delay: (v) => String(v || '')
};
const TASK_FIELD_ALIASES = { nextAction: 'next_action', definitionOfDone: 'definition_of_done', easierVersion: 'easier_version', pausePoint: 'pause_point', recoveryStep: 'recovery_step', estimatedMinutes: 'estimated_minutes', needsOthers: 'needs_others', isRecovery: 'is_recovery', consequenceOfDelay: 'consequence_of_delay' };

function readTaskFields(body) {
  const fields = {};
  for (const [key, value] of Object.entries(body || {})) {
    const column = TASK_FIELD_ALIASES[key] || key;
    if (TASK_FIELD_SETTERS[column]) fields[column] = TASK_FIELD_SETTERS[column](value);
  }
  return fields;
}

async function listTaskRows(db, statusFilter) {
  const sql = statusFilter
    ? 'SELECT * FROM local_tasks WHERE deleted = 0 AND status = ? ORDER BY updated_at DESC'
    : 'SELECT * FROM local_tasks WHERE deleted = 0 ORDER BY status, updated_at DESC';
  const result = await db.query(sql, statusFilter ? [statusFilter] : []);
  return result.values || [];
}

async function currentCapacityMode(db) {
  return normalizeCapacityMode(await getSetting(db, 'capacity_mode') || DEFAULT_CAPACITY_MODE);
}

async function recentlyCompleted(db) {
  const result = await db.query(
    "SELECT * FROM local_tasks WHERE deleted = 0 AND status = 'completed' ORDER BY completed_at DESC, updated_at DESC LIMIT 5",
    []
  );
  const rows = result.values || [];
  return Promise.all(rows.map(async (row) => rowToEngine(row, await taskEventSummary(db, row.id))));
}

export async function localPlannerDay() {
  const db = await getDb();
  const mode = await currentCapacityMode(db);
  const tasks = (await listTaskRows(db, 'active')).map(rowToEngine);
  const completed = await recentlyCompleted(db);
  return { mode, modes: CAPACITY_MODES, ...planDay(tasks, mode), recentlyCompleted: completed };
}

export async function localSetCapacityMode(mode) {
  const db = await getDb();
  const resolved = normalizeCapacityMode(mode);
  await setSetting(db, 'capacity_mode', resolved);
  return { mode: resolved, modes: CAPACITY_MODES };
}

export async function localListTasks() {
  const db = await getDb();
  return (await listTaskRows(db)).map(rowToEngine);
}

// Change journal (see server/db.js's sync_outbox for the desktop mirror of
// this exact table/reasoning): one entry per real mutation, keyed by the
// entity's own permanent sync_id (== this row's own `id`, per the whole
// point of using a UUID primary key -- there is no separate id to
// translate). change_id is generated fresh per call and is the future
// sync engine's replay/dedup key.
function outboxStatement(entityType, entitySyncId, op, payload, revision, deviceIdValue, serverId = null) {
  return {
    statement: 'INSERT INTO sync_outbox (change_id, entity_type, entity_sync_id, op, payload, revision, device_id, created_at, server_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    values: [uuid(), entityType, entitySyncId, op, payload === undefined ? null : JSON.stringify(payload), revision, deviceIdValue, nowIso(), serverId || null]
  };
}

export async function localCreateTask(body) {
  const db = await getDb();
  const fields = readTaskFields(body);
  if (!fields.title) throw new Error('A task title is required.');
  const id = uuid();
  const ts = nowIso();
  const device = await deviceId(db);
  const pairedServerId = await getSetting(db, 'sync_server_id');
  const columns = ['id', 'created_at', 'updated_at', 'device_id', ...Object.keys(fields)];
  const values = [id, ts, ts, device, ...Object.values(fields)];
  await db.executeSet([
    { statement: `INSERT INTO local_tasks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values }
  ], true);
  // Read the real row back rather than hand-building the outbox payload from
  // `fields` -- a hand-built object silently omits every column the schema
  // itself defaults (status, pinned, deleted, sync_status, revision), so a
  // remote peer replaying this entry would reconstruct an incomplete task.
  const row = (await db.query('SELECT * FROM local_tasks WHERE id = ?', [id])).values[0];
  const stmt = outboxStatement('planner_task', id, 'upsert', row, row.revision, device, pairedServerId);
  await db.run(stmt.statement, stmt.values);
  return rowToEngine(row);
}

async function loadTaskRow(db, id) {
  const result = await db.query('SELECT * FROM local_tasks WHERE id = ? AND deleted = 0', [id]);
  return result.values?.[0] || null;
}

function taskEventType(fromStatus, toStatus) {
  if (toStatus === 'completed') return 'completed';
  if (toStatus === 'deferred') return 'deferred';
  if (toStatus === 'parked') return 'parked';
  if (toStatus === 'active' && fromStatus === 'completed') return 'reopened';
  if (toStatus === 'active') return 'reactivated';
  return null;
}

// Status change + its lifecycle event + the completed_at side effect must
// commit together: a status update that "succeeded" with no matching event
// (or vice versa) is exactly the kind of silent history loss a future sync
// could never repair, since it has no way to know a transition happened at
// all. executeSet runs its whole statement list as one transaction (per
// this plugin's own documented behaviour), so a crash or thrown error
// midway rolls every statement in the set back rather than leaving the task
// row and its event log disagreeing with each other.
async function writeTaskFields(db, id, fields) {
  const existing = await loadTaskRow(db, id);
  if (!existing) throw new Error('Task not found.');
  const set = [];
  const columns = Object.keys(fields);
  const ts = nowIso();
  const device = await deviceId(db);
  const pairedServerId = await getSetting(db, 'sync_server_id');
  if (columns.length) {
    const sets = columns.map((c) => `${c} = ?`).join(', ');
    // revision = revision + 1 is computed BY SQLite, not read-then-written
    // in JS -- two calls racing on the same row (a rapid double-tap slipping
    // past the UI's own busy guard, for example) still serialize correctly
    // through SQLite's own single-writer semantics instead of both reading
    // the same starting revision and silently colliding.
    set.push({ statement: `UPDATE local_tasks SET ${sets}, updated_at = ?, revision = revision + 1 WHERE id = ?`, values: [...Object.values(fields), ts, id] });
  }
  let eventId = null;
  let eventType = null;
  if (fields.status && fields.status !== existing.status) {
    eventType = taskEventType(existing.status, fields.status);
    if (!eventType) throw new Error(`Unsupported Planner status transition: ${existing.status} -> ${fields.status}.`);
    eventId = uuid();
    set.push({ statement: 'INSERT INTO local_task_events (id, task_id, event_type, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?)', values: [eventId, id, eventType, existing.status, fields.status, ts] });
    if (fields.status === 'completed') set.push({ statement: 'UPDATE local_tasks SET completed_at = ? WHERE id = ?', values: [ts, id] });
    if (existing.status === 'completed' && fields.status !== 'completed') set.push({ statement: 'UPDATE local_tasks SET completed_at = NULL WHERE id = ?', values: [id] });
  }
  if (set.length) await db.executeSet(set, true);
  // The outbox payload is built from the row AFTER the update commits, not
  // from `{...existing, ...fields}` -- that would miss SQL-computed values
  // (the real revision) and side effects this function itself applies
  // (completed_at), and would silently omit database-defaulted columns
  // fields never touched. This costs a second read, not full atomicity with
  // the row write above, but a real, complete snapshot is worth that cost.
  const freshRow = (await db.query('SELECT * FROM local_tasks WHERE id = ?', [id])).values[0];
  if (columns.length) {
    const stmt = outboxStatement('planner_task', id, 'upsert', freshRow, freshRow.revision, device, pairedServerId);
    await db.run(stmt.statement, stmt.values);
  }
  if (eventId) {
    // taskSyncId matches the wire field name the desktop side uses (see
    // applyPlannerTaskFields in server/index.js) -- on the phone the task's
    // own id already IS its sync_id, so this is just that same value under
    // the shared cross-device field name a receiving peer looks for.
    const stmt = outboxStatement('planner_task_event', eventId, 'upsert', { id: eventId, taskSyncId: id, eventType, fromStatus: existing.status, toStatus: fields.status, createdAt: ts }, 1, device, pairedServerId);
    await db.run(stmt.statement, stmt.values);
  }
  return rowToEngine(freshRow, await taskEventSummary(db, id));
}

async function taskEventSummary(db, taskId) {
  const countRow = (await db.query("SELECT COUNT(*) AS count FROM local_task_events WHERE task_id = ? AND event_type = 'completed'", [taskId])).values?.[0];
  const latestRow = (await db.query("SELECT id FROM local_task_events WHERE task_id = ? AND event_type = 'completed' ORDER BY created_at DESC LIMIT 1", [taskId])).values?.[0];
  return { completionEventCount: Number(countRow?.count || 0), latestCompletionEventId: latestRow?.id || null };
}

export async function localUpdateTask(id, body) {
  const db = await getDb();
  const fields = readTaskFields(body);
  if (typeof body?.pinned === 'boolean') fields.pinned = body.pinned ? 1 : 0;
  if (Object.hasOwn(body || {}, 'status')) {
    if (!['active', 'completed', 'deferred', 'parked'].includes(body.status)) throw new Error('Planner task status is invalid.');
    fields.status = body.status;
  }
  return writeTaskFields(db, id, fields);
}

export async function localCompleteTask(id) {
  const db = await getDb();
  return writeTaskFields(db, id, { status: 'completed' });
}

export async function localDeferTask(id) {
  const db = await getDb();
  return writeTaskFields(db, id, { status: 'deferred' });
}

export async function localPinTask(id) {
  const db = await getDb();
  const existing = await loadTaskRow(db, id);
  if (!existing) throw new Error('Task not found.');
  return writeTaskFields(db, id, { pinned: existing.pinned ? 0 : 1 });
}

export async function localTaskEvents(id) {
  const db = await getDb();
  const result = await db.query('SELECT * FROM local_task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 50', [id]);
  return (result.values || []).reverse().map((e) => ({ id: e.id, eventType: e.event_type, fromStatus: e.from_status, toStatus: e.to_status, actor: 'user', source: 'local-device', createdAt: e.created_at }));
}

// --- Projects / layered cards ----------------------------------------------
// These are phone-owned records. Unlike desktop repository/build automation,
// creating and reviewing a personal project is not a PC-only capability.

function projectRow(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    owner: row.owner,
    confidence: Number(row.confidence),
    next_action: row.next_action || '',
    shareability: row.shareability || 'unknown',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function localListProjects() {
  const db = await getDb();
  const result = await db.query("SELECT * FROM local_projects ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC", []);
  return (result.values || []).map(projectRow);
}

export async function localCreateProject(body) {
  const db = await getDb();
  const name = String(body?.name || '').trim();
  if (!name) throw new Error('A project name is required.');
  const id = uuid();
  const ts = nowIso();
  await db.run(
    'INSERT INTO local_projects (id, name, status, owner, confidence, next_action, shareability, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, 'active', 'user', 0.75, String(body?.next_action || ''), 'unknown', ts, ts]
  );
  return projectRow((await db.query('SELECT * FROM local_projects WHERE id = ?', [id])).values[0]);
}

export async function localUpdateProject(id, body) {
  const db = await getDb();
  const existing = (await db.query('SELECT * FROM local_projects WHERE id = ?', [id])).values?.[0];
  if (!existing) throw new Error('Project not found.');
  const allowedStatus = new Set(['active', 'blocked', 'waiting', 'stable', 'done', 'completed', 'archived']);
  const allowedShareability = new Set(['unknown', 'private', 'local-shareable', 'public-shareable']);
  const next = {
    name: Object.hasOwn(body || {}, 'name') ? String(body.name || '').trim() : existing.name,
    status: allowedStatus.has(body?.status) ? body.status : existing.status,
    owner: Object.hasOwn(body || {}, 'owner') ? String(body.owner || '').trim() || 'user' : existing.owner,
    confidence: Object.hasOwn(body || {}, 'confidence') ? Math.min(1, Math.max(0, Number(body.confidence) || 0)) : existing.confidence,
    next_action: Object.hasOwn(body || {}, 'next_action') ? String(body.next_action || '') : existing.next_action,
    shareability: allowedShareability.has(body?.shareability) ? body.shareability : existing.shareability
  };
  if (!next.name) throw new Error('A project name is required.');
  await db.run(
    'UPDATE local_projects SET name = ?, status = ?, owner = ?, confidence = ?, next_action = ?, shareability = ?, updated_at = ? WHERE id = ?',
    [next.name, next.status, next.owner, next.confidence, next.next_action, next.shareability, nowIso(), id]
  );
  return projectRow((await db.query('SELECT * FROM local_projects WHERE id = ?', [id])).values[0]);
}

export async function localListProjectCards() {
  return (await localListProjects()).map((project) => {
    const hasExecution = Boolean(project.next_action);
    return {
      id: project.id,
      pinned: { title: project.name, status: project.status, owner: project.owner, blocker: project.status === 'blocked' ? 'Project is marked blocked.' : '' },
      glance: { confidence: project.confidence, progress: null },
      context: { populated: true, recap: 'Phone-local personal project.', latestEvidence: '', sourceSummary: 'This Android device', lastReviewed: project.updated_at, linkedItemCount: 0 },
      execution: { populated: hasExecution, activeAction: project.next_action, blocker: project.status === 'blocked' ? 'Project is marked blocked.' : '', subtasks: [] },
      proof: { populated: false, verifications: [] },
      history: { populated: false, events: [] },
      populatedLayers: ['glance', 'context', ...(hasExecution ? ['execution'] : [])]
    };
  });
}

// --- Notes / quick capture --------------------------------------------------

export async function localCreateNote(body) {
  const db = await getDb();
  const text = String(body?.body || '').trim();
  if (!text) throw new Error('A note needs some text.');
  const id = uuid();
  const ts = nowIso();
  await db.run('INSERT INTO local_notes (id, body, created_at, device_id) VALUES (?, ?, ?, ?)', [id, text, ts, await deviceId(db)]);
  return { id, body: text, createdAt: ts };
}

export async function localListNotes() {
  const db = await getDb();
  const result = await db.query('SELECT * FROM local_notes WHERE deleted = 0 ORDER BY created_at DESC LIMIT 100', []);
  return (result.values || []).map((n) => ({ id: n.id, body: n.body, createdAt: n.created_at }));
}

// --- Memory candidates (local, phone-scoped) --------------------------------

export async function localCreateMemoryCandidate(body) {
  const db = await getDb();
  const text = String(body?.body || '').trim();
  if (!text) throw new Error('Nothing to remember was given.');
  const id = uuid();
  await db.run('INSERT INTO local_memory_candidates (id, body, created_at) VALUES (?, ?, ?)', [id, text, nowIso()]);
  return { id, body: text, status: 'candidate', createdAt: nowIso() };
}

export async function localListMemoryCandidates() {
  const db = await getDb();
  const result = await db.query("SELECT * FROM local_memory_candidates WHERE status = 'candidate' ORDER BY created_at DESC", []);
  return result.values || [];
}

// --- Standalone Chat: local sessions/messages --------------------------

export async function localListSessions() {
  const db = await getDb();
  const result = await db.query('SELECT * FROM local_chat_sessions WHERE deleted = 0 ORDER BY pinned DESC, updated_at DESC', []);
  return result.values || [];
}

export async function localCreateSession(title) {
  const db = await getDb();
  const id = uuid();
  const ts = nowIso();
  const cleanTitle = String(title || '').trim() || 'New session';
  await db.run('INSERT INTO local_chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, cleanTitle, ts, ts]);
  return { id, title: cleanTitle, pinned: 0, deleted: 0, created_at: ts, updated_at: ts };
}

export async function localPatchSession(id, fields) {
  const db = await getDb();
  const allowed = ['title', 'pinned', 'deleted'];
  const updates = Object.entries(fields || {}).filter(([key]) => allowed.includes(key));
  for (const [key, value] of updates) {
    await db.run(`UPDATE local_chat_sessions SET ${key} = ?, updated_at = ? WHERE id = ?`, [value, nowIso(), id]);
  }
  const result = await db.query('SELECT * FROM local_chat_sessions WHERE id = ?', [id]);
  return result.values?.[0] || null;
}

export async function localListMessages(sessionId) {
  const db = await getDb();
  const result = await db.query('SELECT * FROM local_chat_messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId]);
  return result.values || [];
}

export async function localAppendMessage(sessionId, role, content) {
  const db = await getDb();
  const session = (await db.query('SELECT id FROM local_chat_sessions WHERE id = ? AND deleted = 0', [sessionId])).values?.[0];
  if (!session) throw new Error('Chat session not found.');
  const id = uuid();
  const ts = nowIso();
  await db.executeSet([
    { statement: 'INSERT INTO local_chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', values: [id, sessionId, role, content, ts] },
    { statement: 'UPDATE local_chat_sessions SET updated_at = ?, revision = revision + 1 WHERE id = ?', values: [ts, sessionId] }
  ], true);
  return { id, session_id: sessionId, role, content, created_at: ts };
}

// Router for the plain session-list/create/messages/patch calls Chat's
// sidebar uses. The streaming send itself is handled directly in Chat (see
// src/localCommands.js) since it has no server-route equivalent to mirror.
export async function localChatApi(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};

  if (path === '/api/chat/sessions' && method === 'GET') return localListSessions();
  if (path === '/api/chat/sessions' && method === 'POST') return localCreateSession(body.title);

  const messagesMatch = /^\/api\/chat\/sessions\/([^/]+)\/messages$/.exec(path);
  if (messagesMatch && method === 'GET') return localListMessages(messagesMatch[1]);

  const patchMatch = /^\/api\/chat\/sessions\/([^/]+)$/.exec(path);
  if (patchMatch && method === 'PATCH') return localPatchSession(patchMatch[1], body);

  throw new Error(`No local handler for ${method} ${path}.`);
}

// --- Router: matches the exact api(path, options) call shape the existing
// UI components already use, so DailyPlanner etc. need no other change on
// native beyond swapping which function they call. Unmatched paths throw
// rather than silently no-op, so a future route added to the UI without a
// local equivalent fails loudly in testing instead of doing nothing.
export async function localPlannerApi(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};

  if (path === '/api/planner/day' && method === 'GET') return localPlannerDay();
  if (path === '/api/planner/capacity' && method === 'POST') return localSetCapacityMode(body.mode);
  if (path === '/api/planner/tasks' && method === 'GET') return localListTasks();
  if (path === '/api/planner/tasks' && method === 'POST') return localCreateTask(body);

  const taskMatch = /^\/api\/planner\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch && method === 'PATCH') return localUpdateTask(taskMatch[1], body);

  const actionMatch = /^\/api\/planner\/tasks\/([^/]+)\/(complete|defer|pin)$/.exec(path);
  if (actionMatch) {
    const [, id, action] = actionMatch;
    if (action === 'complete') return localCompleteTask(id);
    if (action === 'defer') return localDeferTask(id);
    if (action === 'pin') return localPinTask(id);
  }

  const eventsMatch = /^\/api\/planner\/tasks\/([^/]+)\/events$/.exec(path);
  if (eventsMatch && method === 'GET') return localTaskEvents(eventsMatch[1]);

  throw new Error(`No local handler for ${method} ${path}.`);
}

// --- Phase 4 transport: phone side --------------------------------------
// Talks to the small standalone sync bridge desktop runs alongside its main
// server (see server/index.js's "Phone<->desktop sync bridge" section) --
// never the main app's own port, which stays loopback-only. Pairing is
// manual (the desktop Settings screen shows an address + token, the user
// types them in here once) rather than automatic LAN discovery: that is the
// smallest real transport that still needs no PC, adb, or VPS to work, at
// the cost of one-time manual setup instead of zero-config pairing.

export async function localSyncSettings() {
  const db = await getDb();
  const [baseUrl, pairingToken, serverId, userId, protocolVersion, connectionStatus, cursor, lastPushedSeq, lastSyncAt, lastVerifiedAt, lastError] = await Promise.all(
    [
      'sync_base_url', 'sync_pairing_token', 'sync_server_id', 'sync_user_id', 'sync_protocol_version',
      'sync_connection_status', 'sync_cursor', 'sync_last_pushed_seq', 'sync_last_sync_at',
      'sync_last_verified_at', 'sync_last_error'
    ].map((key) => getSetting(db, key))
  );
  const paired = Boolean(baseUrl && pairingToken);
  return {
    baseUrl: baseUrl || '',
    pairingToken: pairingToken || '',
    serverId: serverId || '',
    userId: userId || '',
    protocolVersion: Number(protocolVersion || 0),
    connectionStatus: connectionStatus || (paired ? 'unknown' : 'not_paired'),
    paired,
    cursor: Number(cursor || 0),
    lastPushedSeq: Number(lastPushedSeq || 0),
    lastSyncAt: lastSyncAt || null,
    lastVerifiedAt: lastVerifiedAt || null,
    lastError: lastError || null
  };
}

export async function persistSyncPairingTransition(db, { candidate, pairingToken, transition, verifiedAt = nowIso() }) {
  await db.beginTransaction();
  try {
    if (transition.resetTransport) {
      // Drop only PC-scoped transport state. local_tasks and
      // local_task_events are ordinary phone-owned Planner data and survive
      // removing/replacing a PC. Deleting the old outbox is the fail-closed
      // boundary that prevents pending PC-A work from replaying into PC B.
      await db.execute(`
        DELETE FROM sync_outbox;
        DELETE FROM sync_applied_changes;
        DELETE FROM sync_conflicts;
      `);
    } else {
      // Tasks created with zero PCs are fully valid phone-native work. On an
      // initial pairing (or identity upgrade), bind their unscoped journal
      // entries exactly once to the verified PC selected by the user.
      await db.run('UPDATE sync_outbox SET server_id = ? WHERE server_id IS NULL', [candidate.serverId]);
    }
    await setSetting(db, 'sync_base_url', candidate.baseUrl);
    await setSetting(db, 'sync_pairing_token', pairingToken);
    await setSetting(db, 'sync_server_id', candidate.serverId);
    await setSetting(db, 'sync_user_id', candidate.userId);
    await setSetting(db, 'sync_protocol_version', String(candidate.protocolVersion));
    await setSetting(db, 'sync_connection_status', 'connected');
    await setSetting(db, 'sync_last_verified_at', verifiedAt);
    await setSetting(db, 'sync_last_error', '');
    if (!transition.preserveProgress) {
      await setSetting(db, 'sync_cursor', '0');
      await setSetting(db, 'sync_last_pushed_seq', '0');
      await setSetting(db, 'sync_last_sync_at', '');
    }
    await db.commitTransaction();
  } catch (error) {
    await db.rollbackTransaction().catch(() => {});
    throw error;
  }
}

export async function persistSyncPairingRemoval(db) {
  await db.beginTransaction();
  try {
    // Remove credentials and PC-specific pending/receipt state only. The
    // phone remains a complete local LifePlanSystem client with all Planner,
    // Today, task, note, memory and chat records intact.
    await db.execute(`
      DELETE FROM sync_outbox;
      DELETE FROM sync_applied_changes;
      DELETE FROM sync_conflicts;
      DELETE FROM local_settings WHERE key IN (
        'sync_base_url', 'sync_pairing_token', 'sync_server_id', 'sync_user_id',
        'sync_protocol_version', 'sync_connection_status', 'sync_cursor',
        'sync_last_pushed_seq', 'sync_last_sync_at', 'sync_last_verified_at',
        'sync_last_error'
      );
    `);
    await db.commitTransaction();
  } catch (error) {
    await db.rollbackTransaction().catch(() => {});
    throw error;
  }
}

export async function localRemoveSyncPairing() {
  const db = await getDb();
  await persistSyncPairingRemoval(db);
  return localSyncSettings();
}

export async function localSetSyncPairing({ baseUrl, pairingToken, replaceExisting = false }) {
  const db = await getDb();
  const cleanToken = String(pairingToken || '').trim();
  if (!cleanToken) throw new Error('Pairing code is required.');
  // Verify both service identity and credential BEFORE persisting either one.
  // A typo, a non-LPS web server, or PC A's code sent to PC B cannot replace
  // the phone's last working pairing.
  const candidate = await verifySyncServer({ baseUrl, pairingToken: cleanToken });
  const current = await localSyncSettings();
  const transition = planSyncPairingTransition(current, candidate, { replaceExisting });
  await persistSyncPairingTransition(db, { candidate, pairingToken: cleanToken, transition });
  return { ...(await localSyncSettings()), transition: transition.mode };
}

function extractSyncableTaskFieldsPhone(payload) {
  const fields = readTaskFields(payload || {});
  if (typeof payload?.pinned !== 'undefined') fields.pinned = payload.pinned ? 1 : 0;
  if (typeof payload?.status === 'string' && ['active', 'completed', 'deferred', 'parked'].includes(payload.status)) fields.status = payload.status;
  if (Object.hasOwn(payload || {}, 'completed_at')) fields.completed_at = payload.completed_at ?? null;
  return fields;
}

// Mirrors server/index.js's applyIncomingTaskChange/applyIncomingEventChange
// exactly (same fast-forward-or-conflict rule, same append-only event
// handling) -- the phone's own id column already IS its sync_id, so unlike
// the desktop there is no separate integer-PK lookup for tasks, only for
// resolving an event's taskSyncId to a local row (which on phone is the
// same value, since local_tasks.id IS that sync_id).
async function applyIncomingTaskChangeOnPhone(db, change) {
  const payload = change.payload || {};
  if (change.op === 'tombstone') return { status: 'unsupported' };
  const existing = (await db.query('SELECT * FROM local_tasks WHERE id = ?', [change.entitySyncId])).values?.[0];
  if (!existing) {
    const fields = extractSyncableTaskFieldsPhone(payload);
    fields.title = fields.title || String(payload.title || '').trim();
    if (!fields.title) return { status: 'rejected', reason: 'missing title' };
    fields.device_id = change.deviceId;
    fields.revision = change.revision;
    const ts = payload.created_at || nowIso();
    const columns = ['id', 'created_at', 'updated_at', ...Object.keys(fields)];
    const values = [change.entitySyncId, ts, payload.updated_at || ts, ...Object.values(fields)];
    await db.run(`INSERT INTO local_tasks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values);
    return { status: 'applied' };
  }
  const baseRevision = change.revision - 1;
  if (existing.revision !== baseRevision) {
    await db.run(
      'INSERT INTO sync_conflicts (id, entity_type, entity_sync_id, local_payload, incoming_payload, detected_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), 'planner_task', change.entitySyncId, JSON.stringify(existing), JSON.stringify(payload), nowIso()]
    );
    return { status: 'conflict' };
  }
  const fields = extractSyncableTaskFieldsPhone(payload);
  fields.revision = change.revision;
  fields.device_id = change.deviceId;
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  await db.run(`UPDATE local_tasks SET ${sets} WHERE id = ?`, [...Object.values(fields), change.entitySyncId]);
  return { status: 'applied' };
}

async function applyIncomingEventChangeOnPhone(db, change) {
  const payload = change.payload || {};
  const existingEvent = (await db.query('SELECT 1 FROM local_task_events WHERE id = ?', [change.entitySyncId])).values?.[0];
  if (existingEvent) return { status: 'duplicate' };
  const taskExists = (await db.query('SELECT 1 FROM local_tasks WHERE id = ?', [payload.taskSyncId])).values?.[0];
  if (!taskExists) return { status: 'deferred', reason: 'referenced task not yet present' };
  await db.run(
    'INSERT INTO local_task_events (id, task_id, event_type, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [change.entitySyncId, payload.taskSyncId, payload.eventType, String(payload.fromStatus || ''), String(payload.toStatus || ''), payload.createdAt || nowIso()]
  );
  return { status: 'applied' };
}

// Mirrors the desktop's own hasAppliedSyncChange/markSyncChangeApplied gate
// (server/db.js) exactly. Without this, a crash between applying a pulled
// batch and persisting the advanced sync_cursor would cause the next sync to
// re-request and re-apply the SAME desktop changes -- for a task update,
// existing.revision would already equal the incoming revision (not
// baseRevision), so the fast-forward-or-conflict check below would
// misclassify a harmless redelivery as a genuine conflict.
async function applyIncomingChangeOnPhone(db, change) {
  const existing = (await db.query('SELECT 1 FROM sync_applied_changes WHERE change_id = ?', [change.changeId])).values?.[0];
  if (existing) return { status: 'duplicate' };
  let result;
  if (change.entityType === 'planner_task') result = await applyIncomingTaskChangeOnPhone(db, change);
  else if (change.entityType === 'planner_task_event') result = await applyIncomingEventChangeOnPhone(db, change);
  else result = { status: 'rejected', reason: 'unknown entity type' };
  if (result.status === 'applied' || result.status === 'conflict') {
    await db.run('INSERT OR IGNORE INTO sync_applied_changes (change_id, applied_at) VALUES (?, ?)', [change.changeId, nowIso()]);
  }
  return result;
}

// One push-then-pull round trip. Never throws for an expected condition (not
// paired, desktop unreachable) -- those are reported in the returned status
// so a caller (a periodic timer, a Settings "Sync now" button) can show the
// user something honest instead of an unhandled rejection. A genuinely
// unexpected failure (a malformed response, a local write erroring) is
// caught too and reported the same way, since a background sync tick must
// never crash the app it runs inside.
export async function localSyncNow() {
  const db = await getDb();
  const settings = await localSyncSettings();
  if (!settings.paired) {
    await setSetting(db, 'sync_connection_status', 'not_paired');
    return { status: 'not_paired' };
  }
  const device = await deviceId(db);
  try {
    // Every sync re-authenticates the saved endpoint and checks its stable PC
    // identity before transmitting phone data. This also upgrades a legacy
    // same-endpoint pairing by recording the newly available identity.
    const identity = await verifySyncServer({ baseUrl: settings.baseUrl, pairingToken: settings.pairingToken });
    if (settings.serverId && identity.serverId !== settings.serverId) {
      throw Object.assign(new Error('This address now belongs to a different LifePlanSystem PC. Re-pair explicitly before syncing.'), { code: 'SYNC_SERVER_CHANGED' });
    }
    if (settings.userId && identity.userId !== settings.userId) {
      throw Object.assign(new Error('The paired LifePlanSystem user identity changed. Re-pair explicitly before syncing.'), { code: 'SYNC_SERVER_CHANGED' });
    }
    if (!settings.serverId) {
      await setSetting(db, 'sync_server_id', identity.serverId);
      await setSetting(db, 'sync_user_id', identity.userId);
      await setSetting(db, 'sync_protocol_version', String(identity.protocolVersion));
      // One-time upgrade for pre-identity v0.1 outbox rows. This is safe only
      // after the stored endpoint and credential verified the PC identity.
      await db.run('UPDATE sync_outbox SET server_id = ? WHERE server_id IS NULL', [identity.serverId]);
    }

    const pending = (await db.query('SELECT * FROM sync_outbox WHERE server_id = ? AND seq > ? ORDER BY seq ASC LIMIT 200', [identity.serverId, settings.lastPushedSeq])).values || [];
    const changes = pending.map((row) => ({
      changeId: row.change_id, entityType: row.entity_type, entitySyncId: row.entity_sync_id, op: row.op,
      payload: row.payload ? JSON.parse(row.payload) : null, revision: row.revision, deviceId: row.device_id
    }));

    const data = await exchangeSyncChanges({
      baseUrl: identity.baseUrl,
      pairingToken: settings.pairingToken,
      payload: { deviceId: device, sinceSeq: settings.cursor, changes }
    });
    if (data.serverId !== identity.serverId || data.userId !== identity.userId) {
      throw Object.assign(new Error('The sync response identity did not match the paired LifePlanSystem PC.'), { code: 'SYNC_SERVER_CHANGED' });
    }

    let applied = 0;
    let conflicts = 0;
    // Applied strictly in the order the desktop sent them, matching the
    // desktop's own same-batch task-before-event ordering guarantee.
    for (const change of data.changes || []) {
      const result = await applyIncomingChangeOnPhone(db, change);
      if (result.status === 'applied') applied += 1;
      if (result.status === 'conflict') conflicts += 1;
    }

    // The pushed cursor only advances past changes the desktop durably
    // resolved one way or another (applied/duplicate/conflict). A 'deferred'
    // result (its referenced task hasn't arrived yet) or an outright
    // rejection must stay unacknowledged so the SAME change is resent next
    // time -- advancing past it here would silently drop it forever, since
    // this phone would never again consider it "pending". Resending an
    // already-resolved change later (once a stop point is hit) is harmless:
    // the desktop's change_id ledger makes re-application a no-op.
    const pushResultByChangeId = new Map((data.results || []).map((r) => [r.changeId, r.status]));
    const RESOLVED_STATUSES = new Set(['applied', 'duplicate', 'conflict']);
    let maxPushedSeq = settings.lastPushedSeq;
    for (const row of pending) {
      if (!RESOLVED_STATUSES.has(pushResultByChangeId.get(row.change_id))) break;
      maxPushedSeq = row.seq;
    }
    await setSetting(db, 'sync_last_pushed_seq', String(maxPushedSeq));
    await setSetting(db, 'sync_cursor', String(data.cursor ?? settings.cursor));
    await setSetting(db, 'sync_last_sync_at', nowIso());
    await setSetting(db, 'sync_last_verified_at', nowIso());
    await setSetting(db, 'sync_connection_status', 'connected');
    await setSetting(db, 'sync_last_error', '');
    return { status: 'ok', pushed: pending.length, pulled: (data.changes || []).length, applied, conflicts };
  } catch (error) {
    const message = error?.message || 'Sync failed.';
    const status = error?.code === 'SYNC_UNREACHABLE'
      ? 'unreachable'
      : error?.code === 'SYNC_AUTH_FAILED'
        ? 'authentication_required'
        : error?.code === 'SYNC_SERVER_CHANGED'
          ? 'server_changed'
          : 'error';
    await setSetting(db, 'sync_connection_status', status);
    await setSetting(db, 'sync_last_error', message);
    return { status, message };
  }
}
