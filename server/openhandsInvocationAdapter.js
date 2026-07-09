// Disabled OpenHands invocation adapter boundary.
//
// This module is intentionally pure and side-effect-free. It defines the
// future local-only invocation boundary and failure mapping, but it does not
// contact OpenHands, run commands, write files, install dependencies, or grant
// commit/push/merge permissions. Its only import is the equally pure
// executorEnforcement module, so the protected-path policy has one source of
// truth instead of a drifting copy.

import { OPENHANDS_MANDATORY_FORBIDDEN, violatesMandatoryForbidden } from './executorEnforcement.js';

export const OPENHANDS_ADAPTER_LIMITS = Object.freeze({
  timeoutMsMin: 1,
  timeoutMsMax: 5 * 60 * 1000,
  outputMaxBytesMin: 1,
  outputMaxBytesMax: 16 * 1024 * 1024
});

// Same list the executor enforces (single source of truth; re-exported for
// contract/report display).
export const OPENHANDS_ADAPTER_FORBIDDEN_PATHS = Object.freeze([...OPENHANDS_MANDATORY_FORBIDDEN]);

// Display statuses for UI/report surfaces. 'not-implemented' and 'disabled'
// are reserved: the schema specs and safety matrix admit them for future
// display use, but no current helper emits them (the disabled stub reports
// 'setup-gated'). policy statuses stay the narrower VALID_STATUSES set below.
export const OPENHANDS_INVOCATION_STATUS_TAXONOMY = Object.freeze([
  'setup-gated',
  'blocked',
  'refused',
  'validation-failed',
  'timeout',
  'output-capped',
  'invalid-response',
  'not-implemented',
  'disabled'
]);

export const OPENHANDS_ADAPTER_SAFE_DENIALS = Object.freeze({
  invoked: false,
  realInvocationEnabled: false,
  patchApproved: false,
  commitAllowed: false,
  pushAllowed: false,
  mergeAllowed: false,
  branchDeletionAllowed: false,
  resetAllowed: false,
  stashPopAllowed: false,
  mainMasterWriteAllowed: false,
  privateMemoryAccessAllowed: false,
  dependencyProvisioningAllowed: false,
  requiresHumanReview: true,
  requiresSeparatePostRunApproval: true
});

const FAILURE_MAP = Object.freeze({
  openhands_unavailable: {
    status: 'setup-gated',
    reason: 'OpenHands is unavailable; no invocation was attempted.'
  },
  endpoint_misconfigured: {
    status: 'setup-gated',
    reason: 'OpenHands endpoint is missing or misconfigured.'
  },
  model_missing: {
    status: 'setup-gated',
    reason: 'OpenHands model/provider configuration is missing.'
  },
  timeout: {
    status: 'validation-failed',
    reason: 'OpenHands invocation timed out before a usable result was available.'
  },
  output_capped: {
    status: 'validation-failed',
    reason: 'OpenHands output exceeded the configured report/output cap.'
  },
  invalid_response: {
    status: 'blocked',
    reason: 'OpenHands returned an invalid or unparseable response.'
  },
  protected_path_touched: {
    status: 'refused',
    reason: 'OpenHands output touched a mandatory protected path.'
  },
  changed_file_outside_allowed_paths: {
    status: 'refused',
    reason: 'OpenHands output changed a file outside allowedPaths.'
  },
  too_many_files_changed: {
    status: 'refused',
    reason: 'OpenHands output changed too many files.'
  },
  validation_failed: {
    status: 'validation-failed',
    reason: 'Allowlisted validation failed after OpenHands output.'
  }
});

const VALID_STATUSES = new Set(['setup-gated', 'blocked', 'refused', 'validation-failed']);
const SAFE_DENIALS = OPENHANDS_ADAPTER_SAFE_DENIALS;

function safeResult({
  status = 'setup-gated',
  reason = 'real OpenHands invocation is not implemented or enabled',
  code = '',
  missing = [],
  details = null,
  checks = [],
  config = null,
  payload = null
} = {}) {
  const safeStatus = VALID_STATUSES.has(status) ? status : 'blocked';
  return {
    ok: false,
    invoked: false,
    status: safeStatus,
    code,
    reason,
    missing: Array.isArray(missing) ? missing : [],
    details,
    checks: Array.isArray(checks) ? checks : [],
    config,
    payload,
    ...SAFE_DENIALS,
    safety: { ...SAFE_DENIALS }
  };
}

function stringValue(value) {
  return String(value || '').trim();
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function isSafePositiveInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function normalizeAllowedPath(value) {
  return stringValue(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/+$/, '');
}

function pathTouchesForbidden(normalizedPath) {
  // Delegate to the executor's matcher so the adapter can never accept an
  // allowedPath the executor would refuse (e.g. "nested/.env" or
  // "docs/credentials.json", which the previous local matcher let through).
  return violatesMandatoryForbidden(normalizedPath);
}

function validateAllowedPath(value) {
  const normalized = normalizeAllowedPath(value);
  const raw = stringValue(value).replaceAll('\\', '/');
  if (!normalized) return { ok: false, path: normalized, reason: 'allowedPath is empty' };
  if (raw.startsWith('/') || /^[a-z]:\//i.test(raw)) return { ok: false, path: normalized, reason: 'allowedPath must be relative' };
  if (normalized.split('/').includes('..')) return { ok: false, path: normalized, reason: 'allowedPath must not traverse directories' };
  if (/[\x00-\x1f\x7f]/.test(normalized)) return { ok: false, path: normalized, reason: 'allowedPath must not contain control characters' };
  if (pathTouchesForbidden(normalized)) return { ok: false, path: normalized, reason: 'allowedPath overlaps a protected path' };
  return { ok: true, path: normalized, reason: 'allowedPath is valid' };
}

function isLocalEndpoint(value) {
  const endpoint = stringValue(value);
  if (!endpoint) return false;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    && ['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'].includes(host);
}

export function validateOpenHandsInvocationConfig(config = {}) {
  const endpoint = stringValue(config.endpoint || config.baseUrl);
  const model = stringValue(config.model);
  const provider = stringValue(config.provider || config.modelProvider);
  const apiKeyRef = stringValue(config.apiKeyRef);
  const worktreeDir = stringValue(config.worktreeDir || config.worktreePath);
  const timeoutMs = Number(config.timeoutMs);
  const outputMaxBytes = Number(config.outputMaxBytes);
  const rawAllowedPaths = config.allowedPaths;
  const allowedPathChecks = Array.isArray(rawAllowedPaths)
    ? rawAllowedPaths.map(validateAllowedPath)
    : [];
  const allowedPaths = allowedPathChecks.filter((item) => item.ok).map((item) => item.path);

  const checks = [];
  const check = (gate, ok, detail) => {
    checks.push({ gate, ok, detail });
    return ok;
  };

  check('endpoint_config_present', isLocalEndpoint(endpoint),
    endpoint ? 'local endpoint is configured' : 'missing endpoint config');
  check('model_provider_config_present', Boolean(model || provider),
    model || provider ? 'model/provider config is present' : 'missing model/provider config');
  check('allowed_paths_present', Array.isArray(rawAllowedPaths) && rawAllowedPaths.length > 0,
    Array.isArray(rawAllowedPaths) && rawAllowedPaths.length > 0 ? `${rawAllowedPaths.length} allowed path(s)` : 'missing allowedPaths');
  check('allowed_paths_valid', allowedPathChecks.length > 0 && allowedPathChecks.every((item) => item.ok),
    allowedPathChecks.length > 0 && allowedPathChecks.every((item) => item.ok)
      ? 'allowedPaths are valid and avoid protected paths'
      : `invalid allowedPaths: ${allowedPathChecks.filter((item) => !item.ok).map((item) => `${item.path || '(empty)'} ${item.reason}`).join(', ') || 'none supplied'}`);
  check('worktree_directory_present', Boolean(worktreeDir) && !/[\x00-\x1f\x7f]/.test(worktreeDir),
    worktreeDir ? 'worktree directory is present' : 'missing worktree directory');
  check('timeout_limit_present', isSafePositiveInteger(timeoutMs, OPENHANDS_ADAPTER_LIMITS.timeoutMsMin, OPENHANDS_ADAPTER_LIMITS.timeoutMsMax),
    isSafePositiveInteger(timeoutMs, OPENHANDS_ADAPTER_LIMITS.timeoutMsMin, OPENHANDS_ADAPTER_LIMITS.timeoutMsMax)
      ? `timeout ${timeoutMs} ms`
      : `unsafe timeout; must be an integer ${OPENHANDS_ADAPTER_LIMITS.timeoutMsMin}-${OPENHANDS_ADAPTER_LIMITS.timeoutMsMax}`);
  check('output_cap_present', isSafePositiveInteger(outputMaxBytes, OPENHANDS_ADAPTER_LIMITS.outputMaxBytesMin, OPENHANDS_ADAPTER_LIMITS.outputMaxBytesMax),
    isSafePositiveInteger(outputMaxBytes, OPENHANDS_ADAPTER_LIMITS.outputMaxBytesMin, OPENHANDS_ADAPTER_LIMITS.outputMaxBytesMax)
      ? `output cap ${outputMaxBytes} bytes`
      : `unsafe output cap; must be an integer ${OPENHANDS_ADAPTER_LIMITS.outputMaxBytesMin}-${OPENHANDS_ADAPTER_LIMITS.outputMaxBytesMax}`);

  const ok = checks.every((item) => item.ok);
  return {
    ok,
    setupGated: !ok,
    missing: checks.filter((item) => !item.ok).map((item) => item.gate),
    reason: ok
      ? 'OpenHands adapter config is complete for the future local-only boundary.'
      : `OpenHands adapter config setup-gated: ${checks.filter((item) => !item.ok).map((item) => item.gate).join(', ')}`,
    checks,
    config: {
      endpoint,
      model,
      provider,
      apiKeyRef,
      worktreeDir,
      allowedPaths,
      timeoutMs,
      outputMaxBytes,
      forbiddenPaths: [...OPENHANDS_ADAPTER_FORBIDDEN_PATHS]
    },
    safety: { ...SAFE_DENIALS }
  };
}

export function buildOpenHandsInvocationPayload(config = {}) {
  const validation = validateOpenHandsInvocationConfig(config);
  if (!validation.ok) {
    return safeResult({
      status: 'setup-gated',
      reason: validation.reason,
      missing: validation.missing,
      checks: validation.checks,
      config: validation.config
    });
  }

  return {
    ok: true,
    invoked: false,
    status: 'payload-ready',
    reason: 'OpenHands invocation payload boundary was assembled; the disabled adapter does not invoke OpenHands.',
    payload: {
      endpoint: validation.config.endpoint,
      model: validation.config.model,
      provider: validation.config.provider,
      apiKeyRef: validation.config.apiKeyRef,
      worktreeDir: validation.config.worktreeDir,
      allowedPaths: [...validation.config.allowedPaths],
      forbiddenPaths: [...validation.config.forbiddenPaths],
      timeoutMs: validation.config.timeoutMs,
      outputMaxBytes: validation.config.outputMaxBytes
    },
    ...SAFE_DENIALS,
    safety: { ...SAFE_DENIALS }
  };
}

export function mapOpenHandsInvocationFailure(failure = {}) {
  const code = stringValue(typeof failure === 'string' ? failure : failure.code) || 'invalid_response';
  const mapped = FAILURE_MAP[code] || FAILURE_MAP.invalid_response;
  return safeResult({
    status: mapped.status,
    code,
    reason: failure.reason ? stringValue(failure.reason) : mapped.reason,
    details: typeof failure === 'object' && failure !== null ? (failure.details || null) : null
  });
}

export function summarizeOpenHandsInvocationResult(result = {}) {
  if (!result || typeof result !== 'object') {
    return mapOpenHandsInvocationFailure({ code: 'invalid_response' });
  }
  if (result.ok === true || result.invoked === true) {
    return safeResult({
      status: 'blocked',
      code: 'adapter_stub_no_success_path',
      reason: 'The disabled OpenHands adapter stub cannot produce or accept an approved invocation result.'
    });
  }
  return safeResult({
    status: VALID_STATUSES.has(result.status) ? result.status : 'blocked',
    code: stringValue(result.code),
    reason: stringValue(result.reason) || 'OpenHands invocation did not produce an approved result.',
    missing: Array.isArray(result.missing) ? result.missing : [],
    details: result.details || null,
    checks: Array.isArray(result.checks) ? result.checks : []
  });
}

export function invokeOpenHandsAdapter(options = {}) {
  const invocationFlagPresent = hasOwn(options, 'invocationEnabled');
  const invocationFlagNotOff = invocationFlagPresent && options.invocationEnabled !== false;
  const validation = validateOpenHandsInvocationConfig(options.config || {});
  const missing = [...validation.missing];
  if (!invocationFlagPresent || invocationFlagNotOff) {
    missing.unshift('invocation_flag_explicit_off_by_default');
  }

  if (missing.length > 0) {
    const flagReason = !invocationFlagPresent
      ? 'The invocation flag is missing.'
      : (invocationFlagNotOff ? 'The invocation flag is not false, but the adapter is still a disabled stub and did not invoke OpenHands.' : '');
    return safeResult({
      status: 'setup-gated',
      code: !invocationFlagPresent || invocationFlagNotOff ? 'adapter_stub_not_enabled' : 'adapter_config_setup_gated',
      reason: `OpenHands adapter setup-gated: ${[...new Set(missing)].join(', ')}${flagReason ? ` ${flagReason}` : ''}`,
      missing: [...new Set(missing)],
      checks: validation.checks,
      config: validation.config
    });
  }

  return safeResult({
    status: 'setup-gated',
    code: 'adapter_stub_disabled',
    reason: 'real OpenHands invocation is not implemented or enabled; the adapter stub returned without invoking OpenHands',
    checks: validation.checks,
    config: validation.config,
    payload: buildOpenHandsInvocationPayload(validation.config).payload
  });
}

function normalizeAdapterOutcome(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const code = stringValue(raw.code);
  const displayStatus = code === 'timeout'
    ? 'timeout'
    : (code === 'output_capped' ? 'output-capped'
      : (code === 'invalid_response' ? 'invalid-response'
        : (OPENHANDS_INVOCATION_STATUS_TAXONOMY.includes(raw.status) ? raw.status : 'blocked')));
  // Policy fallback mirrors FAILURE_MAP: timeout/output-capped degrade to
  // validation-failed, invalid-response degrades to blocked.
  return {
    ok: false,
    invoked: false,
    status: displayStatus,
    policyStatus: VALID_STATUSES.has(raw.status) ? raw.status : (displayStatus === 'timeout' || displayStatus === 'output-capped' ? 'validation-failed' : 'blocked'),
    code,
    reason: stringValue(raw.reason) || 'Real OpenHands invocation remains disabled.',
    missing: Array.isArray(raw.missing) ? raw.missing : [],
    details: raw.details || null,
    checks: Array.isArray(raw.checks) ? raw.checks : [],
    ...SAFE_DENIALS,
    safety: { ...SAFE_DENIALS }
  };
}

export function buildOpenHandsHumanNextSteps(input = {}) {
  const outcome = normalizeAdapterOutcome(input);
  const steps = [];
  if (outcome.status === 'setup-gated') {
    steps.push('Review the setup-gated fields and update local configuration only after explicit approval.');
  } else if (outcome.status === 'refused') {
    steps.push('Review the refused path or diff reason and narrow the request before another dry run.');
  } else if (outcome.status === 'validation-failed' || outcome.status === 'timeout' || outcome.status === 'output-capped' || outcome.status === 'invalid-response') {
    steps.push('Review the failed output and keep the worktree/report available for human inspection.');
  } else {
    steps.push('Keep real invocation blocked until a separate approved implementation PR exists.');
  }
  steps.push('Require separate human approval before any later commit, push, PR, merge, cleanup, reset, or stash operation.');
  return steps;
}

export function buildOpenHandsInvocationStatusCard(input = {}) {
  const outcome = normalizeAdapterOutcome(input);
  const humanNextSteps = buildOpenHandsHumanNextSteps(outcome);
  return {
    kind: 'openhands-invocation-status-card',
    title: 'OpenHands invocation',
    status: outcome.status,
    policyStatus: outcome.policyStatus,
    code: outcome.code,
    invoked: false,
    reason: outcome.reason,
    missing: [...outcome.missing],
    badgeTone: outcome.status === 'refused' ? 'danger' : (outcome.status === 'blocked' ? 'warning' : 'neutral'),
    humanNextStep: humanNextSteps[0],
    humanNextSteps,
    ...SAFE_DENIALS,
    safety: { ...SAFE_DENIALS }
  };
}

export function buildOpenHandsInvocationDryRunChecklist(input = {}) {
  const outcome = normalizeAdapterOutcome(input);
  const checkMap = new Map(outcome.checks.map((item) => [item.gate, item]));
  const item = (id, label, required = true) => {
    const check = checkMap.get(id);
    return {
      id,
      label,
      required,
      ok: check ? check.ok === true : false,
      detail: check?.detail || 'not yet verified'
    };
  };
  return {
    kind: 'openhands-invocation-dry-run-checklist',
    status: outcome.status,
    requiresHumanApproval: true,
    approvalRequiredBeforeInvocation: true,
    items: [
      item('endpoint_config_present', 'Local endpoint is configured'),
      item('model_provider_config_present', 'Model/provider is configured'),
      item('allowed_paths_present', 'allowedPaths are present'),
      item('allowed_paths_valid', 'allowedPaths avoid protected paths'),
      item('worktree_directory_present', 'Worktree directory is present'),
      item('timeout_limit_present', 'Timeout limit is safe'),
      item('output_cap_present', 'Output cap is safe')
    ],
    ...SAFE_DENIALS,
    safety: { ...SAFE_DENIALS }
  };
}

export function buildOpenHandsPostRunReviewChecklist(input = {}) {
  const outcome = normalizeAdapterOutcome(input);
  return {
    kind: 'openhands-post-run-review-checklist',
    status: outcome.status,
    requiresHumanReview: true,
    requiresSeparatePostRunApproval: true,
    approvalRequiredBeforeCommitPushPr: true,
    items: [
      { id: 'actual_diff_captured', label: 'Actual diff captured from the isolated worktree', required: true, ok: false },
      { id: 'allowed_paths_enforced', label: 'Changed files checked against allowedPaths', required: true, ok: false },
      { id: 'protected_paths_enforced', label: 'Protected paths checked against the actual diff', required: true, ok: false },
      { id: 'validation_reviewed', label: 'Allowlisted validation output reviewed', required: true, ok: false },
      { id: 'separate_commit_push_pr_approval', label: 'Separate human approval before commit, push, or PR', required: true, ok: false }
    ],
    ...SAFE_DENIALS,
    safety: { ...SAFE_DENIALS }
  };
}

export function buildOpenHandsInvocationReportSection(input = {}) {
  const statusCard = buildOpenHandsInvocationStatusCard(input);
  const dryRunChecklist = buildOpenHandsInvocationDryRunChecklist(input);
  const postRunChecklist = buildOpenHandsPostRunReviewChecklist(input);
  const lines = [
    '## OpenHands invocation adapter',
    `- Status: ${statusCard.status}`,
    `- Invoked: ${statusCard.invoked ? 'yes' : 'no'}`,
    `- Reason: ${statusCard.reason}`,
    `- Next human step: ${statusCard.humanNextStep}`,
    '- Commit/push/merge allowed: no',
    '- Patch approved: no'
  ];
  return {
    kind: 'openhands-invocation-report-section',
    heading: 'OpenHands invocation adapter',
    status: statusCard.status,
    statusCard,
    dryRunChecklist,
    postRunChecklist,
    lines,
    markdown: lines.join('\n'),
    ...SAFE_DENIALS,
    safety: { ...SAFE_DENIALS }
  };
}

export function buildOpenHandsAdapterUiState(input = {}) {
  const statusCard = buildOpenHandsInvocationStatusCard(input);
  return {
    kind: 'openhands-adapter-ui-state',
    status: statusCard.status,
    label: statusCard.status.replaceAll('-', ' '),
    description: statusCard.reason,
    statusCard,
    reportSection: buildOpenHandsInvocationReportSection(input),
    dryRunChecklist: buildOpenHandsInvocationDryRunChecklist(input),
    postRunReviewChecklist: buildOpenHandsPostRunReviewChecklist(input),
    humanNextSteps: buildOpenHandsHumanNextSteps(input),
    ...SAFE_DENIALS,
    safety: { ...SAFE_DENIALS }
  };
}
