# Local Coding Operational Loop

## Outcome

LifePlanSystem now connects its existing governed `NativeCodingWorker` to a usable local-first coding workflow. Workboard can seal and queue a narrow task. **System > Runs** is the operational review workspace. Source Control remains the only Git publication surface.

The worker may continue unattended inside one sealed detached worktree: it selects bounded read-only evidence tools, proposes a scoped edit, runs the independent validator, and—if that validator fails—receives the capped validator evidence for exactly one in-scope correction attempt. The final diff still requires a passing validator result and explicit human patch apply. This is bounded task completion, not unattended live-checkout mutation, Git activity, browser activity, or arbitrary command execution.

Before `needs-evidence` is recorded, the sealed worker now gets up to three self-directed evidence-recovery passes. A concrete gap is not an unattended-completion failure by itself: the worker must use the available bounded read-only tools when an approved source can answer it. It stops only after that bounded recovery is exhausted, the model says no permitted read can answer the fact, or the missing evidence is genuinely outside the sealed scope.

Recovery state is current-state only: when a later in-scope read resolves the gap and the task reaches review, the worker clears the current blocker and appends an `evidence_recovery_complete` audit event. The Runs UI therefore never presents a review-ready patch as still blocked; the prior gaps remain inspectable in the append-only audit.

Every independent checker result is persisted when it occurs, including a terminal failure after the one permitted repair attempt. The UI can therefore show the structured failed checks and capped checker output rather than reducing a failed run to an opaque error string.

The worker also owns a per-task exclusive execution lease under `.lps/native-code/leases`. It is acquired atomically before a detached worktree is created, carries a bounded expiry, blocks a second LPS process from running the same task, and is released during terminal cleanup or restart recovery. This closes cross-process duplicate execution without misrepresenting the JSON task store as transactional SQLite; a future SQLite/CAS migration remains a separate capability.

This implementation does not add another agent, command runner, browser controller, branch owner, or auto-apply path. The local model still returns bounded JSON file replacements. Browser consultation is optional untrusted advice and is never a coding fallback.

## User flow

1. In Workboard or System > Runs, enter a title, objective, allowed repository paths, maximum changed files, and a server-owned validation profile.
2. LPS pins the current 40-character base commit into the task seal. Absolute paths, traversal, protected paths, and unknown validation profiles are refused before model use.
3. **Prepare evidence** runs solvability preflight and bounded workspace indexing over approved paths. It stores ranked files, selection reasons, excerpts, omissions, redaction count, source hash, and an evidence hash. It makes no model or browser request.
4. If local evidence is sufficient, approve the local run directly. If one implementation fact is missing, preview one browser-advice prompt. The exact redacted prompt is bound to its provider and SHA-256 before one dispatch.
5. The native worker rechecks the clean `main` checkout and sealed base commit, creates a detached isolated worktree, reads approved context, invokes the verified loopback coding model, applies only bounded text replacements in isolation, and runs independent validation.
6. Run approval is bound to the task hash, prepared evidence hash, and validated advice answer hash (or an explicit empty advice hash). The final local proposal must declare `action: "propose_edits"`, a 0–1 confidence, and an evidence basis. Below 70% confidence, LPS gives the same sealed worker up to three self-directed evidence-recovery passes: it must use an approved read-only tool when that can answer a named gap. Only exhausted, non-actionable, or genuinely out-of-scope gaps stop in `needs-evidence`; no isolated or live edit is accepted there. System > Runs displays the evidence, recovery count, assessment, review patch, changed files, validator output/evidence hash, model route, task hash, patch hash, and chronological audit record. The live checkout remains unchanged.
7. **Apply reviewed patch** requires a separate explicit approval for the exact patch hash. It rechecks clean live `main` and the unchanged base commit, applies the patch unstaged, and performs no commit or push.
8. Source Control refreshes the resulting changed files. Commit and push remain separate user-controlled Git operations.

## Durable states

- `pending`: sealed and waiting for evidence preparation.
- `prepared`: scoped evidence is ready; local run or optional advisory preview is available.
- `needs-scope`: preflight found an unresolved or out-of-manifest implementation target.
- `needs-evidence`: bounded in-scope evidence recovery is exhausted or cannot answer the named fact, so no isolated or live edit was accepted. The task cannot blindly rerun on the identical sealed evidence; use one optional, reviewed browser advisory question for a named missing fact, or reject and create a better-scoped task.
- `awaiting-advice`: exactly one persisted browser job is being polled; polling never redispatches.
- `running`: isolated worktree/local inference/validation is active.
- `review`: independently validated patch is waiting for patch-hash approval.
- `applied`: reviewed patch was explicitly applied unstaged.
- `failed`, `cancelled`, `interrupted`: no patch was accepted into the live checkout; the user must rerun or reject.
- `apply-interrupted`: LPS stopped during live apply. This is deliberately ambiguous and is not casually dismissible; inspect Source Control before further action.

Startup continues to recover stale `running` and `applying` task records as `interrupted` and `apply-interrupted`. It never resumes or applies model output automatically. Orphan cleanup preserves any worktree still owned by an active/review task.

## Browser advice contract

The production routes use the existing `FileIndexCache`, `solvabilityPreflight`, `buildWorkspaceEvidence`, `BrowserConsultationStore`, `validateAdvice`, and `renderAdviceContext` contracts.

- Advice requires a concrete question and prepared safe excerpts.
- No safe excerpt means no browser request. LPS does not send an ungrounded question.
- Egress classification/redaction runs over the final assembled prompt.
- Confirmation is bound to provider plus prompt hash. ChatGPT also requires the user's Temporary Chat confirmation because LPS cannot verify that provider setting.
- The consultation store dispatches once and retains the browser job identity across polls. Missing connector/provider state leaves the task resumable and sends nothing.
- Provider, question, prompt, supplied files, answer, answer hash, validation result, and timestamps remain in the durable task record.
- Advice paths, schema, task identity, prompt-injection markers, unsafe commands, secret requests, and response size are validated before advice reaches the worker.
- Valid advice is rendered under the untrusted-advice banner. It cannot expand allowed paths, change validation, approve a run, edit a file, apply a patch, or operate Git.

## Product surfaces

### Workboard

The Local coding queue shows active durable statuses and provides a compact task form. Selecting a queued task opens System > Runs. It is development work, not a life goal or memory record.

### System > Runs

The selected-task workspace has:

- a left task rail with durable status;
- a central line-numbered, syntax-coloured evidence and patch viewer, including expandable controller-returned excerpts for each bounded tool result (not model paraphrases);
- a right inspection rail for scope, base commit, validation, browser state, hashes, and explicit controls;
- a bottom chronological run console with evidence hashes and expandable raw task state.

The layout is three columns on desktop, two columns at intermediate width, and one column at 360px. Source previews and patches are read-only. The surface is not an uncontrolled editor.

### System > Browser

Browser remains the connector/manual consultation surface. Coding advisory state is visible in the task, but browser output has no authority over code or completion.

### Source Control

Source Control owns status, diff, stage, commit, pull, push, branches, tags, and installer actions. The coding worker performs none of them.

## Production API

- `GET /api/source/coding/status`: durable tasks, validations, local model truth, active worker lock, browser/provider health, recovered worktrees.
- `POST /api/source/coding/tasks`: validates scope and seals the current base commit.
- `POST /api/source/coding/tasks/:id/prepare`: stores preflight and evidence without inference.
- `POST /api/source/coding/tasks/:id/advice/preview`: builds, classifies, redacts, hashes, and stores the exact provider prompt without sending.
- `POST /api/source/coding/tasks/:id/advice/send`: requires provider/hash/Temporary Chat confirmation and dispatches at most once.
- `POST /api/source/coding/tasks/:id/advice/poll`: polls the same job, validates terminal advice, and stores accepted untrusted context or an honest incomplete/rejected state.
- `POST /api/source/coding/tasks/:id/run`: requires task-hash approval, prepared evidence, clean live source, unchanged base commit, and verified local inference authority.
- `POST /api/source/coding/tasks/:id/apply`: requires patch-hash approval, clean live `main`, and unchanged base commit.
- `POST /api/source/coding/tasks/:id/reject` and `/cancel`: explicit cleanup/cancellation boundaries.

All mutations continue to require the runtime CSRF token.

## Acceptance defects found

The first real production preparation call exposed an existing `server/egressGuard.js` temporal-dead-zone bug: entropy scanning read its character-count map while initializing the same map. Scoped evidence crashed before a hash could be produced. The implementation now builds the frequency map incrementally, and `verify:egress-guard` includes a benign high-entropy string regression fixture.

The next production call exposed a state mismatch: the UI correctly offered Reject for a prepared task, but `NativeCodingWorker.reject` still recognized only the older pre-preparation states. Prepared, needs-scope, and awaiting-advice tasks are now explicitly rejectable and cleanable. `apply-interrupted` remains protected because the live checkout may have changed before the restart.

The first complete production run exposed an evidence-display mismatch for an exact one-file scope with no extracted search terms. The evidence packet had the approved file count/content hash and the worker received the file, but the UI had no ranked anchor or excerpt. `buildWorkspaceEvidence` now always promotes exact approved file paths into bounded visible evidence before adding ranked term matches. The browser-assisted verifier protects the no-search-term exact-file case.

## First real applied task

Task `code-20260802210519224-00794e`, **Prevent coding objective overflow**, was sealed at base commit `1cf1bfe8a8b08a61e3cce42f69dfb4e977a9ba79` with only `src/styles.css`, one changed file, and the frontend validation profile.

The installed checkout had no configured local coding model, so acceptance used a temporary deterministic OpenAI-compatible fixture bound only to `127.0.0.1:4319`; prior model settings were captured and restored in `finally`. This proves the real production controller/API/worktree/checker/apply wiring, not general model reasoning quality. Browser advice was skipped because repository evidence was sufficient.

- Task hash: `56f3ab8455130ad2181400ac23129a2ca9866ce4ef257fd0e866a5342100d2f4`.
- Prepared evidence hash: `173550cbfaba10c75a900c907979420977458754d5dc7d1bed972d1d5f39e914`.
- The first inference transport attempt failed safely because port 4190 is a standards-forbidden Fetch port. The durable task stayed `failed`, no live file changed, and explicit retry used the same scope/base/evidence on allowed loopback port 4319.
- Review changed only `src/styles.css` and independent frontend validation passed.
- Validation evidence hash: `b2fb790107ccc48bc86ad18b5222211d4a29821dccaa46dceb9ddd7100701b24`.
- Patch hash: `4cfadd97998388e8540b38b8507f9a5c40945adcf64e8f7c1cc06fc6fc3c7b85`.
- The live stylesheet hash was identical before and after the local run.
- Explicit patch-hash Apply changed the live stylesheet, unstaged, adding `overflow-wrap: anywhere` to the coding objective header.
- `GET /api/source/status` then reported `{ status: "M", path: "src/styles.css", staged: false, protected: false }`.

## Verification evidence

Observed before final commit:

- `node --check server/nativeCodingWorker.js`: passed.
- `node --check server/index.js`: passed.
- `git diff --check`: passed.
- `npm.cmd run verify:native-coding-worker`: passed after preserving durable validated advice in the bridge.
- `npm.cmd run verify:browser-assisted-coding`: passed, including send-once/poll-only advice and unchanged live checkout before apply.
- `npm.cmd run verify:egress-guard`: passed.
- `npm.cmd run build`: passed; Vite transformed 1,580 modules.
- Production API create/prepare returned a base commit, `prepared`, one ranked approved file, zero redactions, and a SHA-256 evidence hash; explicit reject then returned `rejected`.
- The first real applied task produced review/validation/patch evidence above, proved the live checkout unchanged before Apply, and appeared in Source Control only after Apply.
- Rendered `http://127.0.0.1:5173/#system/runs` was inspected at 1440x900 and 360x780. Desktop rendered 210px / flexible / 260px rails. Mobile rendered a single 321px column inside a 360px viewport with no horizontal body overflow.

Run the final required gates after any follow-up edit:

```powershell
npm.cmd run verify:native-coding-worker
npm.cmd run verify:browser-assisted-coding
npm.cmd run verify:runtime-safety
npm.cmd run build
```

## Remaining deliberate boundaries

- A useful local coding GGUF or another explicitly verified loopback OpenAI-compatible endpoint must be configured. The UI reports unavailable honestly and does not fall back to cloud, Ollama, or OpenHands.
- A browser connector/provider tab is optional. Local runs do not depend on it.
- The user must approve the sealed run and later approve the exact reviewed patch separately.
- Applied files remain unstaged. The user reviews Source Control and separately decides whether to stage, commit, and push.
- Hosted CI, installer, and release artifacts require their own connected evidence; local worker verification does not prove release publication.

## Follow-up: action confidence ledger

The durable task audit records every controller decision with its action name,
confidence, evidence basis, source references where applicable, timestamp, and
evidence hash. Host-enforced checks record full confidence only for the bounded
fact they proved; a model edit assessment must instead earn its value from the
supplied task context, sealed source, and controller tool results. This is a
small vertical slice: browser advice remains untrusted context and is not used
to inflate the model's score. The next bounded expansion is transactional
SQLite-backed task state, leases, and approval nonces from the roadmap item;
do not weaken the model, path, validation, or separate-approval boundaries to
make that migration easier.

## Follow-up: branchless tools

On 2026-08-02 all model branch authority was removed. Both native and legacy
executor paths now use detached worktrees from the pinned `main` commit; policy
tests deny model branch creation/switch/delegation and inspect production source
to reject `git worktree add -b`.

The native worker now supports a bounded iterative evidence loop: `list_files`,
literal `search`, and ranged `read_file`. The controller executes these read-only
operations inside approved paths, records result hashes/sizes, and displays the
trace in System > Runs. Acceptance proves all three calls, final patch review,
unchanged live checkout before Apply, and refusal of an out-of-scope tool read.

GIT AUTHORITY POLICY ACTIVE - all model automation is branchless; cloud models work only on main, and approved local models use detached worktrees with reviewed apply directly to main.
