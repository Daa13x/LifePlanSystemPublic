# Action-control inventory baseline — 2026-08-28

This is a source-derived Phase 3 debt baseline, not a completeness claim.

`scripts/verify-action-control-inventory.mjs` parses the real React source and
records every intrinsic `button`, `input`, `select`, `textarea`, and `summary`
control by owning component. It verifies that action/control annotations are
paired, static, and backed by the live neutral action manifest. A reviewed JSON
fingerprint makes any added, removed, relabelled, remapped, or reordered control
an explicit test failure until its effect on the registry migration is reviewed.

Current source truth:

- 478 intrinsic interactive controls;
- 40 controls in the accepted neutral action-registry slice;
- 438 controls not yet migrated;
- 20 neutral actions in the live manifest.

Updated 2026-08-29: `PlannerItemActions`'s Done/Seen/Drop buttons and their new
inline Confirm control (0→4 of 5 mapped) now route through the existing
`workboard.propose_update` action instead of a raw `PATCH /api/items/:id`
fetch. No new action was added; the pre-existing action's field allowlist
gained one new field (`last_reviewed`, sentinel `"today"` only) to support the
"Seen" button's stale-clearing behaviour.

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
