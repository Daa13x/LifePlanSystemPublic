# OpenHands Invocation Adapter Contract

## Purpose

This contract describes the disabled OpenHands invocation adapter boundary. The
adapter exists so future local-only invocation work can agree on inputs,
outputs, report shapes, UI-facing status shapes, and failure mapping before any
real OpenHands call is implemented.

## Current State

The adapter is disabled. It does not call OpenHands, does not make
network/model calls, does not mutate files, and does not enable real invocation.
`OPENHANDS_EXECUTOR_INVOCATION_ENABLED` remains false.

The adapter can validate future config shape, build a future payload shape, map
known failure cases, and build display/report/checklist objects for later UI and
server polish.

## Non-Goals

- no real OpenHands call;
- no network/model call;
- no file mutation;
- no dependency install/copy/link strategy;
- no ChatGPT automation;
- no browser-login, cloud, deploy, or private/public sync automation;
- no patch approval;
- no commit, push, merge, reset, stash-pop, or branch deletion;
- no private memory or `source_of_truth` access.

## Inputs

Future local-only config inputs are represented by plain objects:

- `endpoint`, limited to local/example endpoints in tests and fixtures;
- `model` or `provider`;
- `apiKeyRef`, which must be a reference only and not a secret value;
- `worktreeDir`;
- `allowedPaths`;
- `timeoutMs`;
- `outputMaxBytes`.

Request or model-provided JSON must not silently override fixed local config.

## Outputs

Adapter outputs are plain objects with non-authorizing defaults:

- `invoked: false`;
- `realInvocationEnabled: false`;
- `patchApproved: false`;
- `commitAllowed: false`;
- `pushAllowed: false`;
- `mergeAllowed: false`;
- `branchDeletionAllowed: false`;
- `resetAllowed: false`;
- `stashPopAllowed: false`;
- `mainMasterWriteAllowed: false`;
- `privateMemoryAccessAllowed: false`;
- `dependencyProvisioningAllowed: false`;
- `requiresHumanReview: true`;
- `requiresSeparatePostRunApproval: true`.

The adapter cannot approve patches and cannot grant commit, push, merge, reset,
stash-pop, or branch deletion permissions.

## Status Values

The UI/report display taxonomy (one list, shared verbatim by
`OPENHANDS_INVOCATION_STATUS_TAXONOMY` and every schema spec's
`allowedStatusValues`) covers:

- `setup-gated`;
- `blocked`;
- `refused`;
- `validation-failed`;
- `timeout`;
- `output-capped`;
- `invalid-response`;
- `not-implemented` (reserved — no current helper emits it);
- `disabled` (reserved — no current helper emits it).

The implementation keeps policy statuses narrower than display statuses
(`setup-gated`, `blocked`, `refused`, `validation-failed`); every display
status degrades to one of those for policy purposes, and every output remains
non-authorizing.

One value sits outside the outcome taxonomy on purpose:
`buildOpenHandsInvocationPayload(...)` returns `status: 'payload-ready'` for a
successfully assembled (but never sent) payload shape. It is a builder-only
status, not an invocation outcome; if a payload-ready object is fed to the
status-card/report helpers it is conservatively displayed as `blocked`.

## Failure Taxonomy

Known failures are mapped without invoking OpenHands. Failure codes are
snake_case and align with fixture names and display statuses
(`output_capped` → `output-capped`, `changed_file_outside_allowed_paths` →
`changed_file_outside_allowed_paths_failure.example.json`):

- `openhands_unavailable`;
- `endpoint_misconfigured`;
- `model_missing`;
- `timeout`;
- `output_capped`;
- `invalid_response`;
- `protected_path_touched`;
- `changed_file_outside_allowed_paths`;
- `too_many_files_changed`;
- `validation_failed`.

Every failure must remain blocked, refused, setup-gated, or validation-failed
from an authorization perspective.

## UI/Report Shape

`buildOpenHandsInvocationStatusCard(...)` returns a display-ready card object
with status, reason, next human step, and non-authorizing defaults.

`buildOpenHandsInvocationReportSection(...)` returns a report section object
with status card, dry-run checklist, post-run checklist, plain lines, and a
Markdown preview.

`buildOpenHandsAdapterUiState(...)` combines the status card, report section,
checklists, and next steps into a UI-facing state object. It does not call the
server and does not change state.

## Dry-Run Checklist Shape

`buildOpenHandsInvocationDryRunChecklist(...)` returns required checks for:

- endpoint config;
- model/provider config;
- `allowedPaths`;
- valid path boundaries;
- worktree directory;
- timeout limit;
- output cap.

The dry-run checklist always requires human approval before any future
invocation implementation can proceed.

## Post-Run Review Checklist Shape

`buildOpenHandsPostRunReviewChecklist(...)` describes post-run review steps:

- capture actual diff;
- enforce `allowedPaths`;
- enforce protected paths;
- review validation;
- require separate human approval before commit, push, or PR.

The checklist always requires separate post-run approval.

## Human Next-Step Wording

Human next-step strings must direct review, setup correction, or separate
approval. They must never instruct automatic commit, push, merge, branch
deletion, reset, or stash-pop.

Note for fixture authors: the schema verifier is deliberately strict — a
fixture's `humanNextStep` fails on the bare words `reset`, `stash-pop`,
`delete branch`, or `enable invocation` even in prohibitive phrasing ("do not
reset"). Word prohibitions positively ("keep history untouched", "require
separate cleanup approval") instead.

## Fixture List

Fixture examples live in
`docs/tooling/openhands_invocation_examples/`:

- `disabled_invocation_request.example.json`;
- `valid_local_config.example.json`;
- `missing_endpoint_failure.example.json`;
- `missing_model_failure.example.json`;
- `timeout_failure.example.json`;
- `output_capped_failure.example.json`;
- `invalid_response_failure.example.json`;
- `protected_path_failure.example.json`;
- `changed_file_outside_allowed_paths_failure.example.json`;
- `too_many_files_failure.example.json`;
- `validation_failed_failure.example.json`;
- `post_run_review_required.example.json`.

Fixtures use localhost/example values only and contain no real secrets.

Schema specs live in
[`openhands_invocation_schemas/`](openhands_invocation_schemas/). The safety
matrix and Fable handoff are in
[`OPENHANDS_INVOCATION_SAFETY_MATRIX.md`](OPENHANDS_INVOCATION_SAFETY_MATRIX.md)
and [`OPENHANDS_INVOCATION_FABLE_POLISH_HANDOFF.md`](OPENHANDS_INVOCATION_FABLE_POLISH_HANDOFF.md).

## Verification Commands

Run:

```bash
npm run verify:openhands-invocation-adapter
npm run verify:openhands-invocation-schemas
npm run verify:openhands-invocation-all
npm run verify:executor-enforcement
npm run build
node --check server/index.js
node --check server/executorEnforcement.js
node --check server/openhandsInvocationAdapter.js
node --check scripts/verify-openhands-invocation-adapter.mjs
node --check scripts/verify-openhands-invocation-schemas.mjs
git diff --check
```

## Fable Polish Checklist

- Naming consistency.
- Whether status names are clear.
- Whether failure taxonomy is too large or too small.
- Whether report sections should be split.
- Whether UI-state shape matches the actual frontend.
- Whether fixtures should become snapshot tests later.
- Whether helper names should be simplified.
- Whether docs duplicate too much text.
- Whether anything should be wired into `server/index.js` later.
