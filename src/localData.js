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
// Every row carries sync metadata (revision, deleted, sync_status) up front
// so a future bidirectional desktop sync (Phase 4) does not require another
// schema migration -- but no sync engine exists yet. Today, everything here
// is local_only and stays on the device until that lands.

import { planDay, CAPACITY_MODES, DEFAULT_CAPACITY_MODE, normalizeCapacityMode } from '../server/capacityPlanner.js';

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

export async function localCreateTask(body) {
  const db = await getDb();
  const fields = readTaskFields(body);
  if (!fields.title) throw new Error('A task title is required.');
  const id = uuid();
  const ts = nowIso();
  const columns = ['id', 'created_at', 'updated_at', 'device_id', ...Object.keys(fields)];
  const values = [id, ts, ts, await deviceId(db), ...Object.values(fields)];
  await db.run(`INSERT INTO local_tasks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values);
  const row = (await db.query('SELECT * FROM local_tasks WHERE id = ?', [id])).values[0];
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
  if (columns.length) {
    const sets = columns.map((c) => `${c} = ?`).join(', ');
    set.push({ statement: `UPDATE local_tasks SET ${sets}, updated_at = ?, revision = revision + 1 WHERE id = ?`, values: [...Object.values(fields), ts, id] });
  }
  if (fields.status && fields.status !== existing.status) {
    const eventType = taskEventType(existing.status, fields.status);
    if (!eventType) throw new Error(`Unsupported Planner status transition: ${existing.status} -> ${fields.status}.`);
    set.push({ statement: 'INSERT INTO local_task_events (id, task_id, event_type, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?)', values: [uuid(), id, eventType, existing.status, fields.status, ts] });
    if (fields.status === 'completed') set.push({ statement: 'UPDATE local_tasks SET completed_at = ? WHERE id = ?', values: [ts, id] });
    if (existing.status === 'completed' && fields.status !== 'completed') set.push({ statement: 'UPDATE local_tasks SET completed_at = NULL WHERE id = ?', values: [id] });
  }
  if (set.length) await db.executeSet(set, true);
  const row = (await db.query('SELECT * FROM local_tasks WHERE id = ?', [id])).values[0];
  return rowToEngine(row, await taskEventSummary(db, id));
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
