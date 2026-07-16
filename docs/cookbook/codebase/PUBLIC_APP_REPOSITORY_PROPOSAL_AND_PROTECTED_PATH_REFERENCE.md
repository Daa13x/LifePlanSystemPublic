# LifePlanSystemPublic Repository Proposal and Protected-Path Reference

Status: complete source-level reference for Repository Explorer reads, repository-write proposals, protected-path checks, approval application, and stale revalidation; runtime verification remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/index.js  1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
src/main.jsx     4592881c34af44848dfc72e74895face6098a1da
```

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_EXPRESS_ENDPOINT_CATALOGUE.md
docs/cookbook/codebase/PUBLIC_APP_MEMORY_APPROVAL_AND_PROJECT_GOVERNANCE_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_SOURCE_CONTROL_COMMAND_AND_SAFETY_REFERENCE.md
```

---

## 1. Purpose and authority boundary

The Repository panel is a review-first text-file editor for the current runtime checkout.

It can:

- list selected text/configuration files;
- preview one allowed file;
- prepare create, update, rename, or delete proposals;
- place the proposal in the shared `approvals` table;
- apply the filesystem mutation only after an approval decision.

The frontend never writes files directly.

The backend is authoritative for:

- workspace confinement;
- protected-path checks;
- stale-content comparison;
- the actual filesystem mutation.

Routes:

```text
GET  /api/repo/files
GET  /api/repo/file
POST /api/repo/proposals
POST /api/approvals/:id/revalidate
POST /api/approvals/:id/:decision
```

Persistence:

```text
approvals.action_type = repo_write
approvals.payload      = JSON proposal envelope
```

A pending proposal survives a server restart because it is stored in SQLite. No filesystem write occurs until approval.

---

## 2. Workspace path confinement

All direct file targets pass through `safeWorkspacePath()`.

Accepted path model:

- repository-relative only;
- no NUL character;
- no Windows drive absolute path;
- no UNC or leading `//` path;
- no `..` path segment;
- resolved path must stay at or below `process.cwd()`.

Return shape:

```text
normalized  slash-normalized repository-relative path
absolute    resolved filesystem path under the runtime root
```

This prevents ordinary path traversal and absolute-path escape.

It does not establish whether the current checkout is the public app or private brain. That is a separate repository-boundary concern.

---

## 3. Protected-path policy

`isProtectedWorkspacePath()` blocks the following root prefixes:

```text
.git/
data/
dist/
node_modules/
release/
.cache/
.lps/
```

It blocks these exact root-level filenames:

```text
.env
.env.local
.env.production
```

It blocks files ending in:

```text
.sqlite
.sqlite3
.db
.gguf
.safetensors
.onnx
.log
```

Protected checks are applied by:

- repository file preview;
- repository proposal creation;
- repository proposal approval;
- repository proposal revalidation;
- Source Control per-file diff and stage operations.

### Scope limitations

The policy is designed around the public app checkout. It does not automatically protect private-brain names such as:

```text
source_of_truth/
rules/
memory/
secrets/
```

It also checks protected directory prefixes only at the repository root. A nested path such as `example/data/file.json` does not match `data/`.

The exact-name environment check protects only root `.env` variants. A nested file such as `config/.env` is not protected by the name rule.

Therefore the runnable app must not be pointed at the private brain on the assumption that this function understands every private-data location.

---

## 4. Repository file listing

Route:

```text
GET /api/repo/files?q=<optional substring>
```

Allowed extensions:

```text
.md
.mdx
.json
.txt
.yml
.yaml
```

Traversal exclusions:

```text
.git
node_modules
dist
data
```

Other behavior:

- recursive depth is not explicitly limited;
- result count is capped at 500;
- search matches the lower-cased relative path;
- results are sorted by path;
- each result exposes path, size, and modification time.

### Listing-policy mismatch

The listing exclusions are narrower than `isProtectedWorkspacePath()`.

For example, the scanner may traverse and list matching text files under:

```text
.lps/
release/
.cache/
```

Previewing those files is later refused, but their names, sizes, and timestamps may already have been disclosed to the UI.

The listing route should use the same central protected-path policy as preview/proposal routes.

### Filesystem behavior

The route does not wrap every directory read/stat in a local error boundary. An unreadable or concurrently removed directory can throw and reach the final server error handler.

---

## 5. File preview

Route:

```text
GET /api/repo/file?path=<relative path>
```

Checks:

1. confine path to workspace;
2. reject protected path;
3. require an existing regular file;
4. read as UTF-8.

Response data:

```text
path
content
updatedAt
```

Limitations:

- there is no file-size cap;
- binary detection is not performed here;
- any non-protected file can be read regardless of extension when the route is called directly;
- UTF-8 decoding is attempted for all accepted targets.

The extension allowlist exists only in the listing route, not preview itself.

---

## 6. Proposal creation

Route:

```text
POST /api/repo/proposals
```

Input fields used:

```text
operation       create | update | rename | delete (not strictly validated)
targetFile      required workspace-relative path
fromFile        rename source path
title           optional approval title
content         proposed text content
previousContent optional optimistic-concurrency snapshot
summary         optional human explanation
risk            optional advisory classification
source          optional proposal origin
priority        approval priority, default P1
```

Stored approval payload:

```json
{
  "operation": "update",
  "targetFile": "docs/example.md",
  "fromFile": null,
  "content": "...",
  "previousContent": "...",
  "summary": "Repository file update proposal.",
  "risk": "medium",
  "source": "Repository Explorer"
}
```

Creation behavior:

1. Normalize operation, defaulting to `update`.
2. Confine and protect-check target.
3. Confine and protect-check optional source.
4. Read existing target content when the target exists.
5. Use caller-provided `previousContent` when explicitly present; otherwise use target content.
6. Insert a `repo_write` approval.
7. Return the pending approval.

No target file is modified during proposal creation.

### Frontend behavior

`RepositoryExplorer` submits operation, target/source paths, content, prior content, summary, risk, and source.

Frontend risk is descriptive only. The server does not use `risk` to select stronger gates.

---

## 7. Operation semantics at approval

A `repo_write` mutation is executed in `POST /api/approvals/:id/approve`.

### Create

Checks:

- target remains workspace-confined;
- target remains non-protected;
- target must not already exist;
- stale comparison is made against empty/current target content when `previousContent` is present.

Effect:

- create parent directories recursively;
- write `payload.content` as UTF-8.

### Update

Checks:

- target remains workspace-confined and non-protected;
- if target exists, read current UTF-8 content;
- if `previousContent` exists, require exact string equality.

Effect:

- create parent directories recursively;
- write content, creating the file if it did not exist.

Thus `update` is effectively an upsert, not update-only.

### Delete

Checks:

- target exists and is a regular file;
- target remains non-protected;
- exact stale-content comparison when supplied.

Effect:

- unlink the file.

No recycle bin or backup artifact is produced.

### Rename

Checks:

- source and target are confined and non-protected;
- source exists and is a regular file;
- target does not exist;
- source content exactly matches `previousContent` when supplied.

Effect:

- create target parent directory recursively;
- rename source to target.

The rename is filesystem-level and remains on the same mounted filesystem/root.

---

## 8. Optimistic stale checking

The proposal stores a full `previousContent` string.

At approval, exact equality is used to detect edits made after proposal creation.

Advantages:

- simple;
- detects any text change;
- prevents an old proposal from silently overwriting a newer version.

Limitations:

- large files duplicate their full contents inside SQLite;
- comparison is encoding/text based;
- no content hash or file metadata is stored;
- no line-ending normalization;
- no merge assistance;
- no file identity/inode check;
- no transaction spans stale check and write, leaving a time-of-check/time-of-use window.

### Rename default-snapshot defect

When the caller omits `previousContent`, proposal creation reads the target path, not the rename source path.

For a normal rename the target does not yet exist, so the stored snapshot defaults to an empty string. Approval later compares that empty string with the source file content and rejects the proposal as stale.

The maintained frontend may supply source content explicitly, but the backend default is incorrect for direct API callers.

---

## 9. Revalidation

Route:

```text
POST /api/approvals/:id/revalidate
```

For `repo_write`:

- rename checks the current `fromFile` content;
- all other operations check `targetFile` content;
- protected paths are rejected;
- exact string comparison determines `valid` and `stale`.

Response:

```text
valid
stale
message
```

Revalidation is advisory. It does not reserve the file or lock the proposal. The file can change after revalidation and before approval.

Known UI defect from the frontend inventory: the Revalidate handler is misplaced, so the current approval UI may throw before calling this route.

### Incomplete operation checks

Revalidation checks content equality only. It does not fully validate:

- create target nonexistence;
- rename target nonexistence;
- delete target regular-file state;
- parent-directory writability.

Approval repeats stronger checks for several of these conditions.

---

## 10. Approval decision and idempotency

The shared approval decision route does not require current status to be `pending`.

Consequences for repository proposals:

- a previously approved create/update/delete/rename can be submitted again;
- repeat update may rewrite the same content;
- repeat delete/rename usually fails because the source is gone;
- an approval status can be changed after an earlier decision;
- side effect and status update are not protected by an idempotency key.

The route should enforce a one-way transition from `pending` and perform the mutation/status update inside a deliberate transaction or durable operation record where possible.

Filesystem effects themselves cannot be rolled back by the current SQLite transaction model.

---

## 11. Audit and recovery characteristics

What persists:

- proposal title;
- action type;
- complete payload;
- priority;
- decision status and time.

What does not persist:

- acting user identity;
- filesystem result metadata;
- before/after hashes;
- backup copy;
- exception details;
- Git commit produced from the change;
- link from proposal to later commit.

Recovery options:

- use Git when the target was tracked;
- restore from an external backup;
- use the stored `previousContent` manually when available.

A delete of an untracked file has no built-in recovery path.

---

## 12. Security and privacy findings

### Private-repository boundary is not encoded

`safeWorkspacePath()` protects only against escape from the active checkout. It does not prevent the public app from operating on the private brain when launched from that directory.

The protected-prefix list also does not represent the complete private-brain schema.

### Protected-name gaps

Nested `.env` files and private folders with different names may be previewed or proposed.

### Listing metadata disclosure

The file list can expose names and metadata under `.lps`, `release`, or `.cache` even though later preview is blocked.

### No proposal size limit

Large content and `previousContent` values can inflate request bodies and SQLite payload storage up to the server's general JSON limit.

### No operation allowlist

An unrecognized operation name is labelled as an update and falls through to update/upsert behavior during approval.

### No symlink-specific policy

Path resolution confines the lexical path, but the implementation does not explicitly reject symbolic links or verify the final real path. A symlink inside the checkout pointing outside it can undermine lexical workspace confinement.

This is a high-priority filesystem-safety gap. Real-path confinement should be checked for existing source/target parents before reads or writes.

---

## 13. Recommended hardening order

1. Refuse operation values outside `create`, `update`, `rename`, and `delete`.
2. Add real-path/symlink confinement.
3. Centralize one protected-path registry used by listing, preview, proposals, Source Control, Browser context, and OpenHands.
4. Encode the private/public repository boundary explicitly.
5. Protect nested environment/secrets patterns.
6. Fix rename default snapshot to read `fromFile`.
7. Enforce pending-only, one-shot approval transitions.
8. Add content hashes and result audit fields.
9. Add file-size limits and binary detection.
10. Add backup/undo behavior for destructive untracked-file changes.

---

## 14. Runtime verification recipe

Use a disposable clone and isolated database.

1. List allowed Markdown files.
2. Confirm `.git`, `data`, and `node_modules` are not listed.
3. Check whether `.lps`, `release`, or `.cache` metadata appears.
4. Attempt preview of a protected path and expect `403`.
5. Test path traversal, drive path, UNC path, and NUL rejection.
6. Propose and approve a new disposable file.
7. Propose update, modify the file externally, and confirm approval returns stale conflict.
8. Propose delete and verify no mutation occurs before approval.
9. Test rename with and without explicit source `previousContent`.
10. Attempt a nested `.env` and symlink escape in a disposable fixture.
11. Attempt an unknown operation name and record current update/upsert behavior.
12. Repeat an already-approved proposal and record idempotency behavior.
13. Restore the disposable checkout.

Do not test destructive paths in the private repository or primary working copy.
