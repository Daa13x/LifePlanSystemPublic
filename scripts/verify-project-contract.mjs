#!/usr/bin/env node
// Exercises the live Node compatibility route on a disposable profile. The
// native command fixture uses the same canonical constraints before any write
// route is eligible for transfer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-project-contract-'));
const dbPath = path.join(probe, 'data', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port: freePort } = server.address();
    server.close(() => resolve(freePort));
  });
});
const base = `http://127.0.0.1:${port}`;
const output = [];
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, LIFE_PLANNER_PORT: String(port), LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probe, 'pairing.json') },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
child.stdout.on('data', (chunk) => output.push(String(chunk)));
child.stderr.on('data', (chunk) => output.push(String(chunk)));

try {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(`Project contract verifier server exited early (${child.exitCode}): ${output.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (attempt === 149) throw new Error('Project contract verifier server did not become healthy.');
  }
  const csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
  const create = async (body) => fetch(`${base}/api/projects`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-LPS-CSRF': csrf }, body: JSON.stringify(body)
  });

  const accepted = await create({ name: 'Validated project', status: 'blocked', owner: 'Alex', confidence: 0.6, evidence: 'Verifier', next_action: 'Review.' });
  assert.equal(accepted.status, 200, 'bounded project request is accepted');
  const record = (await accepted.json()).data;
  assert.deepEqual(
    { name: record.name, status: record.status, owner: record.owner, source: record.source, confidence: record.confidence, evidence: record.evidence, next_action: record.next_action },
    { name: 'Validated project', status: 'blocked', owner: 'Alex', source: 'manual', confidence: 0.6, evidence: 'Verifier', next_action: 'Review.' },
    'accepted project preserves the compatibility record shape'
  );

  for (const body of [
    { name: 'x'.repeat(201) },
    { name: 'Bad status', status: 'unknown-status' },
    { name: 'Bad owner', owner: ' ' },
    { name: 'Bad confidence', confidence: 1.1 },
    { name: 'Bad evidence', evidence: 'x'.repeat(4001) },
    { name: 'Bad next action', next_action: 'x'.repeat(4001) }
  ]) {
    assert.equal((await create(body)).status, 400, `invalid project request is rejected: ${JSON.stringify(Object.keys(body))}`);
  }
  console.log('Project contract verification passed: direct compatibility validation and canonical record shape are enforced.');
} finally {
  if (child.exitCode === null) child.kill();
  for (let attempt = 0; child.exitCode === null && attempt < 40; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(probe, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
