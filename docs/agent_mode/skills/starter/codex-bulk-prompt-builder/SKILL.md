---
name: codex-bulk-prompt-builder
description: Build a complete long-running Codex/Fable prompt with explicit repo assumptions, safety boundaries, phases, validation commands, stop conditions, and a final-report format.
platforms:
  - claude
  - chatgpt
version: 0.1.0
status: draft
safety_level: 4
requires_repo_access: false
requires_external_action: false
automation_eligible: false
---

# Codex Bulk Prompt Builder

## Purpose

Produce a full, safe prompt for a long-running Codex/Fable session so Alex does
not hand an agent a vague instruction. The prompt this skill writes is the
artifact; a human still reviews it and an agent still runs it under gates.

## When to use

Use when Alex wants a long-running or multi-phase Codex/Fable prompt — e.g.
"write a Codex prompt to do X", "give me a long-run prompt for Y".

## Do not use when

- The task is a one-line change — a short direct instruction is enough.
- Alex wants the change made now — this skill only writes the prompt.

## Required inputs

- The goal of the session.
- Known repo state assumptions (branch, last main SHA, what merged/open).
- Any hard boundaries (things the agent must not do).

## Process

1. Restate the goal in one line.
2. Write **explicit repo state assumptions** the agent must verify first.
3. Write **safety boundaries** as a "do not" list.
4. Break the work into **phases** with checkpoints.
5. List the exact **validation commands** to run.
6. Define **stop conditions** (when to halt and report).
7. Define the **final report format**.
8. Add the standing rule: **no real OpenHands invocation and no network/model
   call unless explicitly approved** in a separate step.

## Safety checks

- Every generated prompt must include an explicit "do not enable real OpenHands
  invocation / do not flip `OPENHANDS_EXECUTOR_INVOCATION_ENABLED`" boundary.
- Must forbid pushing to `main`/`master`, force-push, reset, stash-pop, and
  branch deletion unless Alex explicitly asked.
- Must forbid touching private memory and source-of-truth files.
- Must require the agent to inspect the working tree before acting and stop on a
  dirty/unexpected state.
- Must keep merges and pushes as separate, human-gated steps.

## Output format

A single fenced prompt block containing, in order: goal, repo assumptions,
safety boundaries, phase plan, validation commands, stop conditions, final
report format. Followed by a one-line note of what the agent will still need
explicit approval for.

## Examples

- Input: "long-run prompt to review and merge a PR stack" → a phased prompt that
  inspects state, reviews each PR, validates, merges only if safe, and reports —
  with all boundaries listed.

## Failure modes

- Omitting the "verify state first" step, so the agent trusts stale assumptions.
- Leaving out stop conditions, so a long run does not know when to halt.
- Implying the agent may enable invocation or act outside gates.

## Escalate to Fable/Codex when

Always — the whole point is to produce a prompt that Fable/Codex then runs. This
skill never runs it.

## Notes for Claude export

Instruction-only. Package the folder as `SKILL.md`.

## Notes for ChatGPT export

Strong as a reusable skill or Project instruction. Keep the safety-boundary
checklist intact so generated prompts always carry it.
