// runCli working-directory resolution.
//
// History: runCli originally hard-coded `cwd: root` and silently ignored a
// caller-supplied options.cwd, so executor validation meant to run inside an
// isolated worktree actually ran in the repo root. PR #15 changed it to
// `options.cwd || root`, which respects the caller but honours ANY directory.
// This helper closes the remaining gap fail-closed: a caller-provided cwd is
// used only when it resolves INSIDE the repository root (the executor's
// isolated worktrees live under <root>/.lps/tooling/openhands/worktrees).
// Anything else is refused with a reason — never silently swapped for root,
// which was the original bug's failure mode.
//
// Pure and side-effect-free: no filesystem access, no process execution, no
// network. Only node:path string logic, so a committed verification script
// (scripts/verify-runcli-cwd.mjs) can exercise the REAL function without
// booting the server.

import path from 'node:path';

export function resolveRunCliCwd(root, requestedCwd) {
  const rootResolved = path.resolve(String(root || ''));
  if (requestedCwd === undefined || requestedCwd === null || String(requestedCwd).trim() === '') {
    return { ok: true, cwd: rootResolved, source: 'default-root' };
  }
  if (typeof requestedCwd !== 'string') {
    return { ok: false, reason: 'cwd must be a string when provided' };
  }
  const trimmed = requestedCwd.trim();
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return { ok: false, reason: 'cwd must not contain control characters' };
  }
  // Relative values resolve against root; absolute values stand alone. Either
  // way the result must stay inside root — path.relative handles ".."
  // traversal and Windows case-insensitivity/drive differences for us.
  const resolved = path.resolve(rootResolved, trimmed);
  const rel = path.relative(rootResolved, resolved);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!inside) {
    return { ok: false, reason: `cwd escapes the repository root: ${resolved}` };
  }
  return { ok: true, cwd: resolved, source: rel === '' ? 'root' : 'caller-cwd' };
}
