# OpenHands Invocation Docs Index

OpenHands real invocation remains disabled. These docs describe safety
scaffolding only.

## Current Merged State

- PRs #19-#22 landed the disabled invocation adapter, report/status helpers,
  schemas, fixtures, and Fable polish.
- PR #23 landed `runCli` cwd containment: default cwd is the repo root, an
  in-repo/worktree caller cwd is respected, and cwd escape attempts fail closed.
- Verification scripts are safety gates and regression checks. They do not
  authorize real invocation, dependency provisioning, commit, push, merge, or
  branch cleanup.
- The next future milestone is a design review for the real invocation contract,
  not turning invocation on.

## Documents

- Enablement plan:
  [`OPENHANDS_REAL_INVOCATION_ENABLEMENT_PLAN.md`](OPENHANDS_REAL_INVOCATION_ENABLEMENT_PLAN.md)
- Adapter contract:
  [`OPENHANDS_INVOCATION_ADAPTER_CONTRACT.md`](OPENHANDS_INVOCATION_ADAPTER_CONTRACT.md)
- Safety matrix:
  [`OPENHANDS_INVOCATION_SAFETY_MATRIX.md`](OPENHANDS_INVOCATION_SAFETY_MATRIX.md)
- Fable polish handoff:
  [`OPENHANDS_INVOCATION_FABLE_POLISH_HANDOFF.md`](OPENHANDS_INVOCATION_FABLE_POLISH_HANDOFF.md)
- Worktree executor overview:
  [`OPENHANDS_WORKTREE_EXECUTOR.md`](OPENHANDS_WORKTREE_EXECUTOR.md)
- Examples directory:
  [`openhands_invocation_examples/`](openhands_invocation_examples/)
- Schemas directory:
  [`openhands_invocation_schemas/`](openhands_invocation_schemas/)

## Verification Commands

```bash
npm run verify:openhands-invocation-adapter
npm run verify:openhands-invocation-schemas
npm run verify:openhands-invocation-all
npm run verify:runcli-cwd
npm run verify:openhands-stop-boundary
npm run verify:runtime-safety
npm run verify:executor-enforcement
npm run build
```

## Next Safe Prompt

```text
Review and design the real OpenHands invocation contract without implementing it. Define the approval gates, dry-run payload format, human confirmation UX, transport abstraction, kill switch, audit logs, failure modes, and tests proving no real call can happen without explicit approval. Do not enable invocation. Do not add invoke UI. Do not add network/model calls.
```
