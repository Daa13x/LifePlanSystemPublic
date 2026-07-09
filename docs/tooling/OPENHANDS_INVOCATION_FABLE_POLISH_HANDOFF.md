# OpenHands Invocation Fable Polish Handoff

This is a review guide for Fable. It is not an implementation plan to enable
real OpenHands invocation.

## What PR #19 Added

- Disabled OpenHands invocation adapter stub.
- Config validation and safe failure mapping.
- Local-only adapter verification.
- No real OpenHands call.
- No network/model call.
- No runtime server integration.

## What PR #20 Added

- UI/report/status/checklist helper shapes.
- Invocation example fixtures.
- Adapter contract documentation.
- Expanded fixture and helper verification.
- Links from existing OpenHands docs.
- No frontend invoke UI.
- No runtime server integration.

## What This PR Adds

- Schema/spec documents for invocation request, config, result, status card,
  report section, checklists, and human next steps.
- Local-only schema and fixture verification.
- Package scripts for schema-only and combined invocation verification.
- Safety matrix documentation.
- Fable polish handoff material.
- Docs index and links.

## Known Rough Edges

- Status names are intentionally conservative and may need naming polish.
- The schema/spec files are dependency-free contract specs, not enforced by a
  third-party JSON Schema validator.
- The report and UI objects are not wired into `server/index.js`.
- Fixtures are examples and may later become snapshot tests.
- Some docs repeat safety language to stay explicit across stacked PRs.

## Naming Review Checklist

- Are helper names clear enough?
- Should `statusCard`, `reportSection`, or checklist naming be shorter?
- Should `policyStatus` and display `status` remain separate?
- Are `output-capped` and `invalid-response` clearer than the internal failure
  codes?

## Status Taxonomy Review Checklist

- Is the taxonomy too broad or too narrow?
- Should `timeout` and `output-capped` remain display statuses?
- Should `disabled` and `not-implemented` be fixtures later?
- Are refusal and setup-gated states distinct enough for users?

## Schema/Report Shape Review Checklist

- Do schema specs match the eventual frontend needs?
- Should report sections be split into summary, gates, and next actions?
- Do checklists have stable IDs for UI rendering?
- Are required fields too strict or too loose?

## Docs Duplication Review Checklist

- Does the enablement plan repeat too much of the contract?
- Should the safety matrix become the single source for gate descriptions?
- Should examples be linked from fewer places?
- Is the docs index enough for navigation?

## What Not To Enable

- Do not enable real OpenHands invocation.
- Do not add network/model calls.
- Do not wire runtime execution.
- Do not add invoke/run UI.
- Do not add dependency install/copy/link behavior.
- Do not add auto-commit, auto-push, auto-merge, branch deletion, reset, or
  stash-pop.
- Do not touch private memory or `source_of_truth`.

## Suggested Next Fable Review Order

1. Review PR #19 adapter boundary.
2. Review PR #20 UI/report boilerplate and fixtures.
3. Review this schema-validation PR.
4. Polish names and status taxonomy.
5. Decide whether docs need consolidation.
6. Stop before any runtime integration or real invocation.

## Exact Safe Fable Prompt

```text
Review PR #19, PR #20, and the stacked schema-validation PR. Polish naming, schema/report shape, failure taxonomy, fixture clarity, and docs duplication. Do not enable real OpenHands invocation. Do not add network/model calls. Do not wire runtime execution.
```
