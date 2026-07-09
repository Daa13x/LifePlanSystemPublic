---
name: pr-merge-safety-review
description: Run a pre-merge safety gate over a PR — expected base/head, clean workspace, changed files, checks, dangerous-behaviour scan, mergeability — and give a go/no-go with the missing checks.
platforms:
  - claude
  - chatgpt
version: 0.1.0
status: draft
safety_level: 2
requires_repo_access: false
requires_external_action: false
automation_eligible: false
---

# PR Merge Safety Review

## Purpose

Before merging a PR, produce a structured go/no-go so nothing is merged on a
hunch. This skill reasons over the facts Alex provides; Fable/Codex (or Alex via
the GitHub UI) performs the actual merge.

## When to use

Use before merging any PR — "safe to merge?", "check this before I merge".

## Do not use when

- The merge decision is already made and verified — proceed to the gated merge.

## Required inputs

- Expected base and head branches.
- The changed-files list (or a way to get it).
- Check/verifier results and build status.
- Mergeability state (clean / conflicts / behind).
- Whether the working tree is clean.

## Process

1. Confirm base and head match what was expected (a retargeted or wrong base is
   a stop).
2. Confirm the workspace is clean — no unexpected uncommitted changes.
3. Review the changed-files list for scope creep or unexpected files.
4. Confirm the required checks/verifiers and build passed.
5. Scan for dangerous behaviour in the diff (see Safety checks).
6. Confirm mergeability is clean.
7. Give a go/no-go and list any missing checks.

## Safety checks

- **Stop** if the diff enables real OpenHands invocation, flips
  `OPENHANDS_EXECUTOR_INVOCATION_ENABLED`, adds a network/model call, adds an
  invoke/run UI, adds runtime invocation behaviour, or adds dependency
  install/copy/link behaviour.
- **Stop** if it touches private memory or source-of-truth files, or contains
  anything secret-like.
- **Stop** if base/head are not what was expected, or the workspace is dirty with
  unexplained changes.
- Require post-merge validation to be planned (which checks to re-run on `main`).

## Output format

- **Go / No-go:** one word plus one line.
- **Base/head:** expected vs actual.
- **Workspace:** clean / dirty.
- **Changed files:** in-scope / concerns.
- **Checks:** passed / missing.
- **Danger scan:** clear / flags.
- **Mergeability:** clean / not.
- **Missing before merge:** bullet list (empty if none).
- **Post-merge validation:** the checks to re-run.

## Examples

- Input: PR with expected base/head, 6 docs files, all verifiers passing, clean
  mergeability → **Go**, post-merge = re-run the verify suite on `main`.
- Input: PR whose base was silently changed → **No-go**, base mismatch.

## Failure modes

- Approving without confirming the danger scan.
- Forgetting to specify post-merge validation.

## Escalate to Fable/Codex when

The actual merge and post-merge validation are needed — those run against the
real repo under the usual gates. This skill only produces the go/no-go.

## Notes for Claude export

Instruction-only. Package the folder as `SKILL.md`.

## Notes for ChatGPT export

Keep the "Stop if…" list intact; it is the core value of the skill.
