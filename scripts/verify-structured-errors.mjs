import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFailureEnvelope, failureChatContent, normalizeFailure, StructuredFailureError } from '../server/failureContract.js';
import { buildDetailRows } from '../src/messageDetail.js';

const root = path.resolve(import.meta.dirname, '..');
const cause = new StructuredFailureError({
  errorCode: 'CONNECTION_REFUSED', message: 'The local connector refused the request.',
  subsystem: 'browser.connector', stage: 'browser.connector.post', operation: 'post_result', reason: 'connection_refused',
  lastSuccessfulStage: 'browser.prompt.submitted', failedStage: 'browser.connector.post', retryable: true
});
const failure = normalizeFailure(new Error('outer', { cause }), {
  errorCode: 'BROWSER_DISPATCH_FAILED', message: 'The browser dispatch could not be verified.',
  subsystem: 'cloud.consult', stage: 'browser.dispatch.verify', operation: 'verify_dispatch', reason: 'dispatch_unverified',
  lastSuccessfulStage: 'browser.prompt.submitted', failedStage: 'browser.dispatch.verify', retryable: true,
  userActionRequired: false, causedBy: cause
});
assert.equal(failure.errorCode, 'BROWSER_DISPATCH_FAILED');
assert.equal(failure.lastSuccessfulStage, 'browser.prompt.submitted');
assert.equal(failure.failedStage, 'browser.dispatch.verify');
assert.equal(failure.causedBy.errorCode, 'CONNECTION_REFUSED', 'nested causal evidence is retained');
assert.match(failureChatContent(failure), /BROWSER_DISPATCH_FAILED/);

const uncertain = createFailureEnvelope({
  errorCode: 'REMOTE_RESPONSE_TIMEOUT', message: 'The remote response was not observed before the deadline.',
  subsystem: 'browser.capture', stage: 'remote.response.wait', operation: 'wait_for_response', reason: 'deadline_elapsed',
  lastSuccessfulStage: 'browser.prompt.submitted', failedStage: 'remote.response.detected',
  lastConfirmed: 'browser.prompt.submitted', firstUnconfirmed: 'remote.response.detected', retryable: true
});
assert.equal(uncertain.lastConfirmed, 'browser.prompt.submitted');
assert.equal(uncertain.firstUnconfirmed, 'remote.response.detected');
assert.doesNotMatch(uncertain.message, /ChatGPT crashed/i, 'unknown remote cause is not invented');

const rows = buildDetailRows({
  failure,
  memoryGovernance: { created: false },
  execution: { route: {}, capabilitiesUsed: [], toolsUsed: [], contextRetrieved: {}, mutations: [], verification: [], receipts: {} }
}, 'developer');
assert.ok(rows.some(([label, value]) => label === 'Failure' && /BROWSER_DISPATCH_FAILED/.test(value)));
assert.ok(rows.some(([label, value]) => label === 'Last successful' && value === 'browser.prompt.submitted'));
assert.ok(rows.some(([label, value]) => label === 'Caused by' && /CONNECTION_REFUSED/.test(value)));

const ui = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
assert.match(ui, /await sendViaJson\(outgoing, optimisticId, requestKey, originSessionId\);[\s\S]*?recordFailure: true/, 'direct cloud invocation persists through the existing Chat-send owner before preview');
assert.match(ui, /failure && 'error'/, 'structured failure metadata selects the error bubble');
assert.match(css, /\.message\.assistant\.error/, 'assistant failure bubble has explicit error styling');

console.log('Structured failure contract verification passed.');
