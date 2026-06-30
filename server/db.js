import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const dataDir = path.join(root, 'data');
const dbPath = process.env.LIFE_PLANNER_DB || path.join(dataDir, 'life-planner.sqlite');

fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

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
    insertItem.run('blocker', 'Cloud browser automation is not configured yet', 'The app can record consultations, but Playwright-controlled browser execution is unavailable until Playwright is installed and configured.', 'implementation note', 'active', 0.75, 'Playwright is optional for v1 target.', 'app', 'Install Playwright if automated browser consultation is desired.', p1, null);
    insertItem.run('waiting', 'Review candidate memories before promotion', 'Conversation-derived knowledge must move through candidate review before becoming active memory.', 'governance rule', 'stable', 0.95, 'Mission requires chat -> candidate -> reviewed -> approved -> active memory.', 'user', 'Approve, deny, or defer candidates.', p1, null);
    insertItem.run('rule', 'Cloud agents advise, they do not decide', 'External consultation responses must become reviewable suggestions and never automatically change memory.', 'user brief', 'stable', 0.98, 'Reference philosophy from MostlyArmless.', 'user', 'Keep cloud outputs in approval flow.', p1, null);
    insertItem.run('reminder', 'Check stale local context weekly', 'Items not reviewed recently should lose confidence and require verification before promotion.', 'seed', 'active', 0.7, 'Memory decay lowers confidence, not data retention.', 'user', 'Review stale items in Planner.', p2, null);
  }

  const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count;
  if (sessionCount === 0) {
    const sessionId = db.prepare('INSERT INTO chat_sessions (title, pinned) VALUES (?, 1)').run('Life Planner kickoff').lastInsertRowid;
    db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(sessionId, 'assistant', 'Life Planner is ready to collect context. I will treat chat as candidate memory until you approve it.');
  }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, JSON.stringify(value));
}
