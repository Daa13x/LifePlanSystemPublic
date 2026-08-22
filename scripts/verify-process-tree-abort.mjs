#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileWithTreeAbort } from '../server/processTree.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-process-tree-'));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return Number(fs.readFileSync(file, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Descendant PID was not written within ${timeoutMs}ms.`);
}

async function proveTreeTermination(kind) {
  const pidFile = path.join(temp, `${kind}.pid`);
  const childCode = 'setInterval(() => {}, 1000)';
  const parentCode = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });`,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    kind === 'maxBuffer' ? "setInterval(() => process.stdout.write('x'.repeat(4096)), 5);" : 'setInterval(() => {}, 1000);'
  ].join('\n');
  const operation = execFileWithTreeAbort(process.execPath, ['-e', parentCode], {
    windowsHide: true,
    timeout: kind === 'timeout' ? 500 : 5000,
    maxBuffer: kind === 'maxBuffer' ? 1024 : 1024 * 1024
  });
  const descendantPid = await waitForFile(pidFile);
  await assert.rejects(operation, kind === 'timeout' ? /timed out/i : /maxBuffer/i);
  assert.equal(alive(descendantPid), false, `${kind} must terminate descendants before the helper settles`);
}

try {
  await proveTreeTermination('timeout');
  await proveTreeTermination('maxBuffer');
  console.log('PASS process-tree timeout and output-limit termination');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
