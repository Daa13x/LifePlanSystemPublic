// Deterministic acceptance for the Phase 4 change-journal groundwork
// (server/db.js's sync_outbox/recordSyncOutboxEntry, wired into
// applyPlannerTaskFields and the two planner_tasks creation routes).
// Spawns the real server against a disposable database -- the same
// pattern this repo's other HTTP acceptance scripts use -- so this
// exercises the actual route handlers, not a reimplementation of their
// logic.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-sync-outbox-'));
const dbPath = path.join(probeRoot, 'life-planner.sqlite');

let child;
async function startServer(port) {
  const output = [];
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (c) => output.push(String(c)));
  child.stderr.on('data', (c) => output.push(String(c)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).\n${output.join('')}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return base; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become healthy.\n${output.join('')}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

let failures = 0;
const line = (ok, message) => { if (!ok) failures += 1; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`); };

try {
  const port = await freePort();
  const base = await startServer(port);
  const json = (r) => r.json().then((b) => b.data);
  // Desktop mode's loopback mutation guard requires this per-runtime token
  // on every state-changing request (see server/mutationGuard.js) -- the
  // same as a real browser client fetches once and reuses.
  const csrfToken = await fetch(`${base}/api/csrf-token`).then(json).then((d) => d.token);
  const mutHeaders = { 'Content-Type': 'application/json', 'X-LPS-CSRF': csrfToken };

  // --- create: exactly one outbox entry, revision 1 -------------------
  const created = await fetch(`${base}/api/planner/tasks`, { method: 'POST', headers: mutHeaders, body: JSON.stringify({ title: 'Outbox task A' }) }).then(json);
  line(Boolean(created.sync_id), 'a newly created task has a sync_id');
  line(created.revision === 1, 'a newly created task starts at revision 1');

  const readDb = () => new DatabaseSync(dbPath, { readOnly: true });

  {
    const db = readDb();
    const rows = db.prepare("SELECT * FROM sync_outbox WHERE entity_type = 'planner_task' AND entity_sync_id = ?").all(created.sync_id);
    line(rows.length === 1, 'create appends exactly one outbox entry');
    line(rows[0]?.op === 'upsert', 'create is recorded as an upsert');
    line(rows[0]?.revision === 1, 'create is recorded at revision 1');
    line(JSON.parse(rows[0]?.payload || '{}').title === 'Outbox task A', 'the outbox payload carries the real task title');
    db.close();
  }

  // --- complete: task upsert (revision 2) + one event upsert -----------
  await fetch(`${base}/api/planner/tasks/${created.id}/complete`, { method: 'POST', headers: mutHeaders }).then(json);
  {
    const db = readDb();
    const taskRows = db.prepare("SELECT * FROM sync_outbox WHERE entity_type = 'planner_task' AND entity_sync_id = ? ORDER BY seq").all(created.sync_id);
    line(taskRows.length === 2, 'completing a task appends exactly one MORE task outbox entry (2 total)');
    line(taskRows[1]?.revision === 2, 'completion bumps the outbox-recorded revision to 2');
    const eventRows = db.prepare("SELECT * FROM sync_outbox WHERE entity_type = 'planner_task_event'").all();
    line(eventRows.length === 1, 'completing a task appends exactly one lifecycle-event outbox entry');
    line(JSON.parse(eventRows[0]?.payload || '{}').event_type === 'completed', 'the event outbox payload records the real event type');
    const eventSyncId = eventRows[0]?.entity_sync_id;
    const realEvent = db.prepare('SELECT sync_id FROM planner_task_events WHERE sync_id = ?').get(eventSyncId);
    line(Boolean(realEvent), "the event outbox entry's entity_sync_id matches a real planner_task_events row (not a fabricated id)");
    db.close();
  }

  // --- reopen (defer then complete again): a second real event, second outbox entry, no duplicates ---
  await fetch(`${base}/api/planner/tasks/${created.id}`, { method: 'PATCH', headers: mutHeaders, body: JSON.stringify({ status: 'active' }) }).then(json);
  {
    const db = readDb();
    const eventRows = db.prepare("SELECT * FROM sync_outbox WHERE entity_type = 'planner_task_event'").all();
    line(eventRows.length === 2, 'reopening appends a second, distinct lifecycle-event outbox entry (2 total)');
    const distinctChangeIds = new Set(db.prepare('SELECT change_id FROM sync_outbox').all().map((r) => r.change_id));
    const totalRows = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
    line(distinctChangeIds.size === totalRows, 'every outbox row has a distinct change_id -- no accidental duplicate/collision');
    db.close();
  }

  // --- a task never mutated again produces no further outbox noise -----
  const created2 = await fetch(`${base}/api/planner/tasks`, { method: 'POST', headers: mutHeaders, body: JSON.stringify({ title: 'Untouched task' }) }).then(json);
  await fetch(`${base}/api/planner/tasks`).then(json); // an unrelated read must never itself append an outbox row
  {
    const db = readDb();
    const rows = db.prepare("SELECT * FROM sync_outbox WHERE entity_type = 'planner_task' AND entity_sync_id = ?").all(created2.sync_id);
    line(rows.length === 1, 'a task with no further mutation has exactly one outbox entry (its creation) -- reads never append');
    db.close();
  }

  if (failures) {
    console.error(`${failures} sync-outbox check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('All sync-outbox checks passed.');
  }
} catch (error) {
  console.error('Sync-outbox verification crashed:', error);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  try { fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
  catch { /* best-effort temp cleanup; a locked handle here must never mask the real test result above */ }
}
