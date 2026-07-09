# Local Learning Event Schema

Status: docs/test-first only. This document defines an inert record shape for
future local learning review. No runtime loader reads it, no local learning
engine writes it, and no router uses it.

## Safety Boundary

This schema does not authorize:

- runtime local learning;
- a local learning engine;
- skill router implementation;
- automatic memory sync;
- source-of-truth promotion;
- external account upload;
- OpenHands invocation;
- OpenHands mock transport;
- browser automation bridge;
- invoke/run UI;
- network or model calls.

The route value `source_of_truth_candidate_requires_approval` is only a label
for a future review queue. It must not write to, edit, promote into, or otherwise
touch any source-of-truth path.

## Required Fields

`task_type`
: Classification of the original work. Use a short non-empty string such as
  `pr_review`, `docs_schema`, `ui_checklist`, or `implementation_plan`.

`selected_skills`
: LifeSkills used or proposed for the work. Use an array of skill names or
  stable identifiers. Empty is allowed only when no skill was relevant.

`agent_target`
: Intended agent or surface. Suggested values are `chatgpt`, `claude`, `codex`,
  `fable`, and `human`.

`result_quality`
: Outcome quality. Allowed values are `success`, `partial`, `blocked`,
  `unsafe`, and `unknown`.

`mistakes`
: Mistakes, risks, or failure modes observed. Use an array of short strings.
  Empty means none were observed.

`lesson`
: Short lesson learned from the task. This should be plain review text, not a
  durable memory write.

`skill_update_candidate`
: Proposed skill change, if any. Use either an object with reviewable fields or
  an empty string when no update is proposed.

`memory_route`
: Route for any durable-learning candidate. This is routing metadata only and
  does not perform a write.

`approval_required`
: Boolean stating whether human approval is required before any durable write,
  skill change, source-of-truth candidate handling, external action, or future
  automation.

## Allowed Memory Routes

- `ignore` - no durable learning candidate.
- `temporary_handoff` - carry forward as short-lived handoff context only.
- `mistake_warning` - candidate warning for future review.
- `skill_improvement_candidate` - proposed LifeSkill improvement for review.
- `memory_inbox_candidate` - possible durable memory inbox item for approval.
- `source_of_truth_candidate_requires_approval` - possible source-of-truth
  candidate label; requires explicit human approval and performs no write.

## Example Shape

```json
{
  "task_type": "docs_schema",
  "selected_skills": ["pr-merge-safety-review"],
  "agent_target": "codex",
  "result_quality": "success",
  "mistakes": [],
  "lesson": "Keep local learning as reviewable records before adding any runtime writer.",
  "skill_update_candidate": {
    "skill": "lifeskillsystem-next-move",
    "change": "Mention the local learning event schema when planning future feedback loops."
  },
  "memory_route": "skill_improvement_candidate",
  "approval_required": true
}
```

## Verification

Run:

```bash
npm run verify:local-learning-event-schema
```

The verifier checks this document, the machine-readable schema, and examples for
required fields and safety-boundary tokens. It is deterministic, local-only, and
uses built-in Node APIs only.
