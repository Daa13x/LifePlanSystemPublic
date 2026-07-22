// The browser-advice -> NativeCodingWorker join (spec §1). This orchestrates the
// existing owners; it introduces no second worker, queue, task format, or
// approval path. Browser output is untrusted context only and can never edit,
// execute, expand scope, unlock a protected path, disable a checker, apply a
// patch, or approve completion — the worker's own guards remain the authority.
//
// Flow: solvability preflight -> workspace evidence -> ONE consultation ->
// poll the same job -> validate structured advice -> pass validated advice as
// untrusted context to worker.run -> deterministic verification + review/apply
// (owned entirely by NativeCodingWorker).

import { solvabilityPreflight, buildWorkspaceEvidence, validateAdvice, renderAdviceContext } from './browserAssistedCoding.js';
import { classifyFailure } from './infraProbe.js';

export async function runBrowserAssistedTask({
  worker, task, approval, root, worktree, forbiddenPath, cache,
  consultationStore, phase = 'advice', requestFingerprint,
  dispatchConsultation, pollConsultation, maxPolls = 30,
  connectorConnected = true
}) {
  // §6/§8: a missing connector is a transport failure ("incomplete; retry,
  // change nothing"), never a bad-answer that would quarantine the item.
  if (!connectorConnected) {
    return { outcome: 'incomplete', ...classifyFailure('connector-down'), reason: 'browser connector not connected; nothing was changed' };
  }

  // 1) Solvability preflight — stop BEFORE any dispatch if the target is outside
  //    the effective editable/searchable scope.
  const preflight = await solvabilityPreflight({
    root, worktree, allowedPaths: task.allowedPaths, forbiddenPath,
    title: task.title, objective: task.objective, namedTargets: task.namedTargets || [], cache
  });
  if (preflight.outcome !== 'ok') {
    return { outcome: 'needs_human', reason: preflight.reason, preflight };
  }

  // 2) Bounded workspace evidence (real paths + real excerpts).
  const evidence = await buildWorkspaceEvidence({
    root, worktree, allowedPaths: task.allowedPaths, forbiddenPath,
    title: task.title, objective: task.objective, cache
  });

  // 3) Dispatch exactly one consultation for this (task, phase).
  const fingerprint = requestFingerprint || `${task.id}:${phase}:${evidence.anchors.map((a) => a.path).join(',')}`;
  await consultationStore.dispatchOnce(task.id, phase, fingerprint, async () => dispatchConsultation({ evidence, task }));

  // 4) Poll the SAME recorded job to a single terminal result. No redispatch.
  let terminal = null;
  for (let i = 0; i < maxPolls; i += 1) {
    const res = await consultationStore.poll(task.id, phase, pollConsultation);
    if (res.rejected) {
      return { outcome: 'incomplete', ...classifyFailure('transport'), reason: `consultation reply rejected: ${res.rejected}` };
    }
    if (res.terminal) { terminal = res.record; break; }
  }
  if (!terminal) {
    consultationStore.markTimeout(task.id, phase);
    return { outcome: 'incomplete', ...classifyFailure('probe-timeout'), reason: 'no terminal browser reply within the poll budget; nothing was changed' };
  }
  if (['timeout', 'error', 'cancelled'].includes(terminal.state)) {
    return { outcome: 'incomplete', ...classifyFailure('transport'), reason: `consultation ${terminal.state}; nothing was changed` };
  }

  // 5) Validate the structured advice. Bad advice is a bad-answer (blocked),
  //    NOT a transport failure — the two must never be scored the same (§6).
  const validated = validateAdvice(terminal.result, {
    root, worktree, allowedPaths: task.allowedPaths, forbiddenPath, expectedTaskId: task.id
  });
  if (!validated.ok) {
    return { outcome: 'blocked', ...classifyFailure('unusable-answer'), reason: `advice rejected: ${validated.reason}`, findings: validated.findings };
  }

  // 6) Hand the validated advice to the worker as UNTRUSTED context. The worker
  //    owns scope enforcement, checker validation, no-diff detection, and the
  //    explicit review/apply boundary.
  const adviceContext = renderAdviceContext(validated.advice);
  const workerResult = await worker.run(task.id, { ...approval, adviceContext });
  return {
    outcome: 'ran',
    workerStatus: workerResult.status,
    advice: validated.advice,
    evidence: { anchors: evidence.anchors.map((a) => a.path), fileCount: evidence.fileCount }
  };
}
