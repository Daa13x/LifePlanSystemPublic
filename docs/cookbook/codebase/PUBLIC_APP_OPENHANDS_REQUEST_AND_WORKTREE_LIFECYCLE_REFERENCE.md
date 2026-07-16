# LifePlanSystemPublic OpenHands Request and Worktree Lifecycle Reference

Status: complete source-level reference for OpenHands service checks, request files, approval and second-confirmation gates, allowlisted validation, dry-run planning, worktree harness execution, path enforcement, artifacts, and teardown; real agent invocation remains disabled and runtime verification remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/index.js                   1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
server/executorEnforcement.js     7b1cfc2fb6fce31fd2dec06681b5327eb5264d12
server/runCliCwd.js               9142df399db72c3cadd07ed893b37143dbd8c9a5
src/main.jsx                      4592881c34af44848dfc72e74895face6098a1da
package.json                      39205a498cf380731f947259346eb54d15ae9320
```

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_TOOLING_DETECTION_AND_INSTALL_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_SOURCE_CONTROL_COMMAND_AND_SAFETY_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_BACKEND_HELPER_AND_PROCESS_MAP.md
```

---

## 1. Role and current implementation level

OpenHands is treated as a bounded local coding worker, not the LifePlanSystem brain or policy authority.

The maintained implementation has three distinct execution layers:

```text
Layer 1: approved validation runner
         runs one fixed allowlisted validation command in the main checkout

Layer 2: dry-run execution planner
         evaluates gates and writes a report; creates no branch/worktree and edits nothing

Layer 3: isolated-worktree executor harness
         creates a dedicated branch/worktree, runs enforcement and validation,
         writes report/patch artifacts, but real OpenHands invocation is OFF
```

Critical constant:

```js
const OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false;
```

Therefore the current system does not ask OpenHands to generate or edit code.

A status such as `executor-ran` means the harness ran. It does not mean an AI changed files.

---

## 2. Fixed service configuration

```text
Docker container: openhands-app
OpenHands UI:    http://localhost:3000
Ollama API:      http://127.0.0.1:11434
Model label:     qwen2.5-coder:14b-gpu
OpenAI-style URL inside container:
                 http://host.docker.internal:11434/v1
API key reference:
                 dummy (Ollama ignores it)
```

Request JSON cannot override the fixed executor model, endpoint, or key reference.

### Service routes

```text
GET  /api/tooling/openhands/status
POST /api/tooling/openhands/start
POST /api/tooling/openhands/stop
GET  /api/tooling/ollama/status
GET  /api/tooling/ollama/model-status
```

The app can start/stop one existing container. It does not install OpenHands or create/pull/delete containers.

---

## 3. Artifact directories

All request/executor artifacts live under:

```text
.lps/tooling/openhands/
├── requests/
│   └── oh-req-<timestamp>-<sequence>.json
├── reports/
│   ├── oh-req-<id>.md
│   └── oh-req-<id>.patch
└── worktrees/
    └── oh-req-<id>/
```

`.lps/` is protected from repository proposals, Source Control staging, and OpenHands allowed paths.

Persistence:

- request JSON and reports survive server restart;
- sequence counter does not survive restart, though timestamp remains part of the ID;
- worktrees/branches survive only according to executor teardown rules;
- no SQLite table indexes or audits OpenHands requests.

`readOpenHandsRequests()` scans request JSON files on demand and marks unreadable files as `invalid` display records.

---

## 4. Main routes

```text
GET  /api/tooling/openhands/requests
POST /api/tooling/openhands/requests
POST /api/tooling/openhands/requests/:id/approve
POST /api/tooling/openhands/requests/:id/run
GET  /api/tooling/openhands/requests/:id/report
POST /api/tooling/openhands/requests/:id/confirm-execution
POST /api/tooling/openhands/requests/:id/execution-plan
POST /api/tooling/openhands/requests/:id/execute
```

The React panel exposes every route and labels the executor button as invocation OFF.

---

## 5. Request creation

Required user fields:

```text
title
objective
```

Other stored fields:

```text
requestedBy
targetRepoPath
baseBranch
baseBranchAtCreation
allowedPaths
forbiddenPaths
testCommand
maxFilesChanged
requiresApprovalBeforeRun
requiresApprovalBeforeCommit
requiresApprovalBeforePush
riskLevel
createdAt
status
reportPath
```

Forced gates:

```text
requiresApprovalBeforeRun    true
requiresApprovalBeforeCommit true
requiresApprovalBeforePush   true
status                       pending
```

### Base-branch validation

`validateExecutorBaseBranch()` rejects:

- empty/overlong values;
- values beginning with `-`;
- whitespace/control characters;
- `@`, full `refs/` names, revision syntax, unsafe Git characters;
- leading/trailing/double slash;
- unsafe components such as `.lock`, leading dot, trailing dot, or `HEAD`;
- non-ASCII characters outside the simplified allowlist.

The branch is syntax-checked at creation. It is resolved to a commit later during planning/execution.

### Allowed and forbidden paths

`allowedPaths` and `forbiddenPaths` accept arrays or newline-separated text.

A request is rejected when an allowed path overlaps mandatory forbidden locations:

```text
source_of_truth/
memory/
.env
secrets/
data/
.git/
.lps/
credentials
rules/
```

Mandatory entries are always merged into the stored forbidden list.

### Secret-hint rejection

The title and objective are rejected when they match terms such as:

```text
API key
token
password
secret
credential
```

This is a heuristic, not content classification. It does not inspect referenced source files or every possible secret phrase.

### File-count limit

`maxFilesChanged` is clamped at creation to an integer from 1 through 5.

### Inert target path

`targetRepoPath` is stored but is not used to select the execution repository.

All Git commands, request paths, branches, worktrees, and validation run against the server's `process.cwd()` repository root. A different `targetRepoPath` currently has informational value only.

This field must not be presented as multi-repository isolation or routing.

---

## 6. Request-state model

Observed statuses:

```text
pending
approved
validated
validation-failed
execution-planned
executor-ran
invalid
```

Expected main paths:

```text
pending -> approved -> validated | validation-failed

pending -> approved
        -> execution confirmation
        -> execution-planned
        -> executor-ran
```

The same request supports both the validation-runner path and the execution-plan path, but running validation moves it to a terminal validation status that cannot be re-approved through the normal approval route.

### Transition limitations

- Approval blocks only `validated` and `validation-failed`; it can re-approve other statuses, including `approved`, `execution-planned`, or `executor-ran`.
- Re-approval overwrites approval metadata and status.
- There is no explicit reject/cancel/delete/archive route.
- Status changes are direct JSON-file rewrites without a transition log.
- Locally edited request JSON is treated as input and only partially revalidated at each layer.

---

## 7. Human approval

Route:

```text
POST /api/tooling/openhands/requests/:id/approve
```

Approval:

1. validates the request ID/path;
2. loads the JSON file;
3. refuses a request already in `validated` or `validation-failed`;
4. revalidates/normalizes base branch;
5. ensures `baseBranchAtCreation` still matches;
6. writes `status=approved`;
7. records approver/timestamp;
8. pins `approvedBaseBranch`.

Approval does not run commands or create a worktree.

There is no authentication proving the supplied `approvedBy` identity.

---

## 8. Layer 1 — approved validation runner

Route:

```text
POST /api/tooling/openhands/requests/:id/run
```

Allowed commands:

```text
node --check server/index.js
npm run build
```

Default:

```text
node --check server/index.js
```

Required gates:

- current status exactly `approved`;
- no protected path in `allowedPaths`;
- requested command exactly matches the allowlist.

It then:

1. snapshots `git status --porcelain` lines;
2. runs the command in the main repository root;
3. snapshots status again;
4. counts status lines newly appearing in the set;
5. compares that count with `maxFilesChanged`;
6. writes a Markdown report;
7. writes status `validated` or `validation-failed`.

### Runner safety

It does not call OpenHands and contains no commit, push, merge, reset, delete, or force-push operation.

### Runner change-detection defect

`changedTrackedFiles()` compares sets of complete porcelain status lines before and after.

If a file is already modified before validation and the command modifies it further without changing its porcelain status line, that additional mutation is not counted as a new line.

The runner is intended for non-mutating validation commands, but its “files changed by this run” measurement is not a content/hash diff and should not be treated as strong mutation attribution.

The runner also operates in the main checkout, not an isolated worktree.

---

## 9. Second execution confirmation

Route:

```text
POST /api/tooling/openhands/requests/:id/confirm-execution
```

Allowed current statuses:

```text
approved
execution-planned
```

It requires the approval-time base pin to exist and still equal the current request branch.

It records:

```text
executionConfirmed
executionConfirmedAt
executionConfirmedBy
executionConfirmedBaseBranch
executionConfirmedBaseBranchAt
```

This is a second human-intent marker. It still relies on unverified caller-supplied identity and a localhost route without pairing/authentication.

---

## 10. Layer 2 — dry-run execution plan

Route:

```text
POST /api/tooling/openhands/requests/:id/execution-plan
```

It requires:

- approved or execution-planned status;
- second execution confirmation.

`evaluateExecutionPlan()` checks:

```text
human approval
second confirmation
non-empty allowedPaths
mandatory protected-path scan
base-branch syntax
creation-time base pin
approval-time base pin
confirmation-time base pin
base branch resolves to a 40-character commit SHA
dedicated execution branch is not main/master
dedicated branch does not already exist
maxFilesChanged is within 1-5
validation command is allowlisted
```

Proposed branch:

```text
openhands/exec-<request-id-suffix>
```

The plan also builds future invocation constraints and readiness checks, probes OpenHands HTTP reachability, and evaluates whether worktree validation dependencies would be present.

It writes a Markdown report and then writes:

```text
status = execution-planned
executionEligible = true|false
```

### Plan-status limitation

The route sets `execution-planned` even when one or more gates are blocked. Consumers must inspect `executionEligible`, gate results, and readiness—not the status label alone.

The plan creates no branch/worktree, invokes no model, and edits no source.

---

## 11. Future invocation constraints

`buildOpenHandsInvocationConstraints()` binds:

- approval and second-confirmation state;
- allowed paths;
- mandatory forbidden paths;
- branch pins and resolved base commit;
- file-count limit;
- validation runtime/output limits;
- fixed model/endpoint/key reference.

`buildOpenHandsInvocationReadiness()` additionally requires:

- the invocation flag to be explicitly off by default;
- OpenHands service reachability;
- worktree dependency readiness;
- dry-run report generation;
- separate approval for any post-run patch.

### Intentional fail-closed activation barrier

Readiness currently passes its invocation-flag gate only when `OPENHANDS_EXECUTOR_INVOCATION_ENABLED === false`.

Therefore simply flipping the constant to `true` would cause readiness to become setup-gated. Enabling real invocation requires a deliberate code change to the readiness design and implementation, not a one-line flag toggle.

This is a strong fail-closed property and should remain explicit.

---

## 12. Layer 3 — worktree executor harness

Route:

```text
POST /api/tooling/openhands/requests/:id/execute
```

The route first re-evaluates every plan gate and invocation constraint.

It refuses:

- ineligible requests;
- missing tool constraints;
- main/master execution branch;
- execution branch equal to the current branch;
- an already-existing execution branch.

### Isolation creation

It creates:

```text
git worktree add -b openhands/exec-<id> <worktree-path> -- <pinned-base-commit>
```

The worktree is under `.lps/tooling/openhands/worktrees/` and starts from the pinned commit, not the caller's current HEAD.

### Real invocation

`invokeOpenHandsExecutor()` verifies constraints/readiness, then returns without invoking anything because the server constant is false.

Current result:

```text
openHandsInvoked = false
```

### Actual-change enforcement

After the (disabled) invocation point, the harness runs Git status in the worktree and enforces changes against:

- mandatory forbidden paths;
- request forbidden paths;
- request allowed paths;
- maximum file count.

Allowed-path matching is boundary-aware:

- exact file match;
- descendant match for directory-like entries;
- no raw sibling/suffix prefix authorization;
- absolute/traversing changed paths are rejected.

### Porcelain parsing limitation

`parsePorcelainPaths()` uses newline-split non-`-z` output and simplified rename parsing.

Quoted/unusual filenames and complex rename records are not handled with the robustness of `--porcelain=v1 -z` or v2.

### Patch creation

Untracked files are marked intent-to-add in the isolated worktree so `git diff --binary` can include them.

Artifacts:

```text
reports/<request-id>.patch
reports/<request-id>.md
```

Diff capture/report previews have fixed size limits.

### Validation in the worktree

Only the same validation allowlist is accepted.

`node --check server/index.js` has no dependency preflight.

`npm run build` requires the worktree to contain:

```text
package.json
node_modules/
Vite executable under node_modules/.bin
```

Git worktrees normally do not copy ignored `node_modules`, so npm build is usually setup-gated unless dependencies are separately made available.

The executor does not install/copy/link dependencies automatically.

---

## 13. Teardown and preservation

When there is no diff:

1. the worktree is force-removed;
2. Git worktrees are pruned;
3. the execution branch is left in place.

When a real diff exists:

- the worktree is preserved;
- the branch is preserved;
- the patch/report are preserved;
- human review is required.

The executor never automatically deletes the branch.

### One-run branch behavior

Because the branch is retained even when no diff exists, a later execute call for the same request is blocked by “branch already exists.”

There is no dedicated cleanup/retry route. Recovery requires manual Source Control/terminal review and branch removal when appropriate.

### Error path

A `finally` block removes a created worktree when an error occurs before normal teardown, then prunes worktree metadata. It still does not delete the branch.

---

## 14. Reports and request updates

The harness report records:

- request and human markers;
- branch/base/worktree isolation;
- invocation status/reason;
- constraint/readiness gates;
- actual changed files;
- path enforcement;
- diff artifact/preview and limit status;
- validation setup/result/output limits;
- refused actions;
- human next steps.

The request JSON is updated with execution metadata including:

```text
executor-ran status
base branch/commit
invocation flag/result
enforcement result
validation result and limits
diff result and limits
report path
patch path
worktree preservation flag
```

Request/report files are plain local files. They are not signed, hash-bound, immutable, or append-only. Another local process or manual edit can alter them.

---

## 15. Refused actions and downstream boundary

The current executor contains no automatic:

```text
commit
push
merge
pull request
reset --hard
force push
branch deletion
main/master update
arbitrary request-provided shell
```

Any real future patch must be reviewed separately. Commit/push/PR remains a human Source Control workflow.

No implemented route currently records a distinct “patch approved for commit” decision for OpenHands artifacts.

---

## 16. Critical findings

1. Real OpenHands invocation is disabled and cannot be enabled by only flipping the flag because readiness deliberately requires the flag to be off.
2. `targetRepoPath` is inert; execution always targets the server's current repository.
3. Approval can be reapplied to statuses other than validated/validation-failed, including executor-ran.
4. Dry-run status becomes `execution-planned` even when the plan is blocked.
5. Validation-runner mutation attribution uses status-line set differences, not hashes/content.
6. The worktree branch is left behind after no-diff execution, blocking a repeat run.
7. No cleanup/cancel/reject/archive/retry route exists.
8. Request/report/patch files are mutable and not integrity-bound.
9. Localhost routes have no authenticated human identity or pairing secret.
10. Porcelain parsing is not NUL-safe for unusual filenames/renames.
11. `npm run build` in a fresh worktree is normally dependency-gated because `node_modules` is absent.
12. Secret-title/objective detection is heuristic and does not inspect file content.
13. Case-normalized path authorization can behave differently from a case-sensitive filesystem.
14. No concurrent-execution lock exists for the same or overlapping repository scopes.
15. A real future diff can be preserved even when enforcement fails; this is good for forensics but requires explicit cleanup instructions.

---

## 17. Committed verification commands

Current package scripts include:

```text
npm run verify:executor-enforcement
npm run verify:openhands-invocation-adapter
npm run verify:openhands-invocation-schemas
npm run verify:openhands-invocation-all
npm run verify:runcli-cwd
npm run verify:openhands-stop-boundary
npm run verify:runtime-safety
```

These verify pure enforcement/invocation/boundary behavior without claiming a real OpenHands code-edit run.

The complete script-by-script inventory is maintained in a separate cookbook pass.

---

## 18. Runtime verification recipe

Use a disposable clone and never enable real invocation during this verification.

1. Run all committed runtime-safety scripts.
2. Verify Docker missing, container absent, stopped, running, warming, and reachable states.
3. Verify Ollama missing, running without the exact model, and exact model present.
4. Create a request with valid paths and inspect the stored JSON.
5. Attempt protected allowed paths and confirm creation rejection.
6. Attempt secret-like title/objective and confirm rejection.
7. Verify an invalid base branch is refused.
8. Approve and confirm approval-time base pinning.
9. Run the allowlisted validation runner and inspect report/status.
10. Prove arbitrary validation commands are refused.
11. Create a separate request for the execution-plan path.
12. Confirm second-confirmation is required.
13. Generate a dry-run plan and inspect every gate, eligibility value, and report.
14. Run the worktree harness with invocation disabled.
15. Confirm the worktree is created from the pinned base commit.
16. Confirm no source edits, commit, push, merge, or model call occurred.
17. Confirm an empty patch/report is created, worktree removed, and branch retained.
18. Attempt to rerun and confirm the retained branch blocks it.
19. Manually review cleanup of the retained branch.
20. Test npm-build dependency setup-gating in a fresh worktree.
21. Test malformed/unreadable request files and report access path validation.
22. Restart the server and confirm request/report persistence and service-state refresh.
23. Record all paths, commits, commands, and outputs in a dated acceptance record.

Do not call OpenHands execution `DONE` until a separately reviewed design safely implements real invocation, patch approval, concurrency control, cleanup/retry, authentication, and full runtime acceptance.