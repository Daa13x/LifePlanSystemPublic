// OpenHands executor path-enforcement helpers.
//
// Extracted verbatim from server/index.js so the changed-file enforcement path
// (in particular the REJECTION path — executor blocker #3) can be exercised by a
// committed verification script (scripts/verify-executor-enforcement.mjs)
// WITHOUT importing the whole server (which boots Express/sqlite on import) and
// WITHOUT enabling OpenHands invocation.
//
// These functions are pure and side-effect-free: no network, no filesystem, no
// database, no app state. Behaviour is identical to the prior in-index
// definitions (blocker #2 forbidden/protected matching, blocker #4 boundary-safe
// allowedPaths matching). This module changes no runtime behaviour and enables no
// autonomy; OPENHANDS_EXECUTOR_INVOCATION_ENABLED still lives in server/index.js
// and remains false.

// Paths an OpenHands request may never touch, matched as prefixes against the
// request's own allowed/forbidden lists. Requests violating this are rejected
// outright rather than stored.
export const OPENHANDS_MANDATORY_FORBIDDEN = [
  'source_of_truth/',
  'memory/',
  '.env',
  'secrets/',
  'data/',
  '.git/',
  '.lps/',
  'credentials',
  'rules/'
];

export function normalizeRequestPath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

export function validateExecutorBaseBranch(value) {
  const baseBranch = String(value || '').trim();
  if (!baseBranch) return { ok: false, baseBranch: '', reason: 'baseBranch is required' };
  if (baseBranch.length > 120) return { ok: false, baseBranch, reason: 'baseBranch is too long' };
  if (baseBranch.startsWith('-')) return { ok: false, baseBranch, reason: 'baseBranch must not start with "-"' };
  if (/[\s\x00-\x1f\x7f]/.test(baseBranch)) return { ok: false, baseBranch, reason: 'baseBranch must not contain whitespace or control characters' };
  if (baseBranch === '@') return { ok: false, baseBranch, reason: 'baseBranch must name a branch, not "@"' };
  if (baseBranch.startsWith('/') || baseBranch.endsWith('/') || baseBranch.includes('//')) {
    return { ok: false, baseBranch, reason: 'baseBranch must be a normalized branch name' };
  }
  if (baseBranch.startsWith('refs/')) return { ok: false, baseBranch, reason: 'baseBranch must be a short branch name, not a full ref' };
  if (baseBranch.includes('..') || baseBranch.includes('@{')) {
    return { ok: false, baseBranch, reason: 'baseBranch must not contain revision syntax' };
  }
  if (['~', '^', ':', '?', '*', '[', ']', '\\'].some((ch) => baseBranch.includes(ch))) {
    return { ok: false, baseBranch, reason: 'baseBranch contains characters that are unsafe in git refs' };
  }
  const parts = baseBranch.split('/');
  if (parts.some((part) => !part || part === 'HEAD' || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    return { ok: false, baseBranch, reason: 'baseBranch contains an unsafe ref component' };
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch)) {
    return { ok: false, baseBranch, reason: 'baseBranch must use only ASCII branch-name characters' };
  }
  return { ok: true, baseBranch, reason: '' };
}

export function checkWorktreeValidationSetup(validationKey, hasPath, platform = process.platform) {
  const command = String(validationKey || '').trim();
  const exists = typeof hasPath === 'function' ? hasPath : () => false;
  if (command !== 'npm run build') {
    return {
      ok: true,
      setupGated: false,
      missing: [],
      reason: 'no dependency preflight required for this allowlisted validation command'
    };
  }

  const viteBins = platform === 'win32'
    ? ['node_modules/.bin/vite.cmd', 'node_modules/.bin/vite']
    : ['node_modules/.bin/vite'];
  const missing = [];
  if (!exists('package.json')) missing.push('package.json');
  if (!exists('node_modules')) missing.push('node_modules/');
  if (!viteBins.some((candidate) => exists(candidate))) missing.push(`one of ${viteBins.join(', ')}`);

  if (missing.length) {
    return {
      ok: false,
      setupGated: true,
      missing,
      reason: `Dependency-gated: npm run build was not run because the isolated worktree is missing ${missing.join(', ')}. Worktrees do not copy gitignored dependencies; installing, copying, or linking dependencies requires separate approval.`
    };
  }

  return {
    ok: true,
    setupGated: false,
    missing: [],
    reason: 'npm run build dependencies are present in the isolated worktree'
  };
}

export function violatesMandatoryForbidden(candidatePath) {
  const normalized = normalizeRequestPath(candidatePath);
  if (!normalized) return false;
  return OPENHANDS_MANDATORY_FORBIDDEN.some((blocked) =>
    normalized === blocked || normalized.startsWith(blocked) || normalized.includes(`/${blocked}`));
}

export function parsePorcelainPaths(stdout) {
  return (stdout || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const body = line.slice(2).trim();
    const arrow = body.split(' -> ');
    return (arrow[1] || body).replace(/^"(.*)"$/, '$1');
  });
}

// Boundary-safe path authorisation for allowedPaths (executor blocker #4).
// Raw startsWith prefix matching is unsafe: "README.md" would authorise
// "README.md.x", and "docs" would authorise "docs-old". A changed file is
// allowed only by an EXACT match, or — for a directory-like allowed path — as a
// descendant behind a real "/" boundary. File-vs-directory cannot be known for
// certain, so an allowed path whose basename contains a "." is treated as a
// FILE (exact match only); this precisely rejects the suffix/sibling bypasses
// and fails safe (a directory whose name contains a dot is slightly
// over-restricted, never over-permissive). Absolute and ".." traversal changed
// paths are rejected defensively.
export function isChangedFileAllowed(changedFile, allowedPaths) {
  const clean = (p) => String(p || '').trim().replaceAll('\\', '/')
    .replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase();
  const rawForward = String(changedFile || '').replaceAll('\\', '/');
  if (rawForward.startsWith('/') || /^[a-z]:\//i.test(rawForward)) return false; // absolute
  const norm = clean(changedFile);
  if (!norm || norm.split('/').some((seg) => seg === '..')) return false;        // traversal
  return (Array.isArray(allowedPaths) ? allowedPaths : []).some((allowed) => {
    const a = clean(allowed);
    if (!a || a.split('/').some((seg) => seg === '..')) return false;
    if (norm === a) return true;                       // exact match
    const basename = a.slice(a.lastIndexOf('/') + 1);
    if (basename.includes('.')) return false;          // file-like allowed path: exact only
    return norm.startsWith(`${a}/`);                   // directory-like: descendants behind "/"
  });
}

// Enforce every path rule against the FILES ACTUALLY CHANGED in the worktree,
// not against the request's declared intent. Returns structured violations.
export function enforceChangedFiles(changedFiles, request) {
  const allowedPaths = (Array.isArray(request.allowedPaths) ? request.allowedPaths : []).map((p) => normalizeRequestPath(p));
  const forbiddenPaths = (Array.isArray(request.forbiddenPaths) ? request.forbiddenPaths : []).map((p) => normalizeRequestPath(p)).filter(Boolean);
  const maxFiles = Number(request.maxFilesChanged) || 0;
  const violations = [];
  for (const file of changedFiles) {
    const norm = normalizeRequestPath(file);
    if (violatesMandatoryForbidden(norm)) violations.push(`${file}: touches a protected path`);
    else if (forbiddenPaths.some((f) => norm === f || norm.startsWith(f))) violations.push(`${file}: matches a forbidden path`);
    else if (allowedPaths.length && !isChangedFileAllowed(file, request.allowedPaths)) {
      violations.push(`${file}: outside allowedPaths`);
    }
  }
  const overMax = maxFiles > 0 && changedFiles.length > maxFiles;
  if (overMax) violations.push(`changed ${changedFiles.length} file(s) > maxFilesChanged ${maxFiles}`);
  return { ok: violations.length === 0, violations, changedCount: changedFiles.length, maxFiles };
}
