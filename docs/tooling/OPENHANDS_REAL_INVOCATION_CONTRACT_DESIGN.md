# OpenHands Real Invocation Contract Design

> **Design document only.** This describes a *future* contract for real
> OpenHands invocation. It implements nothing. No transport, no UI, no runtime
> route, no network/model call, and no flag change accompany this document.
> Reading, merging, or referencing it does **not** authorize a real invocation.

This complements the existing
[`OPENHANDS_REAL_INVOCATION_ENABLEMENT_PLAN.md`](OPENHANDS_REAL_INVOCATION_ENABLEMENT_PLAN.md)
by specifying the concrete gate/payload/UX/test shape a future implementation
would have to satisfy. Where the enablement plan says *what must be true*, this
document says *what the interfaces would look like* — still without building
them.

## 1. Status

- **Design-only.** No code in this PR implements invocation.
- **Real invocation disabled.** `OPENHANDS_EXECUTOR_INVOCATION_ENABLED` remains
  `false`; nothing here changes it.
- **No transport implemented.** There is no OpenHands client, no HTTP call, no
  model call, no `child_process` execution of an agent.
- **No UI implemented.** There is no invoke/run control. Any future UI begins as
  display-only status (see the staged PR sequence).
- The disabled adapter stub, schemas, fixtures, safety matrix, `runCli` cwd
  containment, and stop-boundary verification (PRs #19–#24) are the merged
  baseline this design sits on top of.

## 2. Non-goals

- Do **not** enable invocation (no flag flip, no "temporary" enable path).
- Do **not** call OpenHands or any model/network endpoint.
- Do **not** bypass, weaken, or shortcut human approval.
- Do **not** automate commit, push, merge, branch deletion, reset, or stash-pop.
- Do **not** add dependency install/copy/link behavior.
- Do **not** add hosted/cloud/deploy/browser-login/ChatGPT automation.
- Do **not** touch private memory or `source_of_truth`.
- Do **not** write secrets into requests, reports, patches, or config.
- Do **not** treat this document, or any verification script, as authorization.

## 3. Required approval gates

A future invocation may proceed only if **every** gate below passes in order.
Any failure stops at that gate with a `blocked` / `refused` / `setup-gated`
result and a human next step — never a fallback that proceeds anyway.

- **Gate 1 — Local validation passes.** `verify:runtime-safety` (and the
  executor readiness gate) pass; the worktree is clean; base branch and base
  commit are pinned; `allowedPaths` is non-empty; protected/forbidden paths are
  enforced; runtime/file/output/report limits are present.
- **Gate 2 — Dry-run payload generated.** The exact payload that *would* be sent
  is assembled and written to the report, with no call made.
- **Gate 3 — User reviews the exact payload.** The full payload, risks, and the
  changed-files scope are shown to the user verbatim (no summarization that
  hides fields).
- **Gate 4 — User explicitly approves one invocation.** Approval is per-request,
  single-use, and references the exact `requestId` and base commit. Blanket or
  standing approval is not accepted.
- **Gate 5 — Invocation stays bounded to one approved request.** One approval
  authorizes at most one call, for one request, on one pinned base commit, in
  one isolated worktree. Retries require a new approval.
- **Gate 6 — Post-run report required.** A report is generated regardless of
  outcome, capturing the actual diff, enforcement results, and validation
  output.
- **Gate 7 — No commit/push/merge without separate approval.** The worktree diff
  is untrusted output for review only; any source-control action is a distinct,
  separately-approved human step.

## 4. Dry-run payload format

Proposed shape for **future documentation only** — not a runtime schema, not
consumed by any code in this PR:

```jsonc
{
  "requestId": "oh-req-<timestamp>-<n>",
  "branch": "local-agent/<requestId>",     // controller-generated local proposal branch from main
  "baseBranch": "main",                      // read-only reference
  "baseCommit": "<pinned 40-hex sha>",       // resolved, recorded, never HEAD
  "worktreePath": ".lps/tooling/openhands/worktrees/<requestId>",
  "allowedPaths": ["docs/tooling"],          // non-empty, boundary-checked
  "forbiddenPaths": ["source_of_truth/", "memory/", ".env", "secrets/", "..."],
  "requestedTask": "<human-authored objective; never overrides fixed config>",
  "autonomyLevel": "dry-run",                // "dry-run" | "single-approved-invocation"
  "invocationEnabled": false,                // must be false unless a future switch + approval flip it
  "requiresHumanApproval": true,
  "safetyChecks": {
    "readinessGate": "pending",
    "dependencyGate": "pending",
    "baseBranchPinned": true,
    "baseCommitPinned": true,
    "allowedPathsPresent": true,
    "protectedPathsEnforced": true,
    "limitsPresent": true,
    "serviceReachabilityProbeOnly": "pending"
  },
  "expectedOutputs": {
    "reportPath": ".lps/tooling/openhands/reports/<requestId>.md",
    "patchPath": ".lps/tooling/openhands/reports/<requestId>.patch",
    "worktreePreservedOnDiff": true
  }
}
```

`apiKeyRef` (if ever needed) is a **reference only**, never a secret value, and
never appears in this payload, the report, or the patch.

## 5. Human confirmation UX requirements

- The **exact payload** (§4) must be visible before any confirmation — no hidden
  or defaulted fields.
- **Risks** must be visible: which paths are writable, the file-count cap, the
  timeout, the output cap, and that model output is untrusted.
- The **changed-files scope** (`allowedPaths` / `forbiddenPaths`) must be visible.
- The **confirm control must state exactly what will happen** — e.g. "Run one
  OpenHands attempt on request `<id>` against base `<sha>` in an isolated
  worktree; nothing will be committed, pushed, or merged." Generic labels
  ("OK", "Run") are not acceptable.
- **No hidden invocation.** No code path may call OpenHands without passing
  through the visible confirm step. There is no auto-run, no keyboard shortcut,
  no retry-on-failure that re-invokes without a fresh confirmation.

## 6. Transport abstraction

- **Future interface only** — this document defines the *shape*, not an
  implementation. Illustrative:
  ```
  interface OpenHandsTransport {
    dryRun(payload): DryRunResult;   // assembles/validates; performs NO call
    invoke(payload, approvalToken): InvocationResult; // guarded; disabled by default
  }
  ```
- **No implementation** ships until its own dedicated, separately-approved PR
  (PR B in §11).
- **Must be mockable** so gates and refusal paths can be tested without any real
  endpoint.
- **Disabled by default** — a default/real transport resolves to a refusing
  no-op that returns `invoked: false`.
- **Must support dry-run mode** that produces the payload and performs no call.
- **Must never call a real transport during tests** unless a test explicitly
  injects a mock. The test harness must fail if a real transport is reachable.

## 7. Kill switch

- **Env flag.** A single authoritative disable flag
  (`OPENHANDS_EXECUTOR_INVOCATION_ENABLED`, default `false`) gates everything;
  when off, no invocation path is reachable.
- **UI disabled state.** Any future UI renders invocation as disabled/greyed with
  an explanation, not a hidden-but-clickable control.
- **Server refusal path.** A future server route (when it exists) returns a
  `refused` / `setup-gated` response while the flag is off — it never falls
  through to a call.
- **Test proving refusal.** A test asserts that with the flag off, every entry
  point (adapter, future route, future UI trigger) refuses and no transport is
  invoked.
- **Audit log for refusal.** Refusals are recorded (see §8) so a blocked attempt
  is observable, not silent.

## 8. Audit log / reporting

Each dry-run, refusal, or (future, approved) invocation records:

- **what was requested** — `requestId`, task, `allowedPaths`, base commit;
- **who approved** — approver identity for the single-use approval (empty for
  refusals/dry-runs);
- **timestamp** — ISO time of the event;
- **branch / worktree** — exec branch and worktree path;
- **safety checks** — the §4 `safetyChecks` outcomes;
- **result** — `dry-run` / `refused` / `setup-gated` / `blocked` /
  `validation-failed` / (future) `invoked`;
- **post-run review requirement** — that commit/push/merge remain separate,
  human-gated steps.

Audit entries never contain secrets or private-memory content.

## 9. Failure modes

Every mode resolves to `blocked` / `refused` / `setup-gated` /
`validation-failed` with a human next step, and **never** commits, pushes,
merges, deletes branches, or touches the main working tree:

- invalid config (missing endpoint/model/limits);
- unsafe path (`allowedPath` overlaps protected/forbidden, or escapes root);
- dirty worktree (uncommitted state where a clean base is required);
- network unavailable (probe fails — probe only, never a real call);
- timeout (invocation or validation exceeds its limit);
- output too large (invocation or validation exceeds the output cap);
- OpenHands unavailable / not reachable;
- user approval missing or not matching the exact request/commit;
- post-run review missing (diff exists but has not been human-reviewed).

If a future approved call produces a real diff, the worktree and branch are
**preserved** for human review; cleanup stays a separate human-gated action.

## 10. Required tests before implementation

Before any real transport is built, these must exist and pass (against mocks —
never a live endpoint):

- no invocation when the flag is false;
- no invocation without a matching single-use approval;
- no invocation with unsafe paths;
- no invocation with a dirty worktree;
- mock transport is **not** called unless an approved, mocked path invokes it;
- a real transport is unavailable/unreachable in tests;
- a future UI cannot trigger invocation while disabled;
- an audit log / report is generated for dry-run, refusal, and (mocked)
  invocation;
- the kill switch blocks every entry point.

## 11. Future PR sequence

Each step is a separate, explicitly-approved PR; none enables real invocation
except the final, human-gated step:

- **PR A — design only** (this document).
- **PR B — mock transport only** (interface + refusing default + mock; no real
  call, tests use the mock).
- **PR C — disabled server route returning refusal only** (route exists but
  returns `refused`/`setup-gated` while the flag is off; test proves refusal).
- **PR D — display-only UI status** (shows disabled invocation state and the
  dry-run payload; no invoke control).
- **PR E — dry-run payload generation** (assembles/records the §4 payload;
  performs no call).
- **PR F — human approval UX** (the §5 confirmation flow producing a single-use
  approval token; still no real transport).
- **PR G — real transport behind explicit approval** (the first PR that could
  make a call — requires the flag on **and** a matching single-use approval;
  heavily gated and separately approved).
- **PR H — post-run report and rollback docs** (finalizes reporting, audit, and
  human-gated rollback guidance).

## 12. Current next safe prompt

The next step after this design doc is **mock transport only** — not real
invocation:

```text
Implement the OpenHands transport abstraction as a MOCK ONLY (PR B). Add the transport interface, a refusing default that returns invoked:false, and an injectable mock used solely in tests. Do not call OpenHands. Do not add a real network/model call. Do not change OPENHANDS_EXECUTOR_INVOCATION_ENABLED. Do not add invoke/run UI or a server invocation route. Add tests proving: no invocation when the flag is false, no invocation without approval, and the real transport is never reachable in tests. Keep it docs+mock+tests only.
```
