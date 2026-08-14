# Active Todo

This public todo file tracks system/UI work only.

## Current goal

Continue the public LifePlanSystem action registry through small, verified
slices so Chat can use existing LPS capabilities without bypassing typed
identity, privacy, confirmation, recovery, or user authority.

## Current checkpoint — 2026-08-14

- The neutral action catalog has bounded Knowledge search/read, typed Workboard
  list/read, and durable Workboard create/update proposal/confirmation.
- Workboard identity is explicit across project, item, roadmap, approval, and
  candidate records. Numeric IDs are never guessed across entity classes.
- Workboard detail is a session-bound sensitive read. Project previews reuse
  the canonical layered-card projection; every returned string, child list, and
  complete response is bounded.
- The real Chat Context Picker previews Workboard records without attaching
  them. Item previews can stage exact typed updates; Attach remains a separate
  explicit context write.
- Workboard updates persist the complete canonical before-state and only the
  validated changed fields. Confirmation is bound to the real chat, typed item,
  correlation ID, expiry, and one-time token. A full-state stale check runs
  before claim and again inside the atomic update/settlement transaction.
- Chat can now request bounded authoritative system status, local-model
  summaries, and recent-run summaries through the same neutral registry used by
  other actions. These checks are read-only, emit concise correlated audits,
  render as plain text, and preserve the full System page as a separate view.
- All eleven currently registered capabilities are now exposed through the neutral
  action catalog. `conversation.search` is a real-session-bound, explicit human
  UI search: generic local/cloud callers do not receive its sensitive-history
  scope, deleted chats and SQL-wildcard expansion are excluded, and only bounded
  titles/snippets plus content-free correlated audit receipts leave the owner.
- `planner.today` reuses the canonical capacity-planner owner to provide an
  explicit human-only, session-bound view of today's mode, bounded task titles,
  next steps, deadlines, blockers, pins, and transparent ordering reasons. It
  does not change capacity, tasks, context, confirmations, or Workboard state.

## Done

- Added README.
- Added sanitised rules.
- Added system architecture.
- Added UI product spec.
- Added write safety model.
- Added memory pipeline.
- Added mutual calibration layer.
- Added true user model architecture.
- Added workload and recovery model.
- Added source review workflow.
- Added source-of-truth placeholders.
- Added memory inbox placeholder.
- Added public open questions.
- Added public predictions.
- Added templates and collaborator handoff.
- Decided first prototype stack: React/Vite frontend, Express API, SQLite local store.
- Built dashboard/planner view.
- Built repository file browser.
- Built proposal/review queue for governed changes and memory candidates.
- Built Browser consultation handoff with manual response capture.

## Next authorised action-registry slice

- Navigation remains prerequisite-blocked: routing is renderer-local and the
  only native message channel is renderer-to-host. A trustworthy action needs an
  authenticated server-to-specific-renderer command stream, correlation binding,
  and applied/failed acknowledgement before it can report success.
- Design and verify that bridge as its own safety slice before registering any
  `navigation.*` action. Do not substitute a server-returned route suggestion for
  evidence that the renderer actually navigated.
- Keep the catalog incremental. Do not expose destructive, repository, external
  send, approval-decision, or other mutations until their confirmation,
  stale-state, rollback, replay, and UI contracts are complete.

## Historical public-scaffold follow-ups

- Make repository public in GitHub settings.
- Ask collaborator to review UI architecture.
- Tighten public/private repo mode separation before any sync.
- Run a public-safe leakage scan before publishing or merging.

## Do not add

- private user data;
- real memory exports;
- raw personal chat logs;
- private uploaded files;
- anything that would make the public repo a copy of private records.
