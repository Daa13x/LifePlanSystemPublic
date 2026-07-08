// Disabled OpenHands invocation adapter boundary.
//
// This module is intentionally pure and side-effect-free. It defines the
// future local-only invocation boundary and failure mapping, but it does not
// contact OpenHands, run commands, write files, install dependencies, or grant
// commit/push/merge permissions.

export const OPENHANDS_ADAPTER_LIMITS = Object.freeze({
  timeoutMsMin: 1,
  timeoutMsMax: 5 * 60 * 1000,
  outputMaxBytesMin: 1,
  outputMaxBytesMax: 16 * 1024 * 1024
});

export const OPENHANDS_ADAPTER_FORBIDDEN_PATHS = Object.freeze([
  'source_of_truth/',
  'memory/',
  '.env',
  'secrets/',
  'data/',
  '.git/',
  '.lps/',
  'credentials',
  'rules/'
]);

const SAFE_DENIALS = Object.freeze({
  patchApproved: false,
  commitAllowed: false,
  pushAllowed: false,
  mergeAllowed: false,
  branchDeletionAllowed: false,
  resetAllowed: false,
  stashPopAllowed: false,
  mainMasterWriteAllowed: false,
  privateMemoryAccessAllowed: false,
  dependencyProvisioningAllowed: false
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
  excessive_output: {
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
  changed_file_outside_allowedPaths: {
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
  const lower = normalizedPath.toLowerCase();
  return OPENHANDS_ADAPTER_FORBIDDEN_PATHS.some((blocked) => {
    const clean = blocked.toLowerCase().replace(/\/+$/, '');
    return lower === clean || lower.startsWith(`${clean}/`) || lower.includes(`/${clean}/`);
  });
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
      code: !invocationFlagPresent || invocationFlagNotOff ? 'adapter_stub_not_enabled' : '',
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
