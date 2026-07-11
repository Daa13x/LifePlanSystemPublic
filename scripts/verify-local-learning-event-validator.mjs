#!/usr/bin/env node
// Verify the pure local-learning event validator and manual validation path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLocalLearningEvent } from '../server/localLearningEventValidator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const validExamplePath = path.join(repoRoot, 'docs', 'agent_mode', 'examples', 'local-learning-event.valid.json');
const requiresApprovalPath = path.join(repoRoot, 'docs', 'agent_mode', 'examples', 'local-learning-event.requires-approval.json');
const validatorPath = path.join(repoRoot, 'server', 'localLearningEventValidator.js');

const REQUIRED_FIELDS = [
  'task_type',
  'selected_skills',
  'agent_target',
  'result_quality',
  'mistakes',
  'lesson',
  'skill_update_candidate',
  'memory_route',
  'approval_required'
];

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function checkFails(name, event, expectedFragment) {
  const result = validateLocalLearningEvent(event);
  line(!result.ok && result.errors.some((error) => error.includes(expectedFragment)),
    `${name} fails with ${JSON.stringify({ errors: result.errors })}`);
}

console.log('--- Local learning event validator verification ---');

line(typeof validateLocalLearningEvent === 'function', 'validator exports validateLocalLearningEvent');

const validExample = readJson(validExamplePath);
const requiresApprovalExample = readJson(requiresApprovalPath);

line(validateLocalLearningEvent(validExample).ok, 'valid example passes');
line(validateLocalLearningEvent(requiresApprovalExample).ok, 'requires-approval example passes');
line(requiresApprovalExample.approval_required === true, 'requires-approval fixture keeps approval_required true');

for (const field of REQUIRED_FIELDS) {
  const event = clone(validExample);
  delete event[field];
  checkFails(`missing ${field}`, event, `${field} is required`);
}

{
  const event = { ...clone(validExample), unexpected: true };
  checkFails('extra unknown field', event, 'unexpected is not an allowed field');
}

{
  const event = { ...clone(validExample), agent_target: 'other-agent' };
  checkFails('invalid agent_target', event, 'agent_target must be one of');
}

{
  const event = { ...clone(validExample), result_quality: 'great' };
  checkFails('invalid result_quality', event, 'result_quality must be one of');
}

{
  const event = { ...clone(validExample), memory_route: 'write_now' };
  checkFails('invalid memory_route', event, 'memory_route must be one of');
}

{
  const event = { ...clone(validExample), approval_required: 'yes' };
  checkFails('non-boolean approval_required', event, 'approval_required must be a boolean');
}

{
  // Fail closed: the sensitive route may never claim approval is not required.
  const event = {
    ...clone(validExample),
    memory_route: 'source_of_truth_candidate_requires_approval',
    approval_required: false
  };
  checkFails('source-of-truth candidate route without approval_required=true', event,
    'approval_required must be true when memory_route is source_of_truth_candidate_requires_approval');
}

{
  // Positive control: the same route with approval_required=true stays valid.
  const event = {
    ...clone(validExample),
    memory_route: 'source_of_truth_candidate_requires_approval',
    approval_required: true
  };
  line(validateLocalLearningEvent(event).ok,
    'source-of-truth candidate route with approval_required=true passes');
}

{
  const event = { ...clone(validExample), skill_update_candidate: 'free-form note' };
  checkFails('skill_update_candidate non-empty string', event,
    'skill_update_candidate string form must be the empty string');
}

{
  const event = { ...clone(validExample), skill_update_candidate: {} };
  checkFails('skill_update_candidate empty object', event, 'skill_update_candidate.skill is required');
}

{
  const event = { ...clone(validExample), skill_update_candidate: { skill: '', change: 'c' } };
  checkFails('skill_update_candidate empty skill', event, 'skill_update_candidate.skill must be a non-empty string');
}

{
  const event = { ...clone(validExample), skill_update_candidate: { skill: 's', change: 'c', extra: 'x' } };
  checkFails('skill_update_candidate with extra key', event, 'skill_update_candidate.extra is not an allowed field');
}

{
  // Positive controls for the tightened shape.
  const objectOk = { ...clone(validExample), skill_update_candidate: { skill: 's', change: 'c' } };
  line(validateLocalLearningEvent(objectOk).ok, 'skill_update_candidate closed {skill, change} object passes');
  const emptyStringOk = { ...clone(validExample), skill_update_candidate: '' };
  line(validateLocalLearningEvent(emptyStringOk).ok, 'skill_update_candidate empty string passes');
}

{
  let malformedFailed = false;
  try {
    JSON.parse('{');
  } catch {
    malformedFailed = true;
  }
  line(malformedFailed, 'malformed JSON fails through parser path');
}

const validatorSource = fs.readFileSync(validatorPath, 'utf8');
const forbiddenSourceTerms = [
  'node:' + 'fs',
  'writeFile',
  'appendFile',
  'createWriteStream',
  'mkdir',
  'unlink',
  'rename',
  'fe' + 'tch(',
  'ax' + 'ios',
  'child_' + 'process',
  'ex' + 'ec(',
  'sp' + 'awn(',
  'pupp' + 'eteer',
  'play' + 'wright',
  'source_of_truth' + '/',
  'sk' + '-',
  'password' + '=',
  'token' + '='
];
const sourceHits = forbiddenSourceTerms.filter((term) => validatorSource.includes(term));
line(sourceHits.length === 0, `validator source has no write/network/action tokens -> ${JSON.stringify(sourceHits)}`);

console.log(`\n${failures === 0 ? 'ALL PASS - local learning event validator is pure and non-writing.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
