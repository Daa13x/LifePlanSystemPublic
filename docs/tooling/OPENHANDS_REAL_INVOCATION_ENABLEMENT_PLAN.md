# OpenHands Real Invocation Enablement Plan

This is a documentation-only plan for a future, local-only OpenHands real
invocation slice. It does not enable invocation, does not implement the
OpenHands call, and does not change `OPENHANDS_EXECUTOR_INVOCATION_ENABLED`.

Real invocation remains disabled. The invocation flag must remain off by
default, and any future implementation must prove that a missing or non-false
default flag is setup-gated before a call can be attempted.

## Scope

The first real invocation implementation must be local-only. It may target only
the configured local OpenHands service and local model/provider wiring. It must
not add hosted automation, ChatGPT automation, browser-login automation, deploy
automation, or private-repo sync behavior.

The exact future OpenHands call boundary must be defined before implementation:

- endpoint URL;
- model/provider;
- API key reference, if needed;
- invocation timeout;
- invocation output cap;
- worktree working directory;
- allowed paths;
- forbidden and protected paths;
- request payload shape;
- response/diff extraction shape;
- failure-to-report mapping.

## Required Local Config

A future implementation PR must name every local config value in the report and
must prevent request JSON from silently overriding it:

- endpoint;
- model/provider;
- API key reference, if needed;
- timeout;
- output cap;
- working directory;
- allowed paths;
- forbidden/protected paths.

Secrets must not be stored in request files, reports, patches, or committed
configuration. If an API key reference is needed, it must be a reference only,
not the secret value.

## Required Gates Before Any Call

Before the real OpenHands call boundary can run, all of these gates must pass:

- invocation readiness gate passes;
- dependency gate passes;
- base branch and base commit are pinned;
- `allowedPaths` is non-empty;
- protected paths are enforced;
- explicit human approval is present;
- second execution confirmation is present;
- dry-run report is visible before execution;
- model/endpoint config is present;
- runtime, file-count, output, and report limits are present;
- OpenHands service reachability has been checked with a probe only.

The service reachability check must remain a probe. It must not start
OpenHands, bypass login/security controls, or install dependencies.

## Required Behavior After Any Call

After a future local OpenHands call returns, the executor must continue to treat
the worktree diff as untrusted until every post-run check passes:

- actual diff is captured;
- changed files are enforced against `allowedPaths`;
- mandatory forbidden/protected paths are enforced;
- full patch and report are generated;
- worktree is preserved on a real diff;
- validation runs only through the allowlist;
- no auto-commit;
- no auto-push;
- no auto-merge;
- separate human approval is required before commit, push, or PR.

The executor must never treat the model's declared intent as sufficient. The
actual git status and diff in the isolated worktree are the enforcement source
of truth.

## Failure Behavior

Every failure mode must be reported as blocked, refused, setup-gated, or
validation-failed without committing, pushing, merging, deleting branches, or
touching the main working tree.

Required failure cases:

- OpenHands unavailable;
- endpoint misconfigured;
- model missing;
- invocation timeout;
- excessive invocation output;
- invalid or unparsable diff/response;
- protected path touched;
- changed file outside `allowedPaths`;
- too many files changed;
- dependency gate missing;
- validation fails;
- validation times out;
- validation output exceeds the cap.

If the future call produces a real diff, the worktree and branch must be
preserved for human review. Cleanup must remain a separate human-gated action.

## Acceptance Criteria For A Future Implementation PR

A future implementation PR may be considered only when it:

- keeps real invocation disabled by default;
- introduces an explicit local-only enablement switch;
- refuses invocation unless the existing readiness gate passes;
- defines the OpenHands call payload and response boundary;
- adds focused tests for unavailable, misconfigured, slow, noisy, and bad-diff
  OpenHands responses;
- proves protected paths and `allowedPaths` enforcement still run against the
  actual worktree diff;
- proves no auto-commit, auto-push, or auto-merge can occur;
- proves secrets are not written to reports, patches, or request files;
- updates reports to show invocation status, refusal/setup-gated reason, limits,
  and next human action;
- leaves `main`/`master` protected from executor writes and pushes.

## Non-Goals

- no ChatGPT automation;
- no bypassing login, verification, Cloudflare, or other security controls;
- no dependency install/copy/link strategy;
- no private memory or `source_of_truth` access;
- no autonomous commit, push, merge, deploy, branch deletion, reset, or
  stash-pop;
- no public/private repo sync behavior;
- no broad Agent Mode runtime enablement.

## Recommended Next PR

After this documentation-only plan, the next smallest PR should implement a
disabled-by-default invocation adapter stub with tests. That PR must still not
enable real invocation and must not call OpenHands. Its job should be to define
the call boundary and failure mapping while the real invocation flag remains
off.
