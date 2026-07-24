// Shell-free "open this folder in Windows Explorer" helper.
//
// Two defects motivated this module:
//   1. explorer.exe returns a NON-ZERO exit code even when it successfully opens
//      a new window, so awaiting it via promisify(execFile) (which rejects on a
//      non-zero exit) made the connector report "Command failed: explorer.exe …"
//      even though the folder opened. We spawn shell-free and treat a successful
//      *spawn* as success; only a spawn error (e.g. the binary is missing) fails.
//   2. Paths were shown/opened malformed (e.g. "D:_Code_\…" missing the drive
//      backslash). We never hand-edit separators — Node's path resolver produces
//      the absolute, OS-native path, preserving drive letters, underscores,
//      spaces, parentheses, Unicode, and installed/portable layouts.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Absolute, OS-native normalization. Injectable pathImpl lets tests exercise
// Windows semantics deterministically via path.win32.
export function normalizeFolderPath(input, pathImpl = path) {
  const raw = String(input == null ? '' : input);
  if (!raw.trim()) throw new Error('An empty folder path cannot be opened.');
  return pathImpl.resolve(raw);
}

// Resolve + validate a folder path without launching anything. Returns
// { resolved }. Throws with the resolved path when it is missing or not a dir,
// so callers can surface an actionable message.
export function resolveExistingFolder(input, { fsImpl = fs, pathImpl = path } = {}) {
  const resolved = normalizeFolderPath(input, pathImpl);
  let stat;
  try {
    stat = fsImpl.statSync(resolved);
  } catch {
    throw new Error(`Folder does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${resolved}`);
  return { resolved };
}

// Open the folder in Explorer (shell-free). Returns the normalized path that was
// opened so the API/UI can display exactly what was targeted. Resolves as soon
// as the child process spawns; a non-zero explorer exit code is NOT a failure.
export function openFolderInExplorer(input, { spawnImpl = spawn, fsImpl = fs, pathImpl = path } = {}) {
  const { resolved } = resolveExistingFolder(input, { fsImpl, pathImpl });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    let child;
    try {
      // Folder path is a SEPARATE argument — never concatenated into a command
      // string — so spaces and special characters need no manual quoting.
      child = spawnImpl('explorer.exe', [resolved], { windowsHide: true });
    } catch (error) {
      return finish(reject, error);
    }
    child.once('error', (error) => finish(reject, error)); // spawn failed (ENOENT, etc.)
    child.once('spawn', () => finish(resolve, resolved));   // launched OK; ignore exit code
  });
}
