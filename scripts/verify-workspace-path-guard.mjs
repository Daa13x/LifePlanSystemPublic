import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspacePath, lexicalWorkspacePath, nearestExistingParent } from '../server/workspacePathGuard.js';

// Acceptance for the centralized Repository Explorer path guard. Proves that
// canonical realpath containment closes the symlink/junction escape that lexical
// containment alone allows, and that lexical/create/protected cases still hold.
// Pure and local: builds a disposable workspace with a real junction that points
// OUTSIDE the workspace and asserts every escape is rejected. Exit 0 = pass.

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };
const throws = (fn, label) => {
  try { fn(); line(false, `${label} — expected rejection but resolved`); }
  catch { line(true, label); }
};
const resolvesTo = (fn, label) => {
  try { return fn(); }
  catch (error) { line(false, `${label} — expected success but threw: ${error.message}`); return null; }
};

console.log('--- workspace path guard verification ---');

// A workspace root, and a sibling "outside" tree the workspace must never reach.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-pathguard-'));
fs.mkdirSync(path.join(scratch, 'workspace'), { recursive: true });
const root = fs.realpathSync.native(path.join(scratch, 'workspace'));
const outside = path.join(scratch, 'outside');
fs.mkdirSync(outside, { recursive: true });
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'inside.md'), '# inside\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET-OUTSIDE-WORKSPACE\n');

// Plant a junction inside the workspace that points at the outside tree. On
// Windows a junction needs no elevation; elsewhere a dir symlink is equivalent.
let junctionPlanted = false;
try {
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  junctionPlanted = true;
} catch (error) {
  console.log(`note  could not plant a junction/symlink on this platform (${error.code || error.message}); escape checks are skipped here but still run in CI`);
}

try {
  // --- lexical containment ---
  throws(() => resolveWorkspacePath(root, '../secret.txt'), 'a parent-traversal path is rejected');
  throws(() => resolveWorkspacePath(root, 'docs/../../secret.txt'), 'an embedded parent traversal is rejected');
  throws(() => resolveWorkspacePath(root, 'C:/Windows/win.ini'), 'a drive-absolute path is rejected');
  throws(() => resolveWorkspacePath(root, '\\\\server\\share\\x'), 'a UNC path is rejected');
  // A leading slash is stripped to a workspace-relative path (not an escape): it
  // must resolve strictly inside the workspace, never at the filesystem root.
  const slashy = resolvesTo(() => resolveWorkspacePath(root, '/etc/passwd'), 'a leading-slash path normalizes to workspace-relative');
  line(!!slashy && slashy.normalized === 'etc/passwd' && slashy.absolute.startsWith(root), 'a leading-slash path stays inside the workspace, not the OS root');
  throws(() => resolveWorkspacePath(root, 'docs/in\0side.md'), 'a NUL byte is rejected');
  throws(() => resolveWorkspacePath(root, '   '), 'an empty path is rejected');

  // --- canonical containment (the escape that lexical checks miss) ---
  if (junctionPlanted) {
    throws(() => resolveWorkspacePath(root, 'escape/secret.txt', { mustExist: true, mustBeFile: true }),
      'a read through an inside junction that points outside is rejected');
    throws(() => resolveWorkspacePath(root, 'escape/newfile.txt'),
      'a create whose parent is a junction pointing outside is rejected');
    throws(() => resolveWorkspacePath(root, 'escape'),
      'the junction directory itself is rejected as a link/out-of-tree');
    // The junction is lexically contained — prove the rejection is canonical, not lexical.
    const lex = resolvesTo(() => lexicalWorkspacePath(root, 'escape/secret.txt'), 'the escape path passes the lexical-only check');
    line(!!lex && lex.normalized === 'escape/secret.txt', 'lexical containment alone would have admitted the escape');
  }

  // --- legitimate reads/creates still work ---
  const good = resolvesTo(() => resolveWorkspacePath(root, 'docs/inside.md', { mustExist: true, mustBeFile: true }), 'an in-workspace file resolves');
  line(!!good && good.normalized === 'docs/inside.md', 'the resolved file keeps its workspace-relative normalized path');
  line(!!good && fs.realpathSync.native(good.absolute) === good.absolute, 'the resolved absolute path is already canonical');
  const create = resolvesTo(() => resolveWorkspacePath(root, 'docs/new-note.md'), 'a create under an existing in-workspace dir resolves');
  line(!!create && create.normalized === 'docs/new-note.md', 'a nested create keeps its normalized path');

  // --- read/existence and protected gating ---
  throws(() => resolveWorkspacePath(root, 'docs/missing.md', { mustExist: true }), 'a missing file fails mustExist');
  throws(() => resolveWorkspacePath(root, 'docs', { mustExist: true, mustBeFile: true }), 'a directory fails mustBeFile');
  throws(() => resolveWorkspacePath(root, 'docs/inside.md', { isProtected: (p) => p === 'docs/inside.md' }),
    'an injected protected-path predicate blocks the path');
  line(resolvesTo(() => resolveWorkspacePath(root, 'docs/inside.md', { isProtected: () => false, mustExist: true, mustBeFile: true }), 'a non-protected path passes the predicate') !== null,
    'the protected predicate admits allowed paths');

  // --- helper contract ---
  line(nearestExistingParent(path.join(root, 'docs', 'deep', 'deeper', 'x.md')) === path.join(root, 'docs'),
    'nearestExistingParent walks up to the closest existing directory');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll workspace path-guard checks passed.');
process.exit(failures ? 1 : 0);
