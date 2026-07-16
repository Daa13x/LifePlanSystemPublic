# LifePlanSystemPublic Chat and Local-Model Execution Reference

Status: complete source-level reference for chat persistence, context loading, memory-candidate extraction, local-model routing, model registry, and Hugging Face download paths; runtime verification remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/index.js  1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
server/db.js     46f761bad8f03592bda1915f1b4fca04f9ccc4bc
src/main.jsx     4592881c34af44848dfc72e74895face6098a1da
```

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_SETTINGS_AND_SECRET_REGISTRY.md
docs/cookbook/codebase/PUBLIC_APP_MEMORY_APPROVAL_AND_PROJECT_GOVERNANCE_REFERENCE.md
```

---

## 1. Persistent chat model

Chat uses three SQLite tables:

```text
chat_sessions
chat_messages
chat_context_files
```

Session deletion is soft deletion through `chat_sessions.deleted = 1`. Messages and attached context remain in SQLite unless the session row is physically removed by some future tool; current routes do not hard-delete sessions.

Primary routes:

```text
GET    /api/chat/sessions
POST   /api/chat/sessions
PATCH  /api/chat/sessions/:id
GET    /api/chat/sessions/:id/messages
POST   /api/chat/sessions/:id/messages
GET    /api/chat/sessions/:id/context
POST   /api/chat/sessions/:id/context
DELETE /api/chat/sessions/:id/context/:contextId
GET    /api/models/runtime
```

---

## 2. Session lifecycle

### Create

`POST /api/chat/sessions`

- accepts an optional trimmed title;
- defaults to `New session`;
- persists immediately.

### Update

`PATCH /api/chat/sessions/:id` accepts only:

```text
title
pinned
deleted
```

The handler dynamically builds SQL only from this fixed allowlist. Every accepted field is written separately and updates `updated_at`.

### Read ordering

Visible sessions are ordered:

```text
pinned descending
updated_at descending
```

### Validation gaps

- the update route does not first verify the session exists;
- title length and pinned/deleted value types are not validated;
- updating a nonexistent id returns a successful envelope with `data: null`.

---

## 3. Context attachment lifecycle

### Attach

`POST /api/chat/sessions/:id/context`

1. verifies the session exists and is not soft-deleted;
2. normalizes a workspace-relative path;
3. rejects absolute paths and `..` traversal;
4. requires an existing file;
5. inserts the path with a `(session_id, path)` uniqueness constraint.

### Remove

`DELETE /api/chat/sessions/:id/context/:contextId` removes the matching attachment row and returns the remaining list.

### Prompt loading

`readChatContextFiles()`:

- reads attached paths newest-first;
- ignores files that disappeared or became unreadable;
- sends at most 10,000 characters total;
- does not persist snapshots, so later file changes affect later prompts;
- does not tell the model which files were unreadable.

### Confirmed protected-path gap

The attach route and `readChatContextFiles()` use workspace confinement but do **not** call `isProtectedWorkspacePath()`.

That differs from:

- repository preview;
- repository write proposals;
- source-control file diff;
- cloud-consultation context selection.

A caller that bypasses the UI can therefore attach files under protected runtime paths such as `data/`, `.lps/`, `.env`, databases, logs, or model files when readable as text. The context is sent to the configured local model or local endpoint. This must be fixed before treating the route as a strict privacy boundary.

---

## 4. Message-send transaction shape

`POST /api/chat/sessions/:id/messages` performs these operations sequentially, without a database transaction:

```text
validate message/session
→ read attached path names
→ insert user message
→ optionally insert memory candidate
→ build prompt and call local model/fallback
→ insert assistant response
→ update session timestamp
→ return the two messages and candidate/runtime metadata
```

Required input:

```json
{"content":"..."}
```

The user message is saved before model execution. If the model fails, the app still saves an assistant fallback explaining the runtime error.

### Partial-failure risk

Because the flow is not transactional, a process crash after the user insert but before the assistant insert can leave an unmatched user message. This is recoverable history, but the UI may need to resend manually.

---

## 5. Automatic candidate extraction

Every trimmed user message with at least 24 characters creates a `memory_candidates` row.

Initial values:

| Field | Value |
|---|---|
| source | `chat` |
| evidence | `Chat session <id>, message <id>` |
| confidence | `0.52` |
| status | database default `candidate` |

Type classification is keyword-based and first-match wins:

```text
blocked/blocker           → blocker
prefer/rule/always/never  → rule
waiting/follow up         → waiting
goal                      → goal
remind/reminder           → reminder
decided/decision          → decision
otherwise                 → current state
```

The title is the first sentence-like segment, capped at 96 characters.

### Limitations

- candidate extraction is not semantic;
- negation and quoted text are not understood;
- sensitive content is not detected or redacted;
- every long-enough message becomes a candidate, even when it is a question or transient instruction;
- candidate creation is not idempotent across repeated sends.

Nothing is promoted automatically.

---

## 6. Assistant prompt composition

`buildAssistantPrompt()` includes:

1. up to 12 approved `knowledge_items` with status `active` or `stable`, sorted by confidence and recency;
2. up to 8 memory candidates with status `candidate` or `deferred`;
3. up to 10,000 characters of attached files;
4. the current user message;
5. governance instructions that chat must not promote memory and cloud agents are consultants only.

The approved-memory block includes type, status, confidence, body, owner, and next action.

### Important privacy distinction

The local prompt can contain full approved memory bodies and attached file text. This is appropriate only for a trusted local endpoint. The endpoint route has no built-in host allowlist, authentication layer, or warning when configured to a non-loopback address.

---

## 7. Runtime selection order

`runPlannerAssistant()` chooses the first answering runtime in this order:

```text
1. app-managed llama-server endpoint
2. configured OpenAI-compatible local endpoint
3. configured llama-cli executable
4. unavailable fallback
```

If no assigned model and no endpoint are configured, it immediately returns a saved-chat fallback.

Any thrown runtime error becomes a normal assistant message; the API request does not fail.

### OpenAI-compatible endpoint

`runEndpointModel()`:

- normalizes the endpoint;
- appends `/v1/chat/completions` unless already present;
- sends one system and one user message;
- uses temperature `0.3`;
- requests up to `700` tokens;
- accepts `choices[0].message.content` or `choices[0].text`.

Known gaps:

- no request timeout;
- no cancellation;
- no API-key/header configuration;
- no streaming;
- no retry;
- no endpoint host restriction;
- no content-size or response-size guard beyond runtime defaults.

### llama-cli

`runLlamaCli()` invokes the configured executable directly with:

```text
-m <model path>
-p <prompt>
-n 700
--temp 0.3
```

Limits:

```text
timeout: 5 minutes
stdout/stderr buffer: 4 MiB
working directory: app root
```

---

## 8. Managed llama-server lifecycle

`POST /api/models/server/start`:

1. requires an assigned Planner Assistant model;
2. accepts or reuses `llamaServerPath`, port, and context size;
3. validates only that the server executable exists;
4. spawns it bound to `127.0.0.1`;
5. stores the process handle in memory;
6. writes server and endpoint settings;
7. returns immediately with “starting”.

`POST /api/models/server/stop` kills only the child process currently referenced by this server process.

### Restart and readiness behavior

- the process handle is lost when Life Planner restarts;
- an orphaned llama-server can remain running but no longer be marked managed;
- start does not wait for endpoint readiness;
- stdout/stderr are ignored;
- child `error` events are swallowed;
- model-file existence is not revalidated at start time;
- stop reports success even when no managed child exists.

A separate health probe is needed for reliable lifecycle status.

---

## 9. Model registry lifecycle

`model_registry` tracks local and downloaded GGUF files.

### Scan

`POST /api/models/scan` recursively scans configured folders for `.gguf` files and upserts by full path.

It records:

```text
name
path
size_bytes
source=local
updated_at
```

Risks:

- no recursion/file-count limit;
- no symlink-cycle handling documented;
- no permission-error isolation inside directory iteration;
- user-provided folders may be anywhere on the machine;
- no model-content validation.

### Assign

`POST /api/models/:id/assign`:

- defaults role to `Planner Assistant`;
- refuses a missing file at assignment time;
- clears that role from other rows;
- assigns the selected row.

There is no transaction around clear-then-assign.

### Delete or purge

`DELETE /api/models/:id`:

- with `purge: true`, deletes the registry row only;
- otherwise deletes an existing `.gguf` file and keeps the row when possible for re-download;
- clears assignment when the file is removed.

Only files ending in `.gguf` are deleted by this route.

---

## 10. Hugging Face integration

### Search and file listing

```text
GET /api/hf/search?q=...
GET /api/hf/files?repo=org/model
```

The optional stored HF token is sent as a bearer token. Search results are filtered for GGUF indications. File listing ranks common quantizations before larger/full-precision files.

### Download

```text
POST /api/hf/download
POST /api/models/:id/download
```

The first downloads a selected repo/file into the configured folder and records HF origin. The second re-downloads a registry entry whose original HF metadata is known.

### Download safety gaps

- no checksum verification;
- no declared size limit or disk-space preflight;
- no partial-download cleanup;
- no temporary file plus atomic rename;
- response body is written directly to final target;
- user-supplied download folder is not workspace-confined;
- simultaneous downloads to the same target are not coordinated;
- remote filename is reduced to `path.basename`, which prevents nested traversal but can cause collisions.

---

## 11. Hardware recommendation route

`GET /api/hardware` reports:

- CPU model and logical core count;
- total RAM;
- NVIDIA GPU data from `nvidia-smi` when available;
- Windows CIM GPU fallback;
- a `small`, `medium`, or `large` recommendation tier.

The recommendation is heuristic, not a benchmark. Windows `AdapterRAM` can be inaccurate for some GPUs.

---

## 12. Failure and restart behavior

| Area | Failure behavior | Persistence |
|---|---|---|
| chat message model call | assistant runtime-error fallback is saved | user/candidate/assistant rows persist |
| local endpoint unavailable | request can hang because no timeout | chat user row already saved |
| llama-cli failure | converted to assistant fallback | persists |
| managed server crash | process handle clears on normal exit | settings still say endpoint configured |
| app restart | managed/browser state lost | DB and model files persist |
| context file removed | silently skipped during prompt build | attachment row persists |
| model file removed externally | registry shows `exists: false` | assignment may remain until route changes it |
| HF download interruption | may leave partial final file | registry insert occurs only after completed pipeline |

---

## 13. Runtime verification recipe

1. Use an isolated database and create a new session.
2. Send a message under 24 characters; verify no candidate is created.
3. Send a longer message; verify the user row, candidate row, assistant row, and runtime label.
4. Restart and verify session/messages persist.
5. Attach an allowed text file and confirm its content affects a test local-model response.
6. Remove the file and verify chat continues without crashing.
7. Verify endpoint routing with a local OpenAI-compatible stub.
8. Verify endpoint failure produces a saved fallback.
9. Assign a real GGUF and test managed server start, readiness, chat, stop, and restart divergence.
10. Scan a controlled model folder and test delete/re-download behavior.
11. Test HF download cancellation and inspect for partial files.
12. Attempt attaching a protected file through the API; this should be marked **BROKEN** until the route rejects it.

---

## 14. Known defects and maintenance risks

- Chat context attachment does not apply protected-path filtering.
- Endpoint calls have no timeout, authentication, or loopback-only enforcement.
- Message/candidate/assistant writes are not transactional.
- Candidate extraction is overly broad and keyword-only.
- Managed llama-server start does not prove readiness and suppresses process diagnostics.
- Managed process state is not reconciled after restart.
- Model scanning is effectively unbounded.
- HF downloads lack integrity, capacity, partial-file, and concurrency protections.
- Settings can describe a configured runtime that is no longer actually reachable.
- A complete first-run health gate should validate model existence, endpoint reachability, executable versions, and privacy scope before Chat is called functional.
