# Local Learning Event Schema

Status: schema and validation are implemented for a manual review path. No
runtime loader, local-learning engine, or router uses this record automatically.

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

The route value `source_of_truth_candidate_requires_approval` is only routing
metadata for human review. It must not write to, edit, promote into, or otherwise
touch any source-of-truth path.

When `memory_route` is `source_of_truth_candidate_requires_approval`,
`approval_required` must be `true`. This mirrors the fail-closed validator rule:
the route label does not authorize writing to `source_of_truth/`, promotion still
requires explicit human approval, and no automatic memory sync occurs.

## Manual Review-Inbox Tools

PR #31 added only a directly invoked writer for validated review candidates. It
writes candidate JSON files exclusively to `.lps/local-learning/review-inbox/`.
PR #33 added a directly invoked, read-only reader/list command for that same
fixed inbox. The reader lists JSON candidates, parses them safely, and reports
their existing validator status. Malformed or schema-invalid candidates remain
visible as invalid, while symlink, junction, or containment failures fail
closed. A missing inbox is an empty success and is not created by listing.

These files are not memory. The tools do not approve, reject, promote, move, or
delete candidates, and they never write to `source_of_truth`. Server startup
imports neither tool, and no runtime local-learning engine is enabled.

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
npm run verify:local-learning-event-validator
npm run verify:local-learning-event-writer
npm run verify:local-learning-review-inbox-reader
```

The schema verifier checks this document, the machine-readable schema, and
examples for required fields and safety-boundary tokens. The validator verifier
checks the pure event validation path. The writer verifier checks the manual,
fixed-path review-inbox boundary. The reader verifier checks missing, valid,
malformed, schema-invalid, and symlinked inbox cases while proving listing stays
read-only. All are deterministic and local-only.
