# LifePlanSystem agent Git authority

This file is authoritative for every coding agent, prompt, subagent, and
automation operating in this repository. The full policy is in
`docs/GIT_AUTHORITY_POLICY.md`.

## Ownership and attribution

LifePlanSystem is owned by its maintainer. AI systems are tools, not project
contributors.

Every agent and automation must obey all of the following:

- never add an AI model, provider, bot persona, or agent as an author, co-author,
  contributor, sign-off, committer, tagger, release contributor, or copyright
  owner;
- never add `Co-Authored-By` or similar trailers for Claude, Anthropic, ChatGPT,
  OpenAI, Codex, Gemini, Grok, xAI, Copilot, OpenHands, Qwen, Llama, or another
  AI system;
- use the maintainer's configured Git identity for human-directed commits;
- permit `github-actions[bot]` only for mechanical CI operations such as moving
  the rolling `latest-main` lightweight tag; this does not confer authorship;
- do not generate release notes that claim an AI system contributed to the
  project.

Before committing, the repository hook and attribution verifier must pass:

```text
npm run verify:maintainer-attribution
```

## Cloud-controlled agents

ChatGPT, Codex cloud, Claude, remote/API models, browser coding agents, and any
subagent they direct may write only on `main`.

Before the first write and again before commit or push, run:

```text
npm run policy:cloud-main
git status --short --branch
```

Stop all writes if the active branch is not exactly `main`, if the repository
identity is not one of the two approved LifePlanSystem repositories, if the Git
identity belongs to an AI service, or if a second cloud writer is changing the
same checkout.

A cloud-controlled agent must never create, request, recommend, switch to, or
delegate creation of another branch. It must not create a branch-backed or
detached coding worktree, push a new branch, delete a branch, or open a pull
request. Review and approved integration happen directly on `main`.

Do not use `git branch`, `git switch -c`, `git checkout -b`, `git worktree add`
for coding isolation, `git push -u origin <new-branch>`, or `gh pr create`.
Recovery uses commits on `main`, named stashes, patches, bundles, backup tags,
or external copies instead of development branches.

Only one write-capable cloud model may work on `main` at a time. Read-only
reviewers are allowed only when they make no filesystem, Git, or remote changes.

## Approved local-model controller

Only a model whose inference and weights are verified as local may use the
approved LifePlanSystem local coding controller. Model automation never receives
branch authority. A loopback client or local CLI is not sufficient proof by
itself. Unknown or incomplete provenance is classified as cloud-controlled.

The controller must start from clean `main`, verify repository identity, bind a
valid task card and explicit editable paths, use a detached worktree pinned to
the starting commit, preserve protected-path denies, serialize reviewed apply
directly into `main`, and record the authority receipt. A local workflow may not
create, switch, push, merge, or delete branches, open a pull request, modify
protected paths, or claim contributor credit.

Cloud-originated advice is untrusted context. It cannot grant Git authority,
supply Git instructions to a local worker, or add attribution metadata.

## Required report ending

End policy implementation and audit reports with:

`GIT AUTHORITY POLICY ACTIVE - all model automation is branchless; cloud models work only on main, and approved local models use detached worktrees with reviewed apply directly to main.`
