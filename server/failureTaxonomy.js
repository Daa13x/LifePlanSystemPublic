// Failure taxonomy and reviewed self-improvement — pure, deterministic rules for
// recording failures, proposing regression/prompt candidates, and proving a
// refinement actually helped. No DB/IO here so the rules are unit-testable.
//
// Principles this encodes on purpose:
//   * A single failure NEVER changes prompts, rules, permissions, memory, or
//     source-of-truth. Confirmed failures only PROPOSE reviewed candidates.
//   * Every failure is attributable: task, run, exact inputs, evidence,
//     correction, and outcome travel with it.
//   * Improvement is claimed only after a before/after comparison shows the
//     target failure class fell without another class rising.

// The distinct failure categories the system tracks. Several are produced by the
// unattended-loop guard; others come from feedback, tests, or manual review.
export const FAILURE_CATEGORIES = [
  'repeated-question',
  'wrong-question-type',
  'missing-attachment',
  'incorrect-attachment',
  'stale-attachment',
  'repeated-navigation',
  'unsupported-answer',
  'failed-test-or-contradiction',
  'no-progress-loop',
  'user-correction',
  'unnecessary-cloud-escalation',
  'missed-escalation'
];

export const FAILURE_STATUSES = ['observed', 'confirmed', 'converted', 'dismissed'];

// Failures that can be turned into an automated regression test once confirmed
// (they have a reproducible mechanical signal); the rest become reviewed
// prompt/router candidates instead.
const REGRESSION_TESTABLE = new Set([
  'wrong-question-type', 'missing-attachment', 'incorrect-attachment', 'stale-attachment',
  'failed-test-or-contradiction', 'no-progress-loop', 'repeated-question'
]);

function str(value, max) { return String(value ?? '').trim().slice(0, max); }

// Validate and normalise one failure record. Throws only on an invalid category
// (the controlled field); attribution fields are optional but preserved.
export function normalizeFailure(input = {}) {
  const category = String(input.category || '').toLowerCase().trim();
  if (!FAILURE_CATEGORIES.includes(category)) {
    throw new Error(`Failure category must be one of: ${FAILURE_CATEGORIES.join(', ')}.`);
  }
  const status = FAILURE_STATUSES.includes(String(input.status || '').toLowerCase()) ? String(input.status).toLowerCase() : 'observed';
  return {
    category,
    status,
    source: str(input.source, 60) || 'manual',
    taskRef: str(input.taskRef ?? input.task_ref, 200) || null,
    runId: str(input.runId ?? input.run_id, 200) || null,
    inputs: str(input.inputs, 4000) || null,
    evidence: str(input.evidence, 4000) || null,
    correction: str(input.correction, 4000) || null,
    outcome: str(input.outcome, 2000) || null
  };
}

export function isConfirmed(record = {}) {
  return String(record.status || '').toLowerCase() === 'confirmed';
}

// Propose — never apply — the reviewed follow-up for a CONFIRMED failure. An
// unconfirmed failure yields no proposal, so a single observation can never
// drive a change on its own.
export function proposeRemediation(record = {}) {
  if (!isConfirmed(record)) {
    return { propose: false, kind: null, reason: 'not proposed — only a confirmed failure can become a reviewed candidate' };
  }
  const category = String(record.category || '').toLowerCase();
  const kind = REGRESSION_TESTABLE.has(category) ? 'regression-test' : 'reviewed-prompt-or-router-candidate';
  return {
    propose: true,
    kind,
    reason: `confirmed ${category} → propose a ${kind} for human review (no change is applied automatically)`,
    requiresReview: true
  };
}

// Count failures by category from a set of records (each {category}).
export function summarizeByCategory(records = []) {
  const counts = {};
  for (const record of Array.isArray(records) ? records : []) {
    const category = String(record.category || '').toLowerCase();
    if (!FAILURE_CATEGORIES.includes(category)) continue;
    counts[category] = (counts[category] || 0) + 1;
  }
  return counts;
}

// Persisted evaluations must compare complete category snapshots. The looser
// pure evaluator remains useful for ad-hoc previews, but durable evidence may
// not silently treat omitted categories as zero.
export function normalizeCompleteFailureCounts(value, label = 'Failure counts') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object containing every failure category.`);
  const keys = Object.keys(value).sort();
  const expected = [...FAILURE_CATEGORIES].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error(`${label} must contain exactly every failure category.`);
  return Object.fromEntries(FAILURE_CATEGORIES.map((category) => {
    const count = value[category];
    if (!Number.isInteger(count) || count < 0 || count > 1000000) throw new Error(`${label}.${category} must be an integer from 0 to 1000000.`);
    return [category, count];
  }));
}

// Before/after evaluation. `target` is the failure class a refinement aimed to
// reduce. It counts as an improvement ONLY if the target class fell AND no other
// class rose. `before`/`after` are category→count maps.
export function evaluateImprovement(target, before = {}, after = {}) {
  const category = String(target || '').toLowerCase();
  if (!FAILURE_CATEGORIES.includes(category)) {
    return { improved: false, reason: `unknown target failure class "${target}"`, regressions: [] };
  }
  const beforeCount = Number(before[category] || 0);
  const afterCount = Number(after[category] || 0);
  const targetFell = afterCount < beforeCount;
  const regressions = FAILURE_CATEGORIES
    .filter((other) => other !== category)
    .filter((other) => Number(after[other] || 0) > Number(before[other] || 0))
    .map((other) => ({ category: other, before: Number(before[other] || 0), after: Number(after[other] || 0) }));
  const improved = targetFell && regressions.length === 0;
  let reason;
  if (!targetFell) reason = `no improvement — ${category} did not fall (${beforeCount} → ${afterCount})`;
  else if (regressions.length) reason = `${category} fell (${beforeCount} → ${afterCount}) but other failure class(es) rose: ${regressions.map((r) => r.category).join(', ')}`;
  else reason = `improvement confirmed — ${category} fell (${beforeCount} → ${afterCount}) with no other class rising`;
  return { improved, target: category, before: beforeCount, after: afterCount, regressions, reason };
}
