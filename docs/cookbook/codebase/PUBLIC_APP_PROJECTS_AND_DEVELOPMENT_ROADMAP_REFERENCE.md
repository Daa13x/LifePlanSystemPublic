# LifePlanSystemPublic Projects and Development-Roadmap Reference

Status: complete source-level reference for project records, roadmap items, roadmap candidates, autonomous scanning, seeding, ordering, and review; runtime verification remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/index.js  1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
server/db.js     46f761bad8f03592bda1915f1b4fca04f9ccc4bc
src/main.jsx     4592881c34af44848dfc72e74895face6098a1da
```

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_MEMORY_APPROVAL_AND_PROJECT_GOVERNANCE_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_PLANNER_AND_ITEM_STATE_REFERENCE.md
```

---

## 1. Two different concepts

The application contains two separate planning structures.

### Life projects

Stored in `projects`, these organize personal/work goals and can be linked from `knowledge_items.project_id`.

### Development roadmap

Stored in `roadmap_items`, this tracks work on the Life Planner application itself.

`roadmap_candidates` is a staging inbox for possible development tasks found in chat or repository files.

These structures are intentionally separate. A development roadmap item is not a Planner project or knowledge item.

---

## 2. Project data model

Project fields:

```text
id
name
status
owner
source
confidence
last_reviewed
evidence
next_action
created_at
updated_at
```

Knowledge items can point to projects through a foreign key with `ON DELETE SET NULL`, although the current API has no project-delete route.

Primary routes:

```text
GET  /api/projects
POST /api/projects
POST /api/approvals              (UI project proposals)
POST /api/approvals/:id/:decision
```

---

## 3. Direct project creation

`POST /api/projects` requires only a non-empty name.

Defaults:

```text
status=active
owner=user
source=manual
confidence=0.75
last_reviewed=today
evidence=Manual entry
next_action=''
```

There is no direct PATCH or DELETE route.

### Validation gaps

- no project status taxonomy;
- no owner taxonomy;
- confidence is not clamped;
- duplicate names are allowed;
- lengths are not capped;
- names are not normalized for uniqueness.

The current React Projects screen uses governed approvals for create/update rather than this direct creation route.

---

## 4. Governed project creation and update

The UI creates generic approvals using action types:

```text
create_project
update_project
```

`create_project` inserts a new project after approval.

`update_project` can change:

```text
name
status
owner
confidence
evidence
next_action
```

The approval payload can carry a `previous` snapshot. Current values are compared before application to detect stale proposals.

This lifecycle, including idempotency defects, is documented in the governance reference.

---

## 5. Roadmap item taxonomy

Allowed statuses:

```text
planned
active
paused
parked
done
```

Allowed categories:

```text
feature
fix
infra
chore
idea
```

These lists are enforced by roadmap create/update routes, but not by SQLite constraints.

---

## 6. Roadmap seed lifecycle

`seedRoadmapIfEmpty()` runs immediately after database migration.

It checks:

```sql
SELECT COUNT(*) FROM roadmap_items
```

Only when the table is empty, it inserts a fixed snapshot of current build work, including Source Control, model management, installer/CI, first-run setup, OpenHands invocation, and brain-aware Chat.

Properties:

- user edits are not overwritten on later starts;
- deleting every roadmap item causes the full seed to return on the next restart;
- seed text can become stale as code changes;
- seed state is not versioned or migrated;
- `sort_order` follows seed array order.

The roadmap seed is documentation-like runtime data, not source-of-truth about whether a feature is actually complete.

---

## 7. Roadmap item routes

```text
GET    /api/roadmap
POST   /api/roadmap
PATCH  /api/roadmap/:id
POST   /api/roadmap/:id/move
DELETE /api/roadmap/:id
```

### Create

Requires title. Invalid/missing status or category falls back to:

```text
status=planned
category=feature
```

New items are appended after the current maximum `sort_order`.

### Update

Supports:

```text
title
detail
resume_notes
category
status
sort_order
```

Invalid explicit status/category is rejected.

`sort_order` is converted using `Number()` without integer/range validation.

### Move

`POST /api/roadmap/:id/move` swaps `sort_order` with the immediate neighbor.

- `direction=up` moves upward;
- every other value defaults to down;
- explicit `BEGIN/COMMIT/ROLLBACK` protects the two-row swap.

### Delete

Deletion is immediate and permanent. There is no confirmation, archive status, or dependency check.

---

## 8. Development-task scanner purpose

The scanner stages technical TODO-like lines as `roadmap_candidates`.

It runs:

```text
1.5 seconds after server startup
every 15 minutes while the process is running
manually through POST /api/roadmap/scan
```

The periodic timer is unref'd, so it does not keep Node alive by itself.

The scanner never promotes a candidate automatically. A user must accept it.

---

## 9. Chat scanning

`scanChatForDevTasks()` reads the latest 400 messages across all sessions, regardless of role.

Each line is evaluated independently.

A normal prose line must contain:

```text
an intent cue AND a development cue
```

Examples of intent cues:

```text
TODO, FIXME, need to, should add/build/fix, implement, refactor, support, roadmap, follow-up
```

Examples of development cues:

```text
endpoint, API, UI, component, server, database, Git, installer, model, Playwright, test, refactor
```

Comment-marker lines and unchecked Markdown checklists have special recognition.

### Important behavior

Because all chat roles are scanned, assistant-generated suggestions can become roadmap candidates. The scanner does not distinguish a user commitment from a model brainstorm.

---

## 10. Repository-file scanning

`scanFilesForDevTasks()` starts from:

```text
src
server
docs/todos
```

Included extensions:

```text
.js .jsx .ts .tsx .css .md .mjs
```

Blocked directory names:

```text
node_modules
dist
data
.git
release
.cache
```

Limits:

```text
maximum collected files: 600
skip file when text length exceeds 400,000 characters
```

Unlike chat scanning, file scanning considers only:

- recognized TODO/FIXME/HACK/XXX comment-marker lines;
- unchecked Markdown checklist lines.

It does not scan ordinary file prose for intent/development keyword pairs.

### Scan gaps

- directory enumeration errors are not isolated consistently;
- symlink behavior is not explicitly controlled;
- `.lps` is not in the scanner's blocked-directory set, although the roots currently avoid it;
- files beyond the 600-file traversal limit are silently ignored;
- traversal order depends on filesystem enumeration and stack order;
- no scan watermark exists, so every run rereads the bounded history/files.

---

## 11. Candidate classification and dedupe

Categories are inferred:

```text
fix-related words                       → fix
refactor/schema/migration/infra/etc.    → infra
idea/maybe/consider/could/explore       → idea
otherwise                               → feature
```

Candidate titles are whitespace-normalized, comment-prefix stripped, and capped at 140 characters.

Dedupe key:

```text
SHA-1 of "roadmap|<normalized lowercase title>"
```

`sourceKind` is not part of the effective key because the caller always passes the literal `roadmap` into `dedupeKey()`.

Consequences:

- the same title from chat and a file becomes one candidate;
- an existing candidate in any status prevents restaging;
- a dismissed candidate never returns even if the underlying TODO still exists;
- an accepted candidate never returns;
- changed wording creates a new candidate.

`roadmapAlreadyKnows()` also tries to prevent restaging a title already present as a roadmap item.

---

## 12. Candidate review lifecycle

Routes:

```text
GET  /api/roadmap/candidates
POST /api/roadmap/candidates/:id/accept
POST /api/roadmap/candidates/:id/dismiss
```

Only status `candidate` appears in the list route.

### Accept

1. Load candidate by id.
2. Append a new roadmap item with status `planned`.
3. Copy category.
4. Add source information to detail.
5. Mark candidate `accepted`.

### Dismiss

Marks candidate `dismissed`.

### State-safety gaps

- accept/dismiss do not require current status `candidate`;
- repeat acceptance can create duplicate roadmap items;
- insert-item and update-candidate are not transactional;
- a crash between those writes can leave a new roadmap item and still-candidate row;
- there is no reopen or snooze operation;
- dismissal reason is not recorded.

---

## 13. Startup and interval behavior

After the server starts listening:

```text
setTimeout(runDevTaskScan, 1500)
setInterval(runDevTaskScan, 15 minutes).unref()
```

Only positive staged counts are logged. Scan errors are returned internally but periodic failures are otherwise quiet.

Restart effects:

- candidates/items persist in SQLite;
- scanner runs again after every restart;
- dedupe normally prevents repeated staging;
- the 15-minute schedule resets.

---

## 14. Failure and recovery

| Failure | Behavior | Recovery |
|---|---|---|
| malformed roadmap title/status/category | 400 | correct request |
| reorder SQL failure | rollback | retry after refresh |
| scanner file read failure | usually skips file | inspect permissions |
| scanner global exception | reports `{ok:false}` | inspect server logs/manual scan |
| accept partial failure | candidate/item may diverge | inspect both tables |
| all roadmap rows deleted | seed returns on restart | keep at least one row or change seed logic |
| stale seed text | remains until user edits/deletes | update source seed and migration strategy |

---

## 15. Runtime verification recipe

1. Start with an isolated database and record the seeded roadmap.
2. Restart and verify seed rows are not duplicated.
3. Create, update, move, and delete a roadmap item.
4. Verify status/category rejection and sort ordering.
5. Add a technical TODO in a test chat message and scan.
6. Add a TODO comment and unchecked checklist in controlled files and scan.
7. Confirm unrelated personal-task text is not staged.
8. Confirm assistant-generated technical text can currently be staged and decide whether that is intended.
9. Accept one candidate and verify source detail and planned status.
10. Attempt repeat accept; mark **BROKEN** until rejected.
11. Dismiss a candidate, leave the source TODO in place, rescan, and verify it does not return.
12. Delete all roadmap items, restart, and verify the seed resurrection behavior.
13. Test a repository with more than 600 candidate files to document coverage limits.

---

## 16. Known defects and maintenance risks

- Chat scanner includes assistant messages and may promote model suggestions into the review inbox.
- Candidate accept/dismiss transitions are not guarded or idempotent.
- Candidate acceptance is not transactional.
- Dismissed tasks never resurface even when still unresolved.
- Seed rows can become stale and reappear after the table is emptied.
- Roadmap deletion is immediate and permanent.
- `sort_order` accepts non-integer/invalid numeric values.
- File scan coverage is bounded and traversal-order dependent.
- The roadmap scanner has no incremental index or source-change tracking.
- Roadmap status is planning metadata, not runtime verification evidence; cookbook/acceptance records remain authoritative for actual completion.
