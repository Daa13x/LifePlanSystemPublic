# OpenHands Worktree Executor (first slice: harness, real invocation OFF)

The highest-risk layer. This first slice builds the executor **harness** and
proves the isolated-worktree → gate → post-change-enforcement → validation →
report flow, but **real OpenHands invocation is DISABLED** by a server-side
constant (`OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false`). No code is generated
or edited in this build.

## Flow (`POST /api/tooling/openhands/requests/:id/execute`)

1. Re-evaluate every dry-run gate (`evaluateExecutionPlan`): approval, second
   confirmation, allowedPaths present, protected-path scan, branch not
   main/master, branch free, maxFilesChanged 1–5, validation allowlisted. If any
   gate fails → **403 refused**.
2. Extra guards: execution branch is never `main`/`master`, never the user's
   current branch, and must not already exist.
3. Create an **isolated git worktree** at `.lps/tooling/openhands/worktrees/<id>`
   on a dedicated `openhands/exec-<id>` branch from the pinned `baseBranch`
   commit, never from the caller's current `HEAD`. The main working tree,
   main/master, and the user's current branch are never touched.
4. Invoke OpenHands — **disabled**; records `invoked: false` and makes no edits.
   Before any future invocation could run, the executor also builds a
   tool-level constraint contract covering allowed paths, mandatory forbidden
   paths, base pin, limits, model/endpoint config, and explicit approval state.
   Missing constraints are refused/setup-gated. A separate invocation readiness
   gate then checks the disabled flag, model/endpoint config, read-only service
   reachability probe, pinned base, dependency gate, limits, paths,
   approval/confirmation state, dry-run report, and post-run approval boundary.
5. Compute the **actual** changed files/diff in the worktree and enforce
   allowedPaths, forbiddenPaths, the protected-path block list, and
   maxFilesChanged **against the real diff** (not the declared intent).
6. Run **only** an allowlisted validation command (`node --check server/index.js`
   or `npm run build`) inside the worktree. For `npm run build`, first check
   that build dependencies are actually present in that isolated worktree; if
   they are missing, report `setup-gated` instead of attempting an implicit
   install/copy/link or pretending build validation ran. Validation runs with
   explicit runtime/output limits and the report names timeout or output-cap
   failures instead of treating them as generic validation failures.
7. Write a report to `.lps/tooling/openhands/reports/<id>.md`.
8. Teardown removes the throwaway worktree (never deletes the branch).

## Fixed OpenHands wiring (request JSON can never override)

- model `openai/qwen2.5-coder:14b-gpu`
- base URL `http://host.docker.internal:11434/v1`
- key `dummy`

The request cannot override the model, endpoint, shell commands, git
operations, protected paths, runtime/output limits, tool-level invocation
constraints, or the validation allowlist.

## Base-branch pinning (blocker #6 - addressed)

The executor no longer creates worktrees from whatever branch the app happens to
be running on. Request creation normalizes and validates `baseBranch` (default
`main`) and rejects option-like or revision-like values such as `--detach`,
`main --force`, `refs/heads/main`, `main..other`, `main@{1}`, `HEAD`, or
shell-ish separators.

That same base branch is pinned again at approval and at the second execution
confirmation. The dry-run plan and real execute gate refuse a request if the
stored base branch differs across creation, approval, confirmation, or execution
time. The gate also resolves the base branch to a commit before execution.

The real worktree command uses argument-array `git` invocation and a `--`
separator, then creates the execution branch from the resolved pinned commit:
`git worktree add -b <exec-branch> <worktree-path> -- <base-commit>`. A malicious
request therefore cannot smuggle flags through the base branch or make the
executor silently run from the user's current branch.

## What it never does

- Never invokes OpenHands in this build (flag off).
- Never edits the main working tree, `main`/`master`, or the user's branch.
- Never auto-commits, auto-pushes, auto-merges, force-pushes, `reset --hard`,
  deletes branches, or pushes to `main`/`master`.
- Never runs arbitrary request-supplied shell.

## Diff preservation (blockers #1 and #2 — addressed)

- **Diff artifact with explicit capture limit:** every run writes the captured
  diff to `.lps/tooling/openhands/reports/<id>.patch`. The report embeds only a
  4000-char preview and points to the `.patch` for review. If `git diff --binary`
  ever hits the explicit diff-output cap, the report names that limit hit and
  the preserved worktree remains the review source of truth.
- **Untracked new files are captured:** plain `git diff` omits untracked new
  files, so before producing the patch the executor marks any untracked files
  intent-to-add (`git add -N`) inside the worktree's own index — isolated, no
  commit, the main repo is never touched — and uses `git diff --binary`. New
  text files appear inline and binary files as base85, so the `.patch` includes
  new-file contents and stays re-appliable. The report states how many untracked
  files were captured.
- **Worktree preservation on real diffs:** teardown now PRESERVES the worktree
  and branch whenever a real diff exists (`changedFiles.length > 0`), so a human
  can review the actual edits in place. With invocation OFF the diff is empty,
  so the worktree is still removed to keep the repo clean. The branch is never
  auto-deleted either way. (The `.patch` alone is not treated as a substitute
  for the working tree.)

## allowedPaths boundary matching (blocker #4 — addressed)

Enforcement of `allowedPaths` against the real changed files
(`enforceChangedFiles` → `isChangedFileAllowed`) uses **path-boundary-safe**
matching, not raw string prefixing. A changed file is authorised only when:

- it **exactly equals** an allowed path, or
- the allowed path is **directory-like** and the changed file is a descendant
  behind a real `/` separator (`allowed` + `/` + …).

An allowed path whose basename contains a `.` is treated as a **file** (exact
match only), since file-vs-directory cannot be known for certain from the string
alone; this fails safe (a dotted directory name is slightly over-restricted,
never over-permissive). Absolute paths (`/…`, `C:/…`) and any `..` traversal
segment in the changed file or allowed path are rejected defensively.

This closes the earlier loose-prefix bypasses, e.g. an allowed path of
`README.md` no longer authorises `README.md.x` or `README.md/anything`, `docs`
no longer authorises `docs-old`/`docs2`/`docsite`, and `src/app` no longer
authorises `src/application`. (The user-supplied `forbiddenPaths` denylist keeps
its broader prefix match — over-blocking on a denylist is safe — and the
mandatory protected-path block list is unchanged.)

## Tool-level invocation constraints (blocker #7 — addressed as preflight)

Real OpenHands invocation remains OFF, but the executor now builds and checks a
future invocation contract before the harness proceeds. The contract must carry:

- `allowedPaths` and the mandatory forbidden/protected paths;
- the pinned base branch and resolved base commit;
- the changed-file count limit;
- validation runtime timeout and output/report caps;
- fixed model/endpoint/API-key reference;
- explicit human approval plus second execution confirmation.

If any of these are missing or mismatched, the executor refuses/setup-gates the
request before future invocation could occur. This does **not** call OpenHands
and does **not** authorize real execution; it only makes the future invocation
boundary explicit and testable while the server-side flag remains false.

## Invocation readiness gate (blocker #8 - addressed as preflight)

Real OpenHands invocation remains OFF. Before any future invocation path could
run, the executor now also builds a readiness result that must pass every
condition below:

- the real invocation flag is explicitly present and false by default;
- fixed model/endpoint config is present;
- a short OpenHands HTTP reachability check has run;
- the base branch and resolved base commit are pinned;
- the isolated-worktree dependency gate has passed;
- changed-file, runtime, output, and report limits are present;
- `allowedPaths` is present and mandatory protected paths are enforced;
- approval plus second execution confirmation are present;
- the dry-run report was generated before execution;
- any post-run patch still requires separate human approval before commit,
  push, or PR.

The service reachability check is a probe only. It does not start OpenHands,
install anything, bypass login/security, or call the agent. If any readiness
condition is missing, the future invocation boundary is reported as
`setup-gated` and real invocation is refused before the placeholder invocation
function can proceed.

For the future local-only enablement plan, see
[`OPENHANDS_REAL_INVOCATION_ENABLEMENT_PLAN.md`](OPENHANDS_REAL_INVOCATION_ENABLEMENT_PLAN.md).

## Enforcement rejection path verified (blocker #3 — addressed)

The changed-file enforcement is verified to **reject a real violating diff**, not
just the no-diff case. To make this testable without booting the server or
enabling invocation, the pure enforcement helpers (`OPENHANDS_MANDATORY_FORBIDDEN`,
`normalizeRequestPath`, `violatesMandatoryForbidden`, `parsePorcelainPaths`,
`isChangedFileAllowed`, `enforceChangedFiles`) were moved verbatim from
`server/index.js` into `server/executorEnforcement.js` (a side-effect-free
module; `server/index.js` imports them, so behaviour is unchanged).

A committed verification script exercises the **real** functions:

    npm run verify:executor-enforcement      # node scripts/verify-executor-enforcement.mjs

It creates a throwaway git repo in the OS temp dir, makes a **real** changed file
outside a narrow `allowedPaths`, gathers changed files exactly as the executor
does (`git status --porcelain` → `parsePorcelainPaths`, the same order
enforcement runs in), calls `enforceChangedFiles`, and asserts the result is
rejected (`ok: false`) with the offending path named. Verified cases include:

- **Rejected (real isolated git working tree):** a new file `docs-forbidden/file.md`
  and a modified tracked `README.md`, each with `allowedPaths` scoped elsewhere →
  `ok: false`, violation names the file as `outside allowedPaths`.
- **Rejected (direct matrix):** `README.md.x` vs `[README.md]`,
  `src/application/file.js` vs `[src/app]`, `docs2/file.md` vs `[docs]`, a `..`
  traversal path, and an absolute path.
- **Protected-path denylist still blocks** `source_of_truth/…`, `memory/…`, `.env`
  (reported as *touches a protected path*) — proving the extract did **not**
  loosen the protected/forbidden denylist.
- **Positive control (must still pass):** `docs/file.md` vs `[docs]` and other
  in-scope changes → `ok: true`, no violations. This guards against a check that
  merely blocks everything.

The script requires no network, no secrets, and no OpenHands invocation; it
cleans up its temp repos and leaves no committed fixtures. **This verification
does not enable, approve, or imply real invocation** — it only proves the
enforcement gate rejects out-of-scope changes when a future, separately-approved
slice produces a real diff.

## Report fields

request id, execution branch, pinned base branch, resolved base commit,
worktree path, worktree-after-run (preserved/removed), whether OpenHands was
invoked, model config, changed files, path-enforcement result
(allowed/forbidden/protected), max-files result, diff summary, full-diff
preview + `.patch` pointer, runtime/output limits, tool-level invocation
constraint checks, invocation readiness checks, validation output and limit
result, refused/blocked actions, and human next steps.

## Human review

The executor produces changes for review only (when invocation is later
enabled). A human reviews the diff (worktree preserved + `.patch`) and uses the
gated **Source Control panel** for any commit/push/PR. The executor itself never
commits or pushes.

## Known limitations (this slice)

- Real OpenHands invocation is intentionally OFF
  (`OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false`); enabling it is a future,
  separately-approved slice. The `allowedPaths` boundary-match blocker (#4),
  enforcement rejection-path verification (#3), worktree build-dependency
  detection/reporting (#5), base-branch pinning (#6), tool-level invocation
  constraints (#7), invocation readiness gate (#8), and executor
  runtime/file/output limit reporting are addressed as safety scaffolding (see
  above).
- `npm run build` inside a fresh worktree now performs a dependency preflight
  first. If `node_modules` / local Vite binaries are absent, the run is clearly
  reported as setup-gated. This slice deliberately does not install, copy, or
  link dependencies; choosing such a provisioning strategy remains a separate
  approval decision. `node --check` works as-is.
- Executor-created `openhands/exec-<id>` branches are never auto-deleted; a
  future human-gated cleanup can prune them. Preserved worktrees also require a
  human-gated cleanup after review.

## Agent Mode integration boundary

- The worktree executor may *eventually* implement approved Agent Mode plans
  (see `docs/agent_mode/AGENT_MODE_STANDARD.md`).
- Real OpenHands invocation remains **OFF**
  (`OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false`).
- Enabling future invocation still requires the remaining known blockers above
  to be fixed first, on a separate, explicitly-approved branch.
- Agent Mode scaffolding (docs/schema) does **not** authorize execution and
  changes no runtime behaviour.
