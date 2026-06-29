# Memory Metadata Standard

Status: public-safe implementation standard

## Purpose

Define the minimum metadata for saved memory items so they can be reviewed, corrected, moved, or promoted without losing context.

## Required fields for new memory entries

Use these fields where practical:

```text
Memory ID:
Date saved:
Source chat/topic:
Status:
Sensitivity:
Confidence:
Item type:
Evidence basis:
Review cadence:
Related IDs:
Correction history:
Promotion recommendation:
```

## Memory ID

Recommended formats:

```text
MEM-YYYY-MM-DD-###
SENS-YYYY-MM-DD-###
FACT-######
```

Use:

- `MEM` for memory inbox or holding entries;
- `SENS` for sensitive memory or sensitive pointers;
- `FACT` for canonical source-of-truth facts.

IDs should not change when an item is moved, corrected, superseded, or promoted.

## Item types

Allowed types:

```text
Fact
Current State
Preference
Decision Rule
Interpretation
Open Question
Risk or Failure Mode
Constraint
Support Pattern
Prompt or Template Candidate
Source Idea
```

A memory may have more than one type.

## Sensitivity labels

Use:

```text
Low
Medium
High
Sensitive Vault
```

Low: safe for ordinary internal use.
Medium: personal but not highly private.
High: private, context-sensitive, or potentially harmful if casually exported.
Sensitive Vault: should be isolated and only referenced when directly relevant.

## Confidence labels

Use:

```text
High
Medium
Low
Mixed
```

High: direct user confirmation or durable record.
Medium: likely but still interpretive or context-dependent.
Low: weak, inferred, old, or needs confirmation.
Mixed: entry contains multiple items with different confidence levels.

## Evidence basis

Record the basis briefly:

```text
Direct user self-report
Repeated chat pattern
Uploaded document
Approved source-of-truth entry
Inference from context
External source
```

Do not inflate confidence because something feels emotionally plausible.

## Review cadence

Use one of:

```text
On correction
Monthly
Quarterly
Before major decision
Before promotion
When context changes
```

Dynamic or sensitive context should be reviewed before being used for major decisions.

## Related IDs

Use related IDs to avoid duplicating memory.

Relationship labels may include:

```text
supports
affects
depends_on
conflicts_with
supersedes
```

## Correction history

Do not silently overwrite important memory.

Use:

```text
Correction history:
- YYYY-MM-DD: <old statement> -> <new statement>; reason: <reason>
```

If the user corrects a memory, treat the correction as higher priority than older chat history.

## Promotion recommendation

Use:

```text
Keep in inbox
Keep sensitive
Promote with approval
Turn into template
Turn into todo
Supersede
Archive after review
```

Promotion into canonical source-of-truth still requires explicit approval.
