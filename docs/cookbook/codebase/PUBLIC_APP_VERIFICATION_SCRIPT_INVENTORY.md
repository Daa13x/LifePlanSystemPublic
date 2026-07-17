# LifePlanSystemPublic Verification Script Inventory

Status: complete source-level inventory of maintained package verification entry points and their safety/test coverage. Source checks do not substitute for runtime acceptance.

Last updated: 2026-07-17

Source snapshots:

```text
package.json                                          39205a498cf380731f947259346eb54d15ae9320
scripts/verify-executor-enforcement.mjs               c032bbf7afa6859e04b8ef2e9f4b4439b4e1757c
scripts/verify-openhands-invocation-adapter.mjs       2ed09110f123c7f81b8c572d32c992d9ad48bbda
scripts/verify-openhands-invocation-schemas.mjs       df47d6af1ce0f27db14b68e2edd5c578df1849c6
scripts/verify-runcli-cwd.mjs                         98a377817164ef042e473cfa8986329898dd10c2
scripts/verify-openhands-stop-boundary.mjs            52730b75f50a1ca7ba32f220875b3bfe16bce080
scripts/verify-lifeskillsystem-skills.mjs             772dc8395e65434f5be4b62cb757253318bb4004
scripts/verify-local-learning-event-schema.mjs        d9fac339136eec93602cc3cd5bc7aa71e672e890
scripts/verify-local-learning-event-validator.mjs     2af3b2c9e677d7eaa2e1ef61fe565ccfee85080b
scripts/verify-local-learning-event-writer.mjs        79bc2b039c845a3483166c0d5a4317e7ed853556
scripts/verify-local-learning-review-inbox-reader.mjs 2541d19c5753c09e5244a6b20e0613f35179589d
```

## 1. Package entry points

```text
npm run check
npm run verify:executor-enforcement
npm run verify:openhands-invocation-adapter
npm run verify:openhands-invocation-schemas
npm run verify:openhands-invocation-all
npm run verify:runcli-cwd
npm run verify:openhands-stop-boundary
npm run verify:runtime-safety
npm run verify:lifeskillsystem-skills
npm run verify:local-learning-event-schema
npm run verify:local-learning-event-validator
npm run verify:local-learning-event-writer
npm run verify:local-learning-review-inbox-reader
```

`npm run check` is only `npm run build`; it is not lint, type-check, or test execution.

## 2. Composite commands

```text
verify:openhands-invocation-all
  -> verify:openhands-invocation-adapter
  -> verify:openhands-invocation-schemas

verify:runtime-safety
  -> verify:runcli-cwd
  -> verify:executor-enforcement
  -> verify:openhands-invocation-all
  -> verify:openhands-stop-boundary
```

`verify:runtime-safety` is the strongest maintained safety composite, but it does not start Express, SQLite, Vite, Chrome, or the installed app.

Update 2026-07-17: the composite now also runs `verify:source-control-safety`, `verify:governance-safety`, and `verify:browser-connector-safety`. The latter two start an isolated Express server with a temporary SQLite database and temporary connector config. Packaging runs `verify-portable-package` against the generated tree, and CI executes the complete runtime-safety composite before packaging.

New maintained entry points:

```text
npm run verify:source-control-safety
npm run verify:governance-safety
npm run verify:browser-connector-safety
npm run verify:portable-package
```

Coverage added:

- disposable Git parsing, protected-path, remote-host, publication-boundary, and secret-scan checks;
- live approval/memory/roadmap idempotency, protected context, backup redaction, settings, and health API checks;
- live browser bridge authentication, pairing generation, tab minimization, and settings redaction checks;
- portable required-file, native dependency, source rebuild, and forbidden-private-path checks.

## 3. Runtime safety verifiers

### `verify-runcli-cwd.mjs`

- imports the real `resolveRunCliCwd` helper;
- proves default root and allowed in-root working directories;
- uses a real child process to observe the resolved directory;
- rejects traversal, absolute escapes, control characters, and non-string values;
- source-checks that `runCli` and the executor use the resolver/worktree path;
- confirms real OpenHands invocation remains disabled.

Local-only; no server boot, network, or main-repository mutation.

### `verify-executor-enforcement.mjs`

- creates disposable Git repositories under the OS temp directory;
- generates real tracked and untracked changes;
- exercises the real porcelain parser and changed-file enforcement;
- tests exact/directory allowed-path boundaries and mandatory forbidden paths;
- validates base-branch syntax/pinning, dependency gates, changed-file limits, and runtime/output limits;
- checks tool constraints/readiness fail closed;
- cleans up temporary repositories.

It never enables or contacts OpenHands.

### `verify-openhands-stop-boundary.mjs`

- requires `OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false`;
- rejects a true assignment;
- checks the adapter has no network/process/shell implementation;
- checks the UI has no real invocation control;
- checks fixtures/schemas never authorize autonomy;
- checks the safety matrix denies auto-approval;
- checks documentation keeps real invocation as a future reviewed milestone.

## 4. Disabled OpenHands adapter/spec verifiers

### `verify-openhands-invocation-adapter.mjs`

Exercises the real disabled adapter helpers for:

- configuration validation;
- explicit-off behavior;
- proof that a supplied transport is not called;
- failure/status mapping;
- denied autonomy booleans;
- required human review;
- protected-path parity;
- payload/report/UI-state generation;
- example parsing and likely-secret scanning.

No network, server boot, dependency install, or repository write.

### `verify-openhands-invocation-schemas.mjs`

Checks all schema/spec and example JSON files for:

- required fields and status taxonomy;
- autonomy booleans fixed false;
- human-review booleans fixed true;
- `nonAuthorizing: true`;
- localhost/example-only endpoints;
- no likely secrets or private paths outside explicit failure examples;
- no network/process implementation in the adapter source.

It checks structural/spec consistency; it is not a general JSON Schema engine test.

## 5. LifeSkillSystem documentation verifier

### `verify-lifeskillsystem-skills.mjs`

Recursively finds `SKILL.md` files under `docs/agent_mode/skills/`.

Required metadata:

```text
name
description
platforms
status
safety_level
```

Required sections:

```text
Purpose
When to use
Safety checks
Output format
Escalate to Fable/Codex when
```

It scans for selected runtime, private-path, and secret tokens. It does not execute skills.

## 6. Local-learning contract verifiers

### `verify-local-learning-event-schema.mjs`

Checks the Markdown contract, JSON schema, and examples remain aligned, closed, approval-aware, and non-authorizing.

### `verify-local-learning-event-validator.mjs`

Imports the pure validator and tests required/unknown fields, enums, source-of-truth approval behavior, closed nested candidate shape, malformed JSON, and absence of write/network capabilities.

### `verify-local-learning-event-writer.mjs`

Uses temporary roots to test:

- one validated candidate write;
- invalid events write nothing;
- path/slug/traversal/junction rejection;
- no-overwrite collision suffixes;
- direct manual-only CLI wiring;
- no server startup import;
- no network/process capability.

### `verify-local-learning-review-inbox-reader.mjs`

Uses temporary roots to test:

- missing inbox as empty non-creating success;
- valid/malformed/schema-invalid listing;
- deterministic filename order;
- symlink/junction rejection;
- control-character-safe CLI output;
- import-time non-mutation;
- read-only filesystem calls;
- no server startup import.

## 7. Manual utilities not exposed as package scripts

```text
node scripts/write-local-learning-event.mjs <input-json> [slug]
node scripts/list-local-learning-review-inbox.mjs
```

They require direct manual invocation and are not called by server startup. The writer creates an unapproved candidate only under `.lps/local-learning/review-inbox/`; the reader lists/validates without promotion, movement, approval, or deletion.

## 8. Coverage matrix

| Area | Source/invariant | Real process/filesystem | Server/API | Browser/UI | Network/service |
|---|---:|---:|---:|---:|---:|
| Vite build | yes | build output | no | no | no |
| runCli cwd | yes | child process | no | no | no |
| executor enforcement | yes | temp Git repos | no | no | no |
| OpenHands stop/adapter/schema | yes | fixture reads | no | helper/source only | no |
| LifeSkillSystem docs | yes | reads docs | no | no | no |
| local-learning schema/validator | yes | fixture reads | no | no | no |
| local-learning writer/reader | yes | temp directories | no | no | no |
| Planner/Chat/Memory/Approval | no dedicated test | no | no | no | no |
| Browser connector | no runtime test | no | no | no | no |
| Portable/installer/CI | no acceptance test | no | no | no | no |

## 9. Missing automated test classes

- Express boot/health with isolated SQLite;
- API request/response contracts;
- migrations, transactions, and restart persistence;
- Planner/Chat/Memory/Approval lifecycle and idempotency;
- repository proposal and disposable Git-route tests;
- Chrome-extension mock-page/job tests;
- React interaction, accessibility, and visual-regression tests;
- portable launch and installer install/upgrade/uninstall;
- hosted GitHub Actions/release acceptance.

Until these exist, use the dated runtime acceptance record.

## 10. Recommended execution order

```powershell
npm ci
npm run build
npm run verify:runtime-safety
npm run verify:lifeskillsystem-skills
npm run verify:local-learning-event-schema
npm run verify:local-learning-event-validator
npm run verify:local-learning-event-writer
npm run verify:local-learning-review-inbox-reader
```

Then perform subsystem-specific runtime acceptance.

## 11. Maintenance rule

When a safety-critical helper changes:

1. test the real helper, not a copied reimplementation;
2. include positive controls and rejection cases;
3. use temporary locations for filesystem/Git effects;
4. keep network and real OpenHands invocation disabled unless separately approved;
5. wire the verifier into the relevant composite and CI release gate;
6. record runtime evidence separately.
