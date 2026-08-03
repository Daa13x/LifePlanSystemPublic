# Gemini and other model instructions for LifePlanSystem

Follow `AGENTS.md`, `docs/GIT_AUTHORITY_POLICY.md`, and
`docs/REPOSITORY_SYNC_CONTRACT.md` exactly.

Before any edit:

```text
npm run policy:agent-start
```

After every commit:

```text
npm run sync:publish
```

Before ending or claiming success:

```text
npm run policy:agent-finish
```

Work only on `main`. Never create branches or pull requests, bypass hooks,
force-push, automatically rebase or merge, reset away work, stack a second
unpushed commit, or claim synchronization without a final fetch and exact hash
match. Only one write-capable agent may use the checkout at a time.
