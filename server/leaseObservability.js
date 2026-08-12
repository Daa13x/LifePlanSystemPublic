// Lease-progress observability (MA-Dev audit delta #4). LPS already has the
// stronger ownership model — a durable, cross-process filesystem run lease with a
// hard expiry — so the delta is NOT MA's process-local scheduler; it is visibility.
// This pure view redacts a task's lease into an operator-readable status: who owns
// the run, when the lease was acquired and expires, how long remains, the active
// phase, and the latest durable audit event. It NEVER exposes the raw lease token
// (which lives only in the on-disk lease file) — only whether a token is bound.

function summarizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  return {
    at: event.at || null,
    phase: event.phase || null,
    verdict: event.verdict || null,
    detail: String(event.detail || '').slice(0, 300)
  };
}

// Redacted lease view for one task. `now` is injectable for deterministic tests.
export function describeRunLease(task = {}, { now = Date.now() } = {}) {
  const phase = task.phase || null;
  const audit = Array.isArray(task.audit) ? task.audit : [];
  const lastEvent = summarizeEvent(audit[audit.length - 1]);
  const lease = task.runLease;

  if (!lease || typeof lease !== 'object') {
    return { held: false, owner: task.id || null, phase, acquiredAt: null, expiresAt: null, remainingMs: null, expired: false, tokenBound: false, lastEvent };
  }

  const expiresMs = Date.parse(lease.expiresAt || '');
  const hasExpiry = Number.isFinite(expiresMs);
  const expired = hasExpiry ? expiresMs <= now : false;
  const remainingMs = hasExpiry ? Math.max(0, expiresMs - now) : null;
  return {
    // A lease past its expiry is reclaimable, so it is not a live hold even though
    // the record still exists on disk until the next acquire/recovery sweep.
    held: !expired,
    owner: task.id || null,
    phase,
    acquiredAt: lease.acquiredAt || null,
    expiresAt: lease.expiresAt || null,
    remainingMs,
    expired,
    // Presence of a token binding, never the token or its hash value.
    tokenBound: Boolean(lease.tokenHash),
    lastEvent
  };
}
