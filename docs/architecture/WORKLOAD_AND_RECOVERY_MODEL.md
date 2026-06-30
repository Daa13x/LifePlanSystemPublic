# Workload and Recovery Model

## Purpose

LifePlanSystem should support long-running AI-assisted repository work without losing context or overwhelming the user.

The system should make work resumable after interruptions, crashes, context loss, or model changes.

## Core idea

Large work should be split into coherent chunks with checkpoints.

After each meaningful batch, the system should record:

- what changed;
- what was not changed;
- what remains;
- what needs approval;
- what file should be read first next time.

## Workload levels

Suggested levels:

1. Small: one narrow edit or review.
2. Medium: several related edits with a summary.
3. Large: a coherent batch across multiple files.
4. Maximum: only for low-risk public/system work, with checkpoints.

Reliability beats size.

If a chat or tool workflow crashes, reduce the next workload level.

## Checkpoint contents

A checkpoint should include:

- date;
- current task;
- files read;
- files changed;
- commit SHAs;
- approvals given;
- approvals still needed;
- next safe action;
- risks or uncertainty.

## Stop rule

If only approval-gated work remains, stop and provide an approval list.

Do not infer approval from phrases like "keep going" when the action is approval-gated.

## Commit visibility

After every commit or batch, report:

```text
File: path/to/file.md
Commit: sha
Change: one-line summary
```
