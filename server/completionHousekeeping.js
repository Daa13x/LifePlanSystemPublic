// Safeguard 5 — guard post-run housekeeping.
//
// Separate: core execution -> deterministic verification -> terminal outcome
// decision -> durable outcome write -> optional housekeeping. Once a valid
// terminal outcome is durably recorded, optional cleanup (archive, workspace
// cleanup, cache pruning, report copying, log rotation, notification) must never
// rewrite it. Only an artifact explicitly declared part of the completion
// contract may block completion — and that decision happens BEFORE the durable
// write, not in housekeeping.

// Run the required completion-contract artifacts. A failure here means the task
// is not complete, so this must run as part of deciding the outcome.
export async function runRequiredArtifacts(artifacts = []) {
  const results = {};
  let ok = true;
  for (const artifact of artifacts) {
    try {
      await artifact.run();
      results[artifact.name] = 'ok';
    } catch (error) {
      results[artifact.name] = 'failed';
      ok = false;
    }
  }
  return { ok, results };
}

// Persist the decided terminal outcome first, then run optional housekeeping
// under individual guards. Housekeeping failures are recorded but never mutate
// task_outcome. Returns the durable outcome augmented with a housekeeping map.
export async function finalize({ outcome, persistOutcome, housekeeping = [] }) {
  if (!outcome || typeof outcome.task_outcome !== 'string') {
    throw new Error('finalize requires an outcome object with a task_outcome string.');
  }
  // 1) Durable write of the terminal outcome — the source of truth from here on.
  await persistOutcome(outcome);
  const recorded = JSON.parse(JSON.stringify(outcome));

  // 2) Optional housekeeping, each individually guarded.
  const housekeepingResult = {};
  for (const op of housekeeping) {
    try {
      const value = await op.run();
      housekeepingResult[op.name] = value === 'skipped' ? 'skipped' : 'ok';
    } catch (error) {
      housekeepingResult[op.name] = 'failed';
      if (op.recovery && typeof op.recovery === 'object') {
        housekeepingResult[`${op.name}__recovery`] = String(op.recovery.detail || 'recovery details retained');
      }
    }
  }

  // task_outcome is exactly what was durably recorded; housekeeping cannot change it.
  return { ...recorded, task_outcome: recorded.task_outcome, housekeeping: housekeepingResult };
}
