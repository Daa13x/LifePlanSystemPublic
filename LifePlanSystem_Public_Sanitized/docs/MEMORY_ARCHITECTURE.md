# Memory Architecture — Three-Layer Model

Status: public-safe implementation guide

## Purpose

Separate reusable system design from personal knowledge and sensitive context.

This reduces bloat, protects privacy, improves future exports, and makes memory easier to review and correct.

## Layer 1 — System Layer

Purpose: describe how LifePlanSystem works.

Examples:

- rules;
- templates;
- generic routers and protocols;
- governance rules;
- source-review workflows;
- write-pipeline rules.

Rules:

- Use generic wording.
- Avoid personal names and direct identifiers unless required for provenance or historical audit trails.
- Do not store detailed personal context here.
- Link to personal or sensitive records by ID when needed.

## Layer 2 — Personal Knowledge Layer

Purpose: store durable user-specific knowledge that is useful for future decisions and support.

Examples:

- confirmed facts;
- preferences;
- constraints;
- decision rules;
- repeated patterns;
- current-state summaries.

Rules:

- Use stable IDs.
- Classify memory items before promotion.
- Preserve uncertainty and sensitivity labels.
- Do not treat every passing thought as permanent truth.
- Promote into canonical source-of-truth only after explicit approval.

## Layer 3 — Sensitive Vault Layer

Purpose: isolate high-sensitivity context.

Examples:

- private relationship context;
- health and mental-health context;
- legal matters;
- financial vulnerability;
- employment conflict;
- private messages or screenshots;
- third-party personal details;
- anything harmful, embarrassing, or identifying if exported casually.

Rules:

- Store detailed sensitive context only when necessary.
- Prefer concise summaries over raw transcript.
- Cross-reference by stable ID instead of duplicating sensitive content across files.
- Never include sensitive-vault details in public-safe exports.
- Do not promote to canonical source-of-truth without explicit approval.

## Stable Memory IDs

Use IDs where practical:

```text
MEM-YYYY-MM-DD-###
SENS-YYYY-MM-DD-###
```

Use `MEM` for normal memory holding entries.
Use `SENS` for sensitive vault entries or pointers.

IDs should remain stable even if the memory is corrected, moved, superseded, or promoted.

## Cross-reference rule

Generic docs should avoid repeating private details.

Instead of copying sensitive context, use a pointer:

```text
Related memory: MEM-YYYY-MM-DD-###
```

or:

```text
Sensitive reference: SENS-YYYY-MM-DD-###
```

The detailed content should remain in the correct private/sensitive holding file.

## Save versus promote

Saving means: a useful item was recorded in an inbox or holding file.

Promotion means: a reviewed item became canonical source-of-truth.

Rules:

- Saving can happen after user approval or under an approved autosave workflow.
- Promotion requires explicit approval.
- The assistant must not claim a save or promotion happened unless a file write or commit actually succeeded.
