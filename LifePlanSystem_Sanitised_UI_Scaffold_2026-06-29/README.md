# LifePlanSystem — Sanitised UI Scaffold

This is a clean, non-personal version of the LifePlanSystem project structure.

It is designed so a collaborator or AI system can understand the architecture and help build a UI without seeing private memories, therapy content, health details, relationship details, legal details, or personal source-of-truth.

## What this is

A repo-backed personal operating system / AI coordination layer.

The repository is the source of truth. The UI should be a pass-through/control layer that helps browse, review, stage, approve, and commit changes.

## What this is not

- Not a dump of private memory.
- Not a therapy archive.
- Not a clone of a person.
- Not a database replacement for the repo.
- Not a system that silently lets AI rewrite important records.

## Core idea

```text
User
  ↓
UI / Control Centre
  ↓
Markdown + Git repository source-of-truth
  ↓
AI models for review, planning, summarising, ranking, and proposal generation
```

## Suggested first build

Start with a simple local or web UI that can:

1. Browse key repo files.
2. Show planner/dashboard cards.
3. Show memory inbox counts.
4. Show approval queue items.
5. Let the user select files for AI review.
6. Create staged Markdown proposals.
7. Commit only after explicit approval.

See:

- `docs/ui/UI_PRODUCT_SPEC.md`
- `docs/architecture/SYSTEM_ARCHITECTURE.md`
- `rules/LIS_RULES_SANITISED.md`
