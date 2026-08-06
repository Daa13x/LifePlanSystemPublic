#!/usr/bin/env node
// Verify the human-authority / copilot boundary contract using the REAL
// server/authorityBoundary.js module, and assert it is backed by the runtime
// confirmation machinery. Local-only: no network, server, or DB. Exit 0 = pass.

import fs from 'node:fs';
import path from 'node:path';
import {
  ACTION_LIFECYCLE,
  HIGH_RISK_CLASSES,
  ACTIVE_WORKFLOW_CONTROLS,
  classifyRisk,
  requiresHumanApproval,
  advanceLifecycle,
  isProvenCorrect,
  confidenceIsProof,
  canProceedAutomatically,
  availableControls
} from '../server/authorityBoundary.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- human-authority boundary verification ---');

// Lifecycle + risk vocabulary.
line(ACTION_LIFECYCLE.join(',') === 'recommendation,proposed,approved,executing,verified', 'the five lifecycle states are defined in order');
line(HIGH_RISK_CLASSES.length === 9 && ['destructive', 'financial', 'medical', 'release', 'source-of-truth'].every((c) => HIGH_RISK_CLASSES.includes(c)), 'the high-risk action classes are defined');

// Risk classification (explicit and keyword-based).
line(classifyRisk({ description: 'delete the project and overwrite the file' }).highRisk === true, 'a destructive action is classified high-risk');
line(classifyRisk({ description: 'buy the subscription with the saved card' }).classes.includes('financial'), 'a payment action is classified financial');
line(classifyRisk({ riskClasses: ['release'], description: 'x' }).classes.includes('release'), 'an explicit risk class is honoured');
line(classifyRisk({ description: 'summarise my notes' }).highRisk === false, 'a plain read/summarise action is not high-risk');

// Human approval is required for high-risk and irreversible actions.
line(requiresHumanApproval({ description: 'publish the release installer' }).required === true, 'publishing a release requires human approval');
line(requiresHumanApproval({ description: 'rename a local draft', reversible: false }).required === true, 'an irreversible action requires human approval even if low-risk');
line(requiresHumanApproval({ description: 'list open tasks' }).required === false, 'a low-risk reversible action does not require approval');

// Lifecycle transitions are ordered; approval and verification are gated.
line(advanceLifecycle('recommendation', { to: 'approved' }).ok === false, 'you cannot skip from recommendation straight to approved');
line(advanceLifecycle('proposed', { to: 'approved' }).ok === false, 'moving to approved without an explicit human decision is refused');
line(advanceLifecycle('proposed', { to: 'approved', humanApproval: true }).ok === true, 'an explicit human decision advances proposed -> approved');
line(advanceLifecycle('executing', { to: 'verified' }).ok === false, 'a verified result is refused without evidence');
line(advanceLifecycle('executing', { to: 'verified', evidence: 'tests pass' }).ok === true, 'evidence advances executing -> verified');

// Approval / confidence / agreement are not proof.
line(isProvenCorrect({ state: 'approved', evidence: 'x' }) === false, 'an approved-but-unverified action is not proven correct');
line(isProvenCorrect({ state: 'verified', evidence: 'tests', rollbackAvailable: true }) === true, 'a verified action with evidence and rollback is proven correct');
line(isProvenCorrect({ state: 'verified', evidence: 'tests', rollbackAvailable: false }) === false, 'even a verified action is not accepted if its rollback path is gone');
line(confidenceIsProof().sufficient === false, 'model confidence / repeated agreement is never sufficient proof');

// Automatic action requires low risk AND full bounds.
{
  const bounded = { permissions: ['read'], budget: 5, scope: ['src/'], stopConditions: ['done'] };
  line(canProceedAutomatically({ description: 'read a file' }, bounded).allowed === true, 'a low-risk, fully-bounded action may proceed automatically');
  line(canProceedAutomatically({ description: 'delete a file' }, bounded).allowed === false, 'a high-risk action may never proceed automatically');
  line(canProceedAutomatically({ description: 'read a file' }, { permissions: [], budget: 0, scope: [], stopConditions: [] }).violations.length >= 4, 'an unbounded action is blocked and names every missing bound');
}

// Interactive controls remain available while a workflow is active.
line(ACTIVE_WORKFLOW_CONTROLS.join(',') === 'pause,cancel,reject,edit,redirect', 'the five active-workflow controls are defined');
line(availableControls('executing').length === 5 && availableControls('verified').length === 0, 'pause/cancel/reject/edit/redirect are available for an active workflow, not a finished one');

// The boundary is backed by the runtime confirmation machinery, not just prose.
{
  const index = read('server/index.js');
  line(fs.existsSync(path.join(root, 'server', 'confirmations.js')) && fs.existsSync(path.join(root, 'server', 'mutationGuard.js')), 'the runtime confirmation and mutation-guard modules exist');
  line(/proposeConfirmation|confirmAndApply/.test(index), 'the server routes destructive actions through durable confirmations');
  line(/app\.post\('\/api\/approvals\/:id\/:decision'/.test(index), 'agent-proposed actions are decided through the approvals endpoint');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll human-authority boundary checks passed.');
process.exit(failures ? 1 : 0);
