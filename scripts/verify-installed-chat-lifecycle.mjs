#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  removeInstalledChatFixture,
  runWithFinalizers,
  stopInstalledChatServer
} from './installed-chat-lifecycle.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-installed-chat-lifecycle-'));

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

async function proveNormalShutdownAndCleanup() {
  const fixture = path.join(temp, 'normal');
  fs.mkdirSync(fixture);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await stopInstalledChatServer(child);
    await removeInstalledChatFixture(fixture);
    assert.equal(fs.existsSync(fixture), false, 'normal shutdown must release the removable fixture');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* test-owned best effort */ }
  }
}

async function proveCleanupRetries() {
  let attempts = 0;
  await removeInstalledChatFixture('transient-fixture', {
    removeSync: () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
    },
    wait: async () => {}
  });
  assert.equal(attempts, 3, 'transient cleanup failure must recover within the retry bound');

  attempts = 0;
  await assert.rejects(removeInstalledChatFixture('permanent-fixture', {
    maxAttempts: 3,
    removeSync: () => {
      attempts += 1;
      throw Object.assign(new Error('still locked'), { code: 'EPERM' });
    },
    wait: async () => {}
  }), /after 3 attempt\(s\).*EPERM.*still locked/i);
  assert.equal(attempts, 3, 'permanent cleanup failure must exhaust the bound and fail closed');
}

async function proveFailurePrecedence() {
  const behaviorFailure = new Error('meaningful behavior failure');
  let finalizers = 0;
  let observed = null;
  try {
    await runWithFinalizers(async () => { throw behaviorFailure; }, [
      { name: 'shutdown', run: async () => { finalizers += 1; throw new Error('shutdown also failed'); } },
      { name: 'cleanup', run: async () => { finalizers += 1; } }
    ]);
  } catch (error) {
    observed = error;
  }
  assert.equal(observed, behaviorFailure, 'finalizer errors must not replace the behavior failure');
  assert.match(observed.message, /meaningful behavior failure/);
  assert.match(observed.message, /Additional shutdown failure/);
  assert.equal(finalizers, 2, 'all finalizers must run after a behavior failure');
}

async function proveAlreadyExitedDoesNotHang() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await stopInstalledChatServer(child, {
    spawnProcess: () => { throw new Error('terminator must not run for an exited child'); },
    timeoutMs: 100
  });
}

async function proveTreeTerminationFailuresFailClosed() {
  const proveFailure = async ({ spawnError = null, exitCode = 0 }) => {
    const child = new EventEmitter();
    Object.assign(child, {
      pid: 424242,
      exitCode: null,
      signalCode: null,
      stdout: { destroyed: false },
      stderr: { destroyed: false }
    });
    const spawnProcess = () => {
      const killer = new EventEmitter();
      killer.kill = () => true;
      setImmediate(() => {
        if (spawnError) killer.emit('error', spawnError);
        else killer.emit('close', exitCode, null);
        child.exitCode = 0;
        child.stdout.destroyed = true;
        child.stderr.destroyed = true;
        child.emit('close', 0, null);
      });
      return killer;
    };
    await assert.rejects(
      stopInstalledChatServer(child, { platform: 'win32', spawnProcess, timeoutMs: 250 }),
      /process-tree termination failed.*pid=424242/i
    );
  };
  await proveFailure({ exitCode: 1 });
  await proveFailure({ spawnError: new Error('taskkill spawn failed') });
}

async function proveWindowsDescendantTermination() {
  if (process.platform !== 'win32') return;
  const pidFile = path.join(temp, 'descendant.pid');
  const childCode = 'setInterval(() => {}, 1000)';
  const parentCode = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore', windowsHide: true });`,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);'
  ].join('\n');
  const parent = spawn(process.execPath, ['-e', parentCode], { stdio: 'ignore', windowsHide: true });
  let descendantPid = null;
  try {
    descendantPid = await waitForFile(pidFile);
    await stopInstalledChatServer(parent);
    assert.equal(alive(descendantPid), false, 'Windows shutdown must terminate the server descendant tree');
  } finally {
    for (const pid of [parent.pid, descendantPid].filter(Boolean)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* test-owned best effort */ }
    }
  }
}

try {
  await proveNormalShutdownAndCleanup();
  await proveCleanupRetries();
  await proveFailurePrecedence();
  await proveAlreadyExitedDoesNotHang();
  await proveTreeTerminationFailuresFailClosed();
  await proveWindowsDescendantTermination();
  console.log('PASS installed Chat lifecycle shutdown, cleanup retries, and failure precedence');
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
