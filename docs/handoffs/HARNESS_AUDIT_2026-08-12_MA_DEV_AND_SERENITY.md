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

## 2026-08-14 continuity-note review

The maintainer later supplied `serenity-chat-2026-08-14.pdf` for an LPS-native
integration review. The six-page external reference was inspected visually and
text-extracted; its SHA-256 is
`FD364D687651FBC4B69B11FF7D5053D95ED3DC2B6EB9C8C03D7F27110DD2F88F`.
The PDF is not checked into this repository, is not a source of runtime
authority, and did not authorize importing external personas, Bibles, prompts,
source code, schemas, or browser/model assumptions.

The review produced these LPS-owned decisions:

| Reference theme | LPS decision and evidence |
| --- | --- |
| Browser-assisted coding consultation needs typed outcomes, provenance, and a visible next step. | **Already implemented for that bounded lane.** `consultationReceipt.js`, `browserAdviceDisposition.js`, and their focused verifiers persist provider-bound evidence and truthful deferred/unavailable/review states. Browser output remains advisory. General research and source-acquisition provenance remain deferred below. |
| Conversation, captured evidence, and an authorised mutation must remain separate records. | **Already implemented.** Chat context, consultation receipts, sealed coding tasks, durable confirmations, and apply receipts remain distinct stores and transitions. No external reply promotes itself to memory, source truth, or a write. |
| Work must be resumable from explicit durable state rather than hidden conversational state. | **Already implemented for the bounded coding lane.** Task recovery, run leases, evidence hashes, consultation receipts, and confirmation bindings supply the resumable state. Broader planner-wide resumption remains future work and must not be simulated with prompts. |
| Action selection should be data-driven, permission checked, and observable. | **Accepted in the 2026-08-14 action-registry slice.** `server/actionRegistry.js` defines typed action contracts and closed outcomes; the existing Chat capability handlers use that registry; the neutral gateway assigns trusted caller scopes; the visible Context Picker declares stable action IDs; correlation IDs link invocation results to concise audit receipts. `verify:action-registry` proves duplicate rejection, malformed/unknown denial, availability, caller isolation, result validation, confirmation states, UI/gateway handler equivalence, CSRF, and database migration. |
| Direct captured evidence should not be delayed behind a second model or presentation pass. | **Accepted as a design constraint, not a new subsystem.** Current LPS receipts retain the captured result first; later summaries cannot replace the underlying evidence. Any future source-intake record must preserve this ordering. |
| External-evidence operations should have a richer common taxonomy. | **Deferred.** Consultation, search, page extraction, and user-supplied intake currently have separate LPS routes. Consolidation belongs with the answerability/research workstream and requires an LPS-owned schema plus runtime tests; this audit does not pre-empt that lane. |
| Hooks or provider text can direct hidden execution. | **Rejected.** Hooks remain bounded checks/receipts, provider text remains untrusted input, and neither can grant action scopes, mutation authority, memory promotion, or Git authority. |

The PDF also cited [Rob Pike's *Notes on Programming in C*](https://zoo.cs.yale.edu/classes/cs223/doc-f2016/Pike.pdf).
The referenced Rule 5 statement was checked against that Yale-hosted primary source. LPS uses
it only as a non-normative design review heuristic: when control flow becomes
complicated, first inspect whether the typed state/authority/evidence contract
is ambiguous. The action registry applies that heuristic by making action
metadata and outcomes explicit; the citation does not become runtime policy.

No personal-memory or source-of-truth record was created from the continuity
chat. Any remaining idea is either already covered by LPS code/tests, explicitly
deferred with a missing dependency, or rejected by the reference-material and
human-authority boundaries.

## 2026-08-14 expanded continuity-blueprint review

The maintainer then supplied `serenity-chat-2026-08-14 (1).pdf`. The expanded
18-page external reference was inspected visually and text-extracted; its
SHA-256 is
`620527B712C0820AED608D63ADB4390C13BF24D8A4A328A65C24CD0312D4254B`.
Its first six pages materially repeat the earlier continuity note. Pages 7–18
add source-contained housekeeping instructions, a false auto-task receipt, and
a broad research, ingestion, task-state, and orchestration blueprint. The file
remains external audit provenance only: it is not copied into the repository,
ingested as personal memory, or treated as runtime authority.

The delta produced three bounded LPS-owned decisions:

| Expanded-reference theme | LPS decision and evidence |
| --- | --- |
| Canonical tool/action payloads, closed truthful outcomes, immutable confirmation state, and evidence-backed receipts. | **Accepted only where an existing LPS lane owns the behavior.** The action registry rejects ambiguous fields and invalid results. The Chat Workboard-create slice now persists validated action arguments in the existing durable confirmation store, binds them to the real chat/action/correlation, accepts only the one-time identifier and token at apply, commits the same-database item mutation and final receipt atomically, and rejects substitution, expiry, tampering, replay, and concurrent duplicate application. The model and browser never receive direct SQLite authority. |
| Imported instructions must remain source data. | **Already enforced as a boundary and retained here.** The housekeeping command and the reply claiming that an auto-task was queued are evidence about the external transcript, not LPS commands or proof of execution. They create no task, hook, file, memory, or authority in LPS. |
| A planner-wide durable task envelope; Candidate → Captured → Accepted → Synthesized → Promoted research states; requested-count, source-diversity, topicality, and per-source-completeness gates; unified URL/document/paste ingestion; and multi-dimensional confidence. | **Deferred to the answerability/research lane.** LPS has useful lane-specific pieces, but it does not implement this blueprint end to end. This action-registry work neither claims nor simulates those missing systems. |
| External personas, prompt text, exact schemas/phases/test matrices, C# housekeeping instructions, Bibles/doctrine, or automatic task/memory/source promotion. | **Rejected.** None is imported, and reference text cannot grant action scopes, mutation authority, source-of-truth status, or Git authority. |

This review preserves the reference lock: transferable engineering ideas become
LPS policy only through an LPS-owned implementation and focused tests. Fluent
external prose, embedded commands, and claimed activity remain untrusted until
the local system records matching direct evidence.

## 2026-08-14 typed Workboard-read checkpoint

The next action-registry slice resolves the prior ambiguous Workboard identity
contract before exposing record reads. `workboard.list` now returns an explicit
`{ type, id }` identity for the repository's real project, item, roadmap,
approval, and candidate entities. `workboard.read` requires that exact pair,
rejects missing, unsupported, cross-type, deleted, or malformed identities, and
never falls back to a global search. Project reads reuse the same layered-card
assembler as the Workboard UI rather than duplicating its business logic.

Workboard detail is classified as sensitive read data. The generic local-agent
scope cannot invoke it, and both the neutral and compatibility HTTP paths
require a real active Chat session before lookup. Results use fixed string,
relationship, child-count, and total-shape bounds; approval payloads are not
returned. The Context Picker preserves the typed identity, offers a separate
plain-text Preview control, and attaches only through the pre-existing explicit
context-record write. Focused unit/HTTP/UI checks cover identity collisions,
oversized nested data, unavailable targets, session bypass attempts, concise
audits, and equivalence with the canonical layered Workboard projection. A
disposable real-browser journey confirmed that Preview left attached context at
zero, the explicit Attach control changed it to one, and the console remained
clean.

## 2026-08-14 durable typed Workboard-update checkpoint

`workboard.propose_update` is now part of the bounded neutral catalog for typed
`item` identities only. The capability normalizes an allowlist of status,
title, detail, next-action, confidence, and real calendar-date changes; rejects
identity/ownership mutation, malformed values, empty requests, and no-ops; and
performs only the authoritative item read needed to produce a bounded exact
diff. It emits a SHA-256 fingerprint of the complete canonical item state and
does not mutate the Workboard while previewing.

The HTTP gateway re-reads and fingerprints the target before persisting a
durable confirmation. The stored record contains the complete canonical
before-state and only the exact validated changes, bound to the real chat,
typed target, action, correlation ID, expiry, and one-time token. Confirmation
accepts only the identifier/token envelope. It revalidates before claiming and
again inside the same SQLite transaction that applies the item update, writes
any content revision, settles the confirmation, and records the idempotency
receipt. Stale, deleted, substituted, tampered, expired, cross-session,
replayed, concurrent, storage-failure, and receipt-failure paths fail closed.

Focused registry, UI, HTTP, and durable-confirmation suites cover the complete
contract, including process-restart persistence and privacy-safe correlated
audits. A disposable real-browser journey showed the exact before/after diff,
proved no mutation before confirmation, applied one update under a rapid double
submission, persisted it across reload, kept context attachments and an
unrelated sentinel unchanged, and visibly rejected a later stale proposal after
another legitimate item mutation.

## 2026-08-14 bounded system-observability checkpoint

The next low-risk slice exposes `system.status`, `system.models`, and
`system.runs` through the neutral action gateway. Each action reuses the
existing authoritative runtime/model/request owner. Returned objects are
projected into strict fixed shapes with per-string, array-count, and complete
receipt bounds; raw runtime output, arbitrary model fields, request payloads,
paths beyond the already-safe basename, and undeclared nested data are omitted.

Chat now offers explicit Check status, Check models, and Recent runs controls.
They invoke the registered handlers, render bounded plain text, create only
concise correlation-linked audit receipts, and leave Workboard records,
confirmations, attachments, and the existing full System view unchanged.
Focused unit/UI/HTTP checks include adversarial 250K-character source fields,
strict-shape assertions, authorization metadata, no-write checks, and audit
privacy. A disposable browser journey exercised all three controls twice,
rendered truthful empty model/run states and live runtime/repository/connector
state, preserved zero attachments and five fixture items, and still navigated
to the full System status page.

## 2026-08-14 bounded conversation-search checkpoint

`conversation.search`, the last pre-existing registered capability that was
outside the neutral catalog, is now exposed as an explicit human-UI sensitive
read. Both the neutral and compatibility paths require a real active Chat
session. Generic local/cloud callers do not receive the history-read scope.
Search uses literal wildcard escaping, excludes deleted chats, and returns only
strictly bounded session titles, roles, snippets, timestamps, and result counts.

The Chat sidebar uses the same registered handler, invalidates late responses
when a different search or session wins, and opens the exact matched session.
Search never attaches context, promotes memory, stages confirmation, or mutates
Workboard data. Unit, UI, and disposable HTTP checks cover oversized stored
fields, malformed dependency identities, blank input, deleted chats, wildcard
queries, phantom-session bypass attempts, caller-scope denial, mutation
isolation, and correlation-linked audits containing neither query nor message
content. The neutral catalog now exposes all ten capabilities that existed when
this continuation began; future actions remain separate safety slices.

## 2026-08-14 bounded Daily Planner checkpoint

`planner.today` extends the neutral catalog without creating another planner.
Its dependency calls the same `plannerDayData()` owner as `/api/planner/day`, so
the capacity mode, ordering, easier-step selection, blockers, pins, deferral,
and transparent reasons remain canonical. The action is classified as sensitive
local data, requires a real active Chat session on both HTTP paths, and is not
granted to generic local/cloud callers.

The result uses strict task identities and fixed limits: at most seven visible
and five deferred tasks, five bounded reasons per task, bounded title/step/date
fields, and a fixed top-level shape. Chat's explicit Check today control uses
the same registered handler and renders plain text. Focused unit/UI/HTTP checks
cover adversarial oversized fields, malformed task identities, caller denial,
phantom sessions, result bounds, canonical-owner reuse, and mutation isolation.
A disposable real-browser check rendered the same normal/empty day as the
canonical endpoint, created one concise successful audit, and left attachments
and confirmations at zero.

At this historical checkpoint, navigation was inspected but not registered:
routing was renderer-local (`pushState` plus React state), while the native
WebView message channel accepted only renderer-to-host provider-window requests.
The required authenticated server-to-specific-renderer command stream and
correlation-bound acknowledgement were completed in the later checkpoint below.

## 2026-08-15 bounded System-navigation checkpoint

The renderer bridge prerequisite is now implemented and independently verified.
`navigation.system` is the second fixed semantic destination exposed through it,
after `navigation.workboard`. The action accepts no route arguments, carries the
requesting window's server-issued renderer binding as trusted request context,
resolves `system` through the canonical router, and reports success only after
that exact renderer acknowledges the single-use correlated command. It cannot
carry a URL, path, script, opener, or arbitrary route, and it changes no stored
application data.

Chat's existing **Open full System** control now invokes the registered action
instead of calling renderer-local navigation directly. Focused registry, bridge,
HTTP, UI-mapping, accessibility, and build checks cover the added destination,
including missing/forged renderer bindings, acknowledgement replay, timeout, and
multi-window isolation. A disposable real-browser journey moved the actual app
from `#chat` to the canonical `#system` view, rendered the System page, displayed
the truthful applied notice, and produced no console warnings or errors.

## 2026-08-15 bounded Settings-navigation checkpoint

`navigation.settings` reuses the same fixed-destination bridge and migrates
Chat's existing **Assign / change** control away from a direct renderer callback.
Like the other navigation actions, it accepts no route input, requires the
requesting window's authenticated renderer binding, and reports applied only
after the renderer acknowledges the canonical `#settings` route.

The first immediate-load browser attempt exposed a real readiness race: a user
could click before the renderer command stream finished registering and receive
a truthful `REJECTED` result. The shared navigation client now establishes a
missing binding on demand and awaits the authenticated stream's `ready` event
before invoking any `navigation.*` action. Focused registry, renderer-bridge,
HTTP, UI, accessibility, and build checks pass. A second immediate-load browser
journey reached `#settings`, rendered the real Settings page, displayed **Opened
Settings**, and produced no console warnings or errors.

GIT AUTHORITY POLICY ACTIVE - all model automation is branchless; cloud models work only on main, and approved local models use detached worktrees with reviewed apply directly to main.
