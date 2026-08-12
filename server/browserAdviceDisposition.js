// Deferred browser-status normalization (MA-Dev audit delta #5). Optional browser
// consultation can end in several non-success ways: the provider tab was not
// connected, the turn is still in flight, the reply was captured incompletely, or
// the answer failed validation. MA-Dev's lesson is to turn each into a clear
// review state that names what is missing and the next allowed HUMAN action —
// never a blind re-run. This module is that normalizer: pure, and every state
// carries relaunchesRun:false so no disposition can auto-relaunch the local run.

export const ADVICE_REVIEW_STATES = Object.freeze(['preview', 'blocked', 'awaiting', 'unavailable', 'incomplete', 'rejected', 'validated']);

function withProvider(text, provider) {
  return text.replaceAll('{provider}', provider || 'the provider');
}

// Given a browser-advice record, return a normalized review disposition. `state`
// echoes the advice status; `category` groups it for the UI; `missing` states what
// evidence/condition is absent; `nextAction` is the next allowed human step; and
// `relaunchesRun` is always false — a deferral or failure never restarts the run.
export function normalizeAdviceDisposition(advice = {}) {
  const state = String(advice?.status || 'none');
  const provider = advice?.provider || '';
  const base = { state, provider: provider || null, relaunchesRun: false };

  switch (state) {
    case 'preview':
      return { ...base, category: 'ready', terminal: false, resumable: true,
        label: 'Prepared — awaiting your review',
        missing: 'your review and send confirmation of the exact provider-bound prompt',
        nextAction: withProvider('Review the exact prompt and confirm to send one advisory request to {provider}, or run locally without advice.', provider) };
    case 'blocked':
      return { ...base, category: 'blocked', terminal: true, resumable: true,
        label: 'Blocked by cloud-egress classification',
        missing: 'a prompt that passes cloud-egress classification',
        nextAction: 'Narrow the scope so no protected content is included, or run locally without advice. Nothing was sent.' };
    case 'awaiting':
      return { ...base, category: 'in-progress', terminal: false, resumable: true,
        label: 'Awaiting the provider reply',
        missing: 'the provider’s completed terminal reply',
        nextAction: 'Poll again — the same job is reused and never resent. You may also run locally without advice.' };
    case 'unavailable':
      return { ...base, category: 'deferred', terminal: true, resumable: true,
        label: 'Deferred — no connected provider tab',
        missing: withProvider('a connected {provider} provider tab', provider),
        nextAction: withProvider('Connect the {provider} tab and send the prepared prompt again, or run locally without advice. Nothing was sent.', provider) };
    case 'incomplete':
      return { ...base, category: 'deferred', terminal: true, resumable: true,
        label: 'Deferred — reply captured incompletely',
        missing: 'a complete terminal reply from the provider',
        nextAction: 'Send one fresh advisory request, or run locally without advice.' };
    case 'rejected':
      return { ...base, category: 'rejected', terminal: true, resumable: true,
        label: 'Rejected — advice failed validation',
        missing: 'advice that passes path-scope, injection, and task-identity validation',
        nextAction: 'Discard this advice and run locally, or re-consult for corrected advice. It cannot alter scope or apply code.' };
    case 'validated':
      return { ...base, category: 'ready', terminal: true, resumable: true,
        label: 'Validated untrusted advisory context',
        missing: '',
        nextAction: 'Optionally consider this untrusted context, then confirm a run. Advice never widens scope, applies code, or counts as validation.' };
    default:
      return { ...base, category: 'none', terminal: false, resumable: true,
        label: 'No browser consultation',
        missing: 'no browser advice has been requested',
        nextAction: 'Prepare an advisory prompt if you want optional untrusted context, or run locally without advice.' };
  }
}
