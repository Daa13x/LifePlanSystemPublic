#!/usr/bin/env node
// Verify the deterministic unattended-loop guard using the REAL
// server/unattendedLoopGuard.js module. Local-only: no network, server, or DB.
// Exit 0 = pass.

import {
  WORK_ITEM_REQUIRED_FIELDS,
  QUESTION_TYPES,
  WORKFLOW_PHASES,
  assessEligibility,
  validateQuestionForPhase,
  validateAttachmentManifest,
  detectNoProgress,
  evaluateUnattendedSend
} from '../server/unattendedLoopGuard.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- unattended loop guard verification ---');

// --- eligibility contract ---
line(WORK_ITEM_REQUIRED_FIELDS.length === 6 && ['id', 'scope', 'stopConditions'].every((f) => WORK_ITEM_REQUIRED_FIELDS.includes(f)), 'the eligibility contract requires the six bounding fields');
{
  const bare = assessEligibility({ id: 'w1', state: 'execution' });
  line(!bare.eligible && bare.missing.includes('scope') && bare.missing.includes('stopConditions'), 'an underspecified item is not eligible and names what is missing');
  const full = assessEligibility({ id: 'w1', state: 'execution', scope: ['src/'], requiredEvidence: ['tests'], expectedOutput: 'a patch', stopConditions: ['tests green'] });
  line(full.eligible && full.missing.length === 0, 'a fully bounded item is eligible for automatic selection');
  const emptyScope = assessEligibility({ id: 'w1', state: 'execution', scope: [], requiredEvidence: ['x'], expectedOutput: 'y', stopConditions: ['z'] });
  line(!emptyScope.eligible && emptyScope.missing.includes('scope'), 'an empty authorised scope is never eligible');
}

// --- question type must match the workflow phase ---
line(QUESTION_TYPES.length === 6 && WORKFLOW_PHASES.includes('execution'), 'question types and workflow phases are defined');
line(validateQuestionForPhase('completion-report', 'execution').valid === false, 'a completion report during execution is rejected as off-track');
line(validateQuestionForPhase('blocker-report', 'execution').valid === true, 'a blocker report during execution is appropriate');
line(validateQuestionForPhase('verification-request', 'verification').valid === true, 'a verification request during verification is appropriate');
line(validateQuestionForPhase('nonsense', 'execution').valid === false && validateQuestionForPhase('clarification', 'nowhere').valid === false, 'unknown question types and phases are rejected');

// --- attachment manifest fails closed ---
{
  const scope = ['src/'];
  const available = [{ path: 'src/a.js', hash: 'h1' }, { path: 'src/b.js', hash: 'h2', stale: true }];
  line(validateAttachmentManifest([{ path: 'src/a.js', hash: 'h1' }], available, { scope }).ok === true, 'a manifest matching in-scope current files is safe');
  line(validateAttachmentManifest([{ path: 'src/missing.js' }], available, { scope }).ok === false, 'a missing required file fails closed');
  line(validateAttachmentManifest([{ path: 'secrets/.env' }], available, { scope }).ok === false, 'an out-of-scope file fails closed');
  line(validateAttachmentManifest([{ path: 'src/a.js', hash: 'DIFFERENT' }], available, { scope }).ok === false, 'a changed file (hash mismatch) fails closed');
  line(validateAttachmentManifest([{ path: 'src/b.js', hash: 'h2' }], available, { scope }).ok === false, 'a stale file fails closed');
  line(validateAttachmentManifest([{ path: 'src/a.js' }], available, { scope: [] }).ok === false, 'with no authorised scope, nothing is attachable');
}

// --- duplicate and no-progress detection ---
{
  const base = { type: 'clarification', text: 'Which config file?', evidenceHash: 'e1', stateHash: 's1' };
  line(detectNoProgress([base]).blocked === false, 'a first attempt is not blocked');
  const dup = detectNoProgress([base, { ...base }]);
  line(dup.blocked === true && dup.duplicateOf === 0, 'a repeated question with no new evidence or state is blocked as a duplicate');
  const justified = detectNoProgress([base, { ...base, justifiedRetry: true }]);
  line(justified.blocked === false, 'a justified retry of the same question is allowed');
  const progressed = detectNoProgress([base, { ...base, text: 'Which config file — the prod one?', evidenceHash: 'e2', stateHash: 's2' }]);
  line(progressed.blocked === false, 'a question with new evidence/state is progress, not a duplicate');
  const stagnant = detectNoProgress([
    { type: 'evidence-request', text: 'run 1', evidenceHash: 'e', stateHash: 's' },
    { type: 'evidence-request', text: 'run 2', evidenceHash: 'e', stateHash: 's' },
    { type: 'evidence-request', text: 'run 3', evidenceHash: 'e', stateHash: 's' }
  ], { limit: 3 });
  line(stagnant.blocked === true && /no progress/.test(stagnant.reason), 'the loop stops for human review after the no-progress limit');
}

// --- full preparation gate ---
{
  const item = { id: 'w1', state: 'execution', scope: ['src/'], requiredEvidence: ['tests'], expectedOutput: 'a patch', stopConditions: ['tests green'] };
  const ready = evaluateUnattendedSend({
    item, phase: 'execution',
    question: { type: 'evidence-request', text: 'attach the failing test', evidenceHash: 'e1', stateHash: 's1' },
    manifest: [{ path: 'src/a.js', hash: 'h1' }], available: [{ path: 'src/a.js', hash: 'h1' }], attempts: []
  });
  line(ready.ready === true && Array.isArray(ready.reasons) && ready.reasons.length >= 3, 'a fully-bounded, in-phase, in-scope send is ready with transparent reasons');
  const unsafe = evaluateUnattendedSend({
    item, phase: 'execution',
    question: { type: 'completion-report', text: 'done', evidenceHash: 'e1', stateHash: 's1' },
    manifest: [{ path: 'secrets/.env' }], available: [], attempts: []
  });
  line(unsafe.ready === false, 'a wrong-phase question with an out-of-scope attachment is not ready');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll unattended-loop-guard checks passed.');
process.exit(failures ? 1 : 0);
