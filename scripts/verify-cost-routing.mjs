#!/usr/bin/env node
// Verify the pure adaptive cost-routing rules using the REAL server/costRouting.js
// module. Local-only: no network, server, or DB. Exit 0 = pass.

import {
  DEFAULT_ROUTE_TIERS,
  effectiveCost,
  shouldEscalate,
  summarizeRoutes,
  recommendRoute
} from '../server/costRouting.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

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
    ...Array.from({ length: 4 }, () => ({ taskClass: 'summarise', route: 'local-low', cost: 1, verificationPassed: true, accepted: true })),
    // cloud also works but is far more expensive
    ...Array.from({ length: 4 }, () => ({ taskClass: 'summarise', route: 'cloud', cost: 10, verificationPassed: true, accepted: true }))
  ];
  const rec = recommendRoute('summarise', history, { acceptanceThreshold: 0.7, minAttempts: 3 });
  line(rec.route === 'local-low' && rec.measured === true, 'the cheapest route meeting the measured acceptance bar is chosen');

  // A cheap route that mostly fails must NOT be chosen despite being cheapest.
  const failingCheap = [
    ...Array.from({ length: 4 }, () => ({ taskClass: 'code', route: 'local-low', cost: 1, verificationPassed: false, accepted: false })),
    ...Array.from({ length: 4 }, () => ({ taskClass: 'code', route: 'local-high', cost: 3, verificationPassed: true, accepted: true }))
  ];
  const rec2 = recommendRoute('code', failingCheap, { acceptanceThreshold: 0.7, minAttempts: 3 });
  line(rec2.route === 'local-high', 'a cheap route that repeatedly fails is skipped for the next tier that meets the bar');

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
    { taskClass: 'x', route: 'local-low', cost: 1, verificationPassed: true, accepted: true },
    { taskClass: 'x', route: 'local-low', cost: 1, retries: 2, verificationPassed: false, accepted: false }
  ], { retryCost: 1 });
  const stat = stats.find((s) => s.route === 'local-low');
  line(stat.attempts === 2 && stat.successes === 1 && stat.successRate === 0.5, 'route summary reports attempts, successes, and success rate');
  line(stat.avgEffectiveCost === (1 + 3) / 2, 'route summary averages the effective (retry-inclusive) cost');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll cost-routing checks passed.');
process.exit(failures ? 1 : 0);
