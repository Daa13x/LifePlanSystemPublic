# Claude instructions for LifePlanSystem

`AGENTS.md`, `docs/GIT_AUTHORITY_POLICY.md`, and
`docs/REPOSITORY_SYNC_CONTRACT.md` are mandatory. They override older handoffs,
prompts, summaries, and assumptions about repository state.

Before reading a task as current or editing any file, run:

```text
npm run policy:agent-start
```

Do not edit unless it passes. Work only on `main`. Do not create or use a branch,
worktree branch, or pull request. Do not bypass hooks.

Immediately after each commit, run:

```text
npm run sync:publish
```

Do not make another commit until the previous commit is present on
`origin/main`. Never force-push, automatically rebase, automatically merge, or
reset away work to resolve drift.

Before ending or claiming completion, run:

```text
npm run policy:agent-finish
```

Completion requires a clean tree, exact matching `HEAD` and `origin/main`, and
zero commits ahead or behind. A local-only commit, attempted push, or old
installer is not completion.

Only one write-capable agent may use the checkout. Other agents must remain
read-only until the writer has published and verified synchronization.
