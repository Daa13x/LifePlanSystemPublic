# Active Todo

This public todo file tracks system/UI work only.

## Current goal

Continue the public LifePlanSystem action registry through small, verified
slices so Chat can use existing LPS capabilities without bypassing typed
identity, privacy, confirmation, recovery, or user authority.

## Current checkpoint — 2026-08-14

- The neutral action catalog has bounded Knowledge search/read, typed Workboard
  list/read, and durable Workboard-create proposal/confirmation.
- Workboard identity is explicit across project, item, roadmap, approval, and
  candidate records. Numeric IDs are never guessed across entity classes.
- Workboard detail is a session-bound sensitive read. Project previews reuse
  the canonical layered-card projection; every returned string, child list, and
  complete response is bounded.
- The real Chat Context Picker previews Workboard records without attaching
  them. Attach remains a separate explicit context write.

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

- Expose `workboard.propose_update` only after it persists the exact reviewed
  item identity, validated changes, and current-state fingerprint in the
  existing durable confirmation owner.
- Reject no-op, malformed, replayed, expired, cross-session, deleted-target,
  and stale-state updates, and settle the item mutation plus confirmation
  receipt atomically.
- Prove the complete preview/confirm/persist/replay/stale/isolation journey in
  deterministic tests and the real browser before publication.

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
