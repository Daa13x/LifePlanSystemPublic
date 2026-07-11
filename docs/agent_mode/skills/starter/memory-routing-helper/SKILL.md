---
name: memory-routing-helper
description: Suggest where a piece of information should go — ignore, temporary handoff, memory inbox candidate, source-of-truth candidate, warning pattern, or needs explicit permission — without syncing anything automatically.
platforms:
  - claude
  - chatgpt
version: 0.1.0
status: draft
safety_level: 1
requires_repo_access: false
requires_external_action: false
automation_eligible: false
---

# Memory Routing Helper

## Purpose

Help Alex decide where something belongs when he asks "should I remember this?"
or "should this be synced?" — a routing recommendation only. It never writes to
memory or to any durable store.

## When to use

Use when Alex asks whether something should be saved, synced, remembered, or
promoted.

## Do not use when

- Alex is asking for the information to actually be written somewhere — that is a
  gated action, not this skill's job.

## Required inputs

- The item in question (the fact, note, or event).
- Where it came from (chat, agent output, a document).

## Process

1. Judge durability: is it a one-off, a short-lived handoff, or a durable fact?
2. Judge sensitivity: does it involve personal, legal, or private detail?
3. Map it to one routing bucket (see Output format).
4. If it is a durable or sensitive candidate, state that it needs **explicit
   permission** before any sync.

## Safety checks

- Always end with: **do not sync automatically.** Routing is a suggestion; a
  human decides and performs any write.
- Never recommend writing directly to source-of-truth files; the most it can
  suggest is a *candidate* for review.
- Flag anything that looks like a secret or private credential as "do not store
  here — handle privately".

## Output format

One routing choice, with a one-line reason:

- `ignore` — not worth storing.
- `temporary handoff` — useful for the current thread only.
- `memory inbox candidate` — worth proposing to the memory inbox for review.
- `source-of-truth candidate` — durable enough to *propose* for promotion.
- `warning / failure pattern` — a mistake or risk worth capturing as a lesson.
- `needs explicit permission` — sensitive; confirm with a human before anything.

Always followed by: **Do not sync automatically.**

## Examples

- Input: "should I remember that PR #24 merged at commit X?" → `memory inbox
  candidate`, reason: durable project state; do not sync automatically.
- Input: a personal medical detail → `needs explicit permission`; do not sync
  automatically.

## Failure modes

- Recommending a durable write without the permission caveat.
- Treating a transient status as a durable fact.

## Escalate to Fable/Codex when

An approved write into a repo-tracked store is wanted — that is a gated memory
pipeline action performed by a human/agent, never by this skill.

## Notes for Claude export

Instruction-only. Package the folder as `SKILL.md`.

## Notes for ChatGPT export

Keep the six routing buckets and the "Do not sync automatically" line verbatim.
