# Skill Template

Copy this file to `docs/agent_mode/skills/starter/<skill-name>/SKILL.md` and
fill every field. This template file itself is **not** a skill — the verifier
only checks files literally named `SKILL.md`, so the empty metadata below is
never scanned.

Keep skills instruction-only. No scripts, no code execution, no external calls,
no secrets, no private memory, no source-of-truth edits. When a skill needs to
mention the concept of durable truth, write it as "source of truth" or
"source-of-truth" (prose), never as the underscore path token, so the skill is
clearly discussing routing rather than touching protected files.

---

```markdown
---
name:
description:
platforms:
  - claude
  - chatgpt
version:
status: draft
safety_level:
requires_repo_access: false
requires_external_action: false
automation_eligible: false
---

# Skill Name

## Purpose

## When to use

## Do not use when

## Required inputs

## Process

## Safety checks

## Output format

## Examples

## Failure modes

## Escalate to Fable/Codex when

## Notes for Claude export

## Notes for ChatGPT export
```

## Field notes

- **name** — kebab-case, matches the folder name.
- **description** — one line; this is what makes the skill trigger, so make it
  specific.
- **platforms** — `claude`, `chatgpt`, or both.
- **status** — `draft` → `stable` → (optionally) `exported`.
- **safety_level** — 0–6 per the LifeSkillSystem Skill Library Plan. It is the
  highest capability the skill's output could lead to.
- **requires_repo_access** — `true` if the skill's output implies reading/editing
  the repo (the human or an agent does the actual access, never the skill).
- **requires_external_action** — `true` if the skill drafts something a human
  sends/submits (letters, forms, messages). Such skills are Level 5+.
- **automation_eligible** — keep `false`. Automation is a separate, approval-gated
  lane.

## Required sections (checked by the verifier)

The metadata fields `name`, `description`, `platforms`, `status`, `safety_level`
and the sections **Purpose**, **When to use**, **Safety checks**, **Output
format**, and **Escalate to Fable/Codex when** are required by
`npm run verify:lifeskillsystem-skills`. The other sections are strongly
recommended for quality.
