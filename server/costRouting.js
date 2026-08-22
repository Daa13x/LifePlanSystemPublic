// Adaptive reasoning-effort and cost routing — pure, deterministic rules for
// choosing the least-expensive route that meets a task's measured acceptance
// bar, and for escalating only on evidence. No DB/IO here so the rules are
// unit-testable and can gate any caller.
//
// Principles this encodes on purpose:
//   * Route from MEASURED results, not marketing labels: "medium" is never
//     assumed to equal "high"; defaults come from observed success + cost.
//   * Escalate on EVIDENCE only: a failed parse, missing evidence, a test
//     contradiction, a repeat, a retry-limit breach, or a below-threshold
//     acceptance score. Never escalate just because a task "sounds complex".
//   * Don't cling to a cheap route that repeatedly wastes attempts.
//   * Total cost includes retries and review time, not token price alone.
//   * High-risk task classes keep deterministic checks regardless of tier.

// Ordered cheapest -> most expensive. costWeight is a relative unit used only to
// break ties toward the cheaper route; real cost comes from measured records.
export const DEFAULT_ROUTE_TIERS = [
  { id: 'local-low', costWeight: 1 },
  { id: 'local-high', costWeight: 3 },
  { id: 'cloud', costWeight: 10 }
];

// Total cost of a task attempt: base (token/compute) cost PLUS the cost of the
// retries it took and any human review time. Cheap-per-token but retry-heavy
// routes are correctly penalised.
export function effectiveCost(record = {}, { retryCost = 1, reviewCostPerMinute = 2 } = {}) {
  const base = Number(record.cost) || 0;
  const retries = Math.max(0, Number(record.retries) || 0);
  const reviewMinutes = Math.max(0, Number(record.reviewMinutes ?? record.review_minutes) || 0);
  return base + retries * retryCost + reviewMinutes * reviewCostPerMinute;
}

// A route attempt "succeeded" only when it passed verification and was not
// rejected by the user (acceptance, where recorded, must not be false).
function succeeded(record = {}) {
  const verified = record.verificationPassed ?? record.verification_passed;
  const accepted = record.accepted;
  return Boolean(verified) && accepted !== false && accepted !== 0;
}

function measuredEffectiveCost(record = {}, options = {}) {
  const cost = record.cost;
  const retries = record.retries ?? 0;
  const reviewMinutes = record.reviewMinutes ?? record.review_minutes ?? 0;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
  if (typeof retries !== 'number' || !Number.isFinite(retries) || !Number.isInteger(retries) || retries < 0) return null;
  if (typeof reviewMinutes !== 'number' || !Number.isFinite(reviewMinutes) || reviewMinutes < 0) return null;
  const total = effectiveCost({ cost, retries, reviewMinutes }, options);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

// Decide whether to escalate off the current route. Escalation is driven only by
// negative evidence; a passing route is never escalated on perceived difficulty.
export function shouldEscalate(signals = {}) {
  const reasons = [];
  if (signals.parseFailed) reasons.push('output failed to parse');
  if (signals.lacksEvidence) reasons.push('answer lacked required evidence');
  if (signals.contradictsTests) reasons.push('output contradicted tests');
  if (signals.repeatedItself) reasons.push('route repeated itself without progress');
  const retries = Number(signals.retries) || 0;
  const retryLimit = Number(signals.retryLimit ?? 2);
  if (retries > retryLimit) reasons.push(`exceeded the retry limit (${retries} > ${retryLimit})`);
  if (signals.acceptanceScore !== undefined && signals.acceptanceScore !== null
    && Number(signals.acceptanceScore) < Number(signals.acceptanceThreshold ?? 0.7)) {
    reasons.push(`acceptance below threshold (${signals.acceptanceScore} < ${signals.acceptanceThreshold ?? 0.7})`);
  }
  if (reasons.length) return { escalate: true, reason: reasons.join('; ') };
  // No negative evidence. If the route is verifying, explicitly refuse to
  // escalate on complexity alone.
  if (signals.verificationPassed) return { escalate: false, reason: 'current route is passing verification — not escalating on perceived complexity' };
  return { escalate: false, reason: 'no negative evidence to justify escalation' };
}

// Per-(task class, route) measured stats from a history of attempt records.
export function summarizeRoutes(history = [], options = {}) {
  const groups = new Map();
  for (const record of Array.isArray(history) ? history : []) {
    const key = `${record.taskClass || record.task_class || ''}|${record.route || ''}`;
    if (!groups.has(key)) groups.set(key, { taskClass: record.taskClass || record.task_class || '', route: record.route || '', attempts: 0, successes: 0, totalCost: 0, costEvidenceValid: true });
    const group = groups.get(key);
    group.attempts += 1;
    if (succeeded(record)) group.successes += 1;
    const measuredCost = measuredEffectiveCost(record, options);
    if (measuredCost === null) group.costEvidenceValid = false;
    else group.totalCost += measuredCost;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    successRate: group.attempts ? group.successes / group.attempts : 0,
    avgEffectiveCost: group.costEvidenceValid && group.attempts ? group.totalCost / group.attempts : null,
    costPerSuccessfulTask: group.costEvidenceValid && group.successes ? group.totalCost / group.successes : null
  }));
}

// Recommend the cheapest route whose MEASURED success rate meets the acceptance
// threshold (with a minimum sample size). Falls back to a configured default
// when there is not enough evidence. High-risk classes are flagged to keep
// deterministic checks regardless of the chosen tier.
export function recommendRoute(taskClass, history = [], {
  tiers = DEFAULT_ROUTE_TIERS, acceptanceThreshold = 0.7, minAttempts = 3,
  defaultRoute = null, highRiskClasses = [], ...costOptions
} = {}) {
  const orderedTiers = [...tiers].sort((a, b) => a.costWeight - b.costWeight);
  const stats = summarizeRoutes(history.filter((record) => (record.taskClass || record.task_class) === taskClass), costOptions);
  const statByRoute = new Map(stats.map((stat) => [stat.route, stat]));
  const highRisk = highRiskClasses.includes(taskClass);

  const eligible = orderedTiers
    .map((tier) => ({ tier, stat: statByRoute.get(tier.id) }))
    .filter(({ stat }) => stat && stat.attempts >= minAttempts && stat.successRate >= acceptanceThreshold && Number.isFinite(stat.costPerSuccessfulTask))
    .sort((left, right) => left.stat.costPerSuccessfulTask - right.stat.costPerSuccessfulTask
      || left.tier.costWeight - right.tier.costWeight
      || left.tier.id.localeCompare(right.tier.id));
  if (eligible.length) {
    const { tier, stat } = eligible[0];
    return {
      route: tier.id,
      reason: `lowest measured cost per successful task (${stat.costPerSuccessfulTask.toFixed(2)}; ${Math.round(stat.successRate * 100)}% success over ${stat.attempts} attempts)`,
      measured: true,
      attempts: stat.attempts,
      successRate: stat.successRate,
      costPerSuccessfulTask: stat.costPerSuccessfulTask,
      highRisk,
      requiresDeterministicChecks: highRisk
    };
  }
  const fallback = defaultRoute || orderedTiers[0].id;
  return { route: fallback, reason: 'insufficient measured evidence — using the configured default route', measured: false, highRisk, requiresDeterministicChecks: highRisk };
}
