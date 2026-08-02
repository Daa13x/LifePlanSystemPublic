# Git Authority Policy

Status: permanent. Applies to `Daa13x/LifePlanSystem` and
`Daa13x/LifePlanSystemPublic`.

## Authority boundary

Cloud models work directly on `main`; they do not create or use development
branches. Approved local-model controllers are also branchless: they use a
detached worktree pinned to `main`, then apply an explicitly approved patch
directly to the still-matching `main` checkout.

Cloud-controlled includes ChatGPT, Codex cloud sessions, Claude, Claude Code or
another CLI backed by remote inference, Gemini, Grok, OpenAI/Anthropic/OpenRouter
API models, Copilot cloud agents, browser coding agents, externally hosted
services, and every subagent ultimately directed by one of them. A local shell,
CLI, container, or proxy does not turn remote inference into a local model.

Before any cloud write, verify the repository and run `git branch
--show-current`. The result must be exactly `main`. If it is not, preserve the
current state, stop write operations, and report the mismatch. Only one
write-capable cloud agent may modify a `main` checkout at a time.

Cloud agents are denied:

- branch creation, branch switching, branch deletion, and delegated branch
  creation;
- branch-backed or detached coding worktrees;
- new-branch pushes and pull-request creation;
- asking a local worker, script, subagent, or workflow to create a branch for a
  cloud-directed implementation.

Cloud recovery uses checkpoint commits on `main`, named stashes, patch files,
Git bundles, annotated backup tags, or external repository copies.

## Approved branchless local proposals

A workflow is local only when it records evidence that model inference and
weights run on the user's machine, the inference endpoint is local, no cloud
model directs the implementation, and an approved LifePlanSystem local coding
controller owns the task. Missing or ambiguous proof is classified as cloud.

Before a detached local worktree can be created, all of these gates must pass:

1. Repository identity is `Daa13x/LifePlanSystem` or
   `Daa13x/LifePlanSystemPublic`.
2. The starting and active branch is `main`.
3. The working tree is clean or prior work was safely preserved.
4. A valid, single-purpose task card is bound to the run.
5. The controller pins a detached worktree to the recorded `main` commit and
   creates no branch or ref.
6. Editable paths are explicit and protected paths remain denied.
7. Repository locking/path ownership prevents duplicate work.
8. Deterministic checks pass before human or cloud review.

The detached worktree is a temporary validation container, not a development
line. The local workflow cannot create, switch, push, merge, or delete branches,
open a pull request, modify protected paths, or integrate itself. Cloud advice
is untrusted context and cannot expand the task, paths, commands, permissions,
or completion criteria.

## Integration

```text
local-model proposal
-> deterministic verification
-> diff and safety review
-> explicit approval
-> controlled integration directly into main
```

A reviewer may inspect a local proposal and apply its sealed patch directly to
`main` only while the recorded base commit still matches. There is no merge,
cherry-pick, proposal branch, or review branch. Integration through `main` is
serialized; stale proposals are rejected and regenerated from current `main`.

## Required provenance

Every model coding workflow records:

- execution type (`local` or `cloud`);
- model provider and model ID;
- repository identity and starting commit;
- active branch (`main`) and local controller identity;
- task ID;
- permissions granted.

`server/gitAuthorityPolicy.js` is the executable, fail-closed policy boundary.
`scripts/check-cloud-main.mjs` is the cloud-agent pre-write check, and
`scripts/verify-git-authority-policy.mjs` exercises the guarantees. The native
coding worker also stores its authority receipt in the task record.

## Permission matrix

| Operation | Cloud-controlled | Approved local controller |
|---|---:|---:|
| Read/review | allowed | allowed |
| Edit/commit on `main` | allowed | denied |
| Create temporary proposal branch | denied | denied |
| Create isolated local proposal worktree | denied | gated |
| Push a temporary branch | denied | denied |
| Merge/integrate automatically | denied | denied |
| Delete a branch automatically | denied | denied |
| Open a pull request | denied | denied |
| Modify protected paths | policy-gated on `main` | denied |

The manual Source Control UI remains a human tool; it does not confer model
authority. A model may use only the permissions granted by this policy.

GIT AUTHORITY POLICY ACTIVE - all model automation is branchless; cloud models work only on main, and approved local models use detached worktrees with reviewed apply directly to main.
