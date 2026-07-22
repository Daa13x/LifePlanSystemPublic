# Browser-Assisted Coding — Safeguards Work Log

Extends the existing owners (`server/nativeCodingWorker.js`, the `browserAgentJobs`
connector + heartbeat endpoints in `server/index.js`, the `verify:*` scripts) to
implement the browser-advice → NativeCodingWorker join specified in
`docs/BROWSER_ASSISTED_LOCAL_CODING.md`, hardened with six mandatory safeguards.

No second coding worker, browser queue, task-card format, workflow registry, or
approval mechanism is introduced. Browser output is contextual advice only; it
never edits, executes, expands scope, unlocks a protected path, disables a
checker, applies a patch, or approves completion. Only the deterministic
Checker may declare success; only the explicit review/apply boundary may write.

## Required flow (implemented in `server/browserAssistedBridge.js`)
task → solvability preflight → bounded workspace evidence → dispatch one browser
consultation → persist job identity → poll same job → validate structured advice
→ pass validated advice as untrusted context → NativeCodingWorker →
deterministic verification → explicit review/apply boundary.

## Modules (new; extend by injection, do not duplicate policy)
- `server/browserAssistedCoding.js` — term extraction, keyed file-index cache
  (Safeguard 6), filename-first anchor ranking, workspace evidence, solvability
  preflight (Safeguard 1), structured-advice validation + path normalisation
  (Structured Browser Advice). Reuses the worker's protected-path policy via an
  injected `forbiddenPath`.
- `server/browserConsultationState.js` — send-once/poll job identity persistence,
  one active consultation per task phase, restart recovery, timeout→fallback
  (Safeguard 2).
- `server/infraProbe.js` — bounded candidate probing with identity validation,
  per-probe timeout budgets, transport-vs-bad-answer outcome split (Safeguard 4).
- `server/completionHousekeeping.js` — durable outcome first, then guarded
  optional housekeeping that can never mutate a recorded terminal outcome
  (Safeguard 5).
- `server/browserAssistedBridge.js` — the orchestrating join over the existing
  owners; browser output stays untrusted context.
- `server/nativeCodingWorker.js` — additive: `run(id, { adviceContext })` folds
  pre-validated untrusted advice into the coder prompt. Absent advice the prompt
  is byte-for-byte unchanged; scope/checker/no-diff authority is untouched.

## Verifier
- `scripts/verify-browser-assisted-coding.mjs` — spec §9 acceptance + the six
  safeguard test matrices + integration (bridge) tests, in the existing
  `node scripts/verify-*.mjs` style. Wired into `package.json` as
  `verify:browser-assisted-coding` and appended to `verify:runtime-safety`.

## Safeguard 3 — verifier audit (result)
Audited the `verify:*` scripts for brittle implementation-text assertions.
Finding: the suite is already behavioural — assertions check exit codes,
structured JSON fields (`ok`, `setupGated`, `requiresHumanReview`,
`requiresSeparatePostRunApproval`), file/DB/worktree state, changed-file scope,
protected-path state, and negative cases via `assert.throws(.../error category/)`.
The illustrative brittle sentence ("Merging … without removing existing rows")
is not present. The only sentence-shaped `assert.match` is a filename artifact
reference in `verify-tray-launcher.mjs` (`Install Local Model Runtime.cmd`),
which is a genuine artifact contract, not brittle prose. No verifier was
rewritten: there was no brittle-wording assertion to repair, and rewriting the
filename reference would weaken a real check. New tests in
`verify-browser-assisted-coding.mjs` follow the semantic style (outcome states,
`ok` booleans, resulting file/worktree state, negative fixtures).

## Preserved load-bearing safety (unweakened)
repository containment, canonical path validation, manifest enforcement,
allowed-path enforcement, protected-path refusal, transport-vs-bad-advice split,
deterministic checker authority, no-diff failure detection, explicit patch
review/apply approval. `verify:native-coding-worker` still passes unchanged.

## Status
- [x] Verify public checkout + main + architecture; private repo preserved.
- [x] Read spec + `NativeCodingWorker` + connector wiring.
- [x] Safeguards 1, 2, 4, 5, 6 modules + advice validation.
- [x] Advice integrated into the worker run path (additive) + bridge orchestrator.
- [x] Safeguard 3 verifier audit (finding above; no weakening).
- [x] `verify:browser-assisted-coding` green (unit + integration); wired into suite.
- [x] Full `verify:runtime-safety` suite green together, run twice (no leakage).
- [x] `vite build` (npm run check) green.
- [x] Committed directly to public `main`.

## Known limitation
A full *live* end-to-end exercise (real signed-in browser + extension returning
advice → worker → applied patch) needs a connected browser/extension and a local
coding model — transport dependencies not available headlessly. The join logic
(evidence → preflight → advice validation → untrusted worker context → review) is
exercised end-to-end by the integration tests with fixtures, including proof that
rejected advice never reaches the worker and the live checkout is unchanged before
apply approval.

Tray-console diagnosis remains separately evidence-gated and does not block this
work; the tray ownership stash is preserved untouched.
