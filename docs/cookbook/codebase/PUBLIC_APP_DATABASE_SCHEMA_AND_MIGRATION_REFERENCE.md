# LifePlanSystemPublic Database Schema and Migration Reference

Status: complete source-level reference for `server/db.js` and the SQLite tables it creates; runtime data validation remains separate.

Last updated: 2026-07-16

Source snapshot:

```text
Repository: Daa13x/LifePlanSystemPublic
Primary file: server/db.js
Blob SHA: 46f761bad8f03592bda1915f1b4fca04f9ccc4bc
Runtime consumers: server/index.js
Database engine: node:sqlite DatabaseSync
```

---

## 1. Database location and startup

```js
const root = process.cwd();
const dataDir = path.join(root, 'data');
const dbPath = process.env.LIFE_PLANNER_DB || path.join(dataDir, 'life-planner.sqlite');
```

Default location:

```text
<runtime root>/data/life-planner.sqlite
```

Override:

```text
LIFE_PLANNER_DB=<database file path>
```

Startup behaviour:

1. Always creates `<runtime root>/data`.
2. Opens the configured database synchronously.
3. Enables WAL journal mode.
4. Enables foreign-key enforcement.
5. `server/index.js` immediately calls `migrate()`.
6. The server then seeds the development roadmap separately if that table is empty.

### Known path defects

- When `LIFE_PLANNER_DB` points outside the default data directory, `db.js` does not create the override path's parent directory.
- `/api/health` currently reports `data/life-planner.sqlite` rather than the effective `LIFE_PLANNER_DB` path, so health metadata can be wrong under an override.
- The database path is not exported as a shared value, which allowed the health-route drift.

---

## 2. Engine and transaction model

The app uses synchronous `DatabaseSync` from Node's built-in `node:sqlite` module.

Configured pragmas:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

Operational implications:

- WAL improves local reader/writer concurrency and creates sidecar files while active.
- Foreign-key actions declared below are enforced.
- SQL and many filesystem operations execute synchronously on the Express process.
- There is no general repository transaction/service layer.
- Roadmap reordering is the only explicitly wrapped `BEGIN`/`COMMIT`/`ROLLBACK` operation in the current server.
- Approval actions that combine database and filesystem changes cannot be atomic across both systems.

---

## 3. Migration strategy

`migrate()` uses three mechanisms:

1. One `CREATE TABLE IF NOT EXISTS` block for all current tables.
2. Compatibility `ALTER TABLE ... ADD COLUMN` loops for fields added after the first schema.
3. Conditional seed records when core tables are empty.

There is no:

- schema-version table;
- ordered migration history;
- down migration;
- migration checksum;
- explicit index migration;
- startup schema assertion against an expected version.

### Additive compatibility migrations

`consultations` compatibility columns:

```text
prompt
opened_url
opened_title
sent_at
captured_at
```

`model_registry` compatibility columns:

```text
hf_repo
hf_file
```

Each `ALTER TABLE` catches every error and assumes the column already exists. That is tolerant for repeated startup but can hide unrelated SQLite errors such as corruption, locking, or invalid schema state.

---

## 4. Relationship map

```text
chat_sessions
├── chat_messages (ON DELETE CASCADE)
├── chat_context_files (ON DELETE CASCADE)
└── memory_candidates.session_id (ON DELETE SET NULL)

chat_messages
└── memory_candidates.source_message_id (ON DELETE SET NULL)

projects
└── knowledge_items.project_id (ON DELETE SET NULL)

standalone workflow/state tables
├── settings
├── model_registry
├── roadmap_items
├── roadmap_candidates
├── approvals
└── consultations
```

`consultations` create `memory_candidates` through application code, not a database foreign key.

`approvals.payload` refers to projects, knowledge items, or repository files through JSON fields, not foreign keys.

---

## 5. `settings`

Purpose: generic local key/value configuration store.

| Column | Type | Rules | Meaning |
|---|---|---|---|
| `key` | TEXT | PRIMARY KEY | Setting identifier |
| `value` | TEXT | NOT NULL | JSON-encoded value |
| `updated_at` | TEXT | NOT NULL, default current timestamp | Last write time |

Access helpers:

- `getSetting(key, fallback)` reads and JSON-parses; on parse failure it returns raw text.
- `setSetting(key, value)` JSON-stringifies and upserts.

Risks:

- no key registry at database level;
- no type constraints;
- secret and non-secret values share one table;
- arbitrary keys can be inserted by `/api/settings`;
- encryption at rest is not implemented by this schema.

See `PUBLIC_APP_SETTINGS_AND_SECRET_REGISTRY.md`.

---

## 6. `model_registry`

Purpose: inventory local GGUF files, assignments, and optional Hugging Face origin.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Registry id |
| `name` | TEXT | NOT NULL | Display/file name |
| `path` | TEXT | NOT NULL, UNIQUE | Local model path |
| `size_bytes` | INTEGER | nullable | Last known size |
| `assigned_role` | TEXT | nullable | Usually `Planner Assistant` |
| `source` | TEXT | NOT NULL, default `local` | Discovery/download source |
| `hf_repo` | TEXT | nullable | Re-download repository |
| `hf_file` | TEXT | nullable | Re-download file path |
| `created_at` | TEXT | default current timestamp | Creation time |
| `updated_at` | TEXT | default current timestamp | Last registry update |

Application invariants, not database constraints:

- only one model should be assigned per role;
- assigned model file should exist;
- re-download requires both HF origin fields;
- model path should point to a GGUF file.

Deleting a downloaded file can retain the row and HF origin for re-download. Purge removes the row.

---

## 7. `chat_sessions`

Purpose: persistent conversation container.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Session id |
| `title` | TEXT | NOT NULL | User-visible title |
| `pinned` | INTEGER | NOT NULL, default `0` | Boolean-like flag |
| `deleted` | INTEGER | NOT NULL, default `0` | Soft-delete flag |
| `created_at` | TEXT | default current timestamp | Created |
| `updated_at` | TEXT | default current timestamp | Last session update |

`pinned` and `deleted` are not constrained to 0/1 at database level.

Deleting a row directly cascades messages/context; normal UI deletion is a soft-delete field update.

---

## 8. `chat_messages`

Purpose: ordered chat transcript.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Message id |
| `session_id` | INTEGER | NOT NULL FK | Parent session |
| `role` | TEXT | CHECK user/assistant/system | Message role |
| `content` | TEXT | NOT NULL | Full text |
| `created_at` | TEXT | default current timestamp | Created |

Foreign key:

```sql
session_id REFERENCES chat_sessions(id) ON DELETE CASCADE
```

No content length limit exists at the database layer. Express JSON input is capped at 25 MB; route logic imposes smaller practical constraints in some flows.

---

## 9. `chat_context_files`

Purpose: repository paths attached to a chat session.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Attachment id |
| `session_id` | INTEGER | NOT NULL FK | Parent session |
| `path` | TEXT | NOT NULL | Workspace-relative path |
| `added_at` | TEXT | default current timestamp | Added |

Constraints:

```sql
UNIQUE(session_id, path)
session_id REFERENCES chat_sessions(id) ON DELETE CASCADE
```

The database does not enforce path confinement or file existence. The attach route validates at write time; chat reads silently skip files that later disappear or become unreadable.

---

## 10. `projects`

Purpose: project-level planning entities.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Project id |
| `name` | TEXT | NOT NULL | Project name |
| `status` | TEXT | NOT NULL, default `active` | Lifecycle state |
| `owner` | TEXT | NOT NULL, default `user` | User/app/other owner |
| `source` | TEXT | NOT NULL, default `manual` | Origin |
| `confidence` | REAL | NOT NULL, default `0.8` | Confidence score |
| `last_reviewed` | TEXT | nullable | Review date/time text |
| `evidence` | TEXT | nullable | Evidence/provenance |
| `next_action` | TEXT | nullable | Next action |
| `created_at` | TEXT | default current timestamp | Created |
| `updated_at` | TEXT | default current timestamp | Updated |

No unique name constraint exists. JSON import duplicate skipping is an application heuristic by exact name.

Status, owner, confidence range, and date formats are application-enforced only.

---

## 11. `roadmap_items`

Purpose: development/build roadmap, separate from personal Planner projects.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Item id |
| `title` | TEXT | NOT NULL | Work item title |
| `detail` | TEXT | NOT NULL, default empty | Description |
| `resume_notes` | TEXT | NOT NULL, default empty | Restart context |
| `category` | TEXT | NOT NULL, default `feature` | feature/fix/infra/chore/idea in app logic |
| `status` | TEXT | NOT NULL, default `planned` | planned/active/paused/parked/done in app logic |
| `sort_order` | INTEGER | NOT NULL, default `0` | Board ordering |
| `created_at` | TEXT | default current timestamp | Created |
| `updated_at` | TEXT | default current timestamp | Updated |

`server/index.js` seeds this table only when empty, using current build-state records. User deletion of all rows causes seed recreation on next server startup.

---

## 12. `roadmap_candidates`

Purpose: review queue for automatically detected development tasks.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Candidate id |
| `title` | TEXT | NOT NULL | Proposed title |
| `detail` | TEXT | NOT NULL, default empty | Detail |
| `category` | TEXT | NOT NULL, default `feature` | Classified category |
| `source_kind` | TEXT | NOT NULL, default `chat` | chat/file origin |
| `source_ref` | TEXT | NOT NULL, default empty | Message id or file:line |
| `signal` | TEXT | NOT NULL, default empty | Triggering text excerpt |
| `dedupe_key` | TEXT | NOT NULL, UNIQUE | SHA-1 normalised title key |
| `status` | TEXT | NOT NULL, default `candidate` | candidate/accepted/dismissed in app logic |
| `created_at` | TEXT | default current timestamp | Created |

Dismissed candidates remain to suppress repeated suggestions.

---

## 13. `knowledge_items`

Purpose: canonical runtime Planner knowledge in the public app database.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Item id |
| `type` | TEXT | NOT NULL | goal/project/decision/etc. in app logic |
| `title` | TEXT | NOT NULL | Item title |
| `body` | TEXT | NOT NULL | Detail/content |
| `source` | TEXT | NOT NULL | Provenance |
| `status` | TEXT | NOT NULL, default `pending review` | Lifecycle state |
| `confidence` | REAL | NOT NULL, default `0.5` | Confidence score |
| `last_reviewed` | TEXT | nullable | Last review date |
| `evidence` | TEXT | nullable | Evidence/provenance |
| `owner` | TEXT | NOT NULL, default `user` | User/app/other |
| `next_action` | TEXT | nullable | Next action |
| `project_id` | INTEGER | nullable FK | Related project |
| `due_at` | TEXT | nullable | Due date/time text |
| `created_at` | TEXT | default current timestamp | Created |
| `updated_at` | TEXT | default current timestamp | Updated |

Foreign key:

```sql
project_id REFERENCES projects(id) ON DELETE SET NULL
```

There are no database CHECK constraints for type, status, confidence range, or date format. Different routes enforce different allowed state lists, so invalid imported or legacy values can exist.

The public SQLite database is the runnable app's canonical store; it is not automatically promoted into the private brain/source-of-truth repository.

---

## 14. `memory_candidates`

Purpose: reviewable chat or consultation statements before knowledge promotion.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Candidate id |
| `session_id` | INTEGER | nullable FK, SET NULL | Source session |
| `source_message_id` | INTEGER | nullable FK, SET NULL | Source message |
| `type` | TEXT | NOT NULL | Proposed knowledge type |
| `title` | TEXT | NOT NULL | Candidate title |
| `body` | TEXT | NOT NULL | Candidate content |
| `source` | TEXT | NOT NULL | chat/cloud consultation/etc. |
| `evidence` | TEXT | nullable | Provenance |
| `confidence` | REAL | NOT NULL, default `0.45` | Candidate confidence |
| `status` | TEXT | NOT NULL, default `candidate` | candidate/deferred/approved/denied in app logic |
| `created_at` | TEXT | default current timestamp | Created |
| `reviewed_at` | TEXT | nullable | Decision time |

Source relationships survive transcript/session deletion as nullable provenance references.

Approval inserts a new `knowledge_items` row; there is no direct foreign key from the approved knowledge item back to the candidate.

---

## 15. `approvals`

Purpose: governed proposal queue.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Approval id |
| `action_type` | TEXT | NOT NULL | Application-dispatched operation |
| `title` | TEXT | NOT NULL | Review title |
| `payload` | TEXT | NOT NULL | JSON operation payload |
| `status` | TEXT | NOT NULL, default `pending` | pending/approved/denied/deferred in app logic |
| `priority` | TEXT | NOT NULL, default `P2` | Priority label |
| `created_at` | TEXT | default current timestamp | Created |
| `decided_at` | TEXT | nullable | Decision time |

Implemented application action types:

```text
create_project
update_project
add_memory
update_memory
repo_write
```

No database constraint validates action type, payload JSON shape, target existence, or status. Approval application parses payload at decision time and performs optimistic stale checks for selected actions.

Because repository writes and database status updates are separate operations, an error after filesystem mutation but before approval status update can leave a partially applied proposal.

---

## 16. `consultations`

Purpose: local record of external/browser consultation lifecycle.

| Column | Type | Rules / default | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | Consultation id |
| `title` | TEXT | NOT NULL | Title |
| `local_draft` | TEXT | NOT NULL | User's original draft/question |
| `target_agent` | TEXT | NOT NULL, default `manual browser` | Intended cloud agent |
| `prompt` | TEXT | nullable | Prepared/sent prompt |
| `opened_url` | TEXT | nullable | Browser URL |
| `opened_title` | TEXT | nullable | Browser title/mode label |
| `sent_at` | TEXT | nullable | Send/open time |
| `captured_at` | TEXT | nullable | Response capture time |
| `external_response` | TEXT | nullable | Captured/pasted answer |
| `status` | TEXT | NOT NULL, default `draft` | draft/sent/captured in app logic |
| `created_at` | TEXT | default current timestamp | Created |
| `updated_at` | TEXT | default current timestamp | Updated |

The first transition from no response to an external response creates a low-confidence `memory_candidates` row through route logic. Repeated patches do not create another candidate once `external_response` was already present.

Consultation text can contain sensitive user context. The schema stores it unencrypted in the local SQLite database.

---

## 17. Seed lifecycle

### Core seed in `db.js`

Runs only when `projects` count is zero.

Creates:

- `Life Planner MVP` project;
- `Personal Admin` project;
- five knowledge items covering MVP goal, browser setup blocker, candidate-memory review, cloud-agent advisory rule, and stale-context review.

Consequences:

- importing/deleting projects until the table is empty causes the seed to return on next startup;
- the knowledge seed is tied to project emptiness, not knowledge-table emptiness;
- an empty knowledge table with existing projects will not be reseeded;
- custom first-run data should account for these conditions.

### Chat seed in `db.js`

When `chat_sessions` is empty:

- creates pinned `Life Planner kickoff` session;
- inserts one assistant governance message.

### Roadmap seed in `server/index.js`

When `roadmap_items` is empty, inserts current build-state items. This seed is outside `migrate()` and uses different ownership/update logic.

---

## 18. Indexes and query patterns

Explicit indexes beyond primary keys and unique constraints are absent.

Existing unique indexes implied by schema:

```text
settings.key
model_registry.path
chat_context_files(session_id, path)
roadmap_candidates.dedupe_key
```

Common unindexed filters/orderings include:

- chat messages by `session_id, created_at, id`;
- memory candidates by `status, created_at`;
- approvals by `status, created_at`;
- knowledge items by status, due/review/update fields;
- projects by `updated_at`;
- consultations by `updated_at`;
- roadmap by `sort_order`;
- model assignment by `assigned_role, updated_at`.

The local MVP may remain small, but query-plan/index review is required before larger histories or frequent scans.

---

## 19. Backup, export, and sensitive data

The SQLite database contains:

- chat transcripts;
- external consultation prompts/responses;
- memory candidates and approved knowledge;
- project/planner state;
- model paths;
- local settings and tokens.

Normal JSON backup export redacts known secrets unless `includeSecrets=1` is explicitly supplied with backup mode. The raw SQLite database always contains the stored secret values.

WAL databases should be backed up through a SQLite-aware method or while cleanly closed/checkpointed; blindly copying only the main `.sqlite` file during active writes can omit WAL content.

---

## 20. Schema verification recipe

Use an isolated file:

```powershell
$env:LIFE_PLANNER_DB = Join-Path $PWD 'data/schema-verification.sqlite'
Remove-Item $env:LIFE_PLANNER_DB -Force -ErrorAction SilentlyContinue
node server/index.js
```

Then inspect through SQLite tooling or a small `node:sqlite` script:

```sql
PRAGMA journal_mode;
PRAGMA foreign_keys;
SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name;
PRAGMA foreign_key_list(chat_messages);
PRAGMA foreign_key_list(chat_context_files);
PRAGMA foreign_key_list(knowledge_items);
PRAGMA foreign_key_list(memory_candidates);
```

Acceptance checks:

1. all 11 tables exist;
2. WAL and foreign keys are enabled;
3. additive columns exist;
4. first-run seeds occur only under their documented conditions;
5. cascade/set-null behaviour works;
6. rerunning migration is idempotent;
7. custom `LIFE_PLANNER_DB` path is actually used;
8. health endpoint path mismatch is recorded until fixed;
9. malformed/legacy setting JSON follows documented fallback;
10. backup procedure accounts for WAL.

---

## 21. Recommended migration improvements

1. Export `dbPath` and use it everywhere, including health/status.
2. Create the effective database parent directory.
3. Add a `schema_migrations` table with ordered versions.
4. Catch only duplicate-column migration errors; surface all others.
5. Add schema checks for enumerated roles/statuses where stable.
6. Add confidence range checks (`0..1`) where appropriate.
7. Add indexes based on measured query patterns.
8. Wrap multi-row database mutations in transactions.
9. Design explicit recovery/compensation for approval workflows that also mutate files.
10. Add a SQLite-consistent backup/checkpoint command.
11. Separate seed data from migration code and make reseed intent explicit.
12. Add automated migration tests from older fixture databases.

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_SETTINGS_AND_SECRET_REGISTRY.md
docs/cookbook/codebase/PUBLIC_APP_EXPRESS_ENDPOINT_CATALOGUE.md
docs/cookbook/codebase/PUBLIC_APP_BACKEND_HELPER_AND_PROCESS_MAP.md
```