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

## Diff preservation (blockers #1 and #2 — addressed)

- **Full uncapped `.patch`:** every run writes the complete diff to
  `.lps/tooling/openhands/reports/<id>.patch`. The report embeds only a
  4000-char preview and points to the `.patch` for the full content, so a large
  future diff is never lost to the preview cap.
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

## Report fields

request id, execution branch, worktree path, worktree-after-run
(preserved/removed), whether OpenHands was invoked, model config, changed files,
path-enforcement result (allowed/forbidden/protected), max-files result, diff
summary, full-diff preview + `.patch` pointer, validation output,
refused/blocked actions, and human next steps.

## Human review

The executor produces changes for review only (when invocation is later
enabled). A human reviews the diff (worktree preserved + `.patch`) and uses the
gated **Source Control panel** for any commit/push/PR. The executor itself never
commits or pushes.

## Known limitations (this slice)

- Real OpenHands invocation is intentionally OFF
  (`OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false`); enabling it is a future,
  separately-approved slice (remaining blockers: rejection-path test against a
  real violating diff, tighter `allowedPaths` matching, worktree build-deps,
  base-branch pinning, and tool-level `allowedPaths`/runtime caps on invocation).
- `npm run build` inside a fresh worktree needs a dependency-sharing strategy
  (worktrees do not copy gitignored `node_modules`); `node --check` works
  as-is. Left as future work.
- Executor-created `openhands/exec-<id>` branches are never auto-deleted; a
  future human-gated cleanup can prune them. Preserved worktrees also require a
  human-gated cleanup after review.

## Agent Mode integration boundary

- The worktree executor may *eventually* implement approved Agent Mode plans
  (see `docs/agent_mode/AGENT_MODE_STANDARD.md`).
- Real OpenHands invocation remains **OFF**
  (`OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false`).
- Enabling future invocation requires the 7 known blockers above to be fixed
  first, on a separate, explicitly-approved branch.
- Agent Mode scaffolding (docs/schema) does **not** authorize execution and
  changes no runtime behaviour.
