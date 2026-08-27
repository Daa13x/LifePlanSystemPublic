import { spawn } from 'node:child_process';
import fs from 'node:fs';

const RETRYABLE_REMOVE_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function childClosed(child) {
  if (!child || (child.exitCode === null && child.signalCode === null)) return false;
  return [child.stdout, child.stderr].every((stream) => !stream || stream.closed || stream.destroyed);
}

function waitForChildClose(child, timeoutMs) {
  if (childClosed(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish();
    const timer = setTimeout(() => finish(new Error(
      `Installed Chat server did not close within ${timeoutMs}ms ` +
      `(pid=${child.pid ?? 'unknown'}, exitCode=${child.exitCode ?? 'null'}, signal=${child.signalCode ?? 'null'}).`
    )), timeoutMs);
    child.once('close', onClose);
    if (childClosed(child)) finish();
  });
}

function taskkillTree(child, spawnProcess, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let killer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { killer?.kill(); } catch { /* the terminator already exited */ }
      finish({ error: new Error(`taskkill did not settle within ${timeoutMs}ms.`) });
    }, timeoutMs);
    try {
      killer = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('error', (error) => finish({ error }));
      killer.once('close', (code, signal) => finish({ code, signal }));
    } catch (error) {
      finish({ error });
    }
  });
}

export async function stopInstalledChatServer(child, {
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = 5000
} = {}) {
  if (!child || childClosed(child)) return;
  if (!child.pid) throw new Error('Installed Chat process-tree termination failed: child has no PID.');

  // Subscribe before terminating so an immediate exit cannot race the waiter.
  const closePromise = waitForChildClose(child, timeoutMs);
  let terminationPromise;
  if (platform === 'win32') {
    terminationPromise = taskkillTree(child, spawnProcess, timeoutMs);
  } else {
    let termination = null;
    try {
      const signalled = child.kill('SIGTERM');
      if (!signalled) termination = { error: new Error('SIGTERM was not delivered.') };
    } catch (error) {
      termination = { error };
    }
    terminationPromise = Promise.resolve(termination);
  }

  const [terminationResult, closeResult] = await Promise.allSettled([terminationPromise, closePromise]);
  const termination = terminationResult.status === 'fulfilled' ? terminationResult.value : { error: terminationResult.reason };
  if (termination?.error || (platform === 'win32' && termination?.code !== 0)) {
    const detail = termination?.error
      ? `error=${termination.error.message}`
      : `exitCode=${termination.code} signal=${termination.signal ?? 'null'}`;
    const closeDetail = closeResult.status === 'rejected' ? ` ${closeResult.reason.message}` : '';
    throw new Error(
      `Installed Chat process-tree termination failed (pid=${child.pid ?? 'unknown'}, ${detail}).${closeDetail}`,
      { cause: termination?.error || closeResult.reason }
    );
  }
  if (closeResult.status === 'rejected') {
    const error = closeResult.reason;
    const terminationDetail = termination?.error
      ? ` terminationError=${termination.error.message}`
      : termination && termination.code !== 0
        ? ` taskkillExit=${termination.code} taskkillSignal=${termination.signal ?? 'null'}`
        : '';
    throw new Error(`${error.message}${terminationDetail}`, { cause: termination?.error || error });
  }
}

export async function removeInstalledChatFixture(target, {
  removeSync = fs.rmSync,
  maxAttempts = 8,
  retryDelayMs = 100,
  wait = sleep
} = {}) {
  let lastError = null;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    try {
      removeSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_REMOVE_CODES.has(error?.code) || attempt === maxAttempts) break;
      await wait(retryDelayMs * attempt);
    }
  }
  throw new Error(
    `Unable to remove installed Chat fixture after ${attemptsUsed} attempt(s): ` +
    `${lastError?.code || lastError?.name || 'unknown'} ${lastError?.message || ''}`.trim(),
    { cause: lastError }
  );
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function attachFinalizerFailure(primary, name, failure) {
  const error = asError(failure);
  primary.message += `\nAdditional ${name} failure: ${error.message}`;
  primary.finalizerFailures ||= [];
  primary.finalizerFailures.push({ name, error });
}

export async function runWithFinalizers(action, finalizers) {
  let primary = null;
  try {
    await action();
  } catch (error) {
    primary = asError(error);
  }
  for (const { name, run } of finalizers) {
    try {
      await run();
    } catch (error) {
      if (primary) attachFinalizerFailure(primary, name, error);
      else primary = asError(error);
    }
  }
  if (primary) throw primary;
}
