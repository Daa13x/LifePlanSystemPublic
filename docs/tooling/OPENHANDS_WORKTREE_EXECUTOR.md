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
   on a dedicated `openhands/exec-<id>` branch (from `HEAD`). The main working
   tree, main/master, and the user's current branch are never touched.
4. Invoke OpenHands — **disabled**; records `invoked: false` and makes no edits.
5. Compute the **actual** changed files/diff in the worktree and enforce
   allowedPaths, forbiddenPaths, the protected-path block list, and
   maxFilesChanged **against the real diff** (not the declared intent).
6. Run **only** an allowlisted validation command (`node --check server/index.js`
   or `npm run build`) inside the worktree.
7. Write a report to `.lps/tooling/openhands/reports/<id>.md`.
8. Teardown removes the throwaway worktree (never deletes the branch).

## Fixed OpenHands wiring (request JSON can never override)

- model `openai/qwen2.5-coder:14b-gpu`
- base URL `http://host.docker.internal:11434/v1`
- key `dummy`

The request cannot override the model, endpoint, shell commands, git
operations, protected paths, or the validation allowlist.

## What it never does

- Never invokes OpenHands in this build (flag off).
- Never edits the main working tree, `main`/`master`, or the user's branch.
- Never auto-commits, auto-pushes, auto-merges, force-pushes, `reset --hard`,
  deletes branches, or pushes to `main`/`master`.
- Never runs arbitrary request-supplied shell.

## Report fields

request id, execution branch, worktree path, whether OpenHands was invoked,
model config, changed files, path-enforcement result (allowed/forbidden/
protected), max-files result, diff summary, full diff, validation output,
refused/blocked actions, and human next steps.

## Human review

The executor produces changes for review only (when invocation is later
enabled). A human reviews the diff and uses the gated **Source Control panel**
for any commit/push/PR. The executor itself never commits or pushes.

## Known limitations (this slice)

- Real OpenHands invocation is intentionally OFF; enabling it is a future,
  separately-approved slice that must also switch teardown to **preserve** the
  worktree so the human can review real edits.
- `npm run build` inside a fresh worktree needs a dependency-sharing strategy
  (worktrees do not copy gitignored `node_modules`); `node --check` works
  as-is. Left as future work.
- Executor-created `openhands/exec-<id>` branches are never auto-deleted; a
  future human-gated cleanup can prune them.
