// Beta security fix, 2026-09-01: the phone<->desktop sync bridge
// (server/index.js's syncBridgeServer, port LIFE_PLANNER_SYNC_PORT) is a
// personal-desktop/LAN pairing feature only -- it always resolves data
// against LOCAL_USER_ID and has no per-user auth, only a static pairing
// token. A hosted LIFE_PLANNER_MULTI_USER deployment is a separate,
// multi-tenant process where that feature does not apply, so the bridge
// must not even start there -- defense in depth, not merely relying on a
// firewall to happen to block the port. Spawns the real server (the same
// pattern scripts/verify-sync-exchange.mjs uses) so this proves the actual
// startup behavior, not a reimplementation of it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-sync-bridge-multiuser-'));

let failures = 0;
const line = (ok, message) => { if (!ok) failures += 1; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`); };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer({ multiUser }) {
  const dbPath = path.join(probeRoot, `life-planner-${multiUser ? 'multi' : 'single'}.sqlite`);
  const port = await freePort();
  const syncPort = await freePort();
  const output = [];
  const env = { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_SYNC_PORT: String(syncPort) };
  if (multiUser) env.LIFE_PLANNER_MULTI_USER = '1';
  else delete env.LIFE_PLANNER_MULTI_USER;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (c) => output.push(String(c)));
  child.stderr.on('data', (c) => output.push(String(c)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).\n${output.join('')}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base, bridge: `http://127.0.0.1:${syncPort}`, output }; }
    catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become healthy.\n${output.join('')}`);
}

async function bridgeReachable(bridge) {
  try {
    const response = await fetch(`${bridge}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

let singleUser;
let multiUser;
try {
  // --- ordinary single-user/desktop operation: unaffected by this fix ----
  singleUser = await startServer({ multiUser: false });
  line(await bridgeReachable(singleUser.bridge), 'sync bridge IS reachable for ordinary single-user/desktop operation (unchanged existing behavior)');

  // --- hosted multi-user beta: the bridge must never start at all --------
  multiUser = await startServer({ multiUser: true });
  line(!(await bridgeReachable(multiUser.bridge)), 'sync bridge does NOT start when LIFE_PLANNER_MULTI_USER is set (fail-closed)');
  line(multiUser.output.join('').includes('Phone sync bridge disabled'), 'the disabled state is logged, not silently absent');

  if (failures) {
    console.error(`${failures} sync-bridge-multiuser check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('All sync-bridge-multiuser checks passed.');
  }
} catch (error) {
  console.error('Sync-bridge-multiuser verification crashed:', error);
  process.exitCode = 1;
} finally {
  for (const instance of [singleUser, multiUser]) {
    if (instance?.child && instance.child.exitCode === null) instance.child.kill();
  }
  try { fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
  catch { /* best-effort temp cleanup; a locked handle here must never mask the real test result above */ }
}
