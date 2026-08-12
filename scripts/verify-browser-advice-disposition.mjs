import fs from 'node:fs';
import path from 'node:path';
import { normalizeAdviceDisposition, ADVICE_REVIEW_STATES } from '../server/browserAdviceDisposition.js';

// Acceptance for deferred browser-status normalization (MA-Dev audit delta #5).
// Every advice outcome must normalize to a clear review state that names what is
// missing and the next allowed human action, and NONE may auto-relaunch the local
// run. Also statically confirms the advice handlers attach a disposition and the
// UI surfaces it. Pure and local. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- browser-advice disposition verification ---');

// The invariant that matters most: no disposition ever relaunches the run, and
// every disposition tells the operator what is missing and what they may do next.
for (const state of ADVICE_REVIEW_STATES) {
  const d = normalizeAdviceDisposition({ status: state, provider: 'ChatGPT' });
  line(d.state === state, `${state}: disposition echoes the advice state`);
  line(d.relaunchesRun === false, `${state}: never auto-relaunches the local run`);
  line(typeof d.nextAction === 'string' && d.nextAction.length > 0, `${state}: names the next allowed human action`);
  line(typeof d.category === 'string' && d.category.length > 0, `${state}: carries a review category`);
}

// State-specific meaning.
const unavailable = normalizeAdviceDisposition({ status: 'unavailable', provider: 'ChatGPT' });
line(unavailable.category === 'deferred' && /connected ChatGPT/.test(unavailable.missing), 'unavailable is a deferred state naming the missing provider tab');
line(/run locally without advice/i.test(unavailable.nextAction), 'unavailable offers running locally without advice');

const awaiting = normalizeAdviceDisposition({ status: 'awaiting', provider: 'ChatGPT' });
line(awaiting.category === 'in-progress' && awaiting.terminal === false, 'awaiting is a non-terminal in-progress state');
line(/reused and never resent/i.test(awaiting.nextAction), 'awaiting reuses the same job and never resends');

const incomplete = normalizeAdviceDisposition({ status: 'incomplete', provider: 'ChatGPT' });
line(incomplete.category === 'deferred' && /complete terminal reply/i.test(incomplete.missing), 'incomplete names the missing complete reply');

const rejected = normalizeAdviceDisposition({ status: 'rejected', provider: 'ChatGPT' });
line(rejected.category === 'rejected' && /path-scope, injection/i.test(rejected.missing), 'rejected names the failed validation dimensions');
line(/cannot alter scope or apply code/i.test(rejected.nextAction), 'rejected reasserts advice cannot alter scope or apply code');

const validated = normalizeAdviceDisposition({ status: 'validated', provider: 'ChatGPT' });
line(validated.category === 'ready' && validated.missing === '', 'validated is ready with nothing missing');
line(/never widens scope, applies code, or counts as validation/i.test(validated.nextAction), 'validated reasserts advice is not authority');

const none = normalizeAdviceDisposition({});
line(none.category === 'none' && none.relaunchesRun === false, 'an absent advice record normalizes safely');

// Provider interpolation must not leak the placeholder token.
line(!JSON.stringify(normalizeAdviceDisposition({ status: 'unavailable', provider: 'Claude' })).includes('{provider}'), 'the provider placeholder is always substituted');

// ---- static wiring ----
const serverSource = fs.readFileSync(path.join(appRoot, 'server', 'index.js'), 'utf8');
const attaches = (serverSource.match(/disposition = normalizeAdviceDisposition\(/g) || []).length;
line(attaches >= 4, 'the advice handlers attach a normalized disposition at each transition');
const uiSource = fs.readFileSync(path.join(appRoot, 'src', 'main.jsx'), 'utf8');
line(/browserAdvice\.disposition/.test(uiSource) && /d\.nextAction/.test(uiSource), 'the review UI surfaces the disposition and its next action');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll browser-advice disposition checks passed.');
process.exit(failures ? 1 : 0);
