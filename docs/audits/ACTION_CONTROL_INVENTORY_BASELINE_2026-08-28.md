# Action-control inventory baseline — 2026-08-28

This is a source-derived Phase 3 debt baseline, not a completeness claim.

`scripts/verify-action-control-inventory.mjs` parses the real React source and
records every intrinsic `button`, `input`, `select`, `textarea`, and `summary`
control by owning component. It verifies that action/control annotations are
paired, static, and backed by the live neutral action manifest. A reviewed JSON
fingerprint makes any added, removed, relabelled, remapped, or reordered control
an explicit test failure until its effect on the registry migration is reviewed.

Current source truth:

- 480 intrinsic interactive controls;
- 43 controls in the accepted neutral action-registry slice;
- 437 controls not yet migrated;
- 21 neutral actions in the live manifest.

Updated 2026-08-29: `PlannerItemActions`'s Done/Seen/Drop buttons and their new
inline Confirm control (0→4 of 5 mapped) now route through the existing
`workboard.propose_update` action instead of a raw `PATCH /api/items/:id`
fetch. No new action was added; the pre-existing action's field allowlist
gained one new field (`last_reviewed`, sentinel `"today"` only) to support the
"Seen" button's stale-clearing behaviour.

Updated 2026-08-29 (second slice): `FeedbackReview`'s "Route to Quality
review" / "Dismiss" buttons and their new inline Confirm control (0→3 of 4
mapped) now route through a new `feedback.propose_triage` action (propose
then confirm) instead of a raw `PATCH /api/feedback/:id` fetch.

The raw route remains, explicitly classified as **COMPATIBILITY ENDPOINT —
INTENTIONAL ACTION-REGISTRY CONFIRMATION EXEMPTION** (see the matching
comment directly above `app.patch('/api/feedback/:id', ...)` in
`server/index.js`), not a silent or unexplained bypass:

1. Both paths (`feedback.propose_triage`'s confirm route and the raw PATCH
   route) share exactly one core mutation implementation,
   `applyFeedbackTriage()` — no second copy of the actionable-check /
   conditional-`failure_events`-insert / status-update logic exists anywhere.
2. `FeedbackReview` (the only UI caller) no longer calls the raw endpoint —
   verified by inspection: no remaining `/api/feedback/` PATCH call exists in
   `src/main.jsx`.
3. The raw route's own pre-existing dedicated test suite
   (`scripts/verify-feedback-http.mjs`, concurrency-safe and idempotent
   triage) passes unchanged after the extraction.
4. Its immediate, chat-session-free mutation behaviour is intentional: it is
   the only path available to a caller that is not chat-session-scoped
   (`feedback.propose_triage`'s confirm route hard-requires a real chat
   session), mirroring the already-accepted `planner.refresh` precedent of
   one legacy direct route plus one governed registry action sharing a
   single authoritative function.
5. This baseline document is that exemption's recorded owner — there is no
   separate backend-endpoint inventory in this codebase's current governance
   model (`verify-action-control-inventory.mjs` scans intrinsic frontend
   controls in `src/main.jsx`, not backend routes), so this note is the
   deliberate record rather than a gap.
6. The route was NOT narrowed to the two triage-only statuses
   (`feedback.propose_triage`'s own allowlist) merely to tidy the registry
   count — no evidence this pass justified narrowing its existing accepted
   `FEEDBACK_STATUSES` contract, so it was left as-is.

The total includes form fields and disclosure controls as required by the
app-wide todo. It is not a percentage-complete score: one text field is not the
same risk or effort as restore, external send, repository write, or deletion.
The baseline prevents silent debt growth; it does not make unmapped controls
AI-controllable and does not authorize any new action.

Impact-first migration order from the reproduced inventory:

1. Setup/recovery and repository operations, because incorrect shared-handler,
   confirmation, or recovery behavior can affect installation and user data.
2. Planner lifecycle controls, including supporting-evidence operations, because
   canonical state, append-only history, retry, and confirmation semantics now
   exist and can be reused.
3. Candidate/approval and Quality-review controls, because they govern memory
   promotion and evaluated behavior changes.
4. External browser/cloud and coding controls only after their existing auth,
   scope, cancellation, and approval boundaries are preserved.
5. Low-risk navigation, filters, fields, and disclosure controls after the
   mutation families have canonical action owners.

Do not bulk-add action IDs. Each migrated family still requires one canonical
handler, typed contracts, risk/permission classification, availability and
stale-state checks, confirmation where required, structured outcomes, recovery,
and bidirectional UI/manifest acceptance.
