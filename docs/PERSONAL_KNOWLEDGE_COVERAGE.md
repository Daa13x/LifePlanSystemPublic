# Personal knowledge coverage

This is a structural coverage record for the local-first Chat retrieval path. It intentionally contains no user record values.

## Eligibility contract

Chat searches current, provenance-bearing local records before model generation. A record is eligible only when it is current and either user-authored, explicitly reviewed into active Knowledge, or a current Workboard project. User-authored saved Chat is available as conversation history. Every result retains a stable source ID, source type, timestamp and provenance. Manual **Attach Knowledge** remains separate: it deliberately adds a selected record to one conversation; it is not required for automatic personal retrieval.

Pending, deferred, temporary, rejected, deleted, deprecated and superseded data is not a confirmed fact. Pending candidates are only included for an explicit pending/candidate/review question and remain labelled pending. Assistant messages, runtime settings, secrets, audit/log data, recovery metadata, and product-development roadmap records are never personal facts.

## Source matrix

| Category | Store / owner | Chat status | Canonicality, review and deletion | Provenance / paths |
| --- | --- | --- | --- | --- |
| Knowledge records (including Workboard tasks, goals, plans, decisions, blockers, terminology and imported extracted documents) | `knowledge_items` / Knowledge and Workboard | Connected | `active`, `stable`, `stale`, and `blocked` are current. `pending review`, archived, deprecated and superseded rows are excluded. Archive removes it from retrieval; a correction supersedes the old row. | `knowledge:<id>`, source, evidence, review/update times. DB is resolved from `LIFE_PLANNER_DB` or `data/life-planner.sqlite`. |
| Approved reviewed memory | promoted `knowledge_items` row / Memory review | Connected | Candidate approval creates an active canonical Knowledge row. | Original candidate evidence plus Knowledge ID. |
| Pending, deferred, temporary candidates | `memory_candidates` / Memory review | Intentionally excluded by default | Non-canonical; only shown for explicit review requests and never described as approved. | `candidate:<id>`, source message/evidence/time. |
| Rejected candidates | `memory_candidates` | Intentionally excluded | Denied/rejected rows are never retrieved. | Review status and timestamp. |
| Deleted / superseded memory | archived or superseded `knowledge_items`; `memory_revisions` | Intentionally excluded | Deletion archives a row; correction marks the previous row superseded. Revision history is audit-only. | IDs and review history retained outside the registry. |
| Projects | `projects` / Workboard | Connected | Current statuses only; completed and archived projects are excluded. | `project:<id>`, source, evidence, update time. |
| Workboard cards, tasks, subtasks, goals, plans and decisions | `knowledge_items` / Workboard | Connected when represented by current Knowledge rows | No separate task table exists. These types inherit Knowledge status and supersession rules. | Knowledge provenance and optional project ID. |
| Product roadmap | `roadmap_items`, `roadmap_candidates` / internal product roadmap | Intentionally excluded | May contain generated implementation material and is not a confirmed user-profile source. | Separate product-planning data; not registered. |
| Saved user Chat | `chat_sessions`, `chat_messages` / Chat | Connected | Only non-deleted sessions and `role='user'`; history is contextual, not automatically approved memory. | `chat:<id>`, conversation title and timestamp. |
| Assistant/system Chat | `chat_messages` | Intentionally excluded | Never treated as user facts. | Kept for display/audit only. |
| Manual Knowledge attachments | `chat_context_records` / Chat | Deliberate per-session context, not registry data | User selection controls attachment; referenced records keep their own lifecycle. | Kind, ref ID, label and provenance. |
| File attachments | `chat_context_files` / Chat | Paths intentionally excluded | Only paths are stored; there is no persisted extracted-text table to safely index. Imported/extracted document text saved as Knowledge is covered above. | Path and added time; no automatic file reads. |
| Settings and credentials | `settings` / Settings | Intentionally excluded | May hold runtime configuration; secret keys use protected storage. | Never registered or emitted by diagnostics. |
| Recovery backups, manifests and staging | backup/export and Setup & Recovery flows | Intentionally excluded | Recovery restores the database; it is not a separate knowledge source. Restored current rows appear after restart/refresh. | Backup metadata is not personal context. |
| Legacy imports | import JSON into `projects` and `knowledge_items` | Connected after import | Imported rows obey the same current-status rules; unsupported sections are ignored. | Source/evidence retained on created rows. |
| Consultations, approvals, audits, logs, model registry | dedicated tables/files | Intentionally excluded | May be assistant/external/generated/runtime material. | Not registered. |

## Data paths

Development resolves to `<repository>/data/life-planner.sqlite` unless `LIFE_PLANNER_DB` supplies an explicit path. The portable package deliberately ships without `app/data`; first run creates `<portable>/app/data/life-planner.sqlite`. The installed application follows the same application-root `data` resolution used by its launched server; it does not silently share the development database. Setup and Recovery imports/restores into the active database selected for that process. The portable builder removes databases, logs, models, environment files and pairing configuration from the package.

## Diagnostic and verification

`personalKnowledgeCoverage` is an internal, counts-only diagnostic used by the verifier. It reports resolved test paths, adapters, unavailable categories, safe counts, and registry totals; it does not expose an unauthenticated endpoint or record contents. `npm run verify:personal-knowledge-coverage` exercises the registry with disposable data and validates eligibility, provenance and path reporting.
