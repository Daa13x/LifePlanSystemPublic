import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-legacy-user-'));
const file = path.join(dir, 'legacy.sqlite');
try {
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT); INSERT INTO chat_sessions VALUES (7, 'preserve chat', 1, 0, 'x', 'x'); CREATE TABLE planner_tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'); INSERT INTO planner_tasks VALUES (9, 'preserve task', 'active');");
  legacy.close();
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', "const { db } = await import('./server/db.js'); db.close();"], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, LIFE_PLANNER_DB: file }, stdio: 'pipe' });
  run(); run();
  const db = new DatabaseSync(file);
  for (const [table, id, title] of [['chat_sessions', 7, 'preserve chat'], ['planner_tasks', 9, 'preserve task']]) {
    assert.equal(db.prepare(`SELECT user_id FROM ${table} WHERE id = ?`).get(id).user_id, 1);
    assert.equal(db.prepare(`SELECT title FROM ${table} WHERE id = ?`).get(id).title, title);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(table === 'chat_sessions' ? 'idx_chat_sessions_user' : 'idx_planner_tasks_user'));
  }
  db.close(); console.log('Legacy user-column migration preserves rows and is idempotent.');
} finally {
  // Windows can retain a just-closed SQLite WAL directory momentarily.
  let removed = false;
  for (let attempt = 0; attempt < 10 && !removed; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); removed = true; }
    catch (error) { if (attempt === 9) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
}
