# LifeSkillSystem Skill Library Plan

## Status

- **Docs-first.** This plan and the skills it describes are Markdown only.
- No runtime automation.
- No external account upload (nothing is installed into Claude or ChatGPT
  automatically).
- No OpenHands invocation (`OPENHANDS_EXECUTOR_INVOCATION_ENABLED` stays false).
- No network/model calls.
- No private memory or source-of-truth edits.

This is a **separate lane** from the OpenHands executor / real-invocation work.
It reuses the safety vocabulary of
[`AGENT_MODE_STANDARD.md`](AGENT_MODE_STANDARD.md) but adds nothing runnable.

## Purpose

Alex repeatedly rebuilds the same prompts, checklists, and review structures by
hand — "what should Fable do next", "is this agent output safe to merge", "how
far are we", "should this be synced to memory". Each time, that thinking is
redone from scratch, often by pulling in Fable or Codex for work a normal chat
could do.

LifeSkillSystem captures those repeated workflows as **reusable skills** that a
normal ChatGPT or Claude chat can run, so:

- the repeatable "thinking / checklist / prompt-building" work does not need
  Fable or Codex every time;
- Fable and Codex are reserved for **repo-changing** work (editing files,
  running checks, opening and merging PRs, implementing code);
- the skills live in the repo as the canonical source, portable across
  platforms, and are only exported to Claude/ChatGPT by an explicit manual step.

## Platform model

LifeSkillSystem does not assume any one platform's skill format is permanent. It
keeps a neutral repo-owned source and treats each platform as an export target.

1. **Claude Skills**
   - Folder/ZIP-style skill packages.
   - A `SKILL.md` per skill (metadata + instructions).
   - Optional resources/scripts *later*, only after review — instruction-only
     first.
   - Uploaded manually by Alex; never pushed automatically.

2. **ChatGPT Skills**
   - Reusable instructions/files/code where supported.
   - Kept instruction-only first.
   - Where skills are not the best fit, the same content can be mirrored as a
     Custom GPT's instructions, a Project's instructions, or an uploaded
     knowledge file.
   - No Actions or external APIs unless explicitly approved.

3. **LifePlanSystem source skills**
   - Canonical, repo-owned Markdown skills under `docs/agent_mode/skills/`.
   - Platform-neutral: the same `SKILL.md` maps to Claude or ChatGPT.
   - Exportable to either platform later.
   - **Never** automatically uploaded without explicit approval.

The repo source is the single source of truth for skill content; platform copies
are downstream exports that can drift and be re-synced manually.

## Important separation

| Layer                 | What it does                                         | Tool                |
| --------------------- | ---------------------------------------------------- | ------------------- |
| Regular chat skills   | Thinking, reviewing, drafting, prompting, checklists | ChatGPT / Claude    |
| Repo agent work       | Edits files, runs tests, opens PRs                   | Fable / Codex       |
| LifePlanSystem memory | Stores approved durable context                      | LPS memory pipeline |
| Automations           | Only later, approval-gated                           | LPS / agents        |

The dividing line: **regular chat skills produce words** (advice, checklists,
prompts, drafts). **Fable/Codex change the repo.** A skill may *draft the prompt*
that Alex then hands to Fable/Codex, but a skill never edits files, runs
commands, or performs external actions itself.

## Skill promotion lifecycle

1. **Observed** — a repeated manual task is noticed.
2. **Backlog** — it is added as a candidate skill (see the backlog table).
3. **Draft** — a Markdown skill is written from the template.
4. **Manual test** — the skill is run by hand in a normal chat.
5. **Review** — its output is checked for quality and safety.
6. **Stable** — it is marked `status: stable` once it reliably helps.
7. **Export** — it may be exported to Claude and/or ChatGPT (manual upload).
8. **Automation candidate** — only after **explicit approval** and dedicated
   verifiers may a stable skill be considered for any automation. This step is
   out of scope for this lane.

A skill never skips from draft to automation. Steps 7 and 8 are always separate,
explicit, human-gated actions.

## Skill safety levels

These levels mirror the 0–6 permission tiers in
[`AGENT_MODE_STANDARD.md`](AGENT_MODE_STANDARD.md) so the two frameworks stay
consistent. A skill's `safety_level` is the **highest** capability its output
could lead to — even though the skill itself only ever produces text.

- **Level 0** — harmless formatting/drafting (summaries, rewrites, structuring).
- **Level 1** — advice/checklist only (recommendations, no repo or external
  effect).
- **Level 2** — prompt generation for agents (drafts prompts for Fable/Codex;
  the human still runs them).
- **Level 3** — repo-read recommendation (suggests what to read; the human or an
  agent reads it).
- **Level 4** — repo-edit prompt generation (drafts a prompt that would change
  the repo; only Fable/Codex, gated, may act on it).
- **Level 5** — external-action guidance (drafts wording for a letter, form, or
  message the human sends).
- **Level 6** — automation candidate (a workflow someone might later automate).

**Levels 5–6 must never run automatically.** A Level 5 skill drafts words for
Alex to send himself; it never sends anything. A Level 6 skill is only ever a
*candidate* described in docs — automating it requires explicit approval and
dedicated verifiers, which are out of scope here.

## Skill backlog table

All entries below are backlog candidates. Only the six starter skills in
`docs/agent_mode/skills/starter/` are drafted so far; the rest are planned.

| # | Skill | Purpose | Trigger phrases | Required inputs | Expected output | Safety level | Platform | Fable/Codex still required | Automation eligibility |
|---|---|---|---|---|---|---|---|---|---|
| 1 | LifePlanSystem Next Move | Decide the safest next step | "what next", "how far are we", "next prompt" | current lane, recent state | lane + safest next move + optional prompt | 2 | both | for repo work only | no |
| 2 | Codex Bulk Prompt Builder | Build a long-running agent prompt | "write a Codex prompt", "long-run prompt" | goal, repo assumptions, boundaries | a full phased prompt with stop conditions | 4 | yes (runs it) | no |
| 3 | Fable Review Prompt Builder | Build a focused review prompt | "review prompt", "have Fable check" | target PR/diff, concerns | a scoped review prompt | 2 | yes (runs it) | no |
| 4 | Agent Output Reviewer | Triage pasted agent output | "is this safe", "review this output" | pasted Codex/Fable output | classification + next prompt | 2 | for follow-up repo work | no |
| 5 | How Far From Finishing Estimator | Honest progress estimate | "how far are we", "are we done" | lane, merged/open PRs | per-lane status + honest gap | 1 | no | no |
| 6 | Memory Inbox Routing | Suggest where info should go | "should I sync this", "remember this?" | the item, its source | routing suggestion + permission note | 1 | no | no |
| 7 | Source-of-Truth Promotion Review | Judge promotion to durable truth | "promote to source of truth" | candidate item, evidence | promote / hold / reject + reason | 1 | no | no |
| 8 | Stop-Boundary Safety Checklist | Confirm the stop boundary holds | "safety check", "did we cross a line" | proposed change | pass/fail against boundary list | 1 | no | no |
| 9 | Runtime Safety Checklist | Pre-flight before running checks | "runtime safety", "before I run this" | intended commands | which checks to run + risks | 1 | no | no |
| 10 | OpenHands Invocation Design Review | Review invocation design docs | "review the invocation design" | design doc text | gaps + safety notes | 1 | no | no |
| 11 | Mock Transport Planning | Plan a mock-only transport step | "plan the mock transport" | current design | scoped mock-only plan | 2 | yes (implements) | no |
| 12 | PR Merge Safety Review | Pre-merge safety gate | "safe to merge", "before merging" | PR base/head/files/checks | go/no-go + missing checks | 2 | yes (merges) | no |
| 13 | Handoff Summariser | Compress a session into a handoff | "write a handoff", "summarise this" | session notes | structured handoff | 0 | no | no |
| 14 | Agent Mistake Capture | Record a mistake as a lesson | "capture this mistake" | what went wrong | structured lesson + guard idea | 1 | no | no |
| 15 | Agent Loop Retrospective | Review a multi-step agent run | "retro this run" | run log/summary | what worked / what to change | 1 | no | no |
| 16 | Admin Letter Helper | Draft admin correspondence | "help me write to X" | recipient, facts, goal | a draft letter | 5 | no | no |
| 17 | Legal/Admin Caution Drafter | Cautious wording for sensitive admin | "careful wording for X" | context, sensitivity | cautious draft + disclaimers | 5 | no | no |
| 18 | Evidence Timeline Builder | Structure events into a timeline | "build a timeline" | dated events/notes | ordered timeline + gaps | 1 | no | no |
| 19 | Mental Health Grounding Message Helper | Draft a supportive grounding note | "grounding message", "help me cope" | situation, tone | a gentle, non-clinical message + signposting | 5 | no | no |
| 20 | Universal Credit / Benefits Summary Helper | Summarise a benefits situation | "explain my UC", "benefits summary" | the facts Alex provides | a plain-language summary + questions to ask | 5 | no | no |
| 21 | Relationship / No-Contact Message Safety Check | Safety-check a personal message | "is this message ok to send" | draft message, context | risk flags + safer rewrite option | 5 | no | no |
| 22 | Job Application / CV Helper | Draft/improve application material | "improve my CV", "cover letter" | role, background | tailored draft | 1 | no | no |
| 23 | LMTR Lead Gen Prompt Builder | Build a lead-gen research prompt | "lead gen prompt for LMTR" | offer, audience | a research/outreach prompt | 2 | no | no |
| 24 | Game Build/Meta Research Prompt Builder | Build a game-research prompt | "meta research prompt" | game, question | a scoped research prompt | 2 | no | no |
| 25 | Web Research Distiller | Distil research into decisions | "distil this research" | pasted research | key points + decision + risks | 0 | no | no |
| 26 | YouTube Transcript to Project Ideas | Turn a transcript into ideas | "ideas from this video" | transcript/link summary | useful ideas + fit + next prompt | 1 | no | no |
| 27 | LifePlanSystem Sync Decision Helper | Decide what to sync where | "should this be synced" | the item, its source | ignore / handoff / memory / truth + permission note | 1 | no | no |

## Non-goals

- No skill runs itself, calls a model, hits the network, or performs an external
  action.
- No skill edits the repo, private memory, or source-of-truth files.
- No skill is uploaded to Claude or ChatGPT automatically.
- No Level 5–6 skill ever executes on its own.
- This lane does not enable, implement, or design real OpenHands invocation.

## Relationship to Agent Mode

This library is the **Level 0–1 chat layer** of the same safety model described
in [`AGENT_MODE_STANDARD.md`](AGENT_MODE_STANDARD.md). Where a chat skill's
output implies a higher-tier action (edit the repo, send a letter), the skill
must **escalate**: it produces the words and explicitly hands off to Fable/Codex
(for repo work) or to Alex (for external actions), never acting itself.
