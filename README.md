# LifePlanSystemPublic

Sanitised public scaffold for the LifePlanSystem UI/pass-through concept.

This repository contains **structure and design only**. It deliberately excludes private memories, therapy context, health details, relationship details, legal details, and personal source-of-truth.

## Purpose

LifePlanSystemPublic is a clean collaboration scaffold for designing a UI around a Markdown/Git-backed LifePlanSystem.

The UI should act as a control centre/pass-through layer:

```text
User
  ↓
LifePlan UI
  ↓
Markdown/Git repository source-of-truth
  ↓
AI model(s) for review, planning, summarising, ranking, and proposal generation
```

## Core rules

- Repository/Markdown remains source-of-truth.
- AI proposes; user approves meaningful changes.
- Historical records are preserved.
- Facts, hypotheses, predictions, preferences, and interpretations are separated.
- Important claims should have provenance and confidence.
- The UI must not become a second competing memory system.

## Start here

- `docs/ui/UI_PRODUCT_SPEC.md`
- `docs/architecture/SYSTEM_ARCHITECTURE.md`
- `rules/LIS_RULES_SANITISED.md`
- `docs/handoffs/COLLABORATOR_HANDOFF.md`
