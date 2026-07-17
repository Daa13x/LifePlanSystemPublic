import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const dataDir = path.join(root, 'data');
export const dbPath = path.resolve(process.env.LIFE_PLANNER_DB || path.join(dataDir, 'life-planner.sqlite'));

fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA secure_delete = ON');

export const SECRET_SETTING_KEYS = new Set(['hfToken', 'githubToken', 'browserConnectorToken']);
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
    WHERE key IN ('hfToken', 'githubToken', 'browserConnectorToken')
  `).all();
  const plaintextRows = rows.filter((row) => {
    const value = String(parseStoredValue(row.value) || '');
    return value && !value.startsWith(DPAPI_PREFIX);
  });
  const emptyRows = rows.filter((row) => !String(parseStoredValue(row.value) || ''));
  if (!plaintextRows.length && !emptyRows.length) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    const update = db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?');
    for (const row of plaintextRows) {
      update.run(JSON.stringify(protectSecret(String(parseStoredValue(row.value)))), row.key);
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL,
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
  `);

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
    insertItem.run('rule', 'Cloud agents advise, they do not decide', 'External consultation responses must become reviewable suggestions and never automatically change memory.', 'user brief', 'stable', 0.98, 'Reference philosophy from MostlyArmless.', 'user', 'Keep cloud outputs in approval flow.', p1, null);
    insertItem.run('reminder', 'Check stale local context weekly', 'Items not reviewed recently should lose confidence and require verification before promotion.', 'seed', 'active', 0.7, 'Memory decay lowers confidence, not data retention.', 'user', 'Review stale items in Planner.', p2, null);
  }

  const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count;
  if (sessionCount === 0) {
    const sessionId = db.prepare('INSERT INTO chat_sessions (title, pinned) VALUES (?, 1)').run('Life Planner kickoff').lastInsertRowid;
    db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(sessionId, 'assistant', 'Life Planner is ready to collect context. I will treat chat as candidate memory until you approve it.');
  }

  migratePlaintextSecretSettings();
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
