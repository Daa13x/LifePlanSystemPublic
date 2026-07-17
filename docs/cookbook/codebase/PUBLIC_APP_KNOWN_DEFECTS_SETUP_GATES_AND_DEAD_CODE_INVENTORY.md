# LifePlanSystemPublic Known Defects, Setup Gates, and Dead-Code Inventory

Status: canonical source-level defect and incompleteness inventory for the runnable public app as inspected on 2026-07-16. Runtime results can add, close, or reprioritize entries; they must not silently erase source-confirmed issues.

Last updated: 2026-07-17

## 1. Status definitions

```text
BROKEN       implemented path contains a confirmed defect
UNSAFE       implemented behavior can cross a security/privacy/safety boundary
SETUP-GATED  behavior requires missing configuration, dependency, service, login, or unverified infrastructure
STATIC EXISTS source/UI exists but runtime success is unproven
STALE        documentation, setting, scaffold, or code no longer matches maintained behavior
DEAD CODE    unreachable, misplaced, or nonfunctional implementation fragment
DESIGN DEBT  maintainability/architecture problem that is not itself an MVP blocker
```

An entry can have more than one status.

## 1.1 Verified closure addendum (2026-07-17)

The older source findings below remain useful historical evidence, but the following entries are superseded by verified fixes:

- Browser extension bridge authentication: fixed with a generated 256-bit pairing token, timing-safe header validation, per-job claim tokens, and 120-second reclaimable leases. Live isolated API verification rejects missing/wrong tokens and accepts the generated token.
- Browser tab privacy: fixed in both the extension and server. Only supported cloud-agent hosts are reported or retained; the live verifier proves an unrelated banking URL is absent.
- Secret-inclusive backup: removed. Backup exports redact all secret settings even when the legacy query flag is supplied.
- Approval Queue Revalidate crash: fixed by moving the callback into `ApprovalQueue`; the screen was opened in a real browser with no console errors.
- Repeated approval, memory-candidate, and roadmap-candidate decisions: fixed with fail-closed atomic status claims; roadmap acceptance wraps its database changes in a transaction. Isolated API tests prove the second request returns `409` and creates no duplicate row.
- Unknown approval actions: rejected at creation and decision boundaries.
- Chat attached-context leakage: fixed with protected-path, regular-file, symlink, and realpath containment checks; `.git/config` is rejected by an isolated API test.
- Nested protected paths and database sidecars: fixed in Source Control policy and `.gitignore`, including `.env`, SQLite WAL/SHM files, pairing configs, `.claude`, and automation probe output.
- Generic secret-setting writes: rejected before any setting mutation. Hugging Face tokens now use a dedicated validated endpoint.
- Health database metadata: reports the effective resolved `LIFE_PLANNER_DB` path and is covered by the governance verifier.
- Inert connector port input: removed. The UI displays the running application port, and the extension reads the generated pairing config.
- Portable package data/native-module deletion and pairing-token leak: fixed by root-scoped private-data cleanup and a required package manifest verifier.
- Installer version and release verification gate: closed. Version is `1.0.0`; hosted push and release-targeted runs passed `verify:runtime-safety`, packaging, Inno compilation, and artifact publication. The exact Release `1.0` asset passed silent install, bundled-runtime health/UI checks, and silent uninstall.

These closures do not resolve plaintext secret storage, public-export classification, browser content classification/selector durability, signed releases, full backup/restore, or the remaining transaction and accessibility findings.

## 2. Critical safety and privacy findings

### `FIXED 2026-07-17` — general Source Control diff protected-content guard

Route:

```text
GET /api/source/diff
```

The route now enumerates changed paths with null-separated Git output before rendering content. If any protected path is present, it returns no general diff detail and directs the Source tab to per-file review. Safe-only diffs pass an explicit path list to Git.

### `FIXED 2026-07-17` — private-repository publication server boundary

Branch and tag publication now require a GitHub origin named `LifePlanSystemPublic` plus the public `SANITISATION_POLICY.md` marker. The backend reports this decision to the Source tab, which disables publication controls and displays the refusal reason when identity cannot be verified. External repository creation defaults private and requires explicit confirmation for public creation.

### `FIXED 2026-07-17` — stored GitHub token host isolation

Stored GitHub credentials are now injected only into parsed HTTPS `github.com` remotes. Unknown hosts, unsupported schemes, and URLs containing embedded credentials are refused; approved non-GitHub remotes never receive the GitHub token.

### `UNSAFE` — browser extension protocol has no authentication

Heartbeat, next-job, and job-result routes have no pairing secret, signature, connector identity, or lease token. Any local process able to call the port can impersonate the extension or modify a job result.

Required fix: per-install pairing secret, scoped job token, lease/expiry, and localhost-origin validation.

### `UNSAFE` — extension reports all HTTP(S) tab titles and URLs

The extension heartbeat sends metadata for every open HTTP(S) tab, not only supported cloud-agent hosts.

Required fix: filter to supported/explicitly selected hosts and minimize metadata.

### `UNSAFE` — public export is not a privacy classification

Public JSON includes every project and every active/stable knowledge item. It does not scan for personal, therapy, health, credential, or private-memory content.

Required fix: explicit shareability classification and preview/confirmation before export.

### `UNSAFE` — secret-inclusive backup endpoint needs no additional authorization

A direct local request using:

```text
/api/export/json?mode=backup&includeSecrets=1
```

returns unredacted stored settings, including tokens. The UI does not expose the link, but the backend accepts it without a fresh confirmation/capability/audit.

Required fix: remove the option or require an explicit one-time authorization and encrypted export path.

### `UNSAFE` — tokens are plaintext in SQLite

API and normal export redaction do not encrypt secrets at rest.

Required fix: OS credential store or separately encrypted secret storage.

## 3. Governance and idempotency defects

### `BROKEN` — Approval Queue Revalidate button is mis-scoped

`ApprovalQueue` renders a call to `revalidate(item.id)`, but the function is declared inside `Projects`, where it also references state that `Projects` does not own.

Expected runtime result: reference error when the Approval Queue Revalidate action is clicked.

Required fix: move the function into `ApprovalQueue` or a shared callback and add a component/API test.

### `BROKEN` — memory candidates can be approved repeatedly

The approve route does not require current status `candidate` before inserting approved knowledge. A direct repeated request can duplicate knowledge.

Required fix: conditional state transition and transaction/unique provenance guard.

### `BROKEN` — generic approvals can be decided repeatedly

Decision routes do not consistently require `pending`. Re-approval can repeat create/add/update side effects.

Required fix: atomic `WHERE status='pending'` transition before mutation, plus idempotency key/audit.

### `BROKEN` — unknown approval action can become approved

An unrecognized `action_type` can pass through decision handling and be marked approved without a meaningful action.

Required fix: reject unknown action types before status change.

### `BROKEN` — roadmap candidate can be accepted repeatedly

A direct repeated accept can create duplicate roadmap work because transition state is not fail-closed.

Required fix: atomic candidate-state transition and accepted-item linkage.

### `DESIGN DEBT` — roadmap scanner ingests assistant messages

Assistant-generated suggestions can be staged as development candidates alongside user statements.

Required fix: deliberate source policy, provenance label, or user-only default.

### `DESIGN DEBT` — direct item/project/Git mutations use inconsistent governance

Repository Explorer uses approvals, while Planner items, direct project endpoints, Roadmap edits, many Git actions, Tooling installs, and model downloads execute directly.

Required decision: define which user actions are direct, which require confirmation, and which must enter the approval ledger.

## 4. Configuration and port defects

### `BROKEN` — `browserAgentPort` setting is inert

The value is saved/displayed, but the extension background and manifest remain hard-coded to `127.0.0.1:4177`.

Required fix: remove the field until supported or generate extension/launch configuration from one port authority.

### `BROKEN` — non-default server port breaks development/extension integrations

`LIFE_PLANNER_PORT` changes Express, but Vite proxy, extension code/permission, portable launchers, and related documentation use `4177`.

Required fix: central port registry and generated configuration.

### `BROKEN` — health route can report the wrong database path

When `LIFE_PLANNER_DB` overrides the database, `/api/health` reports the default path rather than the effective path.

Required fix: export/read the effective database filename from the database module.

### `UNSAFE` — generic settings route bypasses dedicated secret validation

Dedicated GitHub token handling validates token shape, but generic `POST /api/settings` can set secret keys directly unless the value is the redaction placeholder.

Required fix: allowlist public settings on the generic route and force secrets through dedicated handlers.

### `DESIGN DEBT` — settings lack schema/range validation

Ports, paths, context size, modes, endpoint URLs, folders, and arbitrary setting keys are weakly validated.

Required fix: typed central settings registry with defaults, validation, redaction, migration, and consumer ownership.

## 5. Chat and model defects/setup gates

### `UNSAFE` — chat attached context does not use the protected-path filter

Chat context checks workspace confinement and file existence but does not apply the same protected-path policy used by repository preview/cloud context.

Required fix: one shared context-read policy with repository identity and private-folder rules.

### `BROKEN` — chat/model writes are not transactional

User message, model execution/fallback, assistant message, session update, and candidate extraction are sequential. Partial failures can leave incomplete state.

Required fix: define transactional boundaries and recovery status.

### `SETUP-GATED` — local model response needs a configured runtime

A real response requires a managed endpoint, assigned model/server, or CLI path. Otherwise the system must clearly report setup gating.

### `BROKEN` / `DESIGN DEBT` — managed llama-server readiness is not awaited

The process is started and output is hidden; the route does not poll health/readiness before reporting startup.

Required fix: capture logs, readiness probe, startup timeout, and failure cleanup.

### `DESIGN DEBT` — model downloads are not checksum-verified

Hugging Face files are streamed to the selected target without a digest requirement or atomic temporary-file rename.

Required fix: optional/required digest verification, temporary download, cleanup, and provenance metadata.

## 6. Repository path and filesystem defects

### `UNSAFE` — public protected-path rules do not define the private brain

The policy blocks runtime directories/extensions but does not automatically block private-brain trees such as `source_of_truth/`, `rules/`, or all sensitive memory locations.

Required fix: repository identity plus repository-specific policy; never run the public app against the private root by assumption.

### `UNSAFE` — nested `.env` and nested protected directory names can escape simple root checks

Protection is strongest for root prefixes/exact names. Nested paths can fall outside intended checks.

Required fix: path-segment and filename policy independent of depth.

### `UNSAFE` — symlink/junction traversal is not comprehensively blocked in Repository Explorer

Lexical path confinement does not by itself prove the resolved file remains under the repository root.

Required fix: `lstat`/`realpath` containment checks for every path component and target.

### `DESIGN DEBT` — file listing and text reads are synchronous

Large trees/files can block the single Node event loop.

Required fix: bounded asynchronous traversal/read, size caps, and cancellation.

## 7. Browser/connector defects and setup gates

### `BROKEN` — Chrome connector UI can be gated by Playwright readiness

Frontend disabled-reason logic combines primary connector availability with Playwright/Chromium fallback readiness, despite messaging that Playwright is fallback-only.

Required fix: evaluate connector and controlled-browser paths independently.

### `BROKEN` — claimed jobs can become stranded

`GET /extension/next` changes the oldest pending job to `claimed`. There is no lease expiry/reclaim when the extension crashes or loses the tab.

### `DESIGN DEBT` — job map grows and has no pruning/cancellation

Jobs are process-memory entries. Timeouts do not cancel underlying claimed/sent work, and terminal jobs are not explicitly pruned.

### `DESIGN DEBT` — first matching provider tab is selected

Multiple accounts/conversations are not disambiguated. An auth tab can match a provider host.

### `BROKEN` / `SETUP-GATED` — non-connector automatic path is ChatGPT-specific

The server accepts other named agents but direct controlled automation/capture logic is primarily designed for ChatGPT.

### `DESIGN DEBT` — response completion is a three-second stability heuristic

Streaming pauses can be mistaken for completion; changing page content can prevent completion.

### `UNSAFE` — no sensitive-content classifier before cloud egress

Selected files are bounded and path-checked, but their contents are not scanned/classified for private health, therapy, credentials, or identifiers.

## 8. Import/export and recovery defects

### `STALE` / `BROKEN EXPECTATION` — “Local Backup” is not full recovery

Backup JSON omits approvals, roadmap data, model registry, chat context attachments, OpenHands/local-learning artifacts, files/models/browser profiles, and other state. Its importer restores only projects and knowledge items.

Required fix: rename to partial data export or implement versioned full backup/restore.

### `BROKEN` — JSON import is not transactional

A failure after partial inserts can leave partially imported projects/items.

### `DESIGN DEBT` — duplicate detection uses exact title/name only

It is case-sensitive and ignores IDs/provenance/content.

### `UNSAFE` — imported values have weak validation

Statuses, confidence, ownership, evidence, and content are accepted with defaults but no complete schema/domain validation.

### `STALE` — Markdown export is not round-trip

Markdown import treats the entire document as one pending source document; it does not restore exported knowledge rows.

## 9. OpenHands and local-learning findings

### `SETUP-GATED` — real OpenHands invocation is intentionally disabled

```js
OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false
```

`executor-ran` means the harness ran, not that AI edited code.

### `STALE` / `INERT` — `targetRepoPath` is stored but not execution authority

Requests record the field, but execution uses the server's current repository root.

Required fix: remove the field or implement a separately validated repository registry.

### `BROKEN REPEATABILITY` — executor branch remains after no-diff run

The worktree can be removed while the dedicated branch remains. Re-running the same request is then blocked by branch existence.

Required fix: explicit reviewed cleanup action/state or one-run terminal semantics.

### `SETUP-GATED` — `npm run build` in a fresh worktree lacks `node_modules`

The harness correctly refuses rather than installing/copying dependencies automatically.

### `DESIGN DEBT` — OpenHands/local-learning queues are outside SQLite

Requests/candidates/reports use `.lps` files with separate backup, audit, and lifecycle requirements.

### `STATIC EXISTS` — local learning is manual-only

The writer/reader and contract tests exist, but the server does not enable an autonomous learning engine or automatic memory promotion.

## 10. Packaging, installer, and CI findings

### `BROKEN` — `SkipPlaywrightInstall` parameter mismatch

`build-installer.ps1` can forward `-SkipPlaywrightInstall`, but `package-portable.ps1` does not declare it.

### `STALE` — README says portable packaging installs Chromium

Actual behavior creates an installer command; Chromium is downloaded during installer post-run or first launch.

### `SETUP-GATED` — first launch may require Chromium network download

Proxy, antivirus, permissions, CDN, and cache issues can block it.

### `UNSAFE SUPPLY CHAIN` — embedded Node download has no checksum verification

The packaging script downloads and extracts a versioned HTTPS ZIP but does not verify a digest/signature.

### `DESIGN DEBT` — package includes two legacy sanitised scaffold trees

They are not maintained runtime entry points and can confuse users or increase installer size.

### `BROKEN EXPECTATION` — launch uses fixed two-second sleep

The browser can open before Express is ready. There is no health poll or failure message.

### `DESIGN DEBT` — no process/single-instance/shutdown manager

The launcher creates a minimized command server and opens a browser. It does not detect an existing instance or provide controlled shutdown.

### `STALE` — installer version is hard-coded `0.1.0`

It is not derived from package metadata or release tags.

### `SETUP-GATED` — CI source says it has not been validated by a real run

The workflow exists but source comments explicitly retain starting-draft/unvalidated status.

### `BROKEN RELEASE GATE` — CI does not run verification scripts or runtime smoke tests

It builds/packages only. A green build would not prove safety invariants, portable launch, installer behavior, or UI/API workflows.

### `DESIGN DEBT` — release outputs are unsigned

No code signing, SBOM, checksum artifact, or provenance attestation is configured.

## 11. UI, CSS, and accessibility findings

### `BROKEN FOR MOBILE` — hard desktop minimum width

`body` requires 1080px, reduced only to 900px under a 1180px breakpoint. Mobile/narrow windows require horizontal scrolling.

### `ACCESSIBILITY` — form outlines are removed without replacement

Global controls set `outline: none`; explicit `:focus-visible` styling is absent.

### `ACCESSIBILITY` — no automated accessibility verification

No keyboard, contrast, screen-reader, reduced-motion, high-contrast, or axe-style tests are maintained.

### `DESIGN DEBT` — frontend and stylesheet monoliths

All React panels live in `src/main.jsx`; all visual rules live in a global 1,000+ line stylesheet.

### `DESIGN DEBT` — global selector/override coupling

Generic selectors and appended subsystem styles make changes dependent on source order.

## 12. Test and observability gaps

### `STATIC EXISTS` — safety verifiers are not integration tests

Maintained scripts prove selected source invariants but do not boot the app or test UI/API workflows.

Missing automated classes include:

- Express isolated-database smoke tests;
- API contract tests;
- migration/transaction tests;
- Planner/Chat/Memory/Approval lifecycle tests;
- disposable Git route tests;
- browser extension mock-page tests;
- React component/browser tests;
- accessibility/visual regression;
- portable launch and installer tests;
- GitHub Actions release acceptance.

### `DESIGN DEBT` — limited logging/audit model

Many operations return transient stdout/stderr or write a report but there is no centralized structured event log, correlation ID, retention policy, or audit query surface.

### `DESIGN DEBT` — API client has no timeout/cancellation/retry taxonomy

The frontend assumes JSON and exposes a single error string.

## 13. Legacy, stale, and dead-code inventory

Confirmed/likely source categories:

```text
DEAD CODE  misplaced Projects.revalidate implementation
INERT      browserAgentPort setting
INERT      OpenHands request targetRepoPath
DISABLED   real OpenHands invocation adapter/harness call
FUTURE UI  Browser “save chat log later” and “sync everything later” controls
LEGACY     LifePlanSystem_Public_Sanitized/
LEGACY     LifePlanSystem_Sanitised_UI_Scaffold_2026-06-29/
STALE DOC  README Chromium-bundling statement
STALE DOC  workflow starting-draft text until CI is actually validated
STALE NAME backup export implying full recovery
```

The legacy scaffold directories must not be deleted merely because they are not runtime code. First establish whether they provide unique historical/reference content, then archive or remove them through a reviewed cleanup change.

## 14. MVP priority order

Fix or explicitly gate before calling the MVP functional:

1. Approval Queue Revalidate crash.
2. Clean app startup and health with correct effective database reporting.
3. Core Planner/Chat/Memory path and restart persistence.
4. Approval and memory candidate idempotency.
5. Protected-content leak from general diff.
6. Private-repository publication/egress safeguards.
7. Settings/port truth so primary integrations are not falsely configurable.
8. Portable package launch and installer acceptance.
9. CI workflow real run and release artifact evidence.
10. Backup/export naming and recovery documentation.

Post-MVP unless they block actual use:

- component/CSS modularization;
- full mobile redesign;
- real OpenHands invocation;
- autonomous local learning;
- broad architecture rewrite.

## 15. Closure rule

An entry is closed only when:

1. source behavior is fixed or intentionally removed;
2. a focused verification prevents regression where practical;
3. the relevant runtime acceptance scenario passes;
4. documentation and settings text match actual behavior;
5. the dated acceptance record links the exact commit/result;
6. this inventory is updated with the closure evidence.

Do not close entries because the UI looks complete or a code path exists.
