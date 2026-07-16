# LifePlanSystemPublic Memory, Approval, and Project-Governance Reference

Status: complete source-level reference for memory-candidate review, approval actions, project governance, stale checks, and governed repository/memory mutations; runtime verification remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/index.js  1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
server/db.js     46f761bad8f03592bda1915f1b4fca04f9ccc4bc
src/main.jsx     4592881c34af44848dfc72e74895face6098a1da
```

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_PLANNER_AND_ITEM_STATE_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_CHAT_AND_LOCAL_MODEL_EXECUTION_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_REPOSITORY_PROPOSAL_AND_PROTECTED_PATH_REFERENCE.md
```

---

## 1. Governance layers

The public app has three separate mutation paths.

### Direct user authority

```text
POST/PATCH /api/items
POST       /api/projects
```

These mutate SQLite immediately. The stated design is that approval gates govern agent-proposed changes, not direct user actions.

### Memory-candidate review

```text
memory_candidates → approve / defer / deny
```

Candidate approval creates a new active `knowledge_items` row.

### Generic approvals

```text
approvals → approve / defer / deny
```

Approval application can create/update projects, create/update memory, or perform a repository write.

These systems are related but not unified. Candidate decisions do not create `approvals` rows, and generic approvals do not normally become `memory_candidates`.

---

## 2. Memory-candidate origins

### Chat messages

Messages of at least 24 characters create candidates with:

```text
source=chat
confidence=0.52
status=candidate
```

### Cloud consultations

The first time a consultation receives a non-empty `external_response`, the server creates a candidate with:

```text
type=consultation
source=cloud consultation
confidence=0.45
status=candidate
```

Subsequent edits to the same consultation response do not create another candidate because creation occurs only when the previous response was empty.

### Other creation paths

The generic approval action `add_memory` writes directly to `knowledge_items`; it does not create a candidate.

---

## 3. Candidate read and edit

`GET /api/memory` returns:

```text
candidates: every memory_candidates row, newest first
items: every knowledge_items row joined with project_name, newest update first
```

It does not hide denied or approved candidates.

`PATCH /api/memory/candidates/:id` permits editing only when current status is:

```text
candidate
deferred
```

Editable fields:

```text
type
title
body
evidence
confidence
```

Confidence is clamped to the 0–1 range.

### Edit limitations

- empty strings are treated as “leave unchanged” for type/title/body/evidence because the handler passes `value || null`;
- field lengths and accepted candidate types are not validated;
- no updated timestamp is recorded for candidate edits;
- edit history is not retained.

---

## 4. Candidate decisions

Route:

```text
POST /api/memory/candidates/:id/:decision
```

Allowed decisions:

```text
approve
deny
defer
```

### Approve

1. Normalize cloud-consultation candidates.
2. Insert a new `knowledge_items` row.
3. Force status to `active`.
4. Set confidence to at least `0.7`.
5. Set `last_reviewed` to today.
6. Set owner to `user`.
7. Set a generic next action.
8. Mark the candidate `approved` and set `reviewed_at`.

Cloud consultation normalization:

- changes type to `consultation`;
- removes the `Consultation suggestion:` title prefix when present.

### Deny or defer

- deny writes status `denied`;
- defer writes status `deferred`;
- both update `reviewed_at`.

### Critical idempotency defect

The decision route does not require the candidate to be `candidate` or `deferred` before deciding.

Consequences:

- an already-approved candidate can be approved again;
- every repeat approval inserts another knowledge item;
- denied candidates can later be approved through a direct API call;
- repeated deny/defer calls overwrite status and review timestamp.

The route needs an allowed-transition check and an idempotency/uniqueness strategy before candidate approval is production-safe.

---

## 5. Generic approval creation

Route:

```text
POST /api/approvals
```

Required request fields:

```text
action_type
title
payload
```

Optional:

```text
priority, default P2
```

The payload is JSON-stringified and stored as text.

### Critical schema gap

Approval creation does not enforce an action-type allowlist or per-action payload schema. Any non-empty action type and payload can be stored.

The current decision handler implements only:

```text
create_project
update_project
add_memory
repo_write
update_memory
```

An unknown action type can still be marked `approved` without applying any side effect. This produces a misleading approved record.

---

## 6. Generic approval decisions

Route:

```text
POST /api/approvals/:id/:decision
```

Allowed decisions:

```text
approve
deny
defer
```

Resulting statuses:

```text
approve → approved
deny    → denied
defer   → deferred
```

When approved, the action-specific side effect runs before the approval status is updated.

### Critical idempotency defect

The route does not require current status `pending`.

Consequences:

- an approved `create_project` approval can be approved again and create duplicate projects;
- an approved `add_memory` approval can be approved again and create duplicate memory;
- deferred or denied approvals can be approved through a direct API call;
- re-deciding old approvals changes audit meaning;
- action handlers are not uniformly idempotent.

A safe implementation must enforce explicit transitions, such as:

```text
pending → approved | denied | deferred
deferred → pending only through an explicit reopen operation
terminal states → immutable
```

---

## 7. `create_project` approval

Expected payload:

```json
{
  "name": "Project name",
  "status": "active",
  "owner": "user",
  "confidence": 0.75,
  "evidence": "...",
  "next_action": "..."
}
```

On approval it inserts a project with source `approved proposal` and today's review date.

Gaps:

- no required-name validation inside the decision handler;
- no duplicate-name protection;
- no status/owner taxonomy validation;
- confidence is not clamped;
- repeated approval duplicates the row.

---

## 8. `update_project` approval

Expected payload:

```json
{
  "id": 1,
  "previous": {
    "name": "...",
    "status": "...",
    "owner": "...",
    "confidence": 0.7,
    "next_action": "..."
  },
  "updates": {
    "name": "...",
    "status": "...",
    "owner": "...",
    "confidence": 0.8,
    "evidence": "...",
    "next_action": "..."
  }
}
```

Before applying, the handler compares provided `previous` values against current project state.

Compared fields:

```text
name
status
owner
next_action
confidence
```

A mismatch returns HTTP 409 and does not mark the approval decided.

Applied behavior:

- updates only supplied fields;
- sets `last_reviewed` to today;
- updates timestamp;
- uses `Approval <id>` as default evidence.

### Stale-check limitations

- `updated_at`, source, evidence, and review date are not compared;
- omitted `previous` fields receive no stale protection;
- comparison uses string coercion for most fields and numeric coercion for confidence;
- status and owner values are not validated before update.

---

## 9. `add_memory` approval

Expected payload includes:

```text
type
title
body
source
confidence
evidence
owner
next_action
```

On approval it creates an active knowledge item with today's review date.

Defaults:

```text
type=current state
source=approved proposal
confidence=0.7
owner=user
next_action=Review during next planner pass.
```

Gaps:

- title/body are not validated in the decision handler;
- item type/status constraints are not reused;
- confidence is not clamped;
- no duplicate detection;
- repeated approval duplicates the item.

---

## 10. `update_memory` approval

Expected payload:

```json
{
  "id": 1,
  "previous": {
    "updated_at": "...",
    "status": "active",
    "confidence": 0.75
  },
  "updates": {
    "status": "archived",
    "confidence": 0.9,
    "evidence": "...",
    "next_action": "..."
  }
}
```

Stale checks apply only when the corresponding `previous` key is supplied:

```text
updated_at
status
confidence
```

Allowed resulting statuses:

```text
active
stable
stale
deprecated
superseded
archived
pending review
```

Notably, `blocked` and `done`, which are valid direct item statuses, are not accepted by this approval path.

Applied changes also update today's review date and `updated_at`.

### Revalidation gap

The dedicated revalidate route does not implement `update_memory`, although final approval does perform stale checks. The UI can therefore receive a generic “no external stale checks required” response before a later 409 during approval.

---

## 11. `repo_write` approval

Operations:

```text
create
update
delete
rename
```

The handler:

- confines paths to the workspace;
- rejects protected runtime/private paths;
- compares `previousContent` when supplied;
- refuses create over an existing target;
- refuses rename over an existing target;
- creates parent directories for create/update/rename destination;
- performs the filesystem operation directly after approval.

This lifecycle is documented in detail in the repository proposal reference.

---

## 12. Approval revalidation

Route:

```text
POST /api/approvals/:id/revalidate
```

Specialized revalidation exists for:

```text
repo_write
update_project
```

Other action types return valid with the message that no external stale checks are required.

This is not a universal guarantee of safe approval. Final decision handlers can still fail.

### Frontend defect dependency

The current React Approval Queue has a known scope defect around the Revalidate action. Even though the backend route exists, the button may fail before calling it. Runtime acceptance must test the actual button.

---

## 13. Direct project route versus governed UI

Routes:

```text
GET  /api/projects
POST /api/projects
```

The React Projects panel currently creates and edits projects through approvals, but the backend also exposes direct project creation.

Direct creation:

- requires only a name;
- writes source `manual`;
- defaults status active, owner user, confidence 0.75;
- bypasses approval.

There is no direct project update or delete route in the current backend.

### Governance inconsistency

The API permits direct project creation while the UI presents project creation as governed. This is acceptable only if direct API calls are explicitly treated as authenticated user authority. The local server currently has no authentication, so any local process able to call the port can use the bypass.

---

## 14. Audit and provenance behavior

What is retained:

- candidate source/evidence and review timestamp;
- approval payload, priority, created timestamp, status, decision timestamp;
- project/memory source/evidence fields.

What is not retained:

- who approved/denied/deferred;
- reason for a decision;
- candidate edit history;
- approval payload schema version;
- exact applied diff for database changes;
- a link from created knowledge/project rows back to the approval id, except evidence text conventions;
- immutable terminal decisions.

---

## 15. Failure and recovery

| Failure | Behavior | Recovery |
|---|---|---|
| malformed approval payload JSON | approval decision returns 400 | inspect/fix or deny bad row |
| stale project/memory/file | 409, approval remains undecided | refresh and create a new proposal |
| action partially writes before later failure | no general transaction across action/status update | inspect target and approval manually |
| process crash after side effect before status update | approval may remain pending although effect occurred | compare target state before re-deciding |
| unknown action type | can be marked approved with no effect | treat as invalid and repair status/audit |
| repeat approval | may duplicate rows/effects | prevent through code; clean duplicates manually |

Database changes and approval rows persist across restart. Filesystem effects also persist.

---

## 16. Runtime verification recipe

1. Create a chat candidate, edit it, defer it, and approve it.
2. Verify candidate status and the resulting knowledge item.
3. Attempt a second approval of the same candidate; record this as **BROKEN** until rejected.
4. Create each supported approval action with a valid payload.
5. Revalidate project and repo-write proposals before decision.
6. Change the target after proposal creation and confirm stale approval returns 409.
7. Approve create-project and add-memory once, then attempt repeat approval; record as **BROKEN** until rejected.
8. Create an unknown action type and verify it is not allowed; current source is **BROKEN** because it can be marked approved.
9. Confirm deny/defer paths produce no side effect.
10. Restart and verify decision records and target mutations persist.
11. Test the React Revalidate button rather than only the API.

---

## 17. Required hardening before production readiness

- enforce candidate and approval state-transition machines;
- make terminal decisions immutable;
- make approval application idempotent;
- add an action-type allowlist and versioned payload schemas;
- use transactions for database side effect plus approval-status update;
- record actor, reason, and application result;
- add duplicate or idempotency keys for create actions;
- align direct-project API authority with UI governance and local authentication assumptions;
- implement consistent revalidation for update-memory;
- validate types, statuses, confidence, required fields, and lengths inside every action handler;
- recover safely from “side effect succeeded, status update failed” cases.
