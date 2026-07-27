# LPS C# Native Core + WebView2 - Final Brief v6

## Mission

Implement a staged Windows-native migration. C# is authoritative for system and business logic. WinForms is the desktop shell. WebView2 hosts the existing React UI and isolated provider surfaces. SQLite is the single persistent source of truth. React is presentation, accessibility and input only. Node is a temporary compatibility host and must be removed after proven C# parity.

Work on main in the selected checkout. Preserve existing work; no branch, worktree or PR. The installed tray-launched application is the acceptance target. Do not claim success from source tests alone.

## Ownership

| Component | Owns | Must not own |
|---|---|---|
| WinForms | single instance, tray, lifetime, DPI, WebView construction | domain policy or direct SQL |
| Native services | use cases, validation, transactions, providers, migrations, recovery | UI rendering |
| Infrastructure | Sqlite, DPAPI, HTTP, files, redacted logs | business decisions |
| SQLite | every durable domain record and migration journal | duplicate JSON truth |
| React | rendering, accessibility, input collection | durable writes, policy, migration |
| Node compatibility | named legacy read/route adapters | new features or durable writes |

Use .NET Generic Host, DI, typed validated configuration, structured redacted logging and cancellation-aware hosted services. Use Microsoft.Data.Sqlite. Do not create ceremonial repository layers.

## Data safety

One SQLite profile and one native writer. Node does not write after Phase 2. Migrations are forward-only, journalled and transactional where possible. Before schema work, verify a backup, rehearse on a copied profile and run integrity checks. Binary rollback never silently downgrades schema. Preserve DPAPI credentials, provider profile data and user AppData paths. Use explicit connection lifetimes, enabled foreign keys, tested WAL choice, bounded cancellable lock retry and idempotency keys.

## WebView2 security

The main packaged view is trusted only at its local origin. Each provider gets a separate WebView2 environment and user-data directory. Enforce a provider allow-list on navigation; block unknown navigation, popup, download, permission, DevTools and remote debugging unless a documented user action permits them. Test frames, workers, WebSockets, EventSource, loopback and private-network access.

Web messages are not authentication. Accept only versioned JSON that validates origin, schema, type, correlation ID, expiry and one-time capability token. Capabilities grant one named action for one provider/session and revoke on navigation, crash, cancel and timeout. Provider pages receive no filesystem, SQLite, tokens, loopback or arbitrary host commands.

## Provider policy

Official APIs are default. OAuth uses system browser and OS-protected tokens. Maintain a versioned provider registry: provider, model, auth mode, domains, policy status, retry rules, capture mode and review date. Consumer-site automation is never represented as API execution. Classify outbound content server-side; block sensitive data without recording it. Persist immutable reviewed prompt hash, scope references, provider/model and idempotency key. States: draft, blocked, allowed, active, completed, failed, cancelled. Cloud output is untrusted; it cannot change system instructions or create memory except a reviewed candidate with provenance.

## Phase programme

Maintain .agent/run-state.md each phase with baseline commit, commands, changed files, backup/rehearsal IDs, installed build/health, rollback point and pass/fail evidence.

### 0. Baseline
Inventory Node writes, schema, credentials, tray lifecycle, provider paths and installed runtime. Create copied-profile rehearsal. No behavior migration. Exit: evidence complete.

### 1. Native host
Create WinForms executable, Generic Host, DI, logging, single-instance/tray lifecycle, native health identity and packaged React WebView. Test lifetime/cancellation/DPI/clean exit. Rollback: existing launcher remains.

### 2. SQLite ownership
Create native migration runner, backup/recovery service and contracts. Move one low-risk write at a time and disable its Node write path. Test idempotency, lock/cancel, crash/reopen and copied-profile restore. Exit: native writer proven.

### 3. React boundary
Use versioned command/query DTOs. React renders state only. Add architecture tests prohibiting React/Node direct SQL or policy. Test contract replay, keyboard/screen-reader and stale/offline UI.

### 4. Provider foundation
Create provider registry, DPAPI token store, official API adapter, system OAuth, request journal, retry/cancel/idempotency and reviewed memory candidates. Test blocked send, injection, redaction, retry duplication and cancellation.

### 5. Provider views
Implement isolated WebViews, policy and capability protocol. Test hostile origin, malformed/expired messages, popups/downloads/private-network rejection and crash/session recovery.

### 6. Node exit
Replace every Node route/job/write in the parity matrix. Exit only after all writes are native, contract corpus parity passes, two installed native-only releases/restarts pass, restore/update/rollback drills pass, and installer payload contains no Node runtime.

## Evidence and completion

Every phase requires unit, transaction, privacy/security and browser regression tests; production build; portable and installed rebuild; user data and credential preservation evidence; health; clean exit; final diff review. Installer updates are atomic/recoverable and prove installed commit identity. Commit to main, push origin, fetch and prove main equals origin/main.

Final status is COMPLETE only when the active phase exit criteria and installed evidence are true. Use USER ACTION REQUIRED only for an exact external action after all independent work; USER DECISION REQUIRED only for consequential options. Never accept compile, mock or partial UI as completion.

## Per-phase evidence template

For every phase write purpose, affected areas, prerequisites, delivered contracts, prohibited work, automated tests, installed acceptance, data-safety checks, rollback point, exit criteria and next phase in run-state. Record exact command, UTC time, build commit, installer hash, profile identifier without secrets, artifact path and result. A phase with any missing field remains active.

The run-state must also list every manual action that is not yet needed. Do not request a user sign-in, provider connection, installer click or data decision until independent implementation, tests and diagnostics have been exhausted.

## Architecture enforcement

Add machine checks that fail when React or Node imports direct SQLite access, migration code, DPAPI/credential code, prompt classifier, provider credential or durable write route; fail when native command handlers bypass validation/transaction policy; and fail when provider web-message schemas contain unbounded command names. Contract compatibility tests replay saved Node request/response fixtures against native handlers. Security test fixtures include prompt-injection text, malformed messages, wrong origin, reused token and cancelled request.

## Operational detail

Acquire a named single-instance mutex before shell initialization and marshal a second launch to the first instance. Dispose WebViews and host services in deterministic order. Use an owned Job Object for deliberate child processes; never terminate by broad image name. Persist a clean-shutdown marker, classify stale process state at next launch, and surface recovery rather than silently deleting data. Keep bounded redacted logs and a user-exportable diagnostic bundle containing versions, health, migration states and non-secret error identifiers.

The installer must never overwrite or delete application data, credential stores or provider profiles. It must verify payload identity before launch, wait for or safely preserve a running runtime, record installed commit/build identity, and prove an update from a live prior installation plus a clean exit/restart. A failed update leaves the previous runnable binary or enters an explicit recovery flow; it does not leave a partially copied UI.

## Accessibility and UI acceptance

Provider controls belong below the relevant assistant message and at the composer when initiating a new request. Use compact labelled controls, not repeated raw technical metadata. Keep provider panels in LPS with a docked fallback. Test 100/125/150/200 percent DPI, keyboard-only send/cancel/retry/remove guidance, focus restoration after modal/provider failure, screen-reader names/live status, high contrast and reduced motion. Disabled, disconnected, blocked, active, completed, failed and cancelled states must be visually and programmatically distinct. Never display connected merely because a provider surface has loaded.
