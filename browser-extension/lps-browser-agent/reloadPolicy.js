(function installReloadPolicy(root) {
  const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

  function validAttempt(value) {
    if (!value || typeof value !== 'object') return null;
    const attemptedAt = Date.parse(value.attemptedAt);
    if (!value.expectedVersion || !Number.isFinite(attemptedAt)) return null;
    return { expectedVersion: String(value.expectedVersion), attemptedAt, result: String(value.result || '') };
  }

  function decide({ lifecycleState, reloadRequired, expectedVersion, reloadAttempt, now = Date.now(), recoveryWindowMs = DEFAULT_WINDOW_MS } = {}) {
    if (lifecycleState === 'CONNECTED_CURRENT') return { action: 'CLEAR', lifecycleState };
    if (lifecycleState === 'MANUAL_RELOAD_REQUIRED') return { action: 'MANUAL', lifecycleState };
    if (!reloadRequired || !expectedVersion) return { action: 'NONE', lifecycleState: lifecycleState || 'CONNECTED_STALE' };
    const attempt = validAttempt(reloadAttempt);
    const sameRecentAttempt = attempt?.expectedVersion === expectedVersion
      && now - attempt.attemptedAt >= 0
      && now - attempt.attemptedAt <= recoveryWindowMs;
    return sameRecentAttempt
      ? { action: 'MANUAL', lifecycleState: 'MANUAL_RELOAD_REQUIRED' }
      : { action: 'RELOAD', lifecycleState: 'RELOAD_IN_PROGRESS' };
  }

  root.LpsBrowserReloadPolicy = Object.freeze({ decide, DEFAULT_WINDOW_MS });
})(globalThis);
