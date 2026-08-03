# LifePlanSystem Repository Synchronization Contract

Status: permanent and fail-closed.

Applies to every human, ChatGPT, Codex, Claude, Gemini, Copilot, local model,
subagent, automation, and development tool that can modify either
`Daa13x/LifePlanSystem` or `Daa13x/LifePlanSystemPublic`.

## Required invariant

Outside the short interval in which files are actively being edited, the local
`main` checkout must be clean and must resolve to the exact same commit as
`origin/main`.

An active edit can make the working tree temporarily different from GitHub. That
edit window is permitted only after a verified synchronized start, and it must
end with a normal fast-forward push and a second exact synchronization check.
Uncommitted changes, unpushed commits, stale local bases, and stale release assets
must never be reported as synchronized.

## Mandatory lifecycle

### Before reading a task as current or changing any file

Run:

```text
npm run policy:agent-start
```

This requires:

- the approved repository identity;
- active branch exactly `main`;
- upstream exactly `origin/main`;
- no merge, rebase, cherry-pick, revert, or bisect in progress;
- a clean working tree;
- a successful authenticated fetch;
- a fast-forward pull when local `main` is only behind;
- zero commits ahead and zero commits behind after preparation.

If local `main` is ahead, publish the existing commit before starting new work.
If local and remote have diverged, stop. Preserve the work and reconcile it
explicitly. Never fix divergence with an automatic reset, rebase, merge, or
force-push.

### During work

Only one write-capable agent may use a checkout at a time. Every other model or
agent must remain read-only.

Before each commit, the installed `pre-commit` hook fetches `origin/main` and
blocks the commit when:

- another person or model advanced GitHub after the edit began;
- an earlier local commit has not yet been pushed;
- no valid synchronization preparation receipt exists;
- the branch, repository, or upstream is wrong.

A blocked stale commit must not be bypassed with `--no-verify`. Preserve the
working changes, synchronize safely, then reapply or continue from the current
remote commit.

### Immediately after every commit

Run:

```text
npm run sync:publish
```

The publish command:

- requires a clean working tree;
- fetches before pushing;
- blocks if GitHub advanced;
- permits only a normal fast-forward push from `HEAD` to `main`;
- fetches again after the push;
- requires exact matching local and remote commit hashes.

Do not create a second local commit while the first remains unpublished. The
`pre-commit` hook enforces this.

### Before ending, handing off, installing, or claiming completion

Run:

```text
npm run policy:agent-finish
```

Completion requires:

- maintainer attribution verification;
- all committed work published to `origin/main`;
- clean working tree;
- `git rev-list --left-right --count origin/main...HEAD` equal to `0 0`;
- `HEAD` exactly equal to `origin/main`.

A model must state that work is incomplete when any one of those checks fails.
It must never claim that GitHub is synchronized merely because a commit exists
locally or because a push command was attempted.

## Prohibited bypasses

The following are prohibited for model-controlled work:

- `git push --force`, `--force-with-lease`, or ref replacement;
- `git reset --hard` as synchronization;
- automatic rebase or merge to hide divergence;
- `git commit --no-verify` or `git push --no-verify`;
- deleting, disabling, replacing, or bypassing the repository hooks;
- beginning edits before `npm run policy:agent-start` passes;
- ending after a local commit without `npm run sync:publish`;
- claiming success while the working tree is dirty, local is ahead/behind, or
  the downloadable installer points to an older commit.

## Installer and release freshness

Repository synchronization and installer freshness are separate proofs. A
synchronized `main` does not prove that the downloadable installer contains that
commit.

The installer workflow must build from the pushed `main` commit. The rolling
`latest-main` tag and release asset are current only when the tag resolves to the
same commit as `main`. A failed installer build must be visibly reported as
stale; an older executable must not be described as the latest build.

## Recovery rule

When synchronization fails:

1. Stop all writers.
2. Record `git status --short --branch`, `git rev-parse HEAD`,
   `git rev-parse origin/main`, and
   `git rev-list --left-right --count origin/main...HEAD`.
3. Preserve uncommitted work with a named stash, patch, bundle, checkpoint, or
   external copy without discarding it.
4. Restore a clean `main` that can be fast-forwarded from `origin/main`.
5. Run `npm run policy:agent-start` again.
6. Reapply and review preserved work against current `main`.
7. Commit once, run `npm run sync:publish`, then run
   `npm run policy:agent-finish`.

No automated agent may choose destructive recovery on the user's behalf.

GIT AUTHORITY POLICY ACTIVE - all model automation is branchless; cloud models work only on main, and approved local models use detached worktrees with reviewed apply directly to main.
