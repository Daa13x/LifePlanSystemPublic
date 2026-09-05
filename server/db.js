import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createConfirmationsTable } from './confirmations.js';
import { createUsersTables, LOCAL_USER_ID } from './auth.js';

const root = process.cwd();
const dataDir = path.join(root, 'data');
export const dbPath = path.resolve(process.env.LIFE_PLANNER_DB || path.join(dataDir, 'life-planner.sqlite'));

fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA secure_delete = ON');

export const SECRET_SETTING_KEYS = new Set(['hfToken', 'githubToken', 'browserConnectorToken', 'maRelayPairToken', 'syncPairingToken']);
const DPAPI_PREFIX = 'dpapi:v1:';
const warnedSecretDecryptions = new Set();
const secretCache = new Map();

function runDpapi(operation, input) {
  if (process.platform !== 'win32') {
    throw new Error('Secure secret storage requires Windows DPAPI.');
  }
  const script = operation === 'protect'
    ? 'Add-Type -AssemblyName System.Security;$plain=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($plain);$cipher=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($cipher))'
    : 'Add-Type -AssemblyName System.Security;$encoded=[Console]::In.ReadToEnd();$cipher=[Convert]::FromBase64String($encoded);$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))';
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
}

function protectSecret(value) {
  return `${DPAPI_PREFIX}${runDpapi('protect', value)}`;
}

function unprotectSecret(value) {
  return runDpapi('unprotect', value.slice(DPAPI_PREFIX.length));
}

function parseStoredValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function migratePlaintextSecretSettings() {
  const rows = db.prepare(`
    SELECT key, value FROM settings
    WHERE key IN ('hfToken', 'githubToken', 'browserConnectorToken', 'maRelayPairToken')
  `).all();
  const plaintextRows = rows.filter((row) => {
    const value = String(parseStoredValue(row.value) || '');
    return value && !value.startsWith(DPAPI_PREFIX);
  });
  const emptyRows = rows.filter((row) => !String(parseStoredValue(row.value) || ''));
  if (!plaintextRows.length && !emptyRows.length) return;

  // protectSecret() requires Windows DPAPI. A fresh hosted (Linux) database
  // never reaches this branch (rows/plaintextRows/emptyRows are all empty on
  // an empty settings table). The only way to reach it on Linux is restoring
  // a legacy Windows-desktop database onto a hosted server -- an
  // unsupported, unlikely operator mistake, but one that must not crash
  // startup outright.
  const canProtect = process.platform === 'win32';
  if (plaintextRows.length && !canProtect) {
    console.warn(`Skipping plaintext-secret migration for ${plaintextRows.map((r) => r.key).join(', ')}: secure secret storage requires Windows. These settings remain unprotected; clear or reconfigure them.`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    if (canProtect) {
      const update = db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?');
      for (const row of plaintextRows) {
        update.run(JSON.stringify(protectSecret(String(parseStoredValue(row.value)))), row.key);
      }
    }
    const remove = db.prepare('DELETE FROM settings WHERE key = ?');
    for (const row of emptyRows) remove.run(row.key);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction was not active */ }
    throw error;
  }

  // Remove recoverable copies of the legacy plaintext from both the database
  // file and its WAL after the encrypted replacement is durable.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
}

export function migrate() {
  createUsersTables(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS model_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      size_bytes INTEGER,
      assigned_role TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      hf_repo TEXT,
      hf_file TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_context_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, path)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      owner TEXT NOT NULL DEFAULT 'user',
      source TEXT NOT NULL DEFAULT 'manual',
      confidence REAL NOT NULL DEFAULT 0.8,
      last_reviewed TEXT,
      evidence TEXT,
      next_action TEXT,
      shareability TEXT NOT NULL DEFAULT 'unknown' CHECK (shareability IN ('private', 'local-shareable', 'public-shareable', 'unknown')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS roadmap_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      resume_notes TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'feature',
      status TEXT NOT NULL DEFAULT 'planned',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS roadmap_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'feature',
      source_kind TEXT NOT NULL DEFAULT 'chat',
      source_ref TEXT NOT NULL DEFAULT '',
      signal TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'candidate',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS knowledge_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending review',
      confidence REAL NOT NULL DEFAULT 0.5,
      last_reviewed TEXT,
      evidence TEXT,
      owner TEXT NOT NULL DEFAULT 'user',
      next_action TEXT,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      due_at TEXT,
      shareability TEXT NOT NULL DEFAULT 'unknown' CHECK (shareability IN ('private', 'local-shareable', 'public-shareable', 'unknown')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memory_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
      source_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL,
      evidence TEXT,
      confidence REAL NOT NULL DEFAULT 0.45,
      status TEXT NOT NULL DEFAULT 'candidate',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'P2',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS consultations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      local_draft TEXT NOT NULL,
      target_agent TEXT NOT NULL DEFAULT 'manual browser',
      prompt TEXT,
      opened_url TEXT,
      opened_title TEXT,
      sent_at TEXT,
      captured_at TEXT,
      external_response TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- A durable, session-scoped projection of an existing consultation into
    -- Chat. The consultation remains the single underlying cloud-history
    -- record; this table only adds Chat provenance, state, and one-use advice.
    CREATE TABLE IF NOT EXISTS chat_cloud_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consultation_id INTEGER NOT NULL UNIQUE REFERENCES consultations(id) ON DELETE CASCADE,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      user_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
      assistant_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
      scope TEXT NOT NULL CHECK (scope IN ('latest-turn','full-conversation')),
      provider TEXT NOT NULL,
      model TEXT,
      instruction TEXT NOT NULL DEFAULT '',
      prompt_hash TEXT NOT NULL,
      included_message_ids TEXT NOT NULL DEFAULT '[]',
      classification TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'preparing',
      response TEXT,
      feedback TEXT,
      error_detail TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      guidance_active INTEGER NOT NULL DEFAULT 0,
      guidance_consumed_at TEXT,
      feedback_dismissed_at TEXT,
      memory_candidate_id INTEGER REFERENCES memory_candidates(id) ON DELETE SET NULL,
      browser_job_id INTEGER,
      provider_tab_id TEXT,
      provider_url TEXT,
      dispatch_receipt TEXT,
      capture_receipt TEXT,
      verification_level TEXT NOT NULL DEFAULT 'LOCAL_RECORD_ONLY',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_chat_cloud_checks_session ON chat_cloud_checks(session_id, created_at);

    -- Explicitly-selected Knowledge/Workboard records attached to a conversation
    -- as Chat context. Provenance (kind + ref_id + label) is retained so the
    -- assistant only ever sees records the user deliberately chose. Nothing is
    -- attached automatically to a new conversation.
    CREATE TABLE IF NOT EXISTS chat_context_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      provenance TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, kind, ref_id)
    );

    -- Append-only audit trail of Chat capability invocations and confirmed
    -- Workboard writes, for accountability of the Chat control surface.
    CREATE TABLE IF NOT EXISTS chat_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      capability TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'ok',
      detail TEXT NOT NULL DEFAULT '',
      correlation_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memory_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER,
      action TEXT NOT NULL,
      previous_value TEXT,
      replacement_memory_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Existing installations predate per-action correlation tracing. Keep this
  // additive so the action gateway upgrades an old database in place.
  try { db.exec('ALTER TABLE chat_audit ADD COLUMN correlation_id TEXT'); } catch { /* already present */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_audit_correlation ON chat_audit(correlation_id)');

  for (const column of [
    ['prompt', 'TEXT'],
    ['opened_url', 'TEXT'],
    ['opened_title', 'TEXT'],
    ['sent_at', 'TEXT'],
    ['captured_at', 'TEXT']
  ]) {
    try {
      db.exec(`ALTER TABLE consultations ADD COLUMN ${column[0]} ${column[1]}`);
    } catch {
      // Column already exists.
    }
  }

  // Remember a model's Hugging Face origin so a deleted file can be
  // re-downloaded and the list entry can flip downloaded -> download.
  for (const column of [['hf_repo', 'TEXT'], ['hf_file', 'TEXT']]) {
    try {
      db.exec(`ALTER TABLE model_registry ADD COLUMN ${column[0]} ${column[1]}`);
    } catch {
      // Column already exists.
    }
  }

  // Structured, non-conversational diagnostics for an assistant reply
  // (runtime, model, endpoint type, memory-governance result, context files,
  // tokens, timing). Stored as JSON so the answer body stays clean and the
  // UI can surface diagnostics in a Details panel by response-detail mode.
  // Older rows keep metadata = NULL and simply render their saved body.
  for (const column of [['metadata', 'TEXT'], ['pinned', 'INTEGER NOT NULL DEFAULT 0']]) {
    try {
      db.exec(`ALTER TABLE chat_messages ADD COLUMN ${column[0]} ${column[1]}`);
    } catch {
      // Column already exists.
    }
  }

  for (const column of [['chat_session_id', 'INTEGER'], ['user_message_id', 'INTEGER'], ['assistant_message_id', 'INTEGER'], ['scope', 'TEXT'], ['provider_model', 'TEXT']]) {
    try { db.exec(`ALTER TABLE consultations ADD COLUMN ${column[0]} ${column[1]}`); } catch { /* already present */ }
  }

  for (const column of [
    ['feedback_dismissed_at', 'TEXT'],
    ['instruction', "TEXT NOT NULL DEFAULT ''"],
    ['browser_job_id', 'INTEGER'],
    ['provider_tab_id', 'TEXT'],
    ['provider_url', 'TEXT'],
    ['dispatch_receipt', 'TEXT'],
    ['capture_receipt', 'TEXT'],
    ['verification_level', "TEXT NOT NULL DEFAULT 'LOCAL_RECORD_ONLY'"]
  ]) {
    try { db.exec(`ALTER TABLE chat_cloud_checks ADD COLUMN ${column[0]} ${column[1]}`); } catch { /* already present */ }
  }

  // Workflow status is not a privacy decision. Existing records and every new
  // import begin unknown until the user explicitly classifies them.
  for (const table of ['projects', 'knowledge_items']) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN shareability TEXT NOT NULL DEFAULT 'unknown'`); } catch { /* already present */ }
    db.prepare(`UPDATE ${table} SET shareability = 'unknown' WHERE shareability IS NULL OR shareability NOT IN ('private', 'local-shareable', 'public-shareable', 'unknown')`).run();
  }

  // Candidate annotations make the review decision explicit without treating a
  // raw Chat message as canonical memory.
  for (const column of [['category', 'TEXT'], ['sensitivity', 'TEXT'], ['conflict_target_id', 'INTEGER'], ['replacement_mode', 'TEXT']]) {
    try { db.exec(`ALTER TABLE memory_candidates ADD COLUMN ${column[0]} ${column[1]}`); } catch { /* already present */ }
  }

  // Durable confirmation + replay-protection store (see server/confirmations.js).
  createConfirmationsTable(db);

  // Capacity-Aware Daily Planner tasks (see server/capacityPlanner.js). Each task
  // carries the low-capacity-friendly fields the planner needs: an exact next
  // action, why it matters, a definition of done, an easier version, a pause
  // point, a recovery step, effort/importance/time, deadline, blocker, and
  // whether it needs another person. Ordering/visibility is computed
  // transparently from the user's current capacity mode; nothing here is a score.
  db.exec(`
    CREATE TABLE IF NOT EXISTS planner_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','completed','deferred','parked')),
      pinned INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_planner_tasks_status ON planner_tasks(status);

    -- Append-only Planner lifecycle history. A completion event proves only
    -- that LPS recorded a state transition; it is not independent evidence
    -- that the underlying real-world task was completed.
    CREATE TABLE IF NOT EXISTS planner_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES planner_tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('completed','deferred','reopened','reactivated','parked')),
      from_status TEXT NOT NULL CHECK (from_status IN ('active','completed','deferred','parked')),
      to_status TEXT NOT NULL CHECK (to_status IN ('active','completed','deferred','parked')),
      actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 32),
      source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
      reference TEXT CHECK (reference IS NULL OR length(reference) <= 200),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(task_id, source, reference)
    );
    CREATE INDEX IF NOT EXISTS idx_planner_task_events_task ON planner_task_events(task_id, id);

    -- Append-only supporting evidence for one concrete Planner completion
    -- event. Evidence records are user-provided context, never independent
    -- verification. Replacement and revocation are later ledger records so
    -- the original claim is retained rather than silently edited or deleted.
    CREATE TABLE IF NOT EXISTS planner_task_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES planner_tasks(id) ON DELETE CASCADE,
      completion_event_id INTEGER NOT NULL REFERENCES planner_task_events(id) ON DELETE CASCADE,
      record_type TEXT NOT NULL CHECK (record_type IN ('attached','revoked')),
      evidence_kind TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN ('user_assertion','artifact_reference','external_reference')),
      claim TEXT NOT NULL CHECK (length(claim) BETWEEN 1 AND 1000),
      public_reference TEXT CHECK (public_reference IS NULL OR length(public_reference) <= 500),
      target_evidence_id INTEGER REFERENCES planner_task_evidence(id),
      supersedes_evidence_id INTEGER REFERENCES planner_task_evidence(id),
      actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 32),
      source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
      internal_reference TEXT CHECK (internal_reference IS NULL OR length(internal_reference) <= 200),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (record_type = 'attached' AND evidence_kind IS NOT NULL AND target_evidence_id IS NULL)
        OR
        (record_type = 'revoked' AND evidence_kind IS NULL AND public_reference IS NULL AND target_evidence_id IS NOT NULL AND supersedes_evidence_id IS NULL)
      ),
      UNIQUE(task_id, source, internal_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_planner_task_evidence_completion ON planner_task_evidence(completion_event_id, id);
    CREATE INDEX IF NOT EXISTS idx_planner_task_evidence_target ON planner_task_evidence(target_evidence_id, id);

    -- Append-only canonical event stream for a Workboard card (project). It is
    -- the single source for the layered card's History layer and any recorded
    -- Proof evidence — never a display-only copy of the current project row.
    CREATE TABLE IF NOT EXISTS project_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      actor TEXT NOT NULL DEFAULT 'user',
      detail TEXT,
      evidence TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_project_events_project ON project_events(project_id, id);

    -- Continuous user feedback: structured, attributable signal routed to a
    -- review queue. It never modifies production behaviour on its own; sensitive
    -- items stay local under the memory-approval boundary.
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      sentiment TEXT NOT NULL CHECK (sentiment IN ('useful','wrong','confusing','broken','unnecessary','incomplete')),
      surface TEXT NOT NULL DEFAULT '',
      work_item TEXT,
      run_id TEXT,
      provider TEXT,
      app_version TEXT,
      note TEXT,
      evidence TEXT,
      sensitive INTEGER NOT NULL DEFAULT 0,
      actionable INTEGER NOT NULL DEFAULT 0,
      theme_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','routed','dismissed')),
      failure_event_id INTEGER REFERENCES failure_events(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, theme_key);

    -- Failure taxonomy: attributable failure records for reviewed self-improvement.
    -- A single record never changes behaviour; only a confirmed failure may
    -- PROPOSE a regression test or reviewed prompt/router candidate.
    CREATE TABLE IF NOT EXISTS failure_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN (
        'repeated-question','wrong-question-type','missing-attachment','incorrect-attachment',
        'stale-attachment','repeated-navigation','unsupported-answer','failed-test-or-contradiction',
        'no-progress-loop','user-correction','unnecessary-cloud-escalation','missed-escalation')),
      status TEXT NOT NULL DEFAULT 'observed' CHECK (status IN ('observed','confirmed','converted','dismissed')),
      source TEXT NOT NULL DEFAULT 'manual',
      task_ref TEXT,
      run_id TEXT,
      inputs TEXT,
      evidence TEXT,
      correction TEXT,
      outcome TEXT,
      regression_ref TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_failure_events_cat ON failure_events(category, status);

    -- Append-only, failure-bound before/after evaluations. A failure may move
    -- to converted only through an explicitly selected passing row.
    CREATE TABLE IF NOT EXISTS failure_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      failure_event_id INTEGER NOT NULL REFERENCES failure_events(id) ON DELETE CASCADE,
      target_category TEXT NOT NULL,
      regression_ref TEXT NOT NULL,
      before_counts TEXT NOT NULL,
      after_counts TEXT NOT NULL,
      improved INTEGER NOT NULL CHECK (improved IN (0,1)),
      reason TEXT NOT NULL,
      converted_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(failure_event_id, regression_ref, before_counts, after_counts)
    );
    CREATE INDEX IF NOT EXISTS idx_failure_evaluations_failure ON failure_evaluations(failure_event_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_failure_evaluations_converted ON failure_evaluations(failure_event_id) WHERE converted_at IS NOT NULL;

    -- Adaptive cost-routing observations: measured model/effort outcomes used to
    -- route future work to the cheapest route that meets the acceptance bar.
    -- Recorded evidence only; routing decisions are computed, never stored as
    -- authority over a run.
    CREATE TABLE IF NOT EXISTS routing_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_class TEXT NOT NULL,
      route TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      run_ref TEXT,
      task_ref TEXT,
      cost_unit TEXT,
      verification_ref TEXT,
      observation_key TEXT,
      request_hash TEXT,
      cost REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      retries INTEGER NOT NULL DEFAULT 0,
      review_minutes REAL NOT NULL DEFAULT 0,
      verification_passed INTEGER NOT NULL DEFAULT 0,
      accepted INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_routing_obs_class ON routing_observations(task_class, route);

    -- Durable, server-history-backed preparation receipts for unattended
    -- Workboard safety checks. These rows authorize and execute nothing.
    CREATE TABLE IF NOT EXISTS unattended_preparation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      run_id TEXT NOT NULL,
      work_item_type TEXT NOT NULL CHECK (work_item_type IN ('project','item')),
      work_item_id INTEGER NOT NULL,
      contract_hash TEXT NOT NULL,
      canonical_state_hash TEXT NOT NULL,
      no_progress_limit INTEGER NOT NULL CHECK (no_progress_limit BETWEEN 2 AND 10),
      phase TEXT NOT NULL,
      question_type TEXT NOT NULL,
      question_signature TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      justified_retry INTEGER NOT NULL DEFAULT 0 CHECK (justified_retry IN (0,1)),
      retry_reason TEXT,
      transition_reason TEXT,
      manifest_hash TEXT NOT NULL,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      ready INTEGER NOT NULL CHECK (ready IN (0,1)),
      blocked INTEGER NOT NULL CHECK (blocked IN (0,1)),
      reasons_json TEXT NOT NULL,
      failure_event_id INTEGER REFERENCES failure_events(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_unattended_attempt_run ON unattended_preparation_attempts(run_id, work_item_type, work_item_id, id);
    CREATE INDEX IF NOT EXISTS idx_unattended_attempt_blocked ON unattended_preparation_attempts(blocked, created_at);

    -- Request idempotency for retry-unsafe multi-row mutations. A stored first
    -- result lets an identical client retry (dropped response, proxy timeout)
    -- replay instead of re-writing. The record is written in the same
    -- transaction as the mutation, so a rolled-back write leaves no key behind.
    CREATE TABLE IF NOT EXISTS request_idempotency (
      idempotency_key TEXT NOT NULL,
      route TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (route, idempotency_key)
    );

    -- Durable ownership for long-running local Chat generation. Unlike the
    -- generic final-response idempotency receipts above, these rows have an
    -- explicit lifecycle and renewable lease so retries, cancellation, process
    -- restart, and an accidental second server cannot create duplicate turns.
    CREATE TABLE IF NOT EXISTS chat_send_requests (
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','cancel_requested','completed','cancelled','retryable_error','interrupted')),
      user_message_id INTEGER NOT NULL UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE,
      candidate_id INTEGER REFERENCES memory_candidates(id) ON DELETE SET NULL,
      assistant_message_id INTEGER UNIQUE REFERENCES chat_messages(id) ON DELETE SET NULL,
      owner_token TEXT,
      lease_expires_at TEXT,
      result_json TEXT,
      error_detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      settled_at TEXT,
      PRIMARY KEY (session_id, idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_send_one_active_session
      ON chat_send_requests(session_id) WHERE state IN ('pending','cancel_requested');

    -- MA partner relay artifacts are durable but deliberately outside Chat and
    -- local-model context. Receiving a handoff never makes it prompt material.
    CREATE TABLE IF NOT EXISTS partner_relay_artifacts (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      file_name TEXT NOT NULL,
      classification TEXT NOT NULL,
      pdf_bytes BLOB NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT,
      status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewed','rejected')),
      UNIQUE(id, sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_partner_relay_artifacts_status ON partner_relay_artifacts(status, received_at);
  `);

  // Existing installations predate per-user ownership. Ensure the additive
  // columns before creating indexes that reference them: CREATE TABLE IF NOT
  // EXISTS does not retrofit an old table, and an early index failure would
  // otherwise prevent this backfill from ever running.
  for (const table of ['chat_sessions', 'planner_tasks']) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER NOT NULL DEFAULT ${LOCAL_USER_ID}`);
    } catch (error) {
      if (!/duplicate column name:\s*user_id/i.test(String(error?.message || ''))) throw error;
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, deleted, pinned, updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_planner_tasks_user ON planner_tasks(user_id, status)');

  // Existing feedback predates hosted beta accounts. Preserve legacy desktop
  // rows as the fixed local user, then attribute new submissions explicitly.
  try {
    db.exec(`ALTER TABLE feedback ADD COLUMN user_id INTEGER NOT NULL DEFAULT ${LOCAL_USER_ID}`);
  } catch (error) {
    if (!/duplicate column name:\s*user_id/i.test(String(error?.message || ''))) throw error;
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_user_status ON feedback(user_id, status, created_at)');

  // Existing databases predate the explicit feedback -> Quality review bridge.
  // The backlink makes routing idempotent and inspectable without promoting or
  // confirming the observed failure automatically.
  try {
    db.exec('ALTER TABLE feedback ADD COLUMN failure_event_id INTEGER REFERENCES failure_events(id) ON DELETE SET NULL');
  } catch (error) {
    if (!/duplicate column name:\s*failure_event_id/i.test(String(error?.message || ''))) throw error;
  }

  // Existing routing evidence predates provenance and unit attribution.
  // Preserve those rows as explicitly incomplete; never fabricate a backfill.
  // Migration failures other than the expected duplicate-column condition
  // remain fatal.
  for (const [column, type] of [
    ['model', 'TEXT'], ['effort', 'TEXT'], ['run_ref', 'TEXT'], ['task_ref', 'TEXT'],
    ['cost_unit', 'TEXT'], ['verification_ref', 'TEXT'], ['observation_key', 'TEXT'],
    ['request_hash', 'TEXT']
  ]) {
    try {
      db.exec(`ALTER TABLE routing_observations ADD COLUMN ${column} ${type}`);
    } catch (error) {
      if (!new RegExp(`duplicate column name:\\s*${column}`, 'i').test(String(error?.message || ''))) throw error;
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_routing_obs_key ON routing_observations(observation_key) WHERE observation_key IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_routing_obs_run_variant ON routing_observations(run_ref, route, model, effort, cost_unit) WHERE run_ref IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_routing_obs_variant ON routing_observations(task_class, route, model, effort, cost_unit)');

  const projectCount = db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
  if (projectCount === 0) {
    const insertProject = db.prepare(`
      INSERT INTO projects (name, status, owner, source, confidence, last_reviewed, evidence, next_action)
      VALUES (?, ?, ?, ?, ?, date('now'), ?, ?)
    `);
    const p1 = insertProject.run('Life Planner MVP', 'active', 'user', 'seed', 0.9, 'Created as initial local app build target.', 'Wire the SQLite-backed planning loop.').lastInsertRowid;
    const p2 = insertProject.run('Personal Admin', 'active', 'user', 'seed', 0.7, 'Default area for reminders and waiting items.', 'Review waiting-on-me items.').lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO knowledge_items
      (type, title, body, source, status, confidence, last_reviewed, evidence, owner, next_action, project_id, due_at)
      VALUES (?, ?, ?, ?, ?, ?, date('now'), ?, ?, ?, ?, ?)
    `);
    insertItem.run('goal', 'Ship a working local-first planner MVP', 'Create a desktop-first assistant with database-backed planner, chat, memory review, model registry, and import/export.', 'user brief', 'active', 0.95, 'User supplied mission and first build target.', 'user', 'Run the app and review the MVP workflow.', p1, new Date().toISOString());
    insertItem.run('blocker', 'Cloud browser automation is not configured yet', 'The app can record consultations, but Cloud Consultant remains setup-gated until Playwright/Chromium status and the Chrome connector are ready.', 'implementation note', 'active', 0.75, 'Cloud browser execution depends on local browser tooling and an explicit connector/session setup.', 'app', 'Open Browser or Tooling to check Playwright, Chromium, and Chrome connector status.', p1, null);
    insertItem.run('waiting', 'Review candidate memories before promotion', 'Conversation-derived knowledge must move through candidate review before becoming active memory.', 'governance rule', 'stable', 0.95, 'Mission requires chat -> candidate -> reviewed -> approved -> active memory.', 'user', 'Approve, deny, or defer candidates.', p1, null);
    insertItem.run('rule', 'Cloud agents advise, they do not decide', 'External consultation responses must become reviewable suggestions and never automatically change memory.', 'user brief', 'stable', 0.98, 'LPS governance requirement.', 'user', 'Keep cloud outputs in approval flow.', p1, null);
    insertItem.run('reminder', 'Check stale local context weekly', 'Items not reviewed recently should lose confidence and require verification before promotion.', 'seed', 'active', 0.7, 'Memory decay lowers confidence, not data retention.', 'user', 'Review stale items in Planner.', p2, null);
  }

  const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count;
  if (sessionCount === 0) {
    // Atomic: sessionCount === 0 only ever fires once, so a partial write here
    // (session created but onboarding settings missing) would be permanent --
    // the guided question would be seeded with no forced-capture/acknowledgement
    // behavior ever again. Guided first-run capture (Phase 2): the reply to
    // this one seeded question is force-captured as a memory candidate (see
    // insertChatUserTurn / generateAssistantTurn in server/index.js) even if it
    // does not match the ordinary durable-signal heuristic, and gets a
    // deterministic acknowledgement so this works before any model is
    // configured. onboarding.sessionId/onboarding.step are workflow state only
    // -- the answer content itself still goes through the existing candidate ->
    // review -> approval lifecycle, never an automatic promotion.
    db.exec('BEGIN IMMEDIATE');
    try {
      const sessionId = db.prepare('INSERT INTO chat_sessions (title, pinned) VALUES (?, 1)').run('Life Planner kickoff').lastInsertRowid;
      db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(sessionId, 'assistant', "Life Planner is ready to collect context. I will treat chat as candidate memory until you approve it.\n\nTo get started: what's one thing going on in your life right now that you'd like Life Planner to help you keep track of?");
      setSetting('onboarding.sessionId', String(sessionId));
      setSetting('onboarding.step', 'pending');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction was not active */ }
      throw error;
    }
  }

  // Phase 4 groundwork (bidirectional phone<->desktop sync; first slice is
  // tasks/Planner/lifecycle-events only, NOT chat). Positioned at the very
  // end of migrate(), after every CREATE TABLE above has definitely run --
  // an earlier attempt at this same column placed a backfill loop before
  // planner_tasks existed yet on a fresh install and crashed startup with
  // "no such table: planner_tasks". The pre-existing user_id backfill loop
  // above has the identical hazard but never surfaced it, because
  // planner_tasks' own CREATE TABLE separately bakes user_id in directly;
  // this comment is the record of that near-repeat so it doesn't happen a
  // third time.
  //
  // The canonical cross-device identity for a record is `sync_id`, a UUID
  // -- the SAME kind of id the standalone Android app already generates for
  // its own local rows (src/localData.js). The desktop's integer
  // AUTOINCREMENT `id` stays exactly what it always was: an internal
  // implementation detail every foreign key here still uses, never
  // replaced. `revision` and `device_id` mirror the phone schema so a
  // future sync engine can detect a genuine conflict (both sides advanced
  // the same entity's revision since the last common sync point) instead of
  // ever blindly overwriting one side's edit with the other's.
  for (const [column, ddl] of [['sync_id', 'TEXT'], ['revision', 'INTEGER NOT NULL DEFAULT 1'], ['device_id', 'TEXT']]) {
    try { db.exec(`ALTER TABLE planner_tasks ADD COLUMN ${column} ${ddl}`); } catch { /* already present */ }
  }
  try { db.exec('ALTER TABLE planner_task_events ADD COLUMN sync_id TEXT'); } catch { /* already present */ }
  for (const [table, idColumn] of [['planner_tasks', 'id'], ['planner_task_events', 'id']]) {
    const unbackfilled = db.prepare(`SELECT ${idColumn} AS rowId FROM ${table} WHERE sync_id IS NULL`).all();
    if (unbackfilled.length) {
      const stamp = db.prepare(`UPDATE ${table} SET sync_id = ? WHERE ${idColumn} = ?`);
      for (const row of unbackfilled) stamp.run(crypto.randomUUID(), row.rowId);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_sync_id ON ${table}(sync_id)`);
  }

  // The change journal ("outbox"): every task/event mutation appends one
  // row here (see recordSyncOutboxEntry below), rather than a future sync
  // engine diffing full tables. change_id is the replay/dedup key -- the
  // SAME mutation retried (a dropped response, a re-run migration) must
  // never append a second entry, so callers generate it once and this
  // table's own UNIQUE constraint makes a duplicate insert a no-op via
  // INSERT OR IGNORE, not a second real change. Deletion is deliberately
  // NOT a separate mechanism: a 'tombstone' op is just another revisioned
  // outbox entry, so a device offline when a record was deleted applies
  // that deletion on its next sync instead of resurrecting the row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('planner_task', 'planner_task_event')),
      entity_sync_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('upsert', 'tombstone')),
      payload TEXT,
      revision INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_user ON sync_outbox(user_id, seq);
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity ON sync_outbox(entity_type, entity_sync_id);

    -- Dedup ledger for INCOMING changes applied FROM a peer -- makes
    -- applying a batch idempotent if the same batch is ever replayed
    -- (a retried sync request after a dropped response, for example).
    CREATE TABLE IF NOT EXISTS sync_applied_changes (
      change_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- A genuine conflict (both sides advanced the same entity's revision
    -- since the last common sync point) is never resolved by picking a
    -- winner automatically -- both versions are preserved here for the
    -- user to resolve, and the local row is left exactly as it was.
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_sync_id TEXT NOT NULL,
      local_payload TEXT NOT NULL,
      incoming_payload TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      resolution TEXT CHECK (resolution IS NULL OR resolution IN ('kept_local', 'kept_incoming', 'merged'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_conflicts_open ON sync_conflicts(entity_sync_id) WHERE resolved_at IS NULL;
  `);

  migratePlaintextSecretSettings();
}

// Appends one durable change-journal entry. Called from every real
// planner_task/planner_task_event mutation path (see applyPlannerTaskFields
// and the two creation routes in server/index.js) -- never invoked twice for
// the same logical change, since change_id is generated once by the caller
// and this insert is idempotent (OR IGNORE) against a retry.
export function recordSyncOutboxEntry({ entityType, entitySyncId, op, payload, revision, deviceId, userId, changeId = crypto.randomUUID() }) {
  db.prepare(`
    INSERT OR IGNORE INTO sync_outbox (change_id, entity_type, entity_sync_id, op, payload, revision, device_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(changeId, entityType, entitySyncId, op, payload === undefined ? null : JSON.stringify(payload), revision, deviceId || 'desktop', userId);
}

// Transport primitives for the phone<->desktop exchange (server/index.js's
// POST /api/sync/exchange). Entity-specific upsert/conflict decisions live
// there, next to the existing planner field allowlist -- this module only
// owns the journal/ledger storage, the same split as recordSyncOutboxEntry
// above.
export function hasAppliedSyncChange(changeId) {
  return Boolean(db.prepare('SELECT 1 FROM sync_applied_changes WHERE change_id = ?').get(changeId));
}

export function markSyncChangeApplied(changeId) {
  db.prepare('INSERT OR IGNORE INTO sync_applied_changes (change_id) VALUES (?)').run(changeId);
}

export function recordSyncConflict({ entityType, entitySyncId, localPayload, incomingPayload }) {
  db.prepare(`
    INSERT INTO sync_conflicts (entity_type, entity_sync_id, local_payload, incoming_payload)
    VALUES (?, ?, ?, ?)
  `).run(entityType, entitySyncId, JSON.stringify(localPayload), JSON.stringify(incomingPayload));
}

// Everything this user's desktop has recorded after `sinceSeq`, excluding
// entries that originated on the requesting device itself -- a peer never
// needs its own changes echoed back to it. Returns the outbox rows AND the
// true current max seq (not just the max among the returned rows), so a
// caller whose own excluded changes are the newest in the table still
// advances its cursor past them instead of re-requesting the same page
// forever.
export function listOutgoingSyncChanges({ sinceSeq, excludeDeviceId, userId, limit = 200 }) {
  // Bounded, matching the phone's own LIMIT on the push side (see
  // localSyncNow in src/localData.js) -- a device offline for a long stretch
  // must never make one /exchange response unboundedly large. When the page
  // is truncated, the cursor advances only to the LAST row actually
  // returned, not the table's true max -- jumping straight to the true max
  // here would make the caller skip every un-paged row between the two,
  // silently losing them from that device's view. A page that returns fewer
  // rows than the limit really did see everything currently available, so
  // jumping to the true max there is exactly right, not an approximation.
  const changes = db.prepare(`
    SELECT seq, change_id, entity_type, entity_sync_id, op, payload, revision, device_id, created_at
    FROM sync_outbox
    WHERE user_id = ? AND seq > ? AND device_id != ?
    ORDER BY seq ASC
    LIMIT ?
  `).all(userId, sinceSeq, excludeDeviceId, limit);
  const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM sync_outbox WHERE user_id = ?').get(userId);
  const cursor = changes.length === limit ? changes[changes.length - 1].seq : Math.max(sinceSeq, maxRow.maxSeq);
  return { changes, cursor };
}

export function getSetting(key, fallback = null) {
  if (SECRET_SETTING_KEYS.has(key) && secretCache.has(key)) return secretCache.get(key);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  const value = parseStoredValue(row.value);
  if (SECRET_SETTING_KEYS.has(key)) {
    if (!value) return fallback;
    if (typeof value !== 'string' || !value.startsWith(DPAPI_PREFIX)) return fallback;
    try {
      const plaintext = unprotectSecret(value);
      secretCache.set(key, plaintext);
      return plaintext;
    } catch {
      if (!warnedSecretDecryptions.has(key)) {
        warnedSecretDecryptions.add(key);
        console.warn(`Stored ${key} could not be decrypted for this Windows user. Replace or clear it in the app.`);
      }
      secretCache.set(key, fallback);
      return fallback;
    }
  }
  return value;
}

function setRegularSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, JSON.stringify(value));
}

function setSecretSetting(key, value) {
  const plaintext = String(value || '');
  if (!plaintext) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    warnedSecretDecryptions.delete(key);
    secretCache.delete(key);
    return;
  }
  setRegularSetting(key, protectSecret(plaintext));
  warnedSecretDecryptions.delete(key);
  secretCache.set(key, plaintext);
}

export function setSetting(key, value) {
  if (SECRET_SETTING_KEYS.has(key)) {
    setSecretSetting(key, value);
    return;
  }
  setRegularSetting(key, value);
}
