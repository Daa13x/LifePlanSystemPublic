import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// HTTP acceptance for the layered Workboard card endpoints on a disposable
// LIFE_PLANNER_DB (never the user's data): creating a card records a canonical
// append-only 'created' event, the card projects all five layers, and the
// projection is read-only. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-workorder-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
async function startServer(port) {
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: appRoot,
    env: { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing.json') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  child.stdout.on('data', (c) => output.push(String(c)));
  child.stderr.on('data', (c) => output.push(String(c)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).\n${output.join('')}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become healthy.\n${output.join('')}`);
}
async function stopServer(child) { if (child.exitCode === null) child.kill(); for (let i = 0; i < 40 && child.exitCode === null; i += 1) await new Promise((r) => setTimeout(r, 50)); }

let base = '';
let token = '';
async function api(route, { method = 'GET', json } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') { headers.Origin = base; headers['X-LPS-CSRF'] = token; }
  const res = await fetch(`${base}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

console.log('--- workboard cards HTTP verification ---');
const server = await startServer(await freePort());
base = server.base;
try {
  token = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;

  line((await api('/api/workboard/cards/999999')).status === 404, 'an unknown card returns 404');

  const created = await api('/api/projects', { method: 'POST', json: { name: 'Sort out council tax', status: 'active' } });
  line(created.status === 200 && created.body.data.id, 'a Workboard card (project) is created');
  const id = created.body.data.id;

  const card = (await api(`/api/workboard/cards/${id}`)).body.data;
  line(card && card.pinned && card.pinned.title === 'Sort out council tax' && card.pinned.status === 'active', 'the card projects the canonical pinned identity');
  line(['glance', 'context', 'execution', 'proof', 'history'].every((layer) => card[layer] && typeof card[layer].populated === 'boolean'), 'all five layers are projected with an honest populated flag');
  line(card.history.events.length === 1 && card.history.events[0].type === 'created', 'creating the card recorded exactly one canonical append-only "created" event');
  line(card.history.events[0].toStatus === 'active' && card.history.events[0].actor, 'the created event records the initial status and responsible actor');
  line(card.proof.populated === false && card.glance.progress === null, 'unrecorded layers are honestly empty (no fabricated evidence or progress)');

  const list = await api('/api/workboard/cards');
  line(list.status === 200 && Array.isArray(list.body.data) && list.body.data.some((c) => c.id === id), 'the card list projects every project as a work order');

  // The projection is read-only: reading a card must not append new events.
  const before = (await api(`/api/workboard/cards/${id}`)).body.data.history.events.length;
  await api(`/api/workboard/cards/${id}`);
  const after = (await api(`/api/workboard/cards/${id}`)).body.data.history.events.length;
  line(before === after && after === 1, 'reading a card is read-only — it never appends history');
} finally {
  await stopServer(server.child);
  fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll workboard-cards HTTP checks passed.');
process.exit(failures ? 1 : 0);
