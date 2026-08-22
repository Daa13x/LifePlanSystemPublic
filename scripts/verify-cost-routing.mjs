#!/usr/bin/env node
// Verify the pure adaptive cost-routing rules using the REAL server/costRouting.js
// module. Local-only: no network, server, or DB. Exit 0 = pass.

import {
  DEFAULT_ROUTE_TIERS,
  effectiveCost,
  shouldEscalate,
  summarizeRoutes,
  recommendRoute,
  ROUTING_COST_UNIT
} from '../server/costRouting.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };
let fixtureId = 0;
const measured = (overrides = {}) => {
  fixtureId += 1;
  const record = {
    taskClass: 'fixture', route: 'local-low', model: 'local/qwen-fixture', effort: 'low',
    runRef: `run:${fixtureId}`, taskRef: 'task:fixture', costUnit: ROUTING_COST_UNIT,
    cost: 1, verificationPassed: true, accepted: true, ...overrides
  };
  record.verificationRef = record.verificationPassed ? `verification:${fixtureId}` : null;
  return record;
};

console.log('--- adaptive cost routing verification ---');

// Tiers are ordered cheapest -> most expensive.
line(DEFAULT_ROUTE_TIERS[0].costWeight < DEFAULT_ROUTE_TIERS[DEFAULT_ROUTE_TIERS.length - 1].costWeight, 'route tiers are ordered from cheapest to most expensive');

// Total cost includes retries and review time, not token price alone.
{
  const cheapButRetryHeavy = effectiveCost({ cost: 1, retries: 5, reviewMinutes: 3 }, { retryCost: 1, reviewCostPerMinute: 2 });
  const pricierButClean = effectiveCost({ cost: 8, retries: 0, reviewMinutes: 0 });
  line(cheapButRetryHeavy === 1 + 5 + 6, 'effective cost adds retry and review-time cost to base cost');
  line(cheapButRetryHeavy > pricierButClean, 'a cheap-per-token but retry/review-heavy route can cost more overall');
}

// Escalation is evidence-driven; a passing route is never escalated on complexity.
line(shouldEscalate({ parseFailed: true }).escalate === true, 'a parse failure escalates');
line(shouldEscalate({ contradictsTests: true }).escalate === true, 'a test contradiction escalates');
line(shouldEscalate({ retries: 4, retryLimit: 2 }).escalate === true, 'exceeding the retry limit escalates');
line(shouldEscalate({ acceptanceScore: 0.4, acceptanceThreshold: 0.7 }).escalate === true, 'a below-threshold acceptance score escalates');
{
  const passing = shouldEscalate({ verificationPassed: true, taskSoundsComplex: true });
  line(passing.escalate === false && /not escalating on perceived complexity/.test(passing.reason), 'a passing route is NOT escalated just because the task sounds complex');
}

// Routing is from measured results, not labels.
{
  const history = [
    // local-low: 4/4 verified+accepted on task class "summarise"
    ...Array.from({ length: 4 }, () => measured({ taskClass: 'summarise', route: 'local-low', model: 'local/qwen-low', effort: 'low', cost: 1 })),
    // cloud also works but is far more expensive
    ...Array.from({ length: 4 }, () => measured({ taskClass: 'summarise', route: 'cloud', model: 'cloud/frontier', effort: 'high', cost: 10 }))
  ];
  const rec = recommendRoute('summarise', history, { acceptanceThreshold: 0.7, minAttempts: 3 });
  line(rec.route === 'local-low' && rec.measured === true, 'the cheapest route meeting the measured acceptance bar is chosen');

  // A cheap route that mostly fails must NOT be chosen despite being cheapest.
  const failingCheap = [
    ...Array.from({ length: 4 }, () => measured({ taskClass: 'code', route: 'local-low', model: 'local/qwen-low', effort: 'low', cost: 1, verificationPassed: false, accepted: false })),
    ...Array.from({ length: 4 }, () => measured({ taskClass: 'code', route: 'local-high', model: 'local/qwen-high', effort: 'high', cost: 3 }))
  ];
  const rec2 = recommendRoute('code', failingCheap, { acceptanceThreshold: 0.7, minAttempts: 3 });
  line(rec2.route === 'local-high', 'a cheap route that repeatedly fails is skipped for the next tier that meets the bar');

  const measuredCostConflict = [
    ...Array.from({ length: 4 }, () => measured({ taskClass: 'measured-cost', route: 'local-low', model: 'local/expensive-low', effort: 'low', cost: 10 })),
    ...Array.from({ length: 4 }, () => measured({ taskClass: 'measured-cost', route: 'local-high', model: 'local/efficient-high', effort: 'high', cost: 3 }))
  ];
  const recCost = recommendRoute('measured-cost', measuredCostConflict, { acceptanceThreshold: 0.7, minAttempts: 3 });
  line(recCost.route === 'local-high' && recCost.model === 'local/efficient-high' && recCost.effort === 'high' && recCost.costPerSuccessfulTask === 3, 'measured cost per successful task selects an exact model/effort variant');

  const sameRouteVariants = [
    ...Array.from({ length: 4 }, () => measured({ taskClass: 'same-route', route: 'local-high', model: 'local/model-a', effort: 'high', cost: 8 })),
    ...Array.from({ length: 4 }, () => measured({ taskClass: 'same-route', route: 'local-high', model: 'local/model-b', effort: 'medium', cost: 2 }))
  ];
  const variantStats = summarizeRoutes(sameRouteVariants);
  const variantRecommendation = recommendRoute('same-route', sameRouteVariants);
  line(variantStats.length === 2 && variantRecommendation.model === 'local/model-b' && variantRecommendation.effort === 'medium', 'models and effort settings on the same route remain separate measured variants');

  const exactTie = [
    ...Array.from({ length: 3 }, () => measured({ taskClass: 'variant-tie', route: 'local-high', model: 'local/model-b', effort: 'high', cost: 2 })),
    ...Array.from({ length: 3 }, () => measured({ taskClass: 'variant-tie', route: 'local-high', model: 'local/model-a', effort: 'high', cost: 2 }))
  ];
  line(recommendRoute('variant-tie', exactTie).model === 'local/model-a' && recommendRoute('variant-tie', [...exactTie].reverse()).model === 'local/model-a', 'equal exact variants use a deterministic model tie-break independent of history order');

  const equalMeasuredCost = [
    ...Array.from({ length: 3 }, () => measured({ taskClass: 'tie', route: 'local-low', model: 'local/qwen-low', effort: 'low', cost: 2 })),
    ...Array.from({ length: 3 }, () => measured({ taskClass: 'tie', route: 'local-high', model: 'local/qwen-high', effort: 'high', cost: 2 }))
  ];
  line(recommendRoute('tie', equalMeasuredCost).route === 'local-low', 'equal measured cost uses static tier weight only as a deterministic tie-break');

  // Insufficient evidence -> configured default, flagged as not measured.
  const rec3 = recommendRoute('novel', [], { defaultRoute: 'local-low', minAttempts: 3 });
  line(rec3.route === 'local-low' && rec3.measured === false, 'with no measured evidence the configured default is used and flagged unmeasured');

  // High-risk classes keep deterministic checks regardless of tier.
  const rec4 = recommendRoute('summarise', history, { highRiskClasses: ['summarise'] });
  line(rec4.requiresDeterministicChecks === true, 'a high-risk task class keeps deterministic checks regardless of the chosen route');
}

// Route summary computes success rate and average effective cost.
{
  const stats = summarizeRoutes([
    measured({ taskClass: 'x', route: 'local-low', cost: 1 }),
    measured({ taskClass: 'x', route: 'local-low', cost: 1, retries: 2, verificationPassed: false, accepted: false })
  ], { retryCost: 1 });
  const stat = stats.find((s) => s.route === 'local-low');
  line(stat.attempts === 2 && stat.successes === 1 && stat.successRate === 0.5, 'route summary reports attempts, successes, and success rate');
  line(stat.avgEffectiveCost === (1 + 3) / 2, 'route summary averages the effective (retry-inclusive) cost');
  line(stat.costPerSuccessfulTask === 4, 'cost per successful task includes the cost of failed and retried attempts in its numerator');
  const noSuccess = summarizeRoutes([measured({ taskClass: 'x', route: 'cloud', model: 'cloud/frontier', effort: 'high', cost: 5, verificationPassed: false, accepted: false })])[0];
  line(noSuccess.costPerSuccessfulTask === null, 'a route with no successful task has no fabricated cost-per-success value');
  const invalidLegacy = summarizeRoutes([
    { taskClass: 'legacy', route: 'local-high', cost: -5, verificationPassed: true, accepted: true },
    { taskClass: 'legacy', route: 'local-high', cost: 1, verificationPassed: true, accepted: true }
  ])[0];
  line(invalidLegacy.costEvidenceValid === false && invalidLegacy.avgEffectiveCost === null && invalidLegacy.costPerSuccessfulTask === null, 'invalid historical cost evidence is exposed as incomplete and never silently clamped');
  const legacyUnattributed = summarizeRoutes([{ taskClass: 'legacy', route: 'local-low', cost: 1, verificationPassed: true, accepted: true }])[0];
  line(legacyUnattributed.provenanceComplete === false && legacyUnattributed.costPerSuccessfulTask === null, 'legacy evidence remains visible but cannot become a measured recommendation');
  const invalidChoice = recommendRoute('legacy-choice', [
    ...Array.from({ length: 4 }, () => measured({ taskClass: 'legacy-choice', route: 'local-low', model: 'local/qwen-low', effort: 'low', cost: 2 })),
    ...Array.from({ length: 4 }, () => ({ taskClass: 'legacy-choice', route: 'local-high', cost: -5, verificationPassed: true, accepted: true }))
  ]);
  line(invalidChoice.route === 'local-low' && invalidChoice.measured === true, 'invalid historical cost rows cannot win measured route selection');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll cost-routing checks passed.');
process.exit(failures ? 1 : 0);
