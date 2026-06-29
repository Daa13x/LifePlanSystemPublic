# Memory Pipeline

## Purpose

Provide a safe path from raw conversation or notes into durable knowledge.

## Lifecycle

```text
Raw input
  -> Memory Inbox
  -> Review
  -> Promotion candidate
  -> Approval
  -> Source-of-truth
  -> Later review / correction / supersession
```

## Memory item types

- confirmed fact;
- preference;
- decision rule;
- pattern;
- risk/failure mode;
- open question;
- template candidate;
- prediction/hypothesis.

## Promotion rules

Promote only when useful and approved.

Do not promote:
- weak guesses;
- one-off emotional states;
- sensitive details without explicit approval;
- old context without review;
- hallucinated/inferred claims.

## Correction

When corrected:
- preserve old record;
- mark superseded where needed;
- update confidence;
- preserve audit trail.
