# OpenHands Invocation Docs Index

OpenHands real invocation remains disabled. These docs describe safety
scaffolding only.

## Current Merged State

- PRs #19-#22 landed the disabled invocation adapter, report/status helpers,
  schemas, fixtures, and Fable polish.
- PR #23 landed `runCli` cwd containment: default cwd is the repo root, an
  in-repo/worktree caller cwd is respected, and cwd escape attempts fail closed.
- PR #24 added aggregate runtime-safety verification and stop-boundary docs
  cleanup.
- PR #25 adds the real invocation contract design as documentation only. It
  implements no transport, route, UI, network/model call, or invocation path.
- Verification scripts are safety gates and regression checks. They do not
  authorize real invocation, dependency provisioning, commit, push, merge, or
  branch cleanup.
- The next future milestone after this design is mock transport only with a
  refusing default and tests, not real invocation.

## Documents

- Enablement plan:
  [`OPENHANDS_REAL_INVOCATION_ENABLEMENT_PLAN.md`](OPENHANDS_REAL_INVOCATION_ENABLEMENT_PLAN.md)
- Real invocation contract design (design-only; not implemented):
  [`OPENHANDS_REAL_INVOCATION_CONTRACT_DESIGN.md`](OPENHANDS_REAL_INVOCATION_CONTRACT_DESIGN.md)
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

The real invocation contract is now designed in
[`OPENHANDS_REAL_INVOCATION_CONTRACT_DESIGN.md`](OPENHANDS_REAL_INVOCATION_CONTRACT_DESIGN.md)
(design-only, not implemented). Real invocation still requires a future,
separate, **explicit approval** step and remains disabled. The next safe step is
a **mock transport only** — still no real call:

```text
Implement the OpenHands transport abstraction as a MOCK ONLY (PR B). Add the transport interface, a refusing default that returns invoked:false, and an injectable mock used solely in tests. Do not call OpenHands. Do not add a real network/model call. Do not change OPENHANDS_EXECUTOR_INVOCATION_ENABLED. Do not add invoke/run UI or a server invocation route. Add tests proving: no invocation when the flag is false, no invocation without approval, and the real transport is never reachable in tests. Keep it docs+mock+tests only.
```
