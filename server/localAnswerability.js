// Transparent local-answerability assessment for controlled cloud escalation.
//
// This is the deliberate decision layer between "answer from approved local
// knowledge first" and "escalate to a reviewed cloud consultation only when
// local is insufficient and policy permits". It is PURE (no DB, IO, or network)
// so the same code the server uses can be unit-tested directly.
//
// Principles this encodes on purpose:
//   * Local-first: it is only ever consulted AFTER a local retrieval, and it
//     never says "go to cloud" while approved local evidence answers the ask.
//   * No hidden score: it returns a plain `coverage` label and human-readable
//     `reasons`, never an opaque confidence number the user cannot inspect.
//   * Controlled, never automatic: `escalation.requiresApproval` is ALWAYS true.
//     This module only ever *suggests*; it cannot and does not send anything.
//   * Policy-gated: escalation is permitted strictly by the caller's policy.
//   * Privacy-preserving: it does not nudge sensitive topics (health,
//     credentials) toward the cloud, even when local coverage is thin.

// An approved local record scoring at or above this is treated as a strong,
// directly-usable match. retrieveLocalKnowledge already drops anything below its
// own inclusion threshold, so this only distinguishes strong from weak matches.
export const STRONG_MATCH_SCORE = 25;

// Topics we never proactively suggest sending to a cloud provider. The user can
// still choose to start a reviewed check manually; we simply do not nudge it.
const SENSITIVE_QUESTION = /\b(?:diagnos(?:is|ed)|medication|prescription|therap(?:y|ist)|mental health|medical record|symptom|hospital|disabilit|password|passcode|api[ _-]?key|secret|social security|bank account|sort code)\b/i;
const SENSITIVE_INTENTS = new Set(['personal_health']);

function isSubstantiveQuestion(question) {
  const text = String(question || '').trim();
  return text.length >= 8 && /[a-z0-9]/i.test(text);
}

function topApprovedScore(items) {
  let best = null;
  for (const item of items) {
    if (item.state !== 'approved') continue;
    const score = Number(item.score);
    if (Number.isFinite(score) && (best === null || score > best)) best = score;
  }
  return best;
}

// Classify how well approved local knowledge covers the question.
//   'none'   — no local records matched at all;
//   'weak'   — records matched, but none is a strong approved match
//              (low relevance, or only pending/candidate items);
//   'strong' — at least one approved record is a strong, directly-usable match.
export function localCoverage(retrieval = {}) {
  const items = Array.isArray(retrieval.items) ? retrieval.items : [];
  if (!items.length) return 'none';
  const best = topApprovedScore(items);
  if (best !== null && best >= STRONG_MATCH_SCORE) return 'strong';
  return 'weak';
}

// Assess whether the local answer is sufficient and whether a controlled cloud
// escalation should be offered. Inputs:
//   retrieval — the object returned by retrieveLocalKnowledge (items/intent/…);
//   options.question    — the raw user question (for substance + sensitivity);
//   options.cloudPolicy — { allowed: boolean, reason?: string } from the caller;
//                         `allowed` is the only thing that can permit escalation.
// Returns a transparent decision the UI can render and the user can act on. It
// NEVER sends anything and NEVER escalates on its own.
export function assessLocalAnswerability(retrieval = {}, options = {}) {
  const items = Array.isArray(retrieval.items) ? retrieval.items : [];
  const intent = retrieval.intent || options.intent || 'general_conversation';
  const question = options.question ?? '';
  const cloudPolicy = options.cloudPolicy || {};
  const policyAllowed = Boolean(cloudPolicy.allowed);

  const coverage = localCoverage(retrieval);
  const answerable = coverage !== 'none';
  const substantive = isSubstantiveQuestion(question);
  const sensitive = SENSITIVE_INTENTS.has(intent) || SENSITIVE_QUESTION.test(String(question || ''));

  const reasons = [];
  if (coverage === 'strong') reasons.push(`${items.length} approved local record(s) matched, including a strong match — answer from local knowledge`);
  else if (coverage === 'weak') reasons.push(`${items.length} local record(s) matched, but none is a strong approved match`);
  else reasons.push('no approved local evidence matched this question');

  // Escalation is only *suggested* when local is genuinely insufficient, the
  // question is a real ask, it is not a sensitive topic, and policy permits it.
  const insufficient = coverage !== 'strong';
  let suggested = false;
  if (!policyAllowed) {
    reasons.push(cloudPolicy.reason ? `cloud escalation is unavailable: ${cloudPolicy.reason}` : 'cloud escalation is disabled by policy');
  } else if (!insufficient) {
    reasons.push('cloud escalation not needed — local knowledge already answers this');
  } else if (!substantive) {
    reasons.push('cloud escalation not suggested for a non-substantive message');
  } else if (sensitive) {
    reasons.push('sensitive topic — not auto-suggested for cloud; you can still start a reviewed check manually');
  } else {
    suggested = true;
    reasons.push('local evidence is thin and policy permits cloud — a reviewed cloud check is available for your approval');
  }

  return {
    coverage,
    answerable,
    sensitive,
    escalation: {
      permitted: policyAllowed,
      suggested,
      // The user always decides. This layer proposes; it never sends.
      requiresApproval: true,
      reason: reasons[reasons.length - 1]
    },
    reasons
  };
}
