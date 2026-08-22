// Deterministic guardrails for an unattended Workboard loop. This is the safety
// core your uncle's feedback asked for: deterministic PREPARATION and
// no-progress detection, NOT unrestricted autonomy. It is pure (no DB/IO/network)
// so the exact rules are unit-testable and can gate any caller.
//
// Nothing here executes work or sends anything. It only answers: is this item
// eligible for automatic selection, is this the right kind of question for the
// phase, is the attachment manifest safe, and are we making progress or looping?

// A work item may be auto-selected only when it carries every field needed to
// bound the work: a stable id, its state, the authorised scope, the evidence it
// requires, the expected output, and explicit stop conditions.
export const WORK_ITEM_REQUIRED_FIELDS = ['id', 'state', 'scope', 'requiredEvidence', 'expectedOutput', 'stopConditions'];

function isEmpty(value) {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

export function assessEligibility(item = {}) {
  const missing = WORK_ITEM_REQUIRED_FIELDS.filter((field) => isEmpty(item[field]));
  const reasons = [];
  if (missing.length) reasons.push(`not eligible — missing required field(s): ${missing.join(', ')}`);
  else reasons.push('eligible — all bounding fields (id, state, scope, evidence, output, stop conditions) are present');
  // A scope that authorises nothing can never be acted on safely.
  const scopeEmpty = !Array.isArray(item.scope) || item.scope.length === 0;
  if (!missing.includes('scope') && scopeEmpty) { missing.push('scope'); reasons.push('not eligible — authorised scope is empty'); }
  return { eligible: missing.length === 0, missing, reasons };
}

// Every outgoing question must be one of these deliberate kinds.
export const QUESTION_TYPES = ['clarification', 'evidence-request', 'approval-request', 'verification-request', 'blocker-report', 'completion-report'];

// Which question kinds make sense in each workflow phase. A completion report in
// the execution phase, or a verification request during intake, is a smell that
// the loop is off-track.
const PHASE_QUESTION_TYPES = {
  intake: ['clarification'],
  planning: ['clarification', 'approval-request'],
  execution: ['clarification', 'evidence-request', 'blocker-report'],
  verification: ['verification-request', 'evidence-request'],
  review: ['approval-request', 'completion-report'],
  done: ['completion-report']
};

export const WORKFLOW_PHASES = Object.keys(PHASE_QUESTION_TYPES);

export function validateQuestionForPhase(type, phase) {
  const questionType = String(type || '').toLowerCase().trim();
  const workflowPhase = String(phase || '').toLowerCase().trim();
  if (!QUESTION_TYPES.includes(questionType)) return { valid: false, reason: `unknown question type "${type}"` };
  const allowed = PHASE_QUESTION_TYPES[workflowPhase];
  if (!allowed) return { valid: false, reason: `unknown workflow phase "${phase}"` };
  const valid = allowed.includes(questionType);
  return { valid, reason: valid ? `${questionType} is appropriate in the ${workflowPhase} phase` : `${questionType} does not fit the ${workflowPhase} phase (expected one of: ${allowed.join(', ')})` };
}

function inScope(path, scope) {
  return scope.some((root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`));
}

// Validate an exact attachment manifest against what is actually available and
// the authorised scope. FAIL CLOSED: any missing, out-of-scope, stale, or
// changed file makes the whole manifest unsafe to send.
export function validateAttachmentManifest(manifest = [], available = [], { scope = [] } = {}) {
  const violations = [];
  const byPath = new Map((Array.isArray(available) ? available : []).map((file) => [file.path, file]));
  const scopeRoots = Array.isArray(scope) ? scope : [];
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    const found = byPath.get(entry.path);
    if (scopeRoots.length === 0 || !inScope(entry.path, scopeRoots)) violations.push({ path: entry.path, reason: 'outside authorised scope' });
    else if (!found) violations.push({ path: entry.path, reason: 'required file is missing' });
    else if (found.stale) violations.push({ path: entry.path, reason: 'file is marked stale' });
    else if (entry.hash && found.hash && entry.hash !== found.hash) violations.push({ path: entry.path, reason: 'file changed since the manifest was built (hash mismatch)' });
  }
  return { ok: violations.length === 0, violations };
}

export function questionSignature(attempt = {}) {
  if (typeof attempt._trustedSignature === 'string' && attempt._trustedSignature) return attempt._trustedSignature;
  const normalized = String(attempt.text || '').normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return `${String(attempt.type || '').toLowerCase()}::${normalized}`;
}

// Detect duplicate questions and no-progress loops. `attempts` is the ordered
// history (last entry is the current attempt); each carries its question type,
// text, and evidence/state fingerprints. A repeat with no new evidence, no state
// change, and no justified retry is a duplicate; N stagnant attempts stop the
// loop for human review.
export function detectNoProgress(attempts = [], { limit = 3 } = {}) {
  const history = Array.isArray(attempts) ? attempts : [];
  if (history.length === 0) return { blocked: false, reason: 'no attempts yet', stagnant: 0 };
  const current = history[history.length - 1];
  const signature = questionSignature(current);
  for (let i = 0; i < history.length - 1; i += 1) {
    const prior = history[i];
    if (questionSignature(prior) === signature && prior.evidenceHash === current.evidenceHash && prior.stateHash === current.stateHash && !current.justifiedRetry) {
      return { blocked: true, reason: 'duplicate question with no new evidence, no state change, and no justified retry', duplicateOf: i, stagnant: 0 };
    }
  }
  let stagnant = 1;
  for (let i = history.length - 2; i >= 0; i -= 1) {
    if (history[i].evidenceHash === current.evidenceHash && history[i].stateHash === current.stateHash) stagnant += 1;
    else break;
  }
  if (stagnant >= limit) return { blocked: true, reason: `no progress after ${stagnant} attempts — stopping for human review`, stagnant };
  return { blocked: false, reason: `attempt ${history.length} shows progress or is within the no-progress limit`, stagnant };
}

// One convenience gate that runs the full preparation contract for a proposed
// unattended send, returning a single allow/deny with the accumulated reasons.
// It only ever PROPOSES readiness; it never sends.
export function evaluateUnattendedSend({ item, phase, question, manifest = [], available = [], attempts = [], limit = 3 } = {}) {
  const reasons = [];
  const eligibility = assessEligibility(item || {});
  reasons.push(...eligibility.reasons);
  const scope = Array.isArray(item?.scope) ? item.scope : [];
  const questionCheck = validateQuestionForPhase(question?.type, phase);
  reasons.push(questionCheck.reason);
  const manifestCheck = validateAttachmentManifest(manifest, available, { scope });
  if (!manifestCheck.ok) reasons.push(`attachment manifest unsafe: ${manifestCheck.violations.map((v) => `${v.path} (${v.reason})`).join('; ')}`);
  else reasons.push('attachment manifest verified against scope and current files');
  const progress = detectNoProgress([...attempts, question].filter(Boolean), { limit });
  if (progress.blocked) reasons.push(progress.reason);
  const ready = eligibility.eligible && questionCheck.valid && manifestCheck.ok && !progress.blocked;
  return { ready, reasons, eligibility, questionCheck, manifestCheck, progress };
}
