# LifePlanSystemPublic Express Endpoint Catalogue

Status: complete source-level catalogue of Express routes in `server/index.js`; runtime verification remains separate.

Last updated: 2026-07-16

Source snapshot:

```text
Repository: Daa13x/LifePlanSystemPublic
File: server/index.js
Blob SHA: 1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
Registered /api method+path pairs: 125
Additional serving behaviour: dist static middleware, GET * SPA fallback, final JSON error handler
```

This catalogue includes UI-facing, backend-only, browser-extension, tooling, source-control, import/export, health, and process-control routes. Presence in source does not prove successful runtime behaviour.

---

## 1. Server-wide contracts

### Bind and body limits

- Binds to `127.0.0.1` only.
- Port is `LIFE_PLANNER_PORT`, default `4177`.
- JSON body limit is `25mb`.
- The server starts from `process.cwd()`, which is the repository/runtime root used by filesystem and subprocess helpers.

### Standard JSON response

Most API routes return:

```json
{"ok": true, "data": {}}
```

Failures normally return:

```json
{"ok": false, "error": "message"}
```

Export routes return raw JSON or Markdown attachments rather than the standard envelope.

### Error handling

The final Express error handler converts malformed JSON and synchronous middleware errors into JSON. Process-level `unhandledRejection` and `uncaughtException` handlers log errors and keep the local process alive; they are a safety net, not request recovery.

### Effect classes

- **Read** — database, filesystem, status, or external-service lookup.
- **Direct local mutation** — user-authoritative SQLite or local setting change.
- **Governed mutation** — proposal/approval lifecycle applies changes after review.
- **Process control** — starts/stops a local subprocess or container.
- **Filesystem/Git mutation** — changes files, branches, index, worktrees, tags, or remotes.
- **External egress** — sends selected content or requests to an external service/browser.

---

## 2. Health and bootstrap

| Method | Route | Purpose | Effect |
|---|---|---|---|
| GET | `/api/health` | Confirm server/database readiness and report SQLite path | Read |
| GET | `/api/bootstrap` | Return redacted settings, aggregated Planner state, chat sessions, projects, and models | Read |

`/api/bootstrap` does not include full memory data; the frontend separately calls `/api/memory`.

---

## 3. Development Roadmap

| Method | Route | Inputs / behaviour | Effect |
|---|---|---|---|
| GET | `/api/roadmap` | List roadmap items by `sort_order`, then id | Read |
| POST | `/api/roadmap` | Requires `title`; validates status/category; appends item | Direct local mutation |
| PATCH | `/api/roadmap/:id` | Updates title, detail, resume notes, category, status, or sort order | Direct local mutation |
| POST | `/api/roadmap/:id/move` | `direction=up|down`; swaps sort order in explicit transaction | Direct local mutation |
| DELETE | `/api/roadmap/:id` | Deletes one roadmap item | Direct local mutation |
| GET | `/api/roadmap/candidates` | Lists candidates with status `candidate` | Read |
| POST | `/api/roadmap/scan` | Scans chat and selected code/docs for dev-only task signals | Scanner/database mutation |
| POST | `/api/roadmap/candidates/:id/accept` | Converts candidate into a planned roadmap item | Reviewed mutation |
| POST | `/api/roadmap/candidates/:id/dismiss` | Marks candidate dismissed so it is not re-staged | Reviewed mutation |

The scanner also runs after startup and every fifteen minutes. Dedupe prevents accepted/dismissed items from repeatedly returning.

---

## 4. Planner, chat, and attached context

| Method | Route | Inputs / behaviour | Effect |
|---|---|---|---|
| GET | `/api/planner` | Returns aggregated focus, blockers, waiting, automatic, stale, approvals, candidates, and next best item | Read |
| POST | `/api/planner/refresh` | Re-checks browser setup and may stage an approval to retire the resolved browser blocker | Governed proposal creation |
| GET | `/api/chat/sessions` | Lists non-deleted sessions | Read; backend-only relative to current bootstrap UI |
| POST | `/api/chat/sessions` | Creates a persistent session | Direct local mutation |
| PATCH | `/api/chat/sessions/:id` | Supports only `title`, `pinned`, and `deleted` | Direct local mutation |
| GET | `/api/chat/sessions/:id/messages` | Lists messages in chronological order | Read |
| POST | `/api/chat/sessions/:id/messages` | Saves user message, optionally creates memory candidate, runs local model/fallback, saves assistant reply | Database plus model execution |
| GET | `/api/chat/sessions/:id/context` | Lists attached repository paths | Read |
| POST | `/api/chat/sessions/:id/context` | Validates workspace-relative existing file and attaches path | Direct local mutation |
| DELETE | `/api/chat/sessions/:id/context/:contextId` | Removes an attached context record | Direct local mutation |

Chat context reads are bounded and workspace-confined. Chat content never becomes approved memory automatically; sufficiently long messages become review candidates.

---

## 5. Memory, approvals, projects, and Planner items

### Memory candidates

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/memory` | Returns all candidates and all knowledge items with project name | Read |
| PATCH | `/api/memory/candidates/:id` | Edits candidate metadata only while status is `candidate` or `deferred` | Direct candidate mutation |
| POST | `/api/memory/candidates/:id/:decision` | Decision must be `approve`, `deny`, or `defer`; approve inserts a knowledge item | Reviewed/governed mutation |

### Approval queue

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| POST | `/api/approvals` | Requires `action_type`, `title`, and `payload`; stores pending proposal | Proposal creation |
| POST | `/api/approvals/:id/revalidate` | Re-checks repo-write or project-update stale state | Validation/read |
| POST | `/api/approvals/:id/:decision` | Approve, deny, or defer; approved actions are applied by action type | Governed mutation |

Implemented approval action types:

- `create_project`
- `update_project`
- `add_memory`
- `update_memory`
- `repo_write`

Repository, project, and memory approvals use optimistic stale checks where prior values/content were captured. Repository writes refuse protected paths and support create, update, delete, and rename.

### Projects and direct Planner items

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/projects` | Lists all projects | Read; backend-only relative to current bootstrap UI |
| POST | `/api/projects` | Direct manual project creation | Direct local mutation; not used by current React Projects panel |
| GET | `/api/items` | Lists active items; `?all=1` includes archived/deprecated/superseded | Read; backend-only relative to current UI |
| POST | `/api/items` | Creates a user-authored knowledge/Planner item | Direct local mutation |
| PATCH | `/api/items/:id` | Updates recognised fields and optional reviewed date | Direct local mutation |

Direct item routes treat the human user as the authority. Agent-proposed changes are expected to use approvals.

---

## 6. Models, hardware, Hugging Face, and settings

### Model registry and runtime

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/models` | Lists model registry rows enriched with on-disk existence | Read; backend-only relative to bootstrap |
| DELETE | `/api/models/:id` | Default deletes GGUF file but keeps re-download metadata; `purge=true` removes row | Filesystem/database mutation |
| POST | `/api/models/:id/download` | Re-downloads using stored HF repo/file metadata | External download/filesystem mutation |
| POST | `/api/models/:id/assign` | Assigns one model to a role after checking file exists | Direct local mutation |
| POST | `/api/models/scan` | Recursively scans configured folders for `.gguf` files | Filesystem read/database mutation |
| GET | `/api/models/runtime` | Reports assignment, endpoint, CLI/server paths, and managed server state | Read/process status |
| POST | `/api/models/server/start` | Starts configured `llama-server` bound to `127.0.0.1`; persists endpoint settings | Process control/settings mutation |
| POST | `/api/models/server/stop` | Stops only the in-memory managed llama-server child | Process control |
| GET | `/api/hardware` | Reads CPU/RAM and probes NVIDIA/Windows GPU information | Read/subprocess probing |

### Hugging Face

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/hf/files` | Lists GGUF files from one HF model repo, ranked by quantisation preference | External read |
| GET | `/api/hf/search` | Searches models and filters for GGUF signals | External read |
| POST | `/api/hf/download` | Streams selected HF file to configured folder and records origin | External download/filesystem/database mutation |

The HF token is optional for public repos and read only on the server.

### Settings

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/settings` | Returns all settings with `hfToken` and `githubToken` redacted | Read |
| POST | `/api/settings` | Stores supplied key/value pairs; ignores echoed `[redacted]` placeholders | Direct local mutation |

Dedicated GitHub token endpoints are documented under Source Control. The generic settings route can store arbitrary keys, so the settings registry remains a separate required reference.

---

## 7. Consultations and browser automation

### Consultation records

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/consultations` | Lists consultations newest first | Read |
| POST | `/api/consultations` | Requires local draft; stores prompt/target/open metadata | Direct local mutation |
| PATCH | `/api/consultations/:id` | Updates response/status/open metadata; first external response creates a low-confidence candidate | Database/candidate mutation |

No consultation response is promoted directly to approved memory.

### Browser and cloud consultation

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/browser/capabilities` | Reports Playwright/Chromium and external-browser support | Read |
| POST | `/api/browser/open` | Opens URL in real debug Chrome when possible, otherwise controlled profile; reports challenge state | Process/browser control |
| POST | `/api/browser/consult` | Builds bounded context prompt; requires Temporary Chat confirmation for ChatGPT; uses connector or debug Chrome | External egress/browser automation |
| GET | `/api/browser/agent-tabs` | Reports cloud-agent tabs from fresh extension heartbeat or CDP fallback | Read |
| POST | `/api/browser/assist-prompt` | Uses local model to rewrite a browser-agent question | Local model execution |
| POST | `/api/browser/reset-profile` | Deletes only app-owned `data/browser-profile` after confinement check | Destructive local filesystem mutation |
| POST | `/api/browser/copy-prompt` | Copies prompt through platform clipboard command | Local process/clipboard mutation |
| POST | `/api/browser/open-external` | Optionally copies prompt and opens default browser | Process/browser control |
| POST | `/api/browser/open-chrome` | Optionally copies prompt and opens installed Chrome profile | Process/browser control |

Cloud-context limits:

- at most eight paths;
- at most 8,000 characters per file;
- at most 24,000 characters total;
- protected/private paths rejected;
- response remains advisory until explicitly saved and reviewed.

### Chrome extension protocol

| Method | Route | Caller | Behaviour |
|---|---|---|---|
| GET | `/api/browser/extension/install-info` | UI/tooling | Reports unpacked extension path and instructions |
| POST | `/api/browser/extension/install-helper` | UI/tooling | Copies extension path and opens `chrome://extensions` |
| POST | `/api/browser/extension/heartbeat` | Extension | Refreshes connector timestamp and up to 100 tab summaries |
| GET | `/api/browser/extension/next` | Extension | Claims oldest pending in-memory job |
| POST | `/api/browser/extension/jobs/:id` | Extension | Updates job status/result/error |

Connector jobs are in-memory only. A server restart loses queued/completed job state. Freshness is fifteen seconds; consultation waits up to four minutes for a terminal result.

---

## 8. General Tooling

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/tooling/status` | Probes Node, npm, Playwright, Chromium, GitHub CLI, HF CLI, and winget | Read/subprocess probing |
| POST | `/api/tooling/install` | Allowlisted values: `playwright`, `playwrightChromium` | Package installation/process mutation |

No arbitrary installer command is accepted from the request.

---

## 9. OpenHands and Ollama tooling

### Status and container control

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/tooling/openhands/status` | Probes Docker, known container, and HTTP endpoint | Read/subprocess probing |
| POST | `/api/tooling/openhands/start` | Runs fixed `docker start openhands-app` | Process control |
| POST | `/api/tooling/openhands/stop` | Runs fixed `docker stop openhands-app` | Process control |
| GET | `/api/tooling/ollama/status` | Probes local Ollama version endpoint | Read |
| GET | `/api/tooling/ollama/model-status` | Lists Ollama models and checks fixed coder model | Read |

### Request and validation lifecycle

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/tooling/openhands/requests` | Lists JSON requests under `.lps/tooling/openhands/requests` | Filesystem read |
| POST | `/api/tooling/openhands/requests` | Validates scope/secrets/base branch; writes pending request JSON | Filesystem mutation |
| POST | `/api/tooling/openhands/requests/:id/approve` | Records first human approval and pins base branch | Reviewed filesystem mutation |
| POST | `/api/tooling/openhands/requests/:id/run` | Runs only allowlisted validation; writes report; never edits/commits/pushes | Gated subprocess/report mutation |
| GET | `/api/tooling/openhands/requests/:id/report` | Returns confined Markdown report | Filesystem read |
| POST | `/api/tooling/openhands/requests/:id/confirm-execution` | Records second human confirmation and branch pin | Reviewed filesystem mutation |
| POST | `/api/tooling/openhands/requests/:id/execution-plan` | Evaluates gates and writes dry-run plan | Gated read/report mutation |
| POST | `/api/tooling/openhands/requests/:id/execute` | Creates isolated worktree, checks readiness/enforcement, captures patch, runs allowlisted validation | High-risk gated Git/filesystem/process workflow |

Critical current state:

```text
OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false
```

The executor harness can create a worktree and report/patch artifacts, but real OpenHands code generation is deliberately unreachable. It never commits, pushes, merges, force-pushes, resets hard, or deletes the execution branch. A worktree with a real diff is preserved for human review.

---

## 10. Source Control

### Status, diffs, history, and installer

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/source/status` | Git snapshot, remotes, user, CLI auth, install hints | Read/subprocess probing |
| GET | `/api/source/diff` | Returns diff stat and truncated aggregate text diff | Read |
| GET | `/api/source/file-diff` | Returns HEAD/current text sides; refuses protected, binary, or oversized content | Read |
| GET | `/api/source/history` | Returns up to forty commits | Read |
| GET | `/api/source/build-installer` | Returns in-memory installer build state and artifacts | Read/process status |
| POST | `/api/source/build-installer` | Starts one non-blocking PowerShell installer build | Process control |

Installer build output is retained in memory up to 120,000 characters. Restarting the server loses build status, though artifacts remain on disk.

### Stage, discard, and commit

| Method | Route | Gate / behaviour | Effect |
|---|---|---|---|
| POST | `/api/source/stage-all` | Refuses conflicts and any changed protected file | Git index mutation |
| POST | `/api/source/stage-file` | Confined path; protected files refused | Git index mutation |
| POST | `/api/source/unstage-file` | Confined path | Git index mutation |
| POST | `/api/source/unstage-all` | Restores index for all paths | Git index mutation |
| POST | `/api/source/discard-file` | Tracked, non-protected file only | Destructive worktree mutation |
| POST | `/api/source/discard-all` | Requires `confirm=true`; refuses conflicts; leaves untracked files | Destructive worktree mutation |
| POST | `/api/source/commit` | Requires message, staged file, no conflicts/protected staged files | Git commit mutation |

### Branch and synchronization

| Method | Route | Gate / behaviour | Effect |
|---|---|---|---|
| GET | `/api/source/branches` | Lists local and remote branches | Read |
| POST | `/api/source/branch` | Creates and switches to validated branch name | Git branch/worktree mutation |
| POST | `/api/source/checkout` | Refuses conflicts and dirty switch unless `allowDirty` | Git worktree mutation |
| POST | `/api/source/delete-branch` | Refuses main/master/current; optional force delete | Destructive Git mutation |
| POST | `/api/source/fetch` | Fetches all remotes with prune | Network/Git mutation |
| POST | `/api/source/pull` | Current branch, `--ff-only`, origin only | Network/Git mutation |
| POST | `/api/source/rebase` | Pull/rebase current branch from origin | Network/Git mutation |
| POST | `/api/source/merge` | Validated other branch; returns conflicts when present | Git mutation |
| POST | `/api/source/abort-merge` | Attempts merge abort, then rebase abort | Git mutation |
| POST | `/api/source/resolve` | `ours`, `theirs`, or `mark`; stages resolved file | Git worktree/index mutation |
| POST | `/api/source/push` | Requires `confirm=true`; refuses force and main/master; origin/current branch only | External publication |

### Remotes, authentication, and repository creation

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| POST | `/api/source/remote` | Adds or updates validated remote, default `origin` | Git config mutation |
| POST | `/api/source/login/github` | Starts `gh auth login -w` | External interactive process |
| POST | `/api/source/login/hf` | Starts `hf auth login` | External interactive process |
| POST | `/api/source/create/github` | Validates `owner/repo`, requires authenticated `gh` | External repository creation |
| POST | `/api/source/create/hf` | Validates `owner/repo`, type, authenticated `hf` | External repository creation |
| POST | `/api/source/token` | Validates PAT prefix and stores token in SQLite | Secret mutation |
| POST | `/api/source/token/clear` | Clears stored GitHub token | Secret mutation |

For HTTPS pushes, the stored token is inserted only into the one subprocess URL, scrubbed from returned errors, and never persisted into the Git remote.

### Stashes and tags

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/source/stash` | Lists stash refs/subjects | Read |
| POST | `/api/source/stash` | Saves tracked changes; optional untracked/message | Git mutation |
| POST | `/api/source/stash/apply` | Apply or pop by numeric index; returns conflicts | Git mutation |
| POST | `/api/source/stash/drop` | Drops stash by numeric index | Destructive Git mutation |
| GET | `/api/source/tags` | Lists lightweight/annotated tags | Read |
| POST | `/api/source/tags` | Creates validated tag, optional annotation/ref | Git mutation |
| POST | `/api/source/tags/delete` | Deletes local tag | Destructive Git mutation |
| POST | `/api/source/tags/push` | Requires `confirm=true`; publishes one tag | External publication |

---

## 11. Repository Explorer and governed writes

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/repo/files` | Lists up to 500 allowed Markdown/JSON/text/YAML files | Filesystem read |
| GET | `/api/repo/file` | Reads one confined, non-protected file | Filesystem read |
| POST | `/api/repo/proposals` | Stages a `repo_write` approval for create/update/delete/rename | Governed proposal creation |

The file listing blocks `.git`, `node_modules`, `dist`, and `data`; the read/write safety helper additionally blocks runtime data, secrets, databases, models, logs, release output, and `.lps`.

---

## 12. Import and export

| Method | Route | Behaviour | Effect |
|---|---|---|---|
| GET | `/api/export/json` | `mode=public|backup`; optional `includeSecrets=1` for explicit secrets backup | Attachment/read |
| GET | `/api/export/markdown` | Exports all knowledge items as Markdown | Attachment/read |
| POST | `/api/import/json/preview` | Counts supported arrays, duplicates, and ignored sections | Read |
| POST | `/api/import/json` | Imports projects/items; default skips title/name duplicates, `mode=import_all` permits them | Database mutation |
| POST | `/api/import/markdown` | Stores whole document as pending-review source document | Database mutation |

Security note: `/api/export/json?mode=backup&includeSecrets=1` deliberately emits stored secrets. It must remain an explicit local backup action and should never be exposed remotely.

---

## 13. Static serving and scheduled work

When `dist/` exists:

- `express.static(distDir)` serves built assets.
- `GET *` returns `dist/index.html` for SPA fallback.

After listen:

- a dev-task scan runs after 1.5 seconds;
- another scan runs every fifteen minutes with an unreferenced timer;
- server binds to `127.0.0.1` only.

---

## 14. Backend-only or non-React endpoints

These routes are not referenced by the current `src/main.jsx` map, or are primarily called by another client:

- `/api/health`
- `GET /api/chat/sessions`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/items`
- `GET /api/models`
- all `/api/browser/extension/*` heartbeat/job routes
- selected extension installation routes depending on current Tooling UI coverage
- the SPA wildcard

The distinction matters when deleting or changing routes: absence from React does not imply dead code.

---

## 15. Verification checklist

Source-level verification:

```powershell
node --check server/index.js
npm run build
```

Runtime route verification should use an isolated database and include:

1. `/api/health` and `/api/bootstrap` envelope checks.
2. malformed JSON returns JSON error rather than HTML.
3. protected-path refusals for repo, browser context, diffs, staging, and OpenHands.
4. approval stale checks for repo/project/memory.
5. source destructive operations require their documented gates.
6. push/tag publication cannot target main/master or use force.
7. extension heartbeat/job lifecycle and restart loss behaviour.
8. browser consultation does not save/promote automatically.
9. OpenHands real invocation remains disabled.
10. secret values are redacted from normal settings/bootstrap/export responses.

---

## 16. Known limitations and maintenance risks

- `server/index.js` combines routes, database logic, subprocess management, browser automation, import/export, Git operations, and OpenHands orchestration in one file.
- Many handlers perform synchronous SQLite/filesystem work directly on the request path.
- Route-specific schemas are handwritten; there is no shared validation library or generated OpenAPI contract.
- In-memory jobs/process status do not survive restart.
- The generic settings route accepts arbitrary keys.
- External endpoint/model requests have subsystem-specific timeouts but no central cancellation/retry policy.
- Process-level exception handlers keep the process alive but may leave subsystem state inconsistent.
- Runtime verification must remain separate from this source catalogue.

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_UI_ENDPOINT_CATALOGUE.md
docs/cookbook/codebase/PUBLIC_APP_BACKEND_HELPER_AND_PROCESS_MAP.md
docs/cookbook/codebase/PUBLIC_APP_FRONTEND_COMPONENT_AND_API_MAP.md
docs/cookbook/codebase/PUBLIC_APP_CORE_ANATOMY.md
```