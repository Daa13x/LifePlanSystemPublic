# LifePlanSystemPublic Planner and Item-State Reference

Status: complete source-level reference for Planner aggregation, refresh behavior, and direct knowledge-item CRUD; runtime verification remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/index.js  1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
server/db.js     46f761bad8f03592bda1915f1b4fca04f9ccc4bc
src/main.jsx     4592881c34af44848dfc72e74895face6098a1da
```

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_DATABASE_SCHEMA_AND_MIGRATION_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_MEMORY_APPROVAL_AND_PROJECT_GOVERNANCE_REFERENCE.md
```

---

## 1. Purpose and ownership

The Planner is an aggregated read model over four SQLite areas:

- `knowledge_items` — goals, decisions, reminders, blockers, waiting items, rules, notes, and current state;
- `projects` — optional parent project labels joined onto knowledge items;
- `approvals` — pending governed changes;
- `memory_candidates` — conversation or consultation-derived information awaiting review.

The Planner does not have its own table. `plannerData()` reconstructs the view on every request.

Primary routes:

```text
GET  /api/planner
POST /api/planner/refresh
GET  /api/items
POST /api/items
PATCH /api/items/:id
```

The React Planner also reads Planner data through `GET /api/bootstrap`.

---

## 2. Knowledge-item taxonomy

### API-recognized types

```text
goal
project
decision
reminder
current state
blocker
waiting
rule
note
```

### API-recognized statuses

```text
active
stable
blocked
stale
pending review
done
archived
deprecated
superseded
```

These lists are enforced by the direct item routes, but the SQLite table itself has no check constraint for either field. Imports, seeds, approval handlers, or future SQL can therefore introduce other values.

---

## 3. Planner aggregation algorithm

`plannerData()` performs the following steps.

1. Check Playwright/Chromium readiness.
2. Check whether the Chrome connector heartbeat is less than 15 seconds old.
3. Load all knowledge items except `archived`, `deprecated`, and `superseded`.
4. Left-join projects to expose `project_name`.
5. Order by `COALESCE(due_at, updated_at)` ascending, then confidence ascending.
6. Replace the seeded browser blocker text with current browser/tooling status.
7. Load pending approvals and candidate/deferred memory.
8. Build the Planner buckets below.

### Buckets

| Bucket | Rule | Returned maximum |
|---|---|---:|
| `focus` | type is goal/project/decision/reminder/current state and status active/stable | 5 |
| `blockers` | type blocker or status blocked | 5 |
| `waiting` | type waiting **or owner user** | 6 |
| `automatic` | owner app and status active | 5 |
| `stale` | last review older than 14 days, missing review date, explicit stale status, or confidence below 0.55 | 6 |
| `approvals` | approval status pending | 5 |
| `candidates` | candidate status candidate/deferred | 5 |

The summary counts are calculated before result slicing.

### Next-best priority

```text
first pending approval
→ first blocker
→ first memory candidate
→ first focus item
→ first remaining item
→ null
```

This is a fixed priority rule, not a learned ranking.

### Important behavior notes

- Because `waiting` includes every user-owned item, it can overlap heavily with focus and blocker buckets.
- Items without `last_reviewed` are always stale.
- Lower-confidence items sort earlier when the due/update key is equal.
- `due_at` is stored as text and is not format-validated by the API.
- Planner buckets are not mutually exclusive.

---

## 4. Browser-blocker normalization

The seed creates an app-owned item titled:

```text
Cloud browser automation is not configured yet
```

At read time, `normalizeBrowserBlocker()` changes its body, evidence, and next action according to:

- Playwright package availability;
- Chromium executable availability;
- Chrome extension connector freshness.

This transformation is display-only. It does not update the database.

The logic depends on the exact English title. Renaming the seeded item disables the special behavior.

---

## 5. Planner refresh behavior

`POST /api/planner/refresh` is intentionally narrow. It is not a general planning engine.

Current governed automation:

1. Find the seeded browser blocker if it is still active.
2. Confirm Playwright, Chromium, and the Chrome connector are ready.
3. Check whether a pending `update_memory` approval titled `Retire resolved browser connector blocker` already exists.
4. If not, create a P1 approval proposing that the blocker be archived.
5. Return a freshly aggregated Planner.

The refresh never archives the blocker directly. The user must approve the generated proposal.

If no proposal is needed, it returns:

```text
Planner refresh complete. No governed changes proposed.
```

Restart behavior: all resulting approvals and item changes are persisted in SQLite. Tool readiness is recomputed after restart.

---

## 6. Direct item creation

`POST /api/items` is a direct user-authority path and does not create an approval.

Required:

```text
title
```

Defaults:

| Field | Default |
|---|---|
| type | `note` |
| body | title |
| source | `manual` |
| status | `active` |
| confidence | `0.9` |
| last_reviewed | current date |
| owner | `user`, unless request explicitly says `app` |
| next_action | null |
| project_id | null |
| due_at | null |

The design rule is explicit: approvals govern agent-proposed changes; direct user edits bypass the queue.

### Validation gaps

- confidence is converted with `Number()` but not clamped to 0–1;
- project existence is left to the SQLite foreign-key failure path;
- due dates are not parsed or normalized;
- body and title lengths are not capped;
- owner accepts only `app` or falls back to `user`.

---

## 7. Direct item update

`PATCH /api/items/:id` supports:

```text
title
body
type
status
next_action
due_at
project_id
confidence
reviewed
```

Rules:

- unknown fields are ignored;
- type/status change only when included in the recognized lists;
- `reviewed: true` sets `last_reviewed` to today's ISO date;
- every accepted update sets `updated_at` to a JavaScript ISO timestamp;
- at least one recognized field is required.

There is no direct delete route. The intended removal mechanism is a terminal status such as `archived`, `deprecated`, or `superseded`.

### Timestamp inconsistency

SQLite defaults use `CURRENT_TIMESTAMP`, while this route writes a JavaScript ISO timestamp with timezone and milliseconds. Consumers must tolerate both formats.

---

## 8. Read behavior

`GET /api/items` excludes archived/deprecated/superseded by default.

```text
GET /api/items?all=1
```

returns every row.

The Planner uses its own query rather than this endpoint, so changing `/api/items` does not automatically change Planner composition.

---

## 9. State-transition summary

```text
manual create → active by default
active/stable → focus candidates
blocked/type blocker → blocker bucket
owner user/type waiting → waiting bucket
old review/low confidence/stale → stale bucket
done → retained but not automatically hidden
archived/deprecated/superseded → hidden from default Planner/items views
```

No automatic confidence decay is persisted. “Stale” is mostly a read-time classification unless a route or approval explicitly writes the status/confidence.

---

## 10. Failure and recovery

| Failure | Behavior | Recovery |
|---|---|---|
| database write fails | JSON 500 via final error handler | inspect server log and database path |
| invalid item id | 404 | refresh UI |
| unsupported-only patch | 400 | send a recognized field |
| browser readiness check fails during Planner load | caught and treated as unavailable status | refresh after tooling recovers |
| refresh proposal already pending | no duplicate proposal | decide existing approval |
| malformed due/confidence data | may persist because validation is weak | correct with PATCH or database repair |

---

## 11. Runtime verification recipe

Use an isolated database.

1. Start the API with `LIFE_PLANNER_DB` pointing to a temporary file.
2. `POST /api/items` once for each important type.
3. Confirm `GET /api/items` returns them.
4. Confirm `GET /api/planner` places them in the expected overlapping buckets.
5. Set one item's review date/status/confidence so it becomes stale.
6. Mark one item done and confirm it remains visible.
7. Archive one item and confirm it disappears from default reads but appears with `?all=1`.
8. Verify `reviewed: true` updates `last_reviewed`.
9. With browser tooling ready, run Planner refresh and confirm it creates an approval rather than mutating the blocker.
10. Restart and confirm all item/approval state persists.

---

## 12. Known defects and maintenance risks

- `waiting` is broader than its label because all user-owned items qualify.
- The browser blocker relies on one exact seeded title.
- Item confidence and due-date inputs lack robust validation.
- Mixed timestamp formats are written.
- There is no database constraint for item type/status.
- Planner refresh currently contains only one special-case automation.
- `done` items are not excluded from Planner aggregation.
- There is no direct item-delete endpoint or retention policy.
- The UI and API must not describe Planner refresh as autonomous planning; it currently proposes one governed browser-blocker cleanup only.
