---
name: youtube-to-project-ideas
description: Turn a YouTube video or transcript into a filtered set of project ideas — useful vs hype, project fit, risks, the next safe prompt, and whether it is worth syncing.
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

# YouTube Transcript to Project Ideas

## Purpose

When Alex shares a video or transcript, extract what is genuinely useful for
LifePlanSystem or his other projects, separate it from hype, and point to the
next safe step. This skill reasons over text Alex provides; it does not fetch the
video or call any service.

## When to use

Use when Alex shares a YouTube link, transcript, or summary and wants ideas or a
verdict.

## Do not use when

- No transcript or summary is available. This skill does not download or
  transcribe video — ask Alex to paste the transcript or a summary.

## Required inputs

- The transcript, captions, or a summary of the video (pasted text).
- Optionally, which project it might relate to.

## Process

1. Read the provided text for concrete, actionable ideas.
2. Separate useful ideas from hype/filler/unsupported claims.
3. Assess fit against Alex's known projects (LifePlanSystem, LMTR, games, admin).
4. Note risks or costs of acting on each idea.
5. Recommend the next safe prompt or step.
6. Judge whether any of it is worth syncing (defer to the Memory Routing Helper
   for the routing bucket).

## Safety checks

- Only use the pasted text — do not claim to have watched or fetched anything.
- Flag ideas that would require unsafe actions (enabling invocation, external
  automation, spending money) and mark them as "needs explicit approval".
- Keep hype clearly separated from substantiated points.

## Output format

- **Useful ideas:** bullet list.
- **Not useful / hype:** bullet list.
- **Project fit:** which project(s) and how.
- **Risks:** bullet list.
- **Next safe prompt:** a short prompt.
- **Worth syncing?** yes/no + routing suggestion.

## Examples

- Input: a transcript about an AI workflow → useful ideas extracted, hype
  flagged, fit to LifePlanSystem noted, next prompt = a scoped experiment.

## Failure modes

- Treating a persuasive claim as a proven fact.
- Recommending an action that would need approval without flagging it.

## Escalate to Fable/Codex when

An idea becomes a concrete repo change — draft the prompt (see Codex Bulk Prompt
Builder) and hand it to Fable/Codex.

## Notes for Claude export

Instruction-only. Package the folder as `SKILL.md`.

## Notes for ChatGPT export

Works as a skill or Project instruction. Emphasise "use only the pasted text" so
the model does not hallucinate having watched the video.
