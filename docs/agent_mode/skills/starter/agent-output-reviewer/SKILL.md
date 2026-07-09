---
name: agent-output-reviewer
description: Triage pasted Codex/Fable output into a safety classification and extract merged PRs, open PRs, checks, safety status, and the next safe prompt.
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

# Agent Output Reviewer

## Purpose

When Alex pastes a wall of Codex/Fable output, quickly tell him whether it is
safe, what actually happened, and what to do next — without re-reading it all
himself.

## When to use

Use when Alex pastes agent output and asks "is this safe", "review this", "did
this work", or similar.

## Do not use when

- There is no agent output to review.
- Alex wants a repo change verified independently — that needs Fable/Codex to
  actually run checks, not a text review.

## Required inputs

- The pasted Codex/Fable output (as much as available).
- Optionally, what the agent was asked to do.

## Process

1. Read the output for claimed actions and results.
2. Classify overall safety (see Output format).
3. Extract concrete facts: merged PRs, open PRs, checks run and their results,
   and the stated safety status.
4. Flag anything unverifiable or contradictory ("claims merged but no commit
   SHA").
5. Recommend the next safe prompt.

## Safety checks

- Do not take the output's claims as proven — mark unverifiable claims as
  "claimed, not confirmed".
- Watch for danger signals: enabling invocation, network/model calls added,
  pushes to `main`, force-push, reset, branch deletion, private-memory or
  source-of-truth edits. Any of these → classify **unsafe** and say why.
- If the output says a check passed but shows no evidence, treat it as "needs
  review", not "safe".

## Output format

- **Classification:** one of `safe` / `needs review` / `blocked` / `unsafe` /
  `duplicate — already done`.
- **Merged PRs:** list (with SHAs if present) or "none".
- **Open PRs:** list or "none".
- **Checks:** what ran and pass/fail, or "none shown".
- **Safety status:** one line.
- **Next prompt:** the safest next step, as a short prompt.

## Examples

- Input: output claiming four PRs merged with commit SHAs and all verifiers
  passing → `safe`, PRs listed, next prompt = validate main.
- Input: output that flipped a flag to true → `unsafe`, with the offending line
  quoted.

## Failure modes

- Trusting "ALL PASS" text without checking for a danger signal elsewhere.
- Missing a duplicate (work already done in a prior turn) and recommending
  redoing it.

## Escalate to Fable/Codex when

Independent verification is needed (actually running the checks, inspecting the
diff). This skill reviews text; Fable/Codex confirms against the real repo.

## Notes for Claude export

Instruction-only. Package the folder as `SKILL.md`.

## Notes for ChatGPT export

Keep the five classification labels exact so downstream habits stay consistent.
