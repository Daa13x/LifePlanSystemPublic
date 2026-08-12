// Browser-consultation receipt (MA-Dev audit delta #1). Optional browser advice
// is untrusted context, never authority. When a provider answer is validated we
// persist a normalized receipt that records WHAT was consulted and WHICH sealed
// task + prepared evidence it was bound to, so the review UI can show provenance
// and — critically — so advice cannot survive a change to the task scope or the
// prepared evidence it was generated against. A receipt is provenance, not proof;
// it never widens scope, applies a patch, or stands in for validation.

// Build a normalized receipt from a validated (or otherwise terminal) advice
// record plus the sealed task hash and prepared-evidence hash it was bound to.
export function buildConsultationReceipt({ advice = {}, taskHash = '', evidenceHash = '' } = {}) {
  return {
    provider: String(advice.provider || '') || null,
    // The browser job identity is the best available conversation/turn handle.
    conversationId: advice.jobId === undefined || advice.jobId === null ? null : String(advice.jobId),
    promptHash: String(advice.promptHash || '') || null,
    answerHash: String(advice.answerHash || '') || null,
    taskHash: String(taskHash || '') || null,
    evidenceHash: String(evidenceHash || '') || null,
    capturedAt: advice.completedAt || advice.sentAt || null,
    terminalState: String(advice.status || 'unknown')
  };
}

// A receipt is fresh only if it is still bound to the CURRENT sealed task hash and
// the CURRENT prepared-evidence hash. Re-sealing the task or re-preparing evidence
// changes one of these, which makes prior advice stale and requires a fresh
// consultation before it can be bound to a run.
export function isConsultationReceiptFresh(receipt, { taskHash = '', evidenceHash = '' } = {}) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (!receipt.taskHash || !receipt.evidenceHash) return false;
  return receipt.taskHash === String(taskHash || '') && receipt.evidenceHash === String(evidenceHash || '');
}

// The advice hash a run confirmation may bind, or '' when none should apply.
// Returns the validated answer hash only when the advice is validated AND its
// receipt is still fresh against the task's current seal and prepared evidence.
// Advice validated before receipts existed keeps its prior behaviour (no receipt
// -> the stored answer hash), so this change is additive.
export function effectiveValidatedAdviceHash(task = {}) {
  const advice = task.browserAdvice;
  if (!advice || advice.status !== 'validated') return '';
  if (!advice.receipt) return String(advice.answerHash || '');
  const fresh = isConsultationReceiptFresh(advice.receipt, {
    taskHash: task.taskHash,
    evidenceHash: task.preparation?.evidenceHash || ''
  });
  return fresh ? String(advice.answerHash || '') : '';
}
