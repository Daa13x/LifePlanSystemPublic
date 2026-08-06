// Human-authority / copilot boundary — a pure, deterministic contract for who
// decides and what counts as proof. The local model and coding agents are
// copilots, never the final authority. No DB/IO here so the boundary is
// unit-testable and can gate any caller. It complements (does not replace) the
// runtime confirmation machinery in confirmations.js and mutationGuard.js.
//
// Principles this encodes on purpose:
//   * The user (or an explicitly authorised reviewer) is the FINAL authority for
//     destructive, sensitive, financial, legal, medical, account, publication,
//     release, and source-of-truth actions.
//   * An action moves recommendation -> proposed -> approved -> executing ->
//     verified, in order. You cannot skip approval.
//   * Human approval is NOT proof of correctness, and model confidence or
//     repeated agreement is never proof. A verified result needs evidence, and
//     rollback/correction paths must remain.
//   * Automatic action is allowed only when low-risk AND bounded by explicit
//     permissions, budget, scope, and stop conditions.

export const ACTION_LIFECYCLE = ['recommendation', 'proposed', 'approved', 'executing', 'verified'];

export const HIGH_RISK_CLASSES = ['destructive', 'sensitive', 'financial', 'legal', 'medical', 'account', 'publication', 'release', 'source-of-truth'];

const RISK_PATTERNS = {
  destructive: /\b(delete|remove|wipe|destroy|overwrite|purge|drop\s+table|hard[- ]?reset|force[- ]?push)\b/,
  sensitive: /\b(password|passcode|secret|credential|api[ _-]?key|private key|token)\b/,
  financial: /\b(payment|invoice|billing|charge|purchase|buy|refund|bank|card|transfer|subscription)\b/,
  legal: /\b(legal|contract|lawsuit|litigation|appeal|court)\b/,
  medical: /\b(medical|diagnos|prescription|medication|treatment|clinical)\b/,
  account: /\b(account settings|change password|recovery contact|two[- ]?factor|2fa|oauth|grant access|revoke access)\b/,
  publication: /\b(publish|post publicly|share publicly|make public|tweet|announce)\b/,
  release: /\b(release|deploy|installer|ship|publish build|latest-main|rollout)\b/,
  'source-of-truth': /\b(source[- ]?of[- ]?truth|canonical|governance rule|permission rule|memory rule|system prompt)\b/
};

// Classify an action's risk from an explicit riskClasses list and/or keywords in
// its category/type/description. Over-matching toward high-risk is intentional.
export function classifyRisk(action = {}) {
  const detected = new Set(Array.isArray(action.riskClasses) ? action.riskClasses.filter((c) => HIGH_RISK_CLASSES.includes(c)) : []);
  const text = `${action.category || ''} ${action.type || ''} ${action.description || ''}`.toLowerCase();
  for (const [cls, pattern] of Object.entries(RISK_PATTERNS)) if (pattern.test(text)) detected.add(cls);
  const classes = HIGH_RISK_CLASSES.filter((c) => detected.has(c));
  return { highRisk: classes.length > 0, classes };
}

// Whether the user/authorised reviewer must approve before this action proceeds.
export function requiresHumanApproval(action = {}) {
  const { highRisk, classes } = classifyRisk(action);
  const irreversible = action.reversible === false || action.irreversible === true;
  const required = highRisk || irreversible;
  const reasons = [];
  if (highRisk) reasons.push(`high-risk (${classes.join(', ')}) — the user or an authorised reviewer is the final authority`);
  if (irreversible) reasons.push('irreversible — requires explicit approval and a preserved rollback path');
  if (!required) reasons.push('low-risk and reversible — may proceed within explicit bounds');
  return { required, highRisk, classes, irreversible, reasons };
}

// Enforce the ordered lifecycle. Approval requires an explicit human decision;
// a verified result requires evidence (not mere approval, confidence, or
// agreement).
export function advanceLifecycle(current, transition = {}) {
  const index = ACTION_LIFECYCLE.indexOf(current);
  if (index < 0) return { ok: false, reason: `unknown lifecycle state "${current}"` };
  const targetIndex = ACTION_LIFECYCLE.indexOf(transition.to);
  if (targetIndex < 0) return { ok: false, reason: `unknown target state "${transition.to}"` };
  if (targetIndex !== index + 1) return { ok: false, reason: `must move one step forward through ${ACTION_LIFECYCLE.join(' -> ')}` };
  if (transition.to === 'approved' && !transition.humanApproval) return { ok: false, reason: 'approval requires an explicit human decision — a model cannot self-approve' };
  if (transition.to === 'verified' && !transition.evidence) return { ok: false, reason: 'a verified result requires evidence — approval, confidence, or agreement is not proof' };
  return { ok: true, next: transition.to, reason: `advanced to ${transition.to}` };
}

// An action is proven correct only when it is in the verified state WITH evidence
// and its rollback path is intact — approval/execution alone is not proof.
export function isProvenCorrect(record = {}) {
  return record.state === 'verified' && Boolean(record.evidence) && record.rollbackAvailable !== false;
}

// Model confidence and repeated agreement are never sufficient proof on their own.
export function confidenceIsProof() {
  return { sufficient: false, reason: 'model confidence and repeated agreement are not proof — evidence and deterministic checks are still required' };
}

// Automatic (unattended) execution is allowed ONLY when the action is low-risk
// AND fully bounded by explicit permissions, budget, scope, and stop conditions.
export function canProceedAutomatically(action = {}, bounds = {}) {
  const { required, classes, irreversible } = requiresHumanApproval(action);
  const violations = [];
  if (required) violations.push(`requires human approval (${classes.join(', ') || (irreversible ? 'irreversible' : 'high-risk')})`);
  if (!Array.isArray(bounds.permissions) || bounds.permissions.length === 0) violations.push('no explicit permissions granted');
  if (bounds.budget === undefined || bounds.budget === null || Number(bounds.budget) <= 0) violations.push('no execution budget set');
  if (!Array.isArray(bounds.scope) || bounds.scope.length === 0) violations.push('no authorised scope');
  if (!Array.isArray(bounds.stopConditions) || bounds.stopConditions.length === 0) violations.push('no stop conditions');
  return { allowed: violations.length === 0, violations };
}

// Interactive controls that MUST remain available while a workflow is active, so
// the user can always pause, cancel, reject, edit, or redirect it.
export const ACTIVE_WORKFLOW_CONTROLS = ['pause', 'cancel', 'reject', 'edit', 'redirect'];
export function availableControls(state) {
  return ['proposed', 'approved', 'executing'].includes(state) ? [...ACTIVE_WORKFLOW_CONTROLS] : [];
}
