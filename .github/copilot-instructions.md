# LifePlanSystem coding instructions

Obey `AGENTS.md`, `docs/GIT_AUTHORITY_POLICY.md`, and
`docs/REPOSITORY_SYNC_CONTRACT.md`.

Run `npm run policy:agent-start` before any edit. Work only on `main` and do not
create branches, worktrees, or pull requests. The pre-commit and pre-push hooks
must remain enabled and must never be bypassed.

Run `npm run sync:publish` immediately after every commit. Do not begin another
commit while local `main` is ahead of `origin/main`.

Run `npm run policy:agent-finish` before ending or claiming completion. A clean
working tree, exact matching local/remote hashes, and divergence `0 0` are
mandatory. Never force-push, automatically rebase or merge, or reset away work.
Only one write-capable agent may use a checkout at a time.
