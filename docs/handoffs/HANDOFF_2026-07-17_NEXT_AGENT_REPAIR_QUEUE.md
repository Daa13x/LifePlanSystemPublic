# LifePlanSystemPublic Next-Agent Repair Queue

Date: 2026-07-17

Repository: `D:\_Code_\lps`

Branch and push target: `main` -> `origin/main`

Purpose: give the next agent a source-backed queue with implementation order, safety boundaries, and objective completion tests. The matching jobs are also stored in the app Dev Roadmap. Treat the app tracker as operational state and this file as the detailed repair contract.

## Cross-app audit confirmation

Serenity performed a read-only LPS audit and returned source-backed feedback through thread `019f248e-8ff9-7c51-83b8-a446de4ed437`. It reported `main` clean and synchronized at `15b4ec7` and `npm.cmd run verify:runtime-safety` passing. LPS files were not changed by Serenity.

The eight Serenity findings were deduplicated into seven existing Dev Roadmap jobs:

- Public export privacy (`server/index.js:4663,4666,4680`) -> job 9, repair queue section 2.
- Cloud consultation privacy (`server/index.js:670,677,2482,2498`) -> job 10, section 3.
- Browser capture truth (`browser-extension/lps-browser-agent/background.js:99,148,199`) -> job 10, section 3. This shares one job with cloud egress because the confirmation boundary and provider adapter fixtures must be designed together.
- Workspace symlink/junction escape (`server/index.js:991,999,4599,4612`) -> job 12, section 5.
- Partial durable writes (`server/index.js:4699,4711,1779,1784`) -> job 11, section 4.
- Model lifecycle truth (`server/index.js:2298,2323,2122,2138`) -> job 13, section 6.
- Portable startup (`scripts/package-portable.ps1:135,137,138`) -> job 14, section 7.
- Responsive UI (`src/styles.css:43,877`) -> job 16, section 9.

No duplicate roadmap jobs were created. Job 15, signed and attributable release artifacts, remains independently source-backed LPS work but was not part of Serenity's eight findings. The external confirmation changes provenance only; it does not mark any planned item complete and does not replace the acceptance tests below.

## 1. Completed foundation: DPAPI secret storage

Status: complete in the current change set.

Implemented boundary:

- `server/db.js` treats `hfToken`, `githubToken`, and `browserConnectorToken` as secret keys.
- New values are encrypted with current-user Windows DPAPI before SQLite sees them.
- The plaintext is sent to PowerShell over standard input, not in process arguments.
- Startup migrates legacy plaintext rows. `secure_delete`, WAL truncation, and `VACUUM` remove recoverable legacy copies.
- Empty values delete the secret row rather than storing an empty placeholder.
- A database moved to another Windows user fails closed. The user can replace or clear an unreadable token.
- Client, bootstrap, backup, and export settings have no unredacted mode.

Verification contract:

1. Run `npm.cmd run verify:governance-safety`.
2. Confirm the test seeds a plaintext token before server startup.
3. Confirm the migrated database, WAL, and SHM contain no plaintext token bytes.
4. Confirm stored values begin with `dpapi:v1:` but API responses contain only `[redacted]`.
5. Confirm replacement remains encrypted and clear removes the row.

Do not replace this with reversible application-only encoding or a static key committed beside the database. If cross-platform secret storage is later required, add a platform abstraction backed by the OS keychain; do not add an insecure fallback.

## 2. P1: classified exports and transactional recovery

Source evidence:

- `GET /api/export/json?mode=public` exports every project and every `active` or `stable` knowledge item.
- Status is workflow state, not a privacy classification. Health, therapy, financial, relationship, or identity content can be active and still private.
- Markdown export currently emits every knowledge item without a public/private distinction.
- `POST /api/import/json` writes projects and knowledge items in independent loops with no transaction.
- The Settings label `Local Backup` implies complete recovery, but the format omits several tables and has no schema/version manifest.

Implementation sequence:

1. Add a persisted classification field with an explicit closed set such as `private`, `local-shareable`, `public-shareable`, and `unknown`. Default all existing and imported content to `unknown` or `private`, never public.
2. Add migration code and API validation. Reject arbitrary classification strings.
3. Add an export-preview endpoint that reports included, blocked, and unknown records without returning sensitive bodies in the summary.
4. Require explicit confirmation of the preview token before public export. Recompute the selection server-side so a stale preview cannot authorize newer records.
5. Make Markdown export obey the same policy or rename it clearly as a private local export.
6. Define a versioned recovery manifest listing every included table, excluded local secret, row counts, application version, and export timestamp.
7. Validate the entire import before any write. Resolve project references and duplicate policy in memory first.
8. Use `BEGIN IMMEDIATE`; insert all accepted rows; roll back every row on validation or database failure.
9. Rename `Local Backup` until it actually supports complete recovery, or implement full backup/restore including a tested post-restore health check.

Acceptance tests:

- A private or unknown active item never appears in public JSON or Markdown.
- A public export cannot execute without a current preview confirmation.
- A deliberately injected failure after the first insert leaves all table counts unchanged.
- A round-trip recovery fixture preserves supported fields and reports intentionally excluded secrets.
- Backup and public-export tests search serialized output for seeded sensitive canaries.

## 3. P1: cloud egress classification and provider-aware completion

Source evidence:

- `POST /api/browser/consult` builds a full prompt and creates a browser-agent job after path-level context checks.
- Path protection cannot detect sensitive prose in the local draft or in an otherwise allowed source file.
- `browser-extension/lps-browser-agent/background.js` uses broad selectors and text stability. Generic containers such as `main` can capture stale or unrelated text.
- Jobs remain in the in-memory `browserAgentJobs` map after terminal completion or timeout.
- The server waits up to four minutes but exposes no cancellation path.

Implementation sequence:

1. Introduce one server-side egress decision function that receives target provider, local draft, generated prompt, and selected file excerpts.
2. Detect high-confidence credentials, private keys, account numbers, health/therapy terms, identity data, and user-configured private phrases. Treat uncertain results as review-required, not safe.
3. Return a preview with categories and redacted excerpts. Require an explicit confirmation token bound to a hash of the exact prompt and target provider.
4. Revalidate immediately before creating a connector job. Never trust a UI-only checkbox.
5. Split extension behavior into provider adapters for ChatGPT, Gemini, Grok, and Claude. Each adapter owns composer, send, assistant-turn, busy/stop, and completion selectors.
6. Prefer provider completion signals. Keep a bounded text-stability fallback only when the provider adapter documents why no signal is available.
7. Record the assistant-turn count before send and capture only a later assistant turn. Never fall back to page-wide `main` content for an answer.
8. Add cancellation and terminal timestamps. Prune answered, blocked, errored, cancelled, and timed-out jobs after a short diagnostic retention period.
9. Handle multiple matching tabs explicitly: present choices or bind a job to the tab/account selected by the user.
10. Add an acceptance case for extension reload and pairing-config port changes.

Acceptance tests:

- Mock DOM fixtures cover all four providers, streaming, stopped generation, login challenge, stale prior turns, and selector absence.
- A sensitive canary blocks before the extension can claim a job.
- Confirmation is invalid if prompt text or provider changes.
- Cancellation stops waiting and prevents a late result from changing job state.
- Repeated terminal jobs do not grow the map without bound.

## 4. P1/P2: transactional chat, consultation, model, and import writes

Source evidence:

- Chat send inserts the user message, maybe creates a candidate, waits for model execution, inserts the assistant message, then updates the session without a transaction or recoverable pending state.
- Consultation patch updates the consultation and separately creates a memory candidate.
- JSON import performs multiple writes with no rollback.
- Model download writes the file and then updates registry/settings separately.

Implementation sequence:

1. Add a small transaction helper around explicit `BEGIN IMMEDIATE`, `COMMIT`, and guaranteed `ROLLBACK`.
2. For synchronous multi-row operations, validate first and execute all writes in one transaction.
3. Do not hold a SQLite transaction open across model/network calls. For chat, first create a durable request row or pending assistant record, run the model, then atomically finalize the response and candidate linkage.
4. Give retriable requests a client-generated idempotency key with a unique database constraint.
5. Store provenance links directly, such as candidate source message/consultation IDs, instead of relying only on title or status.
6. Return a recoverable state when the model fails after the user message is accepted. The UI should offer retry without duplicating the user message.

Acceptance tests:

- Inject a failure at every write boundary and assert either the complete operation or the documented recoverable pending state.
- Repeating the same idempotency key creates no duplicate messages, candidates, projects, or knowledge items.
- Concurrent approval/import requests respect unique constraints and return `409`, not duplicate side effects.

## 5. P2: Repository Explorer realpath containment

Source evidence:

- Chat context now performs regular-file and realpath containment checks.
- Repository Explorer list, preview, and proposal paths still rely on lexical workspace resolution in several routes.
- A junction or symlink inside the repository can point outside it while retaining an apparently safe lexical path.

Implementation sequence:

1. Create one operation-aware resolver shared by list, read, diff, and proposal routes.
2. Normalize the requested relative path and reject protected segments before filesystem access.
3. For existing targets, resolve `realpath` and require containment under the repository realpath.
4. For creates, resolve and constrain the nearest existing parent, then reject symlink/junction path components.
5. Open/read the validated target with minimal delay and compare final metadata where practical to reduce TOCTOU exposure.
6. Keep protected-path checks after canonicalization as well as before it.

Acceptance tests:

- Symlinks and Windows junctions to an outside directory are rejected by list, preview, context, and proposal APIs.
- A safe in-repository file still works.
- Nonexistent create targets under a safe real parent work; targets under an escaping junction fail.

## 6. P2: verified atomic downloads and llama readiness

Source evidence:

- Hugging Face model downloads stream directly to the final path.
- Interrupted downloads can therefore look like valid registered models.
- Download paths do not verify a published checksum before registration.
- Managed llama-server start records a process before proving the HTTP endpoint is ready and provides limited startup diagnostics.

Implementation sequence:

1. Download to a unique `.partial` file in the final directory so rename remains same-volume and atomic.
2. Enforce a maximum expected size and validate content length when supplied.
3. Compute SHA-256 while streaming. Require a published digest where the upstream provides one; otherwise display the computed digest and provenance as unverified.
4. Close and flush the file, then atomically rename. Delete partial files on abort, timeout, hash mismatch, or process exit.
5. Register/update the model only after rename succeeds.
6. Capture bounded llama stdout/stderr to a diagnostic buffer and log file.
7. Poll the configured endpoint with a bounded timeout and verify a model-aware response before reporting ready.
8. On timeout or early exit, terminate only the owned process and return captured diagnostics.

Acceptance tests:

- Simulated network interruption leaves no final model and no registry row.
- Hash mismatch deletes the partial and reports the expected/actual digest safely.
- Slow successful startup transitions to ready; timeout and crash clean up the owned process.

## 7. P2: installer launch health and process lifecycle - completed 2026-07-22

Completion note:

- Tray support is now an application feature on `main`; do not split it back into a long-lived tray-only branch.
- Installed and portable shortcuts launch `Start Life Planner.vbs`, which starts `LifePlannerTray.ps1` with no visible Node or PowerShell terminal.
- The notification-area icon keeps the local environment alive when the browser closes and provides Open, Pause, Resume, and Exit actions. Exit stops only the owned bundled Node process tree.
- Startup uses a per-install/port mutex, exact bundled-runtime ownership checks, bounded `/api/health` polling, port-collision reporting, log capture, and failed-start cleanup.
- Packaging validates the PowerShell syntax and tray contract, copies the app icon and launchers, and portable-package verification proves the files are present. `verify:tray-launcher` is also part of the standard `verify:runtime-safety` gate.
- The implementation was compared with the native tray lifecycles in `D:\_Code_\Serenity` and `D:\_Code_\KeepHerFlying`; LPS retains their owned-process shutdown pattern and adds HTTP health proof before reporting ready.

Source evidence:

- `scripts/package-portable.ps1` generates `Start Life Planner.cmd` with `timeout /t 2` before opening the browser.
- Slow migration, Chromium setup, port conflict, or startup failure can open a dead page with no useful explanation.
- Repeated launches can create competing servers.

Implementation sequence:

1. Replace the batch-only launcher with a small PowerShell launcher included in the portable package.
2. Check whether `/api/health` already answers on the configured port. If it is the expected app, reuse it; if another process owns the port, fail with a clear message.
3. Start the bundled Node process with stdout/stderr redirected to a known local log.
4. Poll `/api/health` until success, child exit, or bounded timeout. Only then open the browser.
5. Display the log location and last useful error on failure.
6. Add a single-instance mechanism and an explicit controlled-shutdown endpoint or tray/launcher action with local-only authentication.

Acceptance tests:

- Cold start, slow start, already-running start, port collision, migration failure, and missing browser dependency all produce deterministic results.
- No test kills unrelated Node processes; ownership is established by exact executable/path and spawned PID.

## 8. P2: signed and attributable release artifacts

Implementation sequence:

1. Generate `SHA256SUMS` for installer and portable artifact in CI.
2. Generate a CycloneDX or SPDX SBOM from the locked production dependency tree and packaged native/runtime files.
3. Attach GitHub artifact attestations/provenance for the exact commit and workflow run.
4. Add Authenticode signing only when a protected signing identity is explicitly configured. Never put certificate material in the repository or ordinary SQLite settings.
5. Verify the signature and hash after the release asset is downloaded, before install acceptance.
6. Clearly label unsigned local/development builds rather than implying production trust.

Acceptance tests:

- Hash manifest matches downloaded artifacts byte-for-byte.
- Provenance identifies repository, commit, workflow, and artifact digest.
- Signing-enabled builds verify with `Get-AuthenticodeSignature`; signing-disabled builds are explicit and cannot publish as a trusted production release.

## 9. P2: responsive and keyboard-accessible UI

Source evidence:

- `src/styles.css` applies `body { min-width: 900px; }` below 1180px, forcing horizontal overflow on phones and narrow windows.
- Several icon-only controls rely on visual context or title text.
- There is no automated axe/keyboard acceptance in the current pipeline.

Implementation sequence:

1. Capture current desktop screenshots and key workflows before layout changes.
2. Remove the global minimum width and define intentional breakpoints for navigation, Source, Settings, Planner, and modal content.
3. Add visible `:focus-visible` styling with sufficient contrast.
4. Give icon-only controls stable accessible names and ensure form errors are announced.
5. Verify logical tab order, Escape behavior, modal focus trapping/restoration, and no keyboard traps.
6. Add axe checks and a Playwright keyboard smoke path to CI.

Acceptance tests:

- No horizontal page overflow at 360, 768, 1280, and 1920 CSS pixels.
- Planner, Source, Settings, import preview, and confirmations are usable by keyboard only.
- Automated accessibility checks have no serious/critical violations; documented exceptions include owner and follow-up date.

## 10. Tracker and execution rules

- Update the matching Dev Roadmap job when starting: set it to `active` and append the branch/commit plus exact test plan.
- Keep at most one of these risk jobs active per agent unless the changes are inseparable.
- Do not mark a job `done` from static review. Record executed commands, fixture names, runtime evidence, and remaining limitations.
- Before push: fetch `origin/main`, inspect divergence, run the focused verifier plus `npm.cmd run build` and `npm.cmd run verify:runtime-safety`.
- Push only to `origin/main` when explicitly requested by the maintainer.
- Watch the resulting GitHub Actions installer run to completion. A local pass does not prove hosted packaging.
- Never weaken protected paths, redaction, publication confirmation, browser pairing, or OpenHands stop boundaries to make a test pass.
