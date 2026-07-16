# LifePlanSystemPublic Verification Script Inventory

Status: complete source-level inventory of maintained package verification entry points and their safety/test coverage. This inventory does not convert source-level checks into runtime acceptance evidence.

Last updated: 2026-07-16

Source snapshots:

```text
package.json                                        39205a498cf380731f947259346eb54d15ae9320
scripts/verify-executor-enforcement.mjs             c032bbf7afa6859e04b8ef2e9f4b4439b4e1757c
scripts/verify-openhands-invocation-adapter.mjs     2ed09110f123c7f81b8ef2e9f4b4439b4e1757c (see repository for current blob)
scripts/verify-openhands-invocation-schemas.mjs     df47d6af1ce0f27db14b68e2edd5c578df1849c6
scripts/verify-runcli-cwd.mjs                       98a377817164ef042e473cfa8986329898dd10c2
scripts/verify-openhands-stop-boundary.mjs          52730b75f50a1ca7ba32f220875b3bfe16bce080
scripts/verify-lifeskillsystem-skills.mjs           772dc8395e65434f5be4b62cb757253318bb4004
scripts/verify-local-learning-event-schema.mjs      d9fac339136eec93602cc3cd5bc7aa71e672e890
scripts/verify-local-learning-event-validator.mjs   2af3b2c9e677d7eaa2e1ef61fe565ccfee85080b
scripts/verify-local-learning-event-writer.mjs      79bc2b039c845a3483166c0d5a4317e7ed853556
scripts/verify-local-learning-review-inbox-reader.mjs 2541d19c5753c09e5244a6b20e0613f35179589d
```

Note: the adapter verifier's authoritative path and behavior are documented below; use Git to obtain its current blob SHA when updating this document.

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

`npm run check` is currently an alias for `npm run build`; it is not a lint, type-check, or test suite.

## 2. Composite commands

### `verify:openhands-invocation-all`

Runs:

```text
verify:openhands-invocation-adapter
verify:openhands-invocation-schemas
```

It proves the future invocation adapter and its schema/examples remain non-authorizing and local-only.

### `verify:runtime-safety`

Runs:

```text
verify:runcli-cwd
verify:executor-enforcement
verify:openhands-invocation-all
verify:openhands-stop-boundary
```

It is the strongest maintained composite safety check, but it does not start Express or a browser.

## 3. Runtime safety verifiers

### `verify-runcli-cwd.mjs`

Purpose:

- imports the real `resolveRunCliCwd` helper;
- proves missing `cwd` defaults to repository root;
- proves in-repository caller paths are honored by a real child process;
- rejects absolute escapes, traversal, control characters, and non-string values;
- source-checks that `runCli` uses the resolver and the worktree path is still passed;
- confirms OpenHands invocation remains disabled.

Capabilities used:

```text
local child process
read-only source inspection
no network
no server boot
no main-repository mutation
```

### `verify-executor-enforcement.mjs`

Purpose:

- creates disposable Git repositories under the OS temporary directory;
- produces real tracked/untracked changes;
- exercises the real porcelain parser and changed-file enforcement;
- tests exact/directory allowed-path boundaries;
- tests mandatory protected paths;
- validates base-branch syntax and pinning helpers;
- tests dependency setup gates and runtime/output/file-count limit helpers;
- checks invocation constraints/readiness remain fail-closed.

It cleans up temporary repositories and does not enable or contact OpenHands.

### `verify-openhands-stop-boundary.mjs`

Purpose:

- source-checks `OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false`;
- rejects any `true` assignment;
- confirms the adapter has no network/process/shell caller;
- checks obvious UI files do not expose a real OpenHands invocation action;
- checks fixtures/schemas contain no autonomy booleans set to true;
- checks every safety-matrix row denies auto-approval;
- confirms the design index treats real invocation as future work.

This is a stop-line verification, not an executor function test.

## 4. Disabled OpenHands adapter/spec verifiers

### `verify-openhands-invocation-adapter.mjs`

Exercises the real disabled adapter helpers:

- configuration validation;
- explicit-off invocation behavior;
- proof that even a supplied transport is not called;
- failure-code mapping;
- status taxonomy;
- denied autonomy booleans;
- human-review requirements;
- protected-path parity;
- payload/report/UI-state helper output;
- example fixture parsing and likely-secret scanning.

It does not import the full server, call the network, or write repository files.

### `verify-openhands-invocation-schemas.mjs`

Checks:

- all JSON schema/spec and example files parse;
- required status values exist;
- autonomy fields must be false;
- human-review fields must be true;
- specs are explicitly non-authorizing;
- endpoint patterns accept only localhost/example values;
- fixtures contain no likely secrets or remote endpoints;
- the adapter source contains no network/process implementation.

This verifier performs structural/spec consistency checks. It is not JSON Schema engine conformance testing.

## 5. LifeSkillSystem documentation verifier

### `verify-lifeskillsystem-skills.mjs`

Recursively discovers files named `SKILL.md` under:

```text
docs/agent_mode/skills/
```

For each skill it requires metadata:

```text
name
description
platforms
status
safety_level
```

and sections:

```text
Purpose
When to use
Safety checks
Output format
Escalate to Fable/Codex when
```

It scans for selected runtime/secret/unsafe tokens. It does not execute skills or prove their practical usefulness.

## 6. Local-learning contract verifiers

### `verify-local-learning-event-schema.mjs`

Checks the Markdown contract, JSON schema, and examples remain aligned and non-authorizing.

It verifies exact required fields, enumerations, closed nested shape for `skill_update_candidate`, approval requirement for source-of-truth candidates, example parity, and forbidden capability tokens.

### `verify-local-learning-event-validator.mjs`

Imports the pure validator and tests:

- valid examples;
- every missing field;
- unknown fields;
- invalid enum values;
- approval fail-closed behavior;
- closed `skill_update_candidate` shape;
- malformed JSON parser behavior;
- absence of write/network/action capabilities from validator source.

### `verify-local-learning-event-writer.mjs`

Uses temporary repository roots to test the manual review-inbox writer:

- exactly one validated candidate write;
- approval flag preservation;
- invalid events write nothing;
- traversal/absolute/sensitive slug rejection;
- symlink/junction escape rejection for every inbox component;
- no-overwrite and collision suffix behavior;
- direct CLI/manual-only wiring;
- no server startup import;
- no network/process capabilities.

This verifier intentionally writes only under OS temporary directories.

### `verify-local-learning-review-inbox-reader.mjs`

Uses temporary roots to test the read-only reader and list CLI:

- missing inbox is empty success and creates nothing;
- valid, malformed, and schema-invalid candidate reporting;
- non-JSON exclusion;
- deterministic filename order;
- directory/file symlink escape rejection;
- CLI output control-character escaping;
- import-time non-mutation;
- no server startup import;
- read-only filesystem API surface.

## 7. Manual utilities not run by package scripts

```text
node scripts/write-local-learning-event.mjs <input-json> [slug]
node scripts/list-local-learning-review-inbox.mjs
```

These commands are deliberately absent from `package.json` scripts. They require conscious direct invocation and are not called at server startup.

The writer creates an unapproved candidate under:

```text
.lps/local-learning/review-inbox/
```

The reader lists and validates candidates without promotion, movement, approval, or deletion.

## 8. Coverage matrix

| Area | Source/invariant checks | Real process/filesystem | Server/API | Browser/UI | Network/external service |
|---|---:|---:|---:|---:|---:|
| Vite build | yes | yes | no | no | no |
| runCli cwd | yes | child process | no | no | no |
| executor path enforcement | yes | temp Git repos | no | no | no |
| OpenHands disabled boundary | yes | no | no | source text only | no |
| OpenHands adapter/schema | yes | fixture reads | no | helper output only | no |
| LifeSkillSystem docs | yes | reads docs | no | no | no |
| local-learning schema/validator | yes | fixture reads | no | no | no |
| local-learning writer/reader | yes | temp directories | no | no | no |
| Planner/Chat/Memory/API | no dedicated verifier | no | no | no | no |
| Installer/portable launch | no | no | no | no | no |
| Browser connector | no dedicated runtime verifier | no | no | no | no |

## 9. Missing test classes

The repository does not currently contain a maintained automated suite proving:

- Express boot and health on an isolated database;
- route request/response contracts;
- SQLite migration/transaction behavior;
- Planner CRUD and restart persistence;
- Chat session/model fallback behavior;
- memory/approval idempotency;
- repository proposal application;
- Git routes in a disposable repository;
- browser-extension job authentication/capture;
- React component behavior;
- accessibility or visual regression;
- portable launch;
- installer install/upgrade/uninstall;
- GitHub Actions success.

These gaps must be covered by the runtime acceptance record until automated integration tests are added.

## 10. Recommended execution order

For a source change:

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

Then perform the subsystem-specific runtime acceptance recipe.

## 11. Maintenance rule

When a safety-critical helper changes:

1. update or add a verifier that imports the real helper;
2. include a positive control and rejection/control case;
3. use temporary locations for filesystem/Git tests;
4. keep network and real OpenHands invocation disabled unless a separately reviewed test environment is introduced;
5. wire the verifier into an appropriate composite package script;
6. add the composite to CI before treating it as a release gate;
7. record runtime evidence separately.