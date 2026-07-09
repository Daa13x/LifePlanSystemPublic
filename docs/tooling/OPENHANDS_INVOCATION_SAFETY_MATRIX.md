# OpenHands Invocation Safety Matrix

This matrix covers the disabled OpenHands invocation scaffolding. Every row is
non-authorizing: no gate can auto-approve a patch, commit, push, merge, branch
cleanup, reset, stash-pop, dependency provisioning, or real invocation.

| Gate | What it protects | Source/helper/script | Failure status | Human next step | Can ever auto-approve |
| --- | --- | --- | --- | --- | --- |
| Invocation flag default false | Prevents real invocation unless separately approved in a future PR | `server/index.js` | `setup-gated` | Keep invocation disabled and review readiness state | No |
| Readiness gate | Requires every pre-invocation condition before any future boundary | `buildOpenHandsInvocationReadiness` | `setup-gated` | Fix missing gates and rerun dry-run review | No |
| Dependency gate | Prevents pretending worktree build deps exist | `checkWorktreeValidationSetup` | `setup-gated` | Choose dependency strategy only after approval | No |
| Base branch pinning | Prevents execution against a different branch than approved | `validateExecutorBaseBranch` and executor plan | `refused` | Recreate or reapprove with the intended base | No |
| Base commit pinning | Prevents drift between approval and execution | executor plan/report | `refused` | Reconfirm the exact base commit before execution | No |
| Allowed paths | Limits reviewed changes to declared scope | `enforceChangedFiles` | `refused` | Narrow request or allowed paths and rerun review | No |
| Mandatory forbidden/protected paths | Blocks private and protected paths | `OPENHANDS_MANDATORY_FORBIDDEN` and adapter forbidden list | `refused` | Refuse output and inspect the request | No |
| Runtime limits | Prevents long-running validation or invocation boundaries | executor limits and adapter schemas | `timeout` / `validation-failed` | Review timeout and keep artifacts for human review | No |
| Output/report limits | Prevents unbounded output and report noise | executor limits, adapter status, schema validation | `output-capped` / `validation-failed` | Review capped output manually | No |
| Changed-file count limit | Prevents overly broad patches | `checkExecutorMaxFilesChanged` | `refused` | Split the request into a smaller slice | No |
| Dry-run report visibility | Requires report visibility before future invocation | readiness gate and report helpers | `setup-gated` | Show report before any execution approval | No |
| Second confirmation | Requires explicit execution confirmation after approval | request approval fields | `setup-gated` | Obtain second human confirmation | No |
| Adapter disabled stub | Prevents any OpenHands call in current code | `invokeOpenHandsAdapter` | `setup-gated` (`disabled` / `not-implemented` are reserved display statuses; the stub does not emit them yet) | Keep blocked pending separate implementation PR | No |
| Schema validation | Checks specs, statuses, endpoints, and denied autonomy fields | `scripts/verify-openhands-invocation-schemas.mjs` | `blocked` | Fix schema/fixture mismatch before review | No |
| Fixture validation | Checks examples are local-only and non-authorizing | `scripts/verify-openhands-invocation-schemas.mjs` | `blocked` | Fix examples before using them as review material | No |
| Post-run review | Keeps any future output untrusted until reviewed | post-run checklist helpers | `blocked` | Require separate human approval before follow-up | No |
| No auto-commit | Prevents committing generated or unreviewed output | adapter safety fields and executor policy | `blocked` | Use human-gated source control only | No |
| No auto-push | Prevents pushing generated or unreviewed output | adapter safety fields and executor policy | `blocked` | Use human-gated source control only | No |
| No auto-merge | Prevents merging generated or unreviewed output | adapter safety fields and executor policy | `blocked` | Use normal PR review and explicit approval | No |
| No branch deletion/reset/stash-pop | Prevents destructive cleanup or history operations | adapter safety fields and executor policy | `blocked` | Ask for separate cleanup approval | No |
| No private memory/source_of_truth access | Prevents protected private path access | protected path lists and fixture validation | `refused` | Refuse and inspect the path hit | No |
| No dependency install/copy/link | Prevents implicit dependency provisioning | dependency gate and schemas | `setup-gated` | Require separate dependency strategy approval | No |
