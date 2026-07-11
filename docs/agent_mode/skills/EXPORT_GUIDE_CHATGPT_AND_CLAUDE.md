# Skill Export Guide — ChatGPT and Claude

How to take a repo-owned skill and use it inside Claude or ChatGPT. Every step
here is **manual and human-performed**. Nothing in this repo uploads a skill to
any account automatically.

The repo copy under `docs/agent_mode/skills/` is always the canonical version.
Platform copies are downstream exports that can drift; re-sync them from the repo
by hand when they do.

## Claude export

- Each skill lives in its own folder containing a `SKILL.md` (metadata +
  instructions).
- To use it in Claude, package the skill folder as a **ZIP** and upload it
  manually.
- Keep the first skills **instruction-only** — no scripts or resources — until
  the content has been reviewed and proven useful.
- Do not include scripts until they have been reviewed separately.
- Do not include private memory, source-of-truth content, or secrets in a skill
  folder.

## ChatGPT export

- Prefer **instruction-only** skills first.
- Where ChatGPT Skills are available, prepare an equivalent skill folder from the
  same `SKILL.md`.
- Where a skill is not the best fit for the ChatGPT feature set, convert the
  skill content into one of:
  - Custom GPT instructions,
  - Project instructions,
  - an uploaded knowledge file, or
  - a reusable prompt template.
- Do not add **Actions** unless explicitly approved.
- Do not add external APIs unless explicitly approved.

## LifePlanSystem web engine use

LifePlanSystem can **store and surface** skill docs, prompt templates, and export
bundles — it is a good home for the canonical library and for showing Alex which
skills exist and what they do.

It must **not** assume it can automatically install skills into Alex's personal
Claude or ChatGPT accounts. That would require a specific connector or browser
workflow **and** Alex's explicit per-action approval. Until such a workflow
exists and is approved, export stays manual: the web engine may present a bundle
to download, but a human does the upload.

## Manual setup checklist

1. **Review** the skill content end to end.
2. **Remove private info** — no personal data, secrets, source-of-truth content,
   or memory dumps.
3. **Package** the skill folder (ZIP for Claude; the appropriate form for
   ChatGPT).
4. **Upload manually** to the target platform.
5. **Test** the trigger prompts listed in the skill.
6. **Revise the description** if the skill does not trigger reliably — the
   `description` field is what most affects triggering.
7. **Keep the canonical version in the repo** and re-export after any change.

## What this guide does not do

- It does not upload anything.
- It does not call Claude, ChatGPT, OpenHands, or any API.
- It does not add Actions, connectors, or external integrations.
- It does not change `OPENHANDS_EXECUTOR_INVOCATION_ENABLED` or any runtime
  behaviour.
