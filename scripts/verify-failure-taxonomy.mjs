#!/usr/bin/env node
// Verify the pure failure-taxonomy rules using the REAL server/failureTaxonomy.js
// module. Local-only: no network, server, or DB. Exit 0 = pass.

import {
  FAILURE_CATEGORIES,
  FAILURE_STATUSES,
  normalizeFailure,
  isConfirmed,
  proposeRemediation,
  summarizeByCategory,
  evaluateImprovement
} from '../server/failureTaxonomy.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- failure taxonomy verification ---');

// The 12 distinct categories the feedback described.
line(FAILURE_CATEGORIES.length === 12 && ['repeated-question', 'no-progress-loop', 'unnecessary-cloud-escalation', 'missed-escalation'].every((c) => FAILURE_CATEGORIES.includes(c)), 'the twelve failure categories are defined');

// Validation + attribution.
{
  let threw = false;
  try { normalizeFailure({ category: 'oops' }); } catch { threw = true; }
  line(threw, 'an invalid failure category is rejected');
  const r = normalizeFailure({ category: 'MISSING-ATTACHMENT', source: 'loop-guard', taskRef: 'w1', runId: 'r9', inputs: 'manifest X', evidence: 'file absent', correction: 'added file', outcome: 'sent' });
  line(r.category === 'missing-attachment' && r.status === 'observed' && r.taskRef === 'w1' && r.runId === 'r9' && r.evidence === 'file absent', 'a failure is normalised with its full attribution (task, run, inputs, evidence, correction, outcome)');
}

// A single failure never drives change; only a CONFIRMED one proposes a candidate.
{
  line(proposeRemediation({ status: 'observed', category: 'wrong-question-type' }).propose === false, 'an unconfirmed failure proposes nothing (no change from a single observation)');
  const testable = proposeRemediation({ status: 'confirmed', category: 'wrong-question-type' });
  line(testable.propose === true && testable.kind === 'regression-test' && testable.requiresReview === true, 'a confirmed mechanical failure proposes a regression test for review');
  const soft = proposeRemediation({ status: 'confirmed', category: 'unsupported-answer' });
  line(soft.propose === true && soft.kind === 'reviewed-prompt-or-router-candidate', 'a confirmed judgement failure proposes a reviewed prompt/router candidate');
  line(isConfirmed({ status: 'confirmed' }) && !isConfirmed({ status: 'observed' }), 'confirmation state is read correctly');
}

// Category counting.
{
  const counts = summarizeByCategory([{ category: 'repeated-question' }, { category: 'repeated-question' }, { category: 'missed-escalation' }, { category: 'bogus' }]);
  line(counts['repeated-question'] === 2 && counts['missed-escalation'] === 1 && !('bogus' in counts), 'failures are counted per known category and unknowns ignored');
}

// Before/after evaluation: improvement only when the target falls AND nothing rises.
{
  const good = evaluateImprovement('repeated-question', { 'repeated-question': 5, 'missing-attachment': 2 }, { 'repeated-question': 1, 'missing-attachment': 2 });
  line(good.improved === true, 'a target class falling with nothing else rising is an improvement');
  const traded = evaluateImprovement('repeated-question', { 'repeated-question': 5, 'missing-attachment': 2 }, { 'repeated-question': 1, 'missing-attachment': 6 });
  line(traded.improved === false && traded.regressions.some((r) => r.category === 'missing-attachment'), 'trading one failure class for another is NOT an improvement');
  const flat = evaluateImprovement('repeated-question', { 'repeated-question': 3 }, { 'repeated-question': 3 });
  line(flat.improved === false && /did not fall/.test(flat.reason), 'no change in the target class is not an improvement');
  line(evaluateImprovement('unknown', {}, {}).improved === false, 'an unknown target class cannot be claimed as improved');
}

line(FAILURE_STATUSES.join(',') === 'observed,confirmed,converted,dismissed', 'the failure lifecycle statuses are defined');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll failure-taxonomy checks passed.');
process.exit(failures ? 1 : 0);
