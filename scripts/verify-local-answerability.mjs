#!/usr/bin/env node
// Verify the transparent local-answerability / controlled-escalation decision
// using the REAL server/localAnswerability.js module. Local-only: no network,
// no server, no DB. Exit 0 = pass.

import {
  STRONG_MATCH_SCORE,
  localCoverage,
  assessLocalAnswerability
} from '../server/localAnswerability.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

const approved = (score) => ({ state: 'approved', score, canonicalId: 'knowledge:1', title: 't' });
const pending = (score) => ({ state: 'pending', score, canonicalId: 'candidate:1', title: 't' });
const allow = { cloudPolicy: { allowed: true }, question: 'what is my registered gp surgery address' };
const deny = { cloudPolicy: { allowed: false, reason: 'cloud is turned off in settings' }, question: 'what is my registered gp surgery address' };

console.log('--- local answerability verification ---');

// --- coverage classification is transparent and approval-state aware ---
line(localCoverage({ items: [] }) === 'none', 'no matches is "none" coverage');
line(localCoverage({ items: [approved(STRONG_MATCH_SCORE + 5)] }) === 'strong', 'a strong approved match is "strong" coverage');
line(localCoverage({ items: [approved(STRONG_MATCH_SCORE - 5)] }) === 'weak', 'a low-scoring approved match is only "weak"');
line(localCoverage({ items: [pending(100)] }) === 'weak', 'a high-scoring pending candidate is not "strong" (unapproved)');

// --- strong local coverage: answerable, and escalation is NOT suggested ---
{
  const a = assessLocalAnswerability({ items: [approved(STRONG_MATCH_SCORE + 10)], intent: 'housing' }, allow);
  line(a.answerable === true, 'strong coverage is answerable locally');
  line(a.escalation.suggested === false, 'strong local coverage does not suggest cloud escalation (local-first)');
  line(a.reasons.some((r) => /local knowledge/i.test(r)), 'the local-first decision is explained');
}

// --- no/weak local coverage + policy permits: escalation is SUGGESTED ---
{
  const none = assessLocalAnswerability({ items: [], intent: 'housing' }, allow);
  line(none.answerable === false, 'no coverage is not answerable locally');
  line(none.escalation.suggested === true, 'no local evidence + permitting policy suggests a reviewed cloud check');
  const weak = assessLocalAnswerability({ items: [approved(STRONG_MATCH_SCORE - 8)], intent: 'housing' }, allow);
  line(weak.answerable === true && weak.escalation.suggested === true, 'weak coverage stays answerable but still offers escalation');
}

// --- controlled: escalation ALWAYS requires user approval, never auto-sends ---
for (const items of [[], [approved(5)], [approved(100)]]) {
  const a = assessLocalAnswerability({ items, intent: 'housing' }, allow);
  line(a.escalation.requiresApproval === true, 'escalation always requires explicit user approval');
}

// --- policy gate: no escalation is offered when policy forbids it ---
{
  const a = assessLocalAnswerability({ items: [], intent: 'housing' }, deny);
  line(a.escalation.permitted === false && a.escalation.suggested === false, 'a forbidding policy blocks any escalation suggestion');
  line(a.reasons.some((r) => /turned off in settings/.test(r)), 'the policy reason is surfaced verbatim');
}

// --- privacy: sensitive topics are not nudged toward the cloud ---
{
  const health = assessLocalAnswerability({ items: [], intent: 'personal_health' }, { cloudPolicy: { allowed: true }, question: 'what medication am i taking' });
  line(health.sensitive === true && health.escalation.suggested === false, 'a sensitive health question is never auto-suggested for cloud');
  line(health.escalation.permitted === true, 'policy still reports cloud as permitted (the user may start a check manually)');
  const creds = assessLocalAnswerability({ items: [], intent: 'general_conversation' }, { cloudPolicy: { allowed: true }, question: 'what is my bank account password' });
  line(creds.sensitive === true && creds.escalation.suggested === false, 'a credentials question is treated as sensitive and not nudged to cloud');
}

// --- non-substantive messages do not trigger escalation ---
{
  const a = assessLocalAnswerability({ items: [], intent: 'greeting' }, { cloudPolicy: { allowed: true }, question: 'hi' });
  line(a.escalation.suggested === false, 'a greeting does not suggest cloud escalation');
}

// --- every decision carries human-readable reasons (no hidden score) ---
{
  const a = assessLocalAnswerability({ items: [approved(30)], intent: 'housing' }, allow);
  line(Array.isArray(a.reasons) && a.reasons.length > 0 && typeof a.escalation.reason === 'string', 'the assessment always explains itself in plain language');
  line(!('score' in a) && !('confidence' in a), 'no opaque numeric confidence is exposed — only a transparent coverage label');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll local-answerability checks passed.');
process.exit(failures ? 1 : 0);
