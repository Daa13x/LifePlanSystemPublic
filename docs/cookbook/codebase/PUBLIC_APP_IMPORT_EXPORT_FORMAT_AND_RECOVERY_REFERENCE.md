# LifePlanSystemPublic Import, Export, and Recovery Reference

Status: complete source-level reference for JSON/Markdown exports, JSON preview/import, Markdown import, secret handling, round-trip limits, and recovery risks; runtime verification remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/index.js  1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
src/main.jsx     4592881c34af44848dfc72e74895face6098a1da
server/db.js     46f761bad8f03592bda1915f1b4fca04f9ccc4bc
```

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_DATABASE_SCHEMA_AND_MIGRATION_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_SETTINGS_AND_SECRET_REGISTRY.md
docs/cookbook/codebase/PUBLIC_APP_MEMORY_APPROVAL_AND_PROJECT_GOVERNANCE_REFERENCE.md
```

---

## 1. Canonical-storage rule

The UI states:

```text
Files are exchange formats. The SQLite database remains canonical.
```

The maintained exchange routes are:

```text
GET  /api/export/json?mode=public
GET  /api/export/json?mode=backup
GET  /api/export/markdown
POST /api/import/json/preview
POST /api/import/json?mode=skip_duplicates
POST /api/import/json?mode=import_all
POST /api/import/markdown
```

Exports are generated on demand from the current database. They are not scheduled backups, snapshots of WAL state, encrypted archives, or versioned migration bundles.

---

## 2. Export matrix

| Format | Main contents | Intended label | Restorable by current importer |
|---|---|---|---|
| Public JSON | all projects; active/stable knowledge items | shareable subset | partially |
| Backup JSON | projects, all knowledge items, memory candidates, non-deleted sessions, all chat messages, consultations, settings | local backup | only projects and knowledge items |
| Markdown | every knowledge item | readable export | imported only as one pending source document |

The phrase `backup` does not mean full application recovery in the current implementation.

---

## 3. Public JSON export

Route:

```text
GET /api/export/json?mode=public
```

Filename:

```text
life-planner-public-export.json
```

Shape:

```json
{
  "exported_at": "ISO timestamp",
  "mode": "public",
  "projects": [],
  "knowledge_items": []
}
```

Selection rules:

- every row from `projects` is included;
- only `knowledge_items` with status `active` or `stable` are included;
- settings, chat, candidates, consultations, approvals, roadmap data, and models are omitted.

### Public-export privacy limitation

`public` is a status-based subset, not a privacy classifier.

The route does not:

- remove personal project names, evidence, owners, or next actions;
- inspect content for therapy/health, credentials, identifiers, or private-memory markers;
- apply an explicit shareable flag;
- enforce the private/public repository boundary;
- require preview or confirmation.

All projects are exported regardless of status or sensitivity. Active/stable knowledge may still be highly private.

The file must be manually reviewed before sharing.

---

## 4. Backup JSON export

Route:

```text
GET /api/export/json?mode=backup
```

Filename:

```text
life-planner-backup-export.json
```

Included sections:

```text
exported_at
mode
projects
knowledge_items
memory_candidates
chat_sessions (deleted=0 only)
chat_messages
consultations
settings
```

### Secret behavior

Default backup:

```text
GET /api/export/json?mode=backup
```

redacts `hfToken` and `githubToken` as `[redacted]` when present.

A direct caller can request:

```text
GET /api/export/json?mode=backup&includeSecrets=1
```

That returns unredacted setting values, including stored tokens.

The UI does not expose the `includeSecrets=1` link, but the backend route accepts it without an additional confirmation, password, capability token, or export audit record.

### Not included in the backup

The backup omits at least:

```text
approvals
roadmap_items
roadmap_candidates
model_registry
chat_context_files
deleted chat session rows
SQLite metadata/WAL state
browser profiles and cookies
Chrome extension registration
model files
OpenHands requests/reports/patches/worktrees
installer artifacts
Git state and repository files
```

It therefore cannot reconstruct the entire application state.

### Referential-consistency limitation

`chat_messages` includes every message row, while `chat_sessions` excludes soft-deleted sessions. Messages belonging to a deleted session can appear without their parent session in the same export.

The export is assembled with separate SELECT statements and no explicit read transaction. Concurrent writes can produce a cross-table snapshot from slightly different moments.

---

## 5. Markdown export

Route:

```text
GET /api/export/markdown
```

Filename:

```text
life-planner-export.md
```

It exports every knowledge item ordered by type/title, including:

```text
title
type
status
confidence
source
body
next action
```

### Markdown-export privacy limitation

Unlike public JSON, Markdown export does not filter by status.

It can include:

- pending-review content;
- stale, archived, deprecated, or superseded information;
- imported source documents;
- private or sensitive evidence embedded in body text;
- cloud-consultation-derived content after promotion.

No redaction, content classification, preview, or confirmation is applied.

This route should be treated as a private full-readable memory dump, not a public export.

### Format limitations

- project association is not rendered;
- evidence, owner, review date, due date, and item ID are omitted;
- headings/body content are not escaped against Markdown structure;
- no schema/version marker exists;
- the output is not round-trip compatible with the JSON importer.

---

## 6. JSON preview

Route:

```text
POST /api/import/json/preview
```

The frontend parses JSON before calling the route. Other local callers can send any valid JSON body.

Preview reads only:

```text
projects
knowledge_items
```

It returns:

```text
projects
knowledge_items
duplicate_projects
duplicate_knowledge_items
ignored_sections
```

Duplicate rules:

- project duplicate: exact existing `projects.name` equality;
- knowledge duplicate: exact existing `knowledge_items.title` equality.

### Preview limitations

- comparisons are case-sensitive and whitespace-sensitive;
- body, type, project relationship, evidence, or source are not compared;
- duplicate rows inside the incoming file are not deduplicated against one another before import;
- preview does not validate required fields, data types, statuses, confidence range, or field lengths;
- ignored backup sections are counted only as ignored names; their contents are not validated;
- preview results are not bound to the later import payload, so the text can change after preview.

The frontend enables Import after any successful preview but does not cryptographically or structurally pin the previewed payload.

---

## 7. JSON import

Route:

```text
POST /api/import/json
```

Accepted mode:

```text
skip_duplicates  default
import_all        query or body mode
```

The request must contain a `projects` array, a `knowledge_items` array, or both.

### Project mapping

Imported project fields:

```text
name
status                 default active
owner                  default user
confidence             default 0.6
last_reviewed
evidence
next_action
```

Forced field:

```text
source = json import
```

Not imported:

```text
id
created_at
updated_at
```

### Knowledge-item mapping

Imported fields:

```text
type                   default current state
title                  default Imported item
body
status                 default pending review
confidence             default 0.5
last_reviewed
evidence
owner                   default user
next_action
```

Forced field:

```text
source = json import
```

Not imported:

```text
id
project_id
due_at
created_at
updated_at
```

Project-to-item relationships are therefore lost.

### Governance limitation

The importer accepts the incoming `status` directly. An import can create `active` or `stable` knowledge without candidate review or approval.

It also accepts arbitrary type/status strings because the database has no check constraints and the import route does not use the direct-item allowlists.

### Validation and transaction limitations

- The import is not wrapped in a transaction.
- A failure after earlier inserts leaves a partial import.
- Project names are not validated before insertion; a missing/null name can fail mid-import.
- Confidence is not clamped or type-checked.
- `value || default` means valid zero confidence is replaced by the default.
- Field lengths and content size are not bounded below the global JSON-body limit.
- `import_all` can create unrestricted duplicates.
- Duplicate checks query the current database row by row and are not protected by uniqueness constraints.
- Backup-only sections such as chat, candidates, consultations, and settings are silently ignored by the importer.

---

## 8. Markdown import

Route:

```text
POST /api/import/markdown
```

Input:

```json
{"markdown":"# Source document\n..."}
```

The first Markdown H1 becomes the item title. Without an H1, the title is:

```text
Imported markdown document
```

The route creates one `knowledge_items` row:

```text
type        source document
source      markdown import
status      pending review
confidence  0.5
evidence    Imported markdown text
owner       user
next_action Review and extract durable knowledge.
body        complete Markdown text
```

### Markdown-import limitations

- `source document` is not one of the direct item API's recognized item types, though SQLite accepts it.
- The entire document becomes one row; sections are not parsed into candidates or structured facts.
- No duplicate detection exists.
- No file/source provenance beyond the generic import label exists.
- No explicit size limit exists beyond the server's 25 MiB JSON-body limit.
- Imported Markdown can contain untrusted links, HTML, prompts, or sensitive text; it is stored without sanitization/content classification.

It is correctly held at `pending review`, but it is still immediately present in the canonical knowledge table.

---

## 9. Round-trip reality

### Public JSON

Can be re-imported for projects and knowledge items, but:

- IDs/timestamps change;
- project relationships and due dates are lost;
- sources become `json import`;
- duplicate behavior depends only on exact name/title.

### Backup JSON

Only projects and knowledge items are restored by the current importer.

These exported sections are ignored on re-import:

```text
memory_candidates
chat_sessions
chat_messages
consultations
settings
```

The current “backup” is therefore an archival data dump with partial import support, not disaster-recovery automation.

### Markdown

Re-importing the Markdown export creates one pending source-document item containing the whole export, not the original rows.

---

## 10. Recovery hierarchy

For actual local recovery, prefer:

1. stop the app cleanly;
2. back up the SQLite database together with its WAL/SHM files, or use a SQLite-safe backup method;
3. preserve the runnable repository and configuration separately;
4. preserve model files/browser profiles/OpenHands artifacts only when intentionally required;
5. use JSON exports as inspectable secondary archives, not the only backup.

A complete recovery recipe must account for data outside SQLite.

---

## 11. Security findings

1. Any local process able to call the localhost API can download exports.
2. `includeSecrets=1` discloses raw stored tokens without a second confirmation.
3. Public JSON is not truly privacy-filtered; all projects are included.
4. Markdown export is an unredacted dump of every knowledge item.
5. Backup JSON is incomplete and not round-trip restorable.
6. Imports can bypass memory review by supplying active/stable statuses.
7. Imports are non-transactional and can partially apply.
8. No schema version, checksum, signature, encryption, or provenance binding exists.
9. Preview is advisory and not bound to the imported payload.
10. Import/export actions are not recorded in an audit table.

---

## 12. Verification recipe

Use a disposable database.

1. Create representative projects, linked knowledge items, candidates, chat sessions, consultations, approvals, roadmap items, settings, and a model registry row.
2. Export public JSON and verify only active/stable knowledge appears, while noting that all projects appear.
3. Export backup JSON and enumerate included/omitted tables.
4. Verify normal backup redacts tokens.
5. Test `includeSecrets=1` only with disposable fake tokens and confirm the exposure.
6. Export Markdown and verify archived/pending/sensitive test rows appear.
7. Preview JSON containing exact, case-varied, whitespace-varied, and internal duplicates.
8. Import with `skip_duplicates`; verify exact-name/title behavior.
9. Import with `import_all`; verify duplicates are created.
10. Import a deliberately invalid row after a valid row and confirm whether partial application occurs.
11. Import active/stable knowledge and verify it bypasses review.
12. Import exported backup JSON and prove which sections are ignored.
13. Import Markdown and verify one pending `source document` row is created.
14. Restart the server and verify imported rows persist.
15. Restore from a SQLite-safe backup and compare with JSON-based recovery.

Do not mark Import/Export `RUNTIME VERIFIED` or call the JSON file a complete backup until these results are recorded and the documented gaps are either accepted or fixed.