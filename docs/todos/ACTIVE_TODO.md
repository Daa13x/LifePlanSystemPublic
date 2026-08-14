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

- Evaluate `conversation.search`, the final already-registered capability that
  remains outside the neutral catalog. Expose it only with a real active Chat
  session, explicit human UI search, strict query/snippet/result bounds, and no
  generic local/cloud agent scope.
- Prove that searching history does not attach, promote, mutate, or leak raw
  message bodies beyond the requested bounded snippets; preserve concise audit
  receipts without query or message content.
- Keep the catalog incremental. Do not expose additional mutations until their
  confirmation, stale-state, rollback, replay, and UI contracts are complete.

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
