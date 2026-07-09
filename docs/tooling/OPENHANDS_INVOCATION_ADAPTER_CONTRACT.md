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

The UI/report taxonomy currently covers:

- `setup-gated`;
- `blocked`;
- `refused`;
- `validation-failed`;
- `timeout`;
- `output-capped`;
- `invalid-response`.

The implementation may keep policy statuses narrower than display statuses as
long as every output remains non-authorizing.

## Failure Taxonomy

Known failures are mapped without invoking OpenHands:

- OpenHands unavailable;
- endpoint misconfigured;
- model missing;
- timeout;
- excessive output;
- invalid or unparseable response;
- protected path touched;
- changed file outside `allowedPaths`;
- too many files changed;
- validation failed.

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

## Verification Commands

Run:

```bash
npm run verify:openhands-invocation-adapter
npm run verify:executor-enforcement
npm run build
node --check server/index.js
node --check server/executorEnforcement.js
node --check server/openhandsInvocationAdapter.js
node --check scripts/verify-openhands-invocation-adapter.mjs
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
