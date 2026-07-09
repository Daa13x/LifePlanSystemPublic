---
name: lifeskillsystem-next-move
description: Decide the single safest next move for LifePlanSystem work and, when useful, draft the exact prompt to run next.
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

# LifePlanSystem Next Move

## Purpose

Turn "what should I do next?" into a clear, safe recommendation: which lane the
work is in, the safest next step, why, and — only if it helps — the exact prompt
to hand to Fable/Codex or to run in a normal chat. It replaces re-deriving the
next move from scratch every time.

## When to use

Use when Alex asks any of:

- "what next" / "what should I do next"
- "next prompt"
- "how far are we"
- "should I keep using Codex"
- "what should Fable do"

## Do not use when

- The task is a concrete repo change already decided — hand that straight to
  Fable/Codex.
- Alex wants the work *done*, not planned. This skill plans; it does not edit
  files, run commands, or open PRs.

## Required inputs

- The current lane or topic (e.g. "OpenHands scaffolding", "skill library",
  "admin letters").
- A short note of recent state: what merged, what's open, what's blocked.
- Any constraint Alex has stated (deadlines, things to avoid).

If the state is unknown, say so and list what to check first rather than
guessing.

## Process

1. Identify the current lane and its last known state.
2. List the candidate next steps.
3. Pick the **single safest** one that makes real progress.
4. Explain why it is the safest useful move.
5. If a prompt would help, draft it (see the Codex Bulk Prompt Builder or Fable
   Review Prompt Builder skills for shape).
6. Call out what **not** to do yet (e.g. "do not enable invocation", "do not
   merge without review").

## Safety checks

- Never recommend enabling real OpenHands invocation or flipping
  `OPENHANDS_EXECUTOR_INVOCATION_ENABLED`.
- Never recommend touching private memory or source-of-truth files directly.
- Prefer the reversible, smaller step when two options are close.
- If the safest move is "stop and confirm with a human", say that plainly.

## Output format

- **Current lane:** one line.
- **Safest next move:** one or two sentences.
- **Why:** short justification.
- **Prompt (optional):** a fenced block, only if it adds value.
- **Do not do yet:** a short bullet list of boundaries.

## Examples

- Input: "how far are we on OpenHands?" → Output naming the scaffolding lane as
  complete, the real-invocation lane as design-only, and "mock transport only"
  as the next safe step, with a ready-to-paste prompt.
- Input: "what should Fable do next?" → Output recommending one scoped repo task
  and a prompt, with boundaries listed.

## Failure modes

- Recommending several steps at once instead of one clear next move.
- Drafting a prompt that assumes an unverified repo state — always state
  assumptions.
- Suggesting an action above Level 2 without escalating (see below).

## Escalate to Fable/Codex when

The chosen next move is a repo change (edit files, run checks, open or merge a
PR). This skill drafts the prompt; Fable/Codex performs the change under the
usual gates.

## Notes for Claude export

Package this folder as-is (`SKILL.md`). Instruction-only; no resources needed.

## Notes for ChatGPT export

Works well as a skill or as Custom GPT / Project instructions. Keep the
"Do not do yet" boundaries verbatim so the model reliably surfaces limits.
