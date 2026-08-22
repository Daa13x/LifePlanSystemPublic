#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildNativeCodingReadinessReceipt } from '../server/nativeCodingReadiness.js';

const task = {
  id: 'code-readiness-fixture',
  status: 'prepared',
  taskHash: 'a'.repeat(64),
  baseCommit: 'b'.repeat(40),
  validation: 'runtime',
  allowedPaths: ['server/index.js'],
  maxFilesChanged: 2
};
const authority = {
  checks: [
    { gate: 'approved_repository', ok: true },
    { gate: 'starting_branch_main', ok: true },
    { gate: 'clean_worktree', ok: true }
  ],
  receipt: { repository: 'daa13x/lifeplansystempublic', startingCommit: task.baseCommit, activeBranch: 'main' }
};
const readyInput = {
  task,
  taskSealValid: true,
  evidenceReady: true,
  baseCurrent: true,
  evidenceHash: 'c'.repeat(64),
  adviceHash: '',
  adviceCurrent: true,
  validationScope: { ok: true },
  model: {
    configured: true,
    provider: 'local-openai-compatible',
    model: 'org/model-q4',
    localInferenceVerified: true,
    verificationSource: 'explicit user verification',
    codingContextReady: true,
    rejectedRemoteEndpoint: false
  },
  authority,
  workerAvailable: true,
  runLeaseState: 'available',
  applyLeaseState: 'available',
  worktreeAvailable: true
};
const ready = buildNativeCodingReadinessReceipt(readyInput);

assert.equal(ready.ready, true);
assert.equal(ready.kind, 'native_coding.run_readiness');
assert.equal(ready.authorizesExecution, false);
assert.equal(ready.authorizationGranted, false);
assert.equal(ready.executionStarted, false);
assert.deepEqual(ready.effects, { runtimeStarted: false, worktreeCreated: false, leaseAcquired: false });
assert.match(ready.receiptHash, /^[a-f0-9]{64}$/);
assert.ok(ready.gates.every((item) => item.ok && item.reasonCode === 'ok'));

const blocked = buildNativeCodingReadinessReceipt({
  task: { ...task, status: 'running' },
  taskSealValid: false,
  evidenceReady: false,
  adviceCurrent: false,
  validationScope: { ok: false },
  model: { configured: false, provider: '', model: 'C:\\Users\\private\\secret.gguf', localInferenceVerified: false, verificationSource: '', codingContextReady: false, rejectedRemoteEndpoint: true },
  authority: { checks: [{ gate: 'approved_repository', ok: false }], receipt: {} },
  workerAvailable: false,
  runLeaseState: 'unreadable',
  applyLeaseState: 'active',
  worktreeAvailable: false
});
assert.equal(blocked.ready, false);
assert.ok(blocked.gates.every((item) => typeof item.reasonCode === 'string' && !Object.hasOwn(item, 'detail')));
const serialized = JSON.stringify(blocked);
for (const secret of ['C:\\Users\\private', 'secret.gguf', 'ownerPid', 'tokenHash']) assert.ok(!serialized.includes(secret), `readiness receipt excludes ${secret}`);

const server = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
assert.match(server, /nativeCodingModelConfig\(false\)/, 'readiness never starts the managed model runtime');
assert.match(server, /assessNativeCodingRunReadiness[\s\S]*proposeCodingConfirmation/, 'run proposals use the shared readiness assessor');
assert.match(server, /revalidate:\s*\(\)\s*=>\s*codingConfirmationSnapshot/, 'confirmation revalidation recomputes the same readiness-bound snapshot');
assert.match(server, /authorizationGranted:\s*false|buildNativeCodingReadinessReceipt/, 'readiness remains explicitly non-authorizing');

// determinism: identical input => identical digest
const readyAgain = buildNativeCodingReadinessReceipt(readyInput);
assert.equal(readyAgain.receiptHash, ready.receiptHash);
// drift: any readiness change => different digest (confirmation can detect drift, fail closed)
const drifted = buildNativeCodingReadinessReceipt({ ...readyInput, task: { ...readyInput.task, baseCommit: 'd'.repeat(40) } });
assert.notEqual(drifted.receiptHash, ready.receiptHash);

console.log('Native coding readiness receipt verification passed.');
