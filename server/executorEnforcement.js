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

export const OPENHANDS_EXECUTOR_LIMITS = Object.freeze({
  maxFilesChangedMin: 1,
  maxFilesChangedMax: 5,
  validationTimeoutMs: 5 * 60 * 1000,
  validationOutputMaxBytes: 4 * 1024 * 1024,
  validationReportOutputMaxChars: 3000,
  diffOutputMaxBytes: 16 * 1024 * 1024,
  diffReportPreviewMaxChars: 4000,
  worktreeCreateTimeoutMs: 120000,
  untrackedIntentTimeoutMs: 60000,
  worktreeRemoveTimeoutMs: 60000
});

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

export function checkExecutorMaxFilesChanged(value, limits = OPENHANDS_EXECUTOR_LIMITS) {
  const maxFiles = Number(value) || 0;
  const min = Number(limits.maxFilesChangedMin);
  const max = Number(limits.maxFilesChangedMax);
  const ok = Number.isSafeInteger(maxFiles)
    && Number.isSafeInteger(min)
    && Number.isSafeInteger(max)
    && maxFiles >= min
    && maxFiles <= max;
  return {
    ok,
    maxFiles,
    min,
    max,
    reason: ok
      ? `maxFilesChanged = ${maxFiles} (integer limit ${min}-${max})`
      : `BLOCKED - maxFilesChanged = ${maxFiles}; must be an integer ${min}-${max}`
  };
}

function hasPositiveIntegerLimit(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

export function summarizeExecutorCommandResult(result = {}, options = {}) {
  const label = options.label || 'command';
  if (result.timedOut) {
    return {
      ok: false,
      limitHit: true,
      limit: 'runtime',
      reason: `${label} hit runtime limit (${options.timeoutMs || result.timeoutMs || 'unknown'} ms)`
    };
  }
  if (result.outputLimitHit) {
    return {
      ok: false,
      limitHit: true,
      limit: 'output',
      reason: `${label} hit output limit (${options.outputMaxBytes || result.maxBufferBytes || 'unknown'} bytes)`
    };
  }
  return {
    ok: Boolean(result.ok),
    limitHit: false,
    limit: '',
    reason: result.ok
      ? `${label} completed within runtime/output limits`
      : `${label} failed before any runtime/output limit was reported`
  };
}

export function limitExecutorReportText(value, maxChars, label = 'output') {
  const text = String(value ?? '');
  const limit = Number(maxChars) || 0;
  if (limit > 0 && text.length > limit) {
    return {
      text: text.slice(0, limit),
      truncated: true,
      originalChars: text.length,
      maxChars: limit,
      reason: `${label} truncated to ${limit} chars for the report (${text.length} chars total)`
    };
  }
  return {
    text,
    truncated: false,
    originalChars: text.length,
    maxChars: limit,
    reason: `${label} fits within the report limit`
  };
}

export function buildOpenHandsInvocationConstraints({
  request = {},
  plan = {},
  config = {},
  limits = OPENHANDS_EXECUTOR_LIMITS,
  invocationEnabled = false
} = {}) {
  const checks = [];
  const check = (gate, ok, detail) => {
    checks.push({ gate, ok, detail });
    return ok;
  };

  const allowedPaths = Array.isArray(request.allowedPaths) ? request.allowedPaths.filter(Boolean) : [];
  const forbiddenPaths = Array.isArray(request.forbiddenPaths) ? request.forbiddenPaths.filter(Boolean) : [];
  const baseCheck = validateExecutorBaseBranch(request.baseBranch || '');
  const baseBranch = baseCheck.baseBranch;
  const createdBaseBranch = String(request.baseBranchAtCreation || '');
  const approvedBaseBranch = String(request.approvedBaseBranch || '');
  const confirmedBaseBranch = String(request.executionConfirmedBaseBranch || '');
  const baseCommit = String(plan.baseCommit || '').trim();
  const maxFilesCheck = checkExecutorMaxFilesChanged(request.maxFilesChanged, limits);
  const forbiddenWithMandatory = [...new Set([...forbiddenPaths, ...OPENHANDS_MANDATORY_FORBIDDEN])];

  const approvalOk = (request.status === 'approved' || request.status === 'execution-planned')
    && Boolean(request.approvedBy)
    && Boolean(request.approvedAt)
    && request.executionConfirmed === true
    && Boolean(request.executionConfirmedBy)
    && Boolean(request.executionConfirmedAt);
  check('explicit_user_approval_state', approvalOk,
    approvalOk ? 'approval and second confirmation are present' : 'missing approval/confirmation state for future invocation');

  check('allowed_paths_present', allowedPaths.length > 0,
    allowedPaths.length ? `${allowedPaths.length} allowed path(s)` : 'missing allowedPaths for future invocation');
  const protectedHits = allowedPaths.filter((item) => violatesMandatoryForbidden(item));
  check('mandatory_forbidden_paths_enforced', OPENHANDS_MANDATORY_FORBIDDEN.length > 0 && protectedHits.length === 0,
    protectedHits.length ? `allowedPaths overlap protected locations: ${protectedHits.join(', ')}` : 'mandatory forbidden paths are bound and allowedPaths are clean');

  const basePinned = baseCheck.ok
    && createdBaseBranch === baseBranch
    && approvedBaseBranch === baseBranch
    && confirmedBaseBranch === baseBranch
    && /^[0-9a-f]{40}$/i.test(baseCommit);
  check('branch_base_pin', basePinned,
    basePinned ? `base "${baseBranch}" pinned to ${baseCommit.slice(0, 12)}` : 'missing or mismatched creation/approval/confirmation base pin or resolved commit');

  check('changed_file_count_limit', maxFilesCheck.ok, maxFilesCheck.reason);
  check('runtime_timeout_present', hasPositiveIntegerLimit(limits.validationTimeoutMs),
    hasPositiveIntegerLimit(limits.validationTimeoutMs) ? `validation timeout ${limits.validationTimeoutMs} ms` : 'missing integer validation runtime timeout');
  const outputLimitsPresent = hasPositiveIntegerLimit(limits.validationOutputMaxBytes)
    && hasPositiveIntegerLimit(limits.diffOutputMaxBytes)
    && hasPositiveIntegerLimit(limits.validationReportOutputMaxChars)
    && hasPositiveIntegerLimit(limits.diffReportPreviewMaxChars);
  check('output_report_limits_present', outputLimitsPresent,
    outputLimitsPresent ? 'validation/diff output and report limits are positive integers' : 'missing positive integer output/report limits');

  const model = String(config.model || '').trim();
  const baseUrl = String(config.baseUrl || '').trim();
  const apiKeyRef = String(config.apiKeyRef || '').trim();
  const modelConfigOk = Boolean(model) && /^https?:\/\//i.test(baseUrl) && Boolean(apiKeyRef);
  check('model_endpoint_config_present', modelConfigOk,
    modelConfigOk ? `${model} @ ${baseUrl}` : 'missing fixed model, endpoint URL, or API key reference');

  const ok = checks.every((item) => item.ok);
  return {
    ok,
    setupGated: !ok,
    missing: checks.filter((item) => !item.ok).map((item) => item.gate),
    reason: ok
      ? 'Future OpenHands invocation constraints are complete; invocation remains controlled by the disabled server-side flag.'
      : `Future OpenHands invocation setup-gated: ${checks.filter((item) => !item.ok).map((item) => item.gate).join(', ')}`,
    checks,
    constraints: {
      invocationEnabled: Boolean(invocationEnabled),
      allowedPaths,
      forbiddenPaths: forbiddenWithMandatory,
      mandatoryForbiddenPaths: [...OPENHANDS_MANDATORY_FORBIDDEN],
      baseBranch,
      baseCommit,
      maxFilesChanged: maxFilesCheck.maxFiles,
      validationTimeoutMs: limits.validationTimeoutMs,
      validationOutputMaxBytes: limits.validationOutputMaxBytes,
      validationReportOutputMaxChars: limits.validationReportOutputMaxChars,
      diffOutputMaxBytes: limits.diffOutputMaxBytes,
      diffReportPreviewMaxChars: limits.diffReportPreviewMaxChars,
      model,
      baseUrl,
      apiKeyRef,
      approval: {
        status: request.status || '',
        approvedBy: request.approvedBy || '',
        approvedAt: request.approvedAt || '',
        executionConfirmed: request.executionConfirmed === true,
        executionConfirmedBy: request.executionConfirmedBy || '',
        executionConfirmedAt: request.executionConfirmedAt || ''
      }
    }
  };
}

export function buildOpenHandsInvocationReadiness({
  invocationEnabled,
  toolConstraints = {},
  serviceCheck = {},
  dependencySetup = {},
  dryRunReportShown = false,
  postRunPatchRequiresSeparateApproval
} = {}) {
  const checks = [];
  const check = (gate, ok, detail) => {
    checks.push({ gate, ok, detail });
    return ok;
  };
  const toolGate = (name) => (Array.isArray(toolConstraints?.checks) ? toolConstraints.checks : []).find((item) => item.gate === name);
  const requireToolGate = (name, label = name) => {
    const gate = toolGate(name);
    return check(name, Boolean(gate?.ok), gate?.detail || `${label} missing from tool constraint preflight`);
  };

  check('invocation_flag_explicit_off_by_default', invocationEnabled === false,
    invocationEnabled === false ? 'real invocation flag is explicit and false' : 'real invocation flag is missing or not off by default');
  requireToolGate('model_endpoint_config_present', 'model/endpoint config');
  check('openhands_service_reachable_check', serviceCheck.checked === true && serviceCheck.reachable === true,
    serviceCheck.checked === true
      ? (serviceCheck.reachable ? `OpenHands service reachable (${serviceCheck.url || 'local URL'}, code ${serviceCheck.code || 0})` : `OpenHands service is not reachable at ${serviceCheck.url || 'local URL'}`)
      : 'OpenHands service reachability was not checked');
  requireToolGate('branch_base_pin', 'branch/base pin');
  check('dependency_gate_passed', dependencySetup.checked === true && dependencySetup.ok === true && dependencySetup.setupGated !== true,
    dependencySetup.checked === true ? (dependencySetup.reason || 'dependency gate checked') : 'dependency gate was not checked');
  requireToolGate('changed_file_count_limit', 'changed-file count limit');
  requireToolGate('runtime_timeout_present', 'runtime timeout');
  requireToolGate('output_report_limits_present', 'output/report limits');
  requireToolGate('allowed_paths_present', 'allowedPaths');
  requireToolGate('mandatory_forbidden_paths_enforced', 'forbidden/protected paths');
  requireToolGate('explicit_user_approval_state', 'explicit approval state');
  const approval = toolConstraints?.constraints?.approval || {};
  check('second_execution_confirmation_present', approval.executionConfirmed === true && Boolean(approval.executionConfirmedBy) && Boolean(approval.executionConfirmedAt),
    approval.executionConfirmed === true ? 'second execution confirmation is present' : 'second execution confirmation is missing');
  check('dry_run_report_shown', dryRunReportShown === true,
    dryRunReportShown === true ? 'dry-run report has been generated before real invocation' : 'dry-run report has not been generated yet');
  check('post_run_patch_requires_separate_approval', postRunPatchRequiresSeparateApproval === true,
    postRunPatchRequiresSeparateApproval === true ? 'post-run patch requires separate human approval before commit/push/PR' : 'post-run patch approval boundary is missing');

  const ok = checks.every((item) => item.ok);
  return {
    ok,
    setupGated: !ok,
    missing: checks.filter((item) => !item.ok).map((item) => item.gate),
    reason: ok
      ? 'OpenHands invocation readiness gate is satisfied, but real invocation still remains disabled by policy/flag.'
      : `OpenHands invocation readiness setup-gated: ${checks.filter((item) => !item.ok).map((item) => item.gate).join(', ')}`,
    checks
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
