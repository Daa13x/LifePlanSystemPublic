// Beta authorization audit, 2026-09-01: real User A / User B isolation
// checks against a hosted (LIFE_PLANNER_MULTI_USER=1) server instance.
// Spawns the real server against a disposable database (the same pattern
// scripts/verify-sync-exchange.mjs uses), so this exercises actual HTTP
// auth/ownership enforcement, not a reimplementation of it.
//
// Confirmed via a Codex adversarial audit (COMPLETED -- VALID BUT
// TOKEN-INEFFICIENT; reconciled against source and this live test rather
// than trusted blindly) plus direct source/live verification:
// - roadmap_items/roadmap_candidates have no user_id column, but /api/roadmap*
//   is already correctly excluded from HOSTED_ALLOWED_PREFIXES -- confirmed
//   404 for an authenticated hosted user below, NOT a live cross-user leak
//   (an earlier characterization of this as an unmitigated beta blocker is
//   corrected here with real evidence).
// - approvals/memory_candidates WERE listed globally (no user_id filter)
//   through the allowlisted /api/planner endpoint -- fixed by making both
//   intentionally empty under MULTI_USER rather than retrofitting
//   per-user ownership onto single-instance AI-agent workflows never
//   designed for multi-tenancy.
// - settings.capacityMode WAS a single global value any tester could
//   change for every other tester -- fixed by freezing it at the default
//   under MULTI_USER.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CAPACITY_MODE } from '../server/capacityPlanner.js';

const root = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-hosted-isolation-'));
const dbPath = path.join(probeRoot, 'life-planner.sqlite');

let failures = 0;
const line = (ok, message) => { if (!ok) failures += 1; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`); };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

let child;
async function startServer({ multiUser = true } = {}) {
  const port = await freePort();
  const syncPort = await freePort();
  const output = [];
  const env = { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_SYNC_PORT: String(syncPort) };
  if (multiUser) env.LIFE_PLANNER_MULTI_USER = '1';
  else delete env.LIFE_PLANNER_MULTI_USER;
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

try {
  const json = (r) => r.json();

  // --- migration edge case: seed a legacy single-user value BEFORE any
  // hosted account exists, exactly the "upgrading an existing desktop
  // install to hosted beta" scenario -- new testers must NOT inherit it.
  const legacyBase = await startServer({ multiUser: false });
  const legacyCsrf = await fetch(`${legacyBase}/api/csrf-token`).then(json).then((d) => d.data.token);
  const legacySet = await fetch(`${legacyBase}/api/planner/capacity`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LPS-CSRF': legacyCsrf }, body: JSON.stringify({ mode: 'pain-illness' }) }).then(json);
  line(legacySet.ok === true && legacySet.data.mode === 'pain-illness', 'a legacy single-user capacity value is seeded before any hosted account exists');
  child.kill();
  child = null;

  const base = await startServer({ multiUser: true });
  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  // --- register two independent testers -----------------------------------
  const regA = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice-isolation-test', password: 'correct horse battery staple 1' }) }).then(json);
  const regB = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob-isolation-test', password: 'correct horse battery staple 2' }) }).then(json);
  line(regA.ok === true && regB.ok === true, 'both testers register independently');
  const tokenA = regA.data.token;
  const tokenB = regB.data.token;

  // --- A creates a planner task; B cannot see, patch, or delete it --------
  const csrfA = await fetch(`${base}/api/csrf-token`, { headers: auth(tokenA) }).then(json).then((d) => d.data.token);
  const csrfB = await fetch(`${base}/api/csrf-token`, { headers: auth(tokenB) }).then(json).then((d) => d.data.token);
  const mutA = { 'Content-Type': 'application/json', 'X-LPS-CSRF': csrfA, ...auth(tokenA) };
  const mutB = { 'Content-Type': 'application/json', 'X-LPS-CSRF': csrfB, ...auth(tokenB) };

  const taskA = await fetch(`${base}/api/planner/tasks`, { method: 'POST', headers: mutA, body: JSON.stringify({ title: "Alice's private task" }) }).then(json).then((r) => r.data);
  line(Boolean(taskA?.id), "A's task was created");

  const listB = await fetch(`${base}/api/planner/tasks`, { headers: auth(tokenB) }).then(json).then((r) => r.data);
  line(!listB.some((t) => t.id === taskA.id), "B's task list does not include A's task");

  const patchAsB = await fetch(`${base}/api/planner/tasks/${taskA.id}`, { method: 'PATCH', headers: mutB, body: JSON.stringify({ title: 'Hijacked' }) });
  line(patchAsB.status === 404, "B cannot PATCH A's task by known ID (404, not leaked-then-blocked)");

  const completeAsB = await fetch(`${base}/api/planner/tasks/${taskA.id}/complete`, { method: 'POST', headers: mutB });
  line(completeAsB.status === 404, "B cannot complete A's task by known ID");

  const stillAlicesTitle = (await fetch(`${base}/api/planner/tasks`, { headers: auth(tokenA) }).then(json).then((r) => r.data)).find((t) => t.id === taskA.id)?.title;
  line(stillAlicesTitle === "Alice's private task", "A's task title is untouched after B's attempted hijack");

  // --- A creates a chat session; B cannot read or rename it ---------------
  const sessionA = await fetch(`${base}/api/chat/sessions`, { method: 'POST', headers: mutA, body: JSON.stringify({ title: "Alice's private chat" }) }).then(json).then((r) => r.data);
  line(Boolean(sessionA?.id), "A's chat session was created");

  const listSessionsB = await fetch(`${base}/api/chat/sessions`, { headers: auth(tokenB) }).then(json).then((r) => r.data);
  line(!listSessionsB.some((s) => s.id === sessionA.id), "B's session list does not include A's session");

  const readMessagesAsB = await fetch(`${base}/api/chat/sessions/${sessionA.id}/messages`, { headers: auth(tokenB) });
  line(readMessagesAsB.status === 404, "B cannot read A's chat messages by known session ID");

  const renameAsB = await fetch(`${base}/api/chat/sessions/${sessionA.id}`, { method: 'PATCH', headers: mutB, body: JSON.stringify({ title: 'Hijacked' }) });
  line(renameAsB.status === 404, "B cannot rename A's chat session by known ID");

  // --- roadmap is not reachable at all in hosted mode (not a live leak) --
  const roadmapAsA = await fetch(`${base}/api/roadmap`, { headers: auth(tokenA) });
  line(roadmapAsA.status === 404, '/api/roadmap is not reachable under MULTI_USER (excluded from the hosted allowlist)');

  // --- capacity mode is genuinely per-user, not a shared global toggle ----
  const capacityDefaultA = await fetch(`${base}/api/planner/capacity`, { headers: auth(tokenA) }).then(json).then((r) => r.data.mode);
  const capacityDefaultB = await fetch(`${base}/api/planner/capacity`, { headers: auth(tokenB) }).then(json).then((r) => r.data.mode);
  line(capacityDefaultA === DEFAULT_CAPACITY_MODE && capacityDefaultB === DEFAULT_CAPACITY_MODE, 'both fresh testers default to the same starting capacity mode, never inheriting a legacy desktop value');

  const setA = await fetch(`${base}/api/planner/capacity`, { method: 'POST', headers: mutA, body: JSON.stringify({ mode: 'overwhelmed' }) }).then(json);
  line(setA.ok === true && setA.data.mode === 'overwhelmed', "A can set A's own capacity mode");
  const setB = await fetch(`${base}/api/planner/capacity`, { method: 'POST', headers: mutB, body: JSON.stringify({ mode: 'high-focus' }) }).then(json);
  line(setB.ok === true && setB.data.mode === 'high-focus', "B can set B's own, DIFFERENT capacity mode");

  const capacityAfterA = await fetch(`${base}/api/planner/capacity`, { headers: auth(tokenA) }).then(json).then((r) => r.data.mode);
  const capacityAfterB = await fetch(`${base}/api/planner/capacity`, { headers: auth(tokenB) }).then(json).then((r) => r.data.mode);
  line(capacityAfterA === 'overwhelmed', "A still reads A's own value (unaffected by B's write)");
  line(capacityAfterB === 'high-focus', "B still reads B's own, different value");

  // --- approvals/memory_candidates are intentionally empty, not leaked ---
  const plannerA = await fetch(`${base}/api/planner`, { headers: auth(tokenA) }).then(json).then((r) => r.data);
  line(Array.isArray(plannerA.approvals) && plannerA.approvals.length === 0, 'approvals are intentionally empty under MULTI_USER, not a global leak');
  line(Array.isArray(plannerA.candidates) && plannerA.candidates.length === 0, 'memory candidates are intentionally empty under MULTI_USER, not a global leak');

  // --- unauthenticated / malformed / invalid token access -----------------
  const noAuth = await fetch(`${base}/api/planner/tasks`);
  line(noAuth.status === 401, 'an unauthenticated request to a protected route is refused');
  const malformedAuth = await fetch(`${base}/api/planner/tasks`, { headers: { Authorization: 'Bearer not-a-real-token' } });
  line(malformedAuth.status === 401, 'a malformed/invalid bearer token is refused');

  if (failures) {
    console.error(`${failures} hosted-multiuser-isolation check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('All hosted-multiuser-isolation checks passed.');
  }
} catch (error) {
  console.error('Hosted-multiuser-isolation verification crashed:', error);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  try { fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
  catch { /* best-effort temp cleanup; a locked handle here must never mask the real test result above */ }
}
