import { spawn } from 'node:child_process';

function forcedError(kind, timeoutMs = 0) {
  if (kind === 'abort') {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    error.killed = true;
    error.signal = 'SIGTERM';
    return error;
  }
  if (kind === 'maxBuffer') {
    const error = new Error('stdout or stderr exceeded maxBuffer');
    error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    error.killed = true;
    error.signal = 'SIGTERM';
    return error;
  }
  const error = new Error(`Command timed out after ${timeoutMs}ms`);
  error.code = 'ETIMEDOUT';
  error.killed = true;
  error.signal = 'SIGTERM';
  return error;
}

function terminateProcessTree(child) {
  if (!child?.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { child.kill('SIGTERM'); } catch { /* process already exited */ }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* taskkill already settled it */ }
      resolve();
    };
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('close', done);
      killer.once('error', done);
    } catch {
      done();
    }
  });
}

export function execFileWithTreeAbort(command, args = [], options = {}, signal = null) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeout || 0);
    const maxBuffer = Number(options.maxBuffer || 1024 * 1024);
    const spawnOptions = { ...options, stdio: ['ignore', 'pipe', 'pipe'] };
    delete spawnOptions.timeout;
    delete spawnOptions.maxBuffer;
    delete spawnOptions.encoding;
    delete spawnOptions.signal;

    let child;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let forced = null;
    let termination = Promise.resolve();
    let timer = null;
    let spawnError = null;

    const forceTermination = (kind) => {
      if (forced) return termination;
      forced = forcedError(kind, timeoutMs);
      termination = terminateProcessTree(child);
      return termination;
    };
    const onAbort = () => { void forceTermination('abort'); };

    try {
      child = spawn(command, args, spawnOptions);
    } catch (error) {
      reject(error);
      return;
    }

    const collect = (stream, chunk) => {
      const next = Buffer.concat([stream === 'stdout' ? stdout : stderr, Buffer.from(chunk)]);
      if (stream === 'stdout') stdout = next.subarray(0, maxBuffer);
      else stderr = next.subarray(0, maxBuffer);
      if (next.length > maxBuffer) void forceTermination('maxBuffer');
    };
    child.stdout?.on('data', (chunk) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk) => collect('stderr', chunk));
    child.once('error', (error) => { spawnError = error; });

    const finish = async (code, childSignal) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      await termination;
      const stdoutText = stdout.toString(options.encoding || 'utf8');
      const stderrText = stderr.toString(options.encoding || 'utf8');
      if (forced || spawnError || code !== 0) {
        const error = forced || spawnError || new Error(`Command failed with exit code ${code}`);
        if (error.code === undefined || error.code === null) error.code = code;
        if (!error.signal && childSignal) error.signal = childSignal;
        error.stdout = stdoutText;
        error.stderr = stderrText;
        reject(error);
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    };
    child.once('close', (code, childSignal) => { void finish(code, childSignal); });

    if (timeoutMs > 0) timer = setTimeout(() => { void forceTermination('timeout'); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
