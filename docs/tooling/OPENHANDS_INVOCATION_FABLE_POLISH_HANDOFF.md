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

## What PR #21 Added

- Schema/spec documents for invocation request, config, result, status card,
  report section, checklists, and human next steps.
- Local-only schema and fixture verification.
- Package scripts for schema-only and combined invocation verification.
- Safety matrix documentation.
- Fable polish handoff material.
- Docs index and links.

## What PR #22 Added

- Fable polish over the adapter, schema specs, fixtures, failure taxonomy, and
  safety matrix.
- Schema endpoint-pattern regression checks.
- Shared status taxonomy with reserved display statuses.
- Protected-path parity with the executor denylist.

## What PR #23 Added

- `runCli` cwd containment through `resolveRunCliCwd`.
- Default cwd remains the repo root.
- Caller cwd is respected only when it resolves inside the repo/worktree
  boundary.
- cwd escape attempts fail closed with `EBADCWD`.
- Focused `npm run verify:runcli-cwd` coverage.

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

## Suggested Next Review Order

1. Treat PRs #19-#23 as the merged disabled-safety baseline.
2. Review whether docs are now too duplicative.
3. Design the real invocation contract without implementing it.
4. Stop before any runtime integration, invoke UI, network/model call, or real
   invocation.

## Exact Safe Next Prompt

```text
Review and design the real OpenHands invocation contract without implementing it. Define the approval gates, dry-run payload format, human confirmation UX, transport abstraction, kill switch, audit logs, failure modes, and tests proving no real call can happen without explicit approval. Do not enable invocation. Do not add invoke UI. Do not add network/model calls.
```
