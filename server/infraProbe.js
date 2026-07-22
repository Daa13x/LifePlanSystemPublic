// Safeguard 4 — probe infrastructure; do not assume documented defaults.
//
// Bounded, ordered candidate selection with per-candidate timeout budgets and
// identity validation (an open port is not proof of the right service). Also
// the transport-vs-bad-answer outcome split (spec §6): a run that never reached
// the model is "incomplete; retry, change nothing", not "blocked; bad answer".
// No unrestricted port scanning: candidates are explicit.

export const SELECTION_PRIORITY = Object.freeze(['explicit', 'env', 'default', 'fallback']);

// Outcome split (spec §6).
export const OUTCOME_TRANSPORT = 'incomplete'; // retry later, change nothing
export const OUTCOME_BAD_ANSWER = 'blocked';   // needs new advice / retrain

const TRANSPORT_KINDS = new Set([
  'browser-closed', 'not-connected', 'connector-down', 'probe-timeout',
  'runtime-not-started', 'cold-start-timeout', 'transport', 'network', 'no-candidate'
]);

export function classifyFailure(kind) {
  const category = TRANSPORT_KINDS.has(String(kind)) ? 'transport' : 'bad-answer';
  return { category, outcome: category === 'transport' ? OUTCOME_TRANSPORT : OUTCOME_BAD_ANSWER, kind: String(kind) };
}

export function buildCandidates({ explicit, envValue, documentedDefault, fallback } = {}) {
  const list = [];
  if (explicit) list.push({ value: explicit, source: 'explicit' });
  if (envValue) list.push({ value: envValue, source: 'env' });
  if (documentedDefault) list.push({ value: documentedDefault, source: 'default' });
  if (fallback) list.push({ value: fallback, source: 'fallback' });
  const seen = new Set();
  return list.filter((item) => { const k = String(item.value); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Run one async attempt under its OWN timeout budget. A shared budget across a
// slow cold start and the real question is exactly the bug this prevents.
export async function withTimeout(fn, timeoutMs, { now = Date.now } = {}) {
  let timer = null;
  const started = now();
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('probe timed out'), { timedOut: true })), timeoutMs); })
    ]);
    return { ok: true, result, timedOut: false, elapsed: now() - started };
  } catch (error) {
    return { ok: false, error, timedOut: Boolean(error && error.timedOut), elapsed: now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// validateIdentity(value) => truthy evidence when the service answering is the
// EXPECTED one; falsy/throw otherwise. Never accept a bare open port.
export async function probeCandidate(candidate, { validateIdentity, timeoutMs = 2000, now = Date.now }) {
  const attempt = await withTimeout(() => validateIdentity(candidate.value), timeoutMs, { now });
  if (attempt.ok && attempt.result) {
    return { ...candidate, ok: true, identityEvidence: attempt.result, timedOut: false };
  }
  return {
    ...candidate,
    ok: false,
    identityEvidence: null,
    timedOut: attempt.timedOut,
    error: attempt.timedOut ? 'probe timed out' : String(attempt.error?.message || 'identity check failed')
  };
}

export async function selectInfrastructure({ explicit, envValue, documentedDefault, fallback, validateIdentity, timeoutMs = 2000, now = Date.now }) {
  const candidates = buildCandidates({ explicit, envValue, documentedDefault, fallback });
  const checked = [];
  for (const candidate of candidates) {
    const probed = await probeCandidate(candidate, { validateIdentity, timeoutMs, now });
    checked.push({ value: probed.value, source: probed.source, ok: probed.ok, timedOut: probed.timedOut, error: probed.error || '' });
    if (probed.ok) {
      return {
        selected: probed.value,
        source: probed.source,
        identityEvidence: probed.identityEvidence,
        candidatesChecked: checked,
        fallbackReason: probed.source === 'explicit' ? '' : `explicit/earlier sources unavailable; selected ${probed.source}`
      };
    }
  }
  return {
    selected: null,
    source: null,
    identityEvidence: null,
    candidatesChecked: checked,
    fallbackReason: candidates.length ? 'no candidate passed identity validation' : 'no candidates supplied',
    failure: classifyFailure('no-candidate')
  };
}

// Measure silence, not elapsed time, for long operations (spec §6). A process
// still printing progress is still working; a fixed wall clock kills healthy
// long jobs. Reset on progress; a generous absolute ceiling still bounds it.
export function createSilenceMonitor({ silenceMs, ceilingMs, now = Date.now }) {
  const startedAt = now();
  let lastProgress = startedAt;
  return {
    progress() { lastProgress = now(); },
    // Returns null when healthy, or a reason string when it should be stopped.
    check() {
      const t = now();
      if (t - lastProgress > silenceMs) return 'silence-timeout';
      if (ceilingMs && t - startedAt > ceilingMs) return 'absolute-ceiling';
      return null;
    },
    startedAt,
    lastProgressAt() { return lastProgress; }
  };
}
