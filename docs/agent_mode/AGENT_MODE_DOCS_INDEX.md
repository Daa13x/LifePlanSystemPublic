# Agent Mode Docs Index

Navigation for the Agent Mode and LifeSkillSystem documentation. Everything here
is **documentation-only** — no runtime loader reads these files, and nothing in
this folder enables execution, real OpenHands invocation, or external actions.

## Agent Mode foundations

- Standard, lifecycle, permission tiers, approval gates:
  [`AGENT_MODE_STANDARD.md`](AGENT_MODE_STANDARD.md)
- Capability gap schema (documentation-only):
  [`CAPABILITY_GAP_SCHEMA.yaml`](CAPABILITY_GAP_SCHEMA.yaml)
- Skill manifest schema (documentation-only; `runtime_enabled` defaults false):
  [`SKILL_MANIFEST_SCHEMA.yaml`](SKILL_MANIFEST_SCHEMA.yaml)
- Example registry (non-executable; no approved/live skills):
  [`registry.example.yaml`](registry.example.yaml)

## LifeSkillSystem skill library (chat skills)

- Plan and skill backlog:
  [`LIFESKILLSYSTEM_SKILL_LIBRARY_PLAN.md`](LIFESKILLSYSTEM_SKILL_LIBRARY_PLAN.md)
- Skill template:
  [`skills/SKILL_TEMPLATE.md`](skills/SKILL_TEMPLATE.md)
- Export guide (Claude + ChatGPT; manual upload only):
  [`skills/EXPORT_GUIDE_CHATGPT_AND_CLAUDE.md`](skills/EXPORT_GUIDE_CHATGPT_AND_CLAUDE.md)
- Routing and local learning loop (design-only):
  [`LIFESKILL_ROUTING_LOCAL_LEARNING_LOOP.md`](LIFESKILL_ROUTING_LOCAL_LEARNING_LOOP.md)

### Starter skills (instruction-only)

- [`skills/starter/lifeskillsystem-next-move/SKILL.md`](skills/starter/lifeskillsystem-next-move/SKILL.md)
- [`skills/starter/codex-bulk-prompt-builder/SKILL.md`](skills/starter/codex-bulk-prompt-builder/SKILL.md)
- [`skills/starter/agent-output-reviewer/SKILL.md`](skills/starter/agent-output-reviewer/SKILL.md)
- [`skills/starter/memory-routing-helper/SKILL.md`](skills/starter/memory-routing-helper/SKILL.md)
- [`skills/starter/pr-merge-safety-review/SKILL.md`](skills/starter/pr-merge-safety-review/SKILL.md)
- [`skills/starter/youtube-to-project-ideas/SKILL.md`](skills/starter/youtube-to-project-ideas/SKILL.md)

## Verification commands

```bash
npm run verify:lifeskillsystem-skills
npm run verify:runtime-safety
npm run verify:openhands-stop-boundary
npm run build
```

`verify:lifeskillsystem-skills` checks that every `SKILL.md` under
`docs/agent_mode/skills/` has the required metadata and sections and contains no
runtime/secret/unsafe tokens. It is a docs completeness/safety check — it grants
no capability and runs nothing.

## Related (separate lanes)

- OpenHands invocation docs index (real invocation stays disabled):
  [`../tooling/OPENHANDS_INVOCATION_DOCS_INDEX.md`](../tooling/OPENHANDS_INVOCATION_DOCS_INDEX.md)
