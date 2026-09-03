import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mock, test } from 'node:test';

const sqlite = new DatabaseSync(':memory:');
const calls = [];

const database = {
  async open() {},
  async execute(sql) {
    calls.push(['execute', sql]);
    if (/^\s*PRAGMA\s+/i.test(sql)) {
      throw new Error('Queries can be performed using SQLiteDatabase query or rawQuery methods only.');
    }
    sqlite.exec(sql);
    return { changes: 0 };
  },
  async query(sql, values = []) {
    calls.push(['query', sql]);
    if (/^\s*PRAGMA\s+journal_mode\s*=\s*WAL/i.test(sql)) {
      return { values: [{ journal_mode: 'wal' }] };
    }
    return { values: sqlite.prepare(sql).all(...values) };
  },
  async run(sql, values = []) {
    calls.push(['run', sql]);
    const result = sqlite.prepare(sql).run(...values);
    return { changes: { changes: Number(result.changes), lastId: Number(result.lastInsertRowid || 0) } };
  },
  async executeSet(set, transaction = true) {
    if (transaction) sqlite.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of set) sqlite.prepare(entry.statement).run(...(entry.values || []));
      if (transaction) sqlite.exec('COMMIT');
      return { changes: { changes: set.length } };
    } catch (error) {
      if (transaction) sqlite.exec('ROLLBACK');
      throw error;
    }
  },
  async beginTransaction() { sqlite.exec('BEGIN IMMEDIATE'); },
  async commitTransaction() { sqlite.exec('COMMIT'); },
  async rollbackTransaction() { sqlite.exec('ROLLBACK'); }
};

class SQLiteConnection {
  async checkConnectionsConsistency() { return { result: true }; }
  async isConnection() { return { result: false }; }
  async createConnection() { return database; }
}

mock.module('@capacitor-community/sqlite', {
  namedExports: { CapacitorSQLite: {}, SQLiteConnection }
});

const local = await import('../src/localData.js');

test('native startup classifies the result-returning WAL PRAGMA as a query', async () => {
  const day = await local.localPlannerDay();
  assert.equal(day.mode, 'normal');
  assert.ok(calls.some(([method, sql]) => method === 'query' && /^PRAGMA journal_mode=WAL;/i.test(sql)));
  assert.ok(!calls.some(([method, sql]) => method === 'execute' && /^\s*PRAGMA/i.test(sql)));
});

test('Today create, edit, defer, complete, reopen and persistence use the real local schema', async () => {
  const task = await local.localCreateTask({ title: 'Physical beta task', next_action: 'Tap it', importance: 4, effort: 2 });
  assert.equal((await local.localListTasks()).find((item) => item.id === task.id)?.title, 'Physical beta task');
  assert.equal((await local.localUpdateTask(task.id, { title: 'Edited beta task' })).title, 'Edited beta task');
  assert.equal((await local.localDeferTask(task.id)).status, 'deferred');
  assert.equal((await local.localUpdateTask(task.id, { status: 'active' })).status, 'active');
  const completed = await local.localCompleteTask(task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completionHistoryAvailable, true);
  assert.ok((await local.localTaskEvents(task.id)).some((event) => event.eventType === 'completed'));
  assert.equal((await local.localUpdateTask(task.id, { status: 'active' })).status, 'active');
});

test('Projects, Cards and Completed data persist without a PC', async () => {
  const project = await local.localCreateProject({ name: 'Phone-only project', next_action: 'Keep local' });
  await local.localUpdateProject(project.id, { status: 'completed', next_action: 'Done' });
  const projects = await local.localListProjects();
  assert.equal(projects.find((item) => item.id === project.id)?.status, 'completed');
  const cards = await local.localListProjectCards();
  assert.equal(cards.find((item) => item.id === project.id)?.pinned.title, 'Phone-only project');
});

test('on-device Chat creates, patches and persists messages without a PC', async () => {
  assert.deepEqual(await local.localListSessions(), []);
  const session = await local.localCreateSession('New planning chat');
  await local.localPatchSession(session.id, { title: 'Android chat', pinned: 1 });
  await local.localAppendMessage(session.id, 'user', 'add task Buy milk');
  await local.localAppendMessage(session.id, 'assistant', 'Added: Buy milk');
  const sessions = await local.localListSessions();
  const messages = await local.localListMessages(session.id);
  assert.equal(sessions[0].title, 'Android chat');
  assert.deepEqual(messages.map((item) => item.role), ['user', 'assistant']);
  assert.deepEqual(messages.map((item) => item.content), ['add task Buy milk', 'Added: Buy milk']);
});

test.after(() => sqlite.close());
