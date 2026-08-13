# Local Coding Harness Audit — MA-Dev and Serenity

**Date:** 2026-08-12  
**Purpose:** assess the browser-assisted local-coding implementation that now
exists in `D:\_Code_\MA-Dev`, trace it to its Serenity origin, and identify
practices LPS can adopt without weakening LPS's local-model, human-apply, and
Git-authority boundaries. This is an audit and transfer decision record, not an
authorization to copy either implementation.

## Scope and evidence

| Repository | Revision inspected | Relationship | Evidence collected |
| --- | --- | --- | --- |
| `D:\_Code_\MA-Dev` | `6466390fc4ded504f312fdfb0e8cb35727fcbeee` | Later continuation | Source inspection plus 69 focused harness tests passed. |
| `D:\_Code_\Serenity` | `4c56de8d398dd46e88896e5a0967a36fa19f35b1` | Shared/original baseline | Source inspection plus 64 focused harness tests passed. |
| LPS | `eb08fe426d0bb73ca6e08976ab5617272c33b440` | Transfer target | `nativeCodingWorker.js`, browser-assistance modules, HTTP routes, UI, and their verification scripts inspected. |

Focused suites executed in each MA repository:

```text
dotnet test [external-project test suite] --no-restore \
  --filter "[focused browser/local-coding, verification, and source-packet contracts]"
```

The MA-Dev result was **69 passed, 0 failed**; Serenity's result was **64
passed, 0 failed**. These are contract tests, not live browser or installed-app
acceptance. No provider account, browser tab, external assistant, source
mutation, commit, or deployment was exercised by this audit.

`MA-Dev` is not an independent alternate design. Its history continues from
Serenity commit `4c56de8d3`; subsequent harness-focused commits include
`ac49740b1` (independent modules), `12c7d02d8` (standalone web projects),
`614957afa` (bounded browser evidence), `79e0d4ffe` / `754227d3c`
(workspace/project routing), and `274f79cea` / `01fccbdb6` (authorized new
files and desktop hosts). The later implementation adds roughly 708 lines and
removes 55 across the audited automation, execution, and contract-test areas.

## What MA-Dev/Serenity actually implement

The central external implementation is intentionally unnamed. A cited Project
item can move through local-first investigation, optional Captain-owned
browser consultation, local coding, local verification, and an optional browser
follow-up. It uses one process-local `SemaphoreSlim`, a cancellable background
owner, typed browser outcomes (`Completed`, `Deferred`, `Unavailable`, and
`Failed`), a durable Project/Galley journal, and a `FILE` / `CHANGE` / `VERIFY`
/ `RISK` reply convention.

The browser bridge accepts only registered, prompt-capable provider tabs. It
can send bounded source attachments, keep a new work item's conversation fresh,
retain the provider identity, distinguish an already-active browser turn from a
provider failure, wait briefly to recapture an incomplete terminal reply in the
same conversation, and retain a failed browser-turn record.

The local executor resolves the cited workspace rather than the installed app,
checks that a source tree exists, derives a focused test/build command, and
records verification evidence. Its related tests cover task-anchor selection,
requested-source packets, unsafe/ambiguous verification commands, independent
web-root verification, no-change evidence, browser deferral, cancellation, and
single-flight ownership.

This is useful experience, but it is **not LPS's security architecture**. In
particular, MA's `PlanExecutionService` opens work-scoped `FileWrite` and `Exec`
approval and ultimately permits a local executor to write into the selected
workspace and execute commands. It has no LPS-style sealed task hash, pinned
base-commit patch review, detached proposal worktree, durable cross-process
lease, one-time run/apply confirmations, or direct-main stale-patch apply gate.
It must therefore be treated as a source of practices, never as an execution
engine to transplant.

## Transfer matrix

| Finding | Evidence in MA-Dev/Serenity | LPS status | Transfer decision |
| --- | --- | --- | --- |
| Structured browser states distinguish temporary deferral from failure. | `ProjectBrowserTurnStatus`; deferred-turn test returns task to pending. | LPS's bridge has preparation/advice outcomes, but its audit vocabulary can be more explicit. | **Adopt conceptually.** Preserve explicit states in task receipts and UI; never convert `Deferred` into a blind re-run. |
| Browser advice needs provider/conversation provenance. | Browser result carries `Site`; first turns use `freshChat`; incomplete replies are recaptured from the same prompt. | LPS stores validated advice and an advice hash, but not a normalized provider/conversation receipt. | **High-value candidate.** Add optional advice provenance (`provider`, browser turn/receipt ID, capture time, answer hash) to the sealed task record and review UI. Do not trust it as authority. |
| Source handoff must be narrow, ranked, and on-demand. | Initial packet limits source neighbours; requested packet parsing prioritizes exactly named files; attachment tests cover grounding and duplicate requests. | LPS has allowed-path evidence, ranking, excerpts, egress guarding, and scoped read tools. | **Already largely adopted.** Keep LPS's stronger egress/redaction guards. Consider an explicit on-demand browser-source request protocol only if it can remain within the preapproved evidence manifest. |
| Cloud/browser output must have a constrained schema. | `FILE`/`CHANGE`/`VERIFY`/`RISK` convention; no-change is separately detected. | LPS validates structured JSON advice (`summary`, files, guidance, risks, checks, confidence), path scope, injection markers, and task identity. | **Already stronger in LPS.** Do not replace JSON validation with a prose convention. Add a distinct `no_change_evidence` advice disposition if it improves review clarity. |
| “No code change” is a real outcome, not success by implication. | Tests prove structured and flattened no-change contracts remain evidence-only and bypass mutation. | LPS can produce a reviewable patch or a low-confidence/evidence-needed state, but audit output should explicitly distinguish verified no-change evidence from an empty failed proposal. | **Adopt.** Introduce only with observed source evidence and a check result; it must never mark a coding task completed solely on browser advice. |
| Local-first investigation should exhaust bounded local evidence before browser escalation. | Local-only pass test never invokes browser; incomplete local attempt is deliberately released for browser handoff. | LPS coder has bounded controller read tools and three evidence-recovery passes; browser preparation is optional. | **Already adopted, with safer semantics.** Maintain the LPS order: local evidence → optional untrusted browser advice → separately confirmed local isolated run. |
| A stale/hung run needs visible ownership, cancellation, and recovery. | Process-local single flight, owner timestamp/progress, cancellation, concurrent-run rejection tests. | LPS has in-process reservation, task lifecycle recovery, and filesystem run leases across restarts/processes. | **Partly adopted, LPS is stronger cross-process.** Improve only observability: expose lease owner, expiry/heartbeat, active phase, and last durable progress receipt in the existing review UI. |
| Browser turn telemetry should be durable and operator-readable. | Persistent Project automation journal records stage, provider, source evidence, and terminal errors. | LPS persists task audit records, tool excerpts, browser advice, validation output, and confirmation receipts. | **Already adopted.** Make any new provenance fields appear alongside existing evidence, not in a second journal. |
| Workspace identity needs explicit binding. | MA repairs install-vs-source path confusion and carries project/application/workspace identity. | LPS pins base commit, allowed paths, prepared evidence hash, and worktree. | **Already stronger.** If multi-project use expands, add an immutable repository identity snapshot rather than MA's flexible workspace fallback. |
| Verification command selection must be constrained by the task. | Tests reject unsafe/missing/ambiguous test project and require frontend checks for UI work. | LPS task cards already hold a validation command; worker independently executes it in isolation. | **High-value candidate.** Add a preflight that classifies changed file types and rejects a task whose declared validation cannot cover them. Keep an explicit human-selected command; never let browser advice choose it. |
| Browser verification after local validation can be informative. | MA performs a second browser turn after local verification. | LPS independent checker is authoritative; browser advice is intentionally untrusted context. | **Reject as a completion gate.** An optional post-review explanation may be useful later, but it cannot determine task success, patch approval, apply, or Git action. |
| Continuous “until completion” queue draining. | MA uses a one-item-at-a-time continuous item limit under a live background owner. | LPS intentionally requires a distinct sealed task and explicit confirmation per run. | **Reject.** It conflicts with the LPS human apply/run authority boundary and turns task discovery into unattended mutation. |
| Work-scoped direct file/command approval. | MA `PlanExecutionService` grants `FileWrite` and `Exec` while a mission runs. | LPS worker has no model shell, Git, browser, network, installer, or deployment tools. | **Reject.** This is the most important non-transfer: it would defeat LPS's bounded-patch and human-apply model. |
| Browser provider rotation after an error or cooldown. | MA derives dispatch order across available registered assistants. | LPS's bridge is browser-assisted context, not a provider authority. | **Do not transfer automatic rotation.** It risks provider/context drift. A user-selected provider with provenance is safer; a failure should return an evidence-needed/deferred result. |

## LPS deltas that are worth implementing next

These are deliberately scoped improvements; none grants the browser, a cloud
model, or the local coding model new mutation or Git authority.

1. **Browser-consultation receipt.** When valid browser advice is attached,
   persist a normalized receipt: provider label, browser conversation/turn ID
   when available, capture timestamp, advice hash, task/evidence hash it was
   bound to, and terminal state. Show it in the existing task audit panel.
   Test that a stale receipt or changed prepared evidence invalidates the advice
   snapshot and requires fresh confirmation.

2. **Explicit no-change disposition.** Permit a browser-advice or local-coder
   response to say “no source mutation recommended” only when it references
   sealed prepared evidence. Keep the task in review as `evidence_only`; require
   an operator to close it, and never create/apply a patch or treat a browser
   assertion as verification.

3. **Validation-scope preflight.** Before a run approval is offered, compare
   the task's allowed paths and declared validation to a small deterministic
   coverage policy (for example, UI paths require a production build; server
   paths require the relevant runtime/API check). If coverage is ambiguous,
   block with a concrete reason and require the operator to amend the task.
   The worker must still run the selected command independently in the detached
   worktree.

4. **Lease-progress observability.** Do not add MA's process-local scheduler.
   Instead expose the stronger LPS lease's state: owner task, expiry/heartbeat,
   active phase, and latest audit event. Add tests for stale versus refreshed
   lease visibility and never reveal the raw lease token.

5. **Deferred browser status, not retry theater.** Normalize unavailable,
   awaiting-active-turn, capture-incomplete, and rejected-advice outcomes into
   clear review states. Each must identify what evidence is missing and the next
   allowed human action; none may automatically relaunch the local coding run.

## Things specifically not to copy

- MA/Serenity's generic planning executor, model-driven file writes, command
  execution, and work-scoped approval switches.
- Its process-local background queue as the durable source of task ownership.
- Automatic browser-provider rotation or an implicit fallback to another
  conversation/provider.
- Browser “verification” as a substitute for the isolated checker, a reviewable
  diff, or explicit apply confirmation.
- Workspace fallback logic that guesses an install directory or any writable
  folder when the cited repository path is absent.
- Prompt-only guarantees. LPS should retain controller-enforced paths, egress
  guarding, patch/diff seals, validation execution, and confirmation receipts.

## Completion standard for follow-on work

No follow-on item is complete merely because a browser gives plausible advice.
For every transferred behavior, add focused tests to the worker/bridge/API/UI
layers that prove the following chain:

```text
sealed task + pinned base commit + scoped evidence
  -> optional browser receipt (untrusted, hash-bound, provenance visible)
  -> fresh one-time human run confirmation
  -> local-only isolated proposal and independent validation
  -> reviewable sealed diff
  -> fresh one-time human apply confirmation against unchanged main
  -> ordinary human-controlled Source/Git flow
```

The worker must reject stale task, evidence, advice, patch, model-identity, and
confirmation bindings. A browser outage, a partial capture, unsupported source
request, missing validation coverage, or unresolved evidence gap must produce a
truthful deferred/review state rather than unbounded retries or silent task
completion.

## Audit conclusion

MA-Dev demonstrates practical improvements in browser conversation handling,
bounded source packets, typed deferrals, visible progress, and test coverage.
LPS already has the better authority model for local coding: explicit scope,
sealed evidence, detached isolation, independent validation, durable
confirmations, stale-patch rejection, and branchless human Git control. The
appropriate path is therefore to enrich LPS's evidence and operator visibility,
not to import MA's autonomous workspace-writing loop.

GIT AUTHORITY POLICY ACTIVE - all model automation is branchless; cloud models work only on main, and approved local models use detached worktrees with reviewed apply directly to main.
