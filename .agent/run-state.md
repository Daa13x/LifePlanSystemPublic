# Native-Core Migration Run State

## Phase 0 baseline

- Baseline commit: 7654d48cffd7
- Repository: Daa13x/LifePlanSystemPublic on main; remote matches local at baseline.
- Existing runtime: installed tray host starts bundled node.exe and server/index.js on loopback port 4177.
- Durable truth today: data/life-planner.sqlite, opened and migrated by server/db.js using node:sqlite.
- Existing protections: WAL, foreign keys, secure delete, DPAPI-wrapped setting values, staged backup/restore and installed health identity.
- Node write surface: Express owns chat, projects, roadmap, memory, cloud checks, settings, provider/browser, tooling and source-control mutations.
- Native implementation status: no C# project exists. .NET 9 runtime is installed but no SDK is available, so native source cannot yet be compiled.
- Data rule: no migration or installed database mutation has been performed by this programme.

## Evidence

- Commands: git status --short --branch; npm run policy:cloud-main; dotnet --info; source inventory of server/db.js, server/index.js, installer and tray script.
- Installed baseline build: ab07d29b2397; health database state ready.
- Rollback point: no production database or installer modification during Phase 0.

## Next

## Phase 1 native shell

- SDK provisioned locally: .NET SDK 9.0.306 under the local LifePlanSystem tool directory.
- Added: native/LifePlanSystem.Native WinForms project with Generic Host, single-instance mutex, native runtime identity, as-invoker manifest and a main WebView2 profile isolated under LocalAppData.
- Boundary: the native view accepts only the existing 127.0.0.1:4177 UI origin; it has no SQLite, credential, provider or host-message capability.
- Build evidence: Release build completed with zero errors. The WebView2 package emits one WindowsBase version-resolution warning that must be resolved before installed cutover.
- Data safety: no production database mutation, no installer change and no compatibility-write change.
- Rollback: remove the unreferenced native project; installed Node/tray path is unchanged.

## Next

Resolve the WebView2 package warning, add native-only contract and database-migration services against disposable copied profiles, and prove they do not become a second writer before routing any live request to C#.

## Phase 2 preparation

- Added NativeDatabase using Microsoft.Data.Sqlite with an explicit non-pooled, foreign-key-enabled, cancellable transaction boundary and checksum-protected migration journal.
- Added a disposable copied-profile console acceptance project. It proves migration idempotency, transaction completion and deterministic database cleanup.
- Evidence: dotnet run native/LifePlanSystem.Native.Tests completed with PASS native SQLite migration and transaction contract.
- Live database rule remains unchanged: this service is not registered in the shell and no installed request has been routed to it.
- Dependency evidence: current stable Microsoft.Web.WebView2 1.0.3967.48 still emits MSB3277 because the package references its WPF assembly. This is documented as an unresolved package-level warning; no suppression has been applied.

## Next

Define the first native-owned read contract and its compatibility fixture corpus. Do not route or write live domain data until contract parity and copied-profile recovery tests cover it.

## Phase 3 read-contract preparation

- Added RuntimeStatusReader: a read-only, non-pooled SQLite status contract for active projects, active blockers, review items and memory-candidate counts.
- Fixture proof: the copied-profile test seeds the source-compatible tables and verifies the native contract returns the expected values without a write connection.
- Data safety: the native shell still does not register the contract against the installed database; the existing Node health endpoint remains canonical during compatibility.

## Next

Create a formal compatibility fixture from the current Node health/workboard response, compare native and Node values against an isolated database copy, and only then select a first read route for native routing.

## Native runtime lifecycle

- Added NativeHealthService as a cancellation-aware Generic Host BackgroundService on loopback 127.0.0.1:4178.
- Source-runtime smoke evidence: LifePlanSystem.Native.exe --health-smoke returned native health JSON with runtime identity, compatibility database state and Node compatibility label; the bounded smoke process then exited cleanly.
- The native health endpoint intentionally has no application commands and no database access.

## Next

Make the native shell packageable and add a native launcher alongside the existing Node tray path. Keep it opt-in until installed evidence proves WebView runtime, health, clean exit and profile isolation.

## Native publish evidence

- Added npm run build:native and npm run verify:native.
- Evidence: verify:native published the win-x64 native artifact to release/LifePlannerNative and passed its bounded native loopback health smoke test.
- The native artifact is not installed or substituted for the Node package. This is intentional: SQLite ownership, full React contract routing, provider isolation and Node exit gates remain incomplete.

## Next

Define a native launch manifest and portable-package verification that can ship the native artifact alongside, but never replace, the Node runtime until full parity evidence is recorded.

## Native provider and shutdown evidence

- Added ProviderCapabilityStore: cryptographically random 32-byte, provider/origin/action-bound capabilities with five-minute maximum lifetime, one-use consumption and provider-wide revocation.
- Fixture proof rejects replay and wrong-origin use.
- Fixed the native health smoke shutdown path: the listener is explicitly closed before Generic Host waits for its background service. Source and published smoke now serve health then exit without leaving a locked executable.

## Next

Add provider registry/policy contracts and an isolated provider WebView environment. The compatibility main view must remain message-deny by default.

## Native provider policy evidence

- Added provider registry entries for current ChatGPT, Gemini, Claude and Grok browser-assisted paths.
- Each entry is HTTPS host allow-listed and explicitly classified BrowserAssistedManual plus UserReviewedPasteOnly; no consumer-site automation is represented as official API execution.
- Fixture proof rejects unknown navigation and verifies the truthful capture classification.

## Next

Build an isolated provider WebView host only after a provider has an approved official API or explicit browser-assisted user flow. No provider WebView may share the main profile or receive native commands by default.

## Native recovery evidence

- Added NativeBackupService. It opens the source database read-only, creates an SQLite online backup in a caller-selected directory, runs `PRAGMA integrity_check`, and records a SHA-256 digest with the resulting evidence.
- Fixture proof: the native copied-profile contract creates and verifies a backup without changing the source fixture.
- Live database rule remains unchanged: no installed database has been opened, backed up, or migrated by this native service during this programme.

## Next

Add an opt-in portable native companion package with an explicit manifest and clean-launch verification. It must remain separate from the installed Node/tray application until parity and ownership gates are complete.

## Native companion packaging

- The portable packaging pipeline now publishes the native WinForms artifact and includes it under `native/` alongside the unchanged Node/tray payload.
- Added `Start Native Shell.cmd`. It launches the existing tray host with auto-open disabled, waits for the local health endpoint, then starts the isolated native WebView2 shell. This is explicitly opt-in and preserves the existing Node database owner, app data, credentials and default launcher.
- Automated evidence: installer safety verification passed and portable-package verification requires the native executable plus the bounded health-gated launcher.
- Installed acceptance: `release/LifePlannerPortableSetup.exe` was built from clean `ea3d89d7ae07cd5cd30f68c1b1b5b756dca2fb37` at 2026-07-29T11:38Z (SHA-256 `82E6EB6370FDFADC977CD6AF273E86B7583EFF65ED1FAD44E77FF217BB59B48B`). The silent update completed, preserved the existing `app/data/life-planner.sqlite` path, and the installed health endpoint reports that exact clean commit.
- Browser-driven installed check: launched `C:\Users\alexl\AppData\Local\Programs\Life Planner\native\LifePlanSystem.Native.exe`; it displayed the real Life Planner interface in a window titled `Life Planner (native-shell-compatibility)`, with no white screen. Closing its standard window control exited the native process cleanly.
- The installed native executable and portable native executable matched the published smoke-tested SHA-256 `342CB7E2303CB1279662BE6200AEC0195E435D33781DDC21D26A7A90CFF23FB1` before installation.

## Next

Continue native ownership work on a copied profile: add a controlled native read parity harness for current Node response fixtures before selecting any native write migration. The installed Node/tray path and credentials remain untouched.

## Native Workboard read parity

- Corrected the native status contract to match the live Node `lightweightGroundingFacts` queries exactly: non-terminal projects, non-archived blockers by type or status, pending approvals, and candidate/deferred memories.
- The copied-profile fixture now includes terminal projects, archived blockers, approved approvals and approved memory candidates; it proves the native reader excludes each one just like Node.
- Evidence: `dotnet run --project native/LifePlanSystem.Native.Tests/LifePlanSystem.Native.Tests.csproj -c Release` passed after the parity fixture update. The reader remains unregistered from the installed shell and has no write path.

## Native installed-profile read route

- Added a package-bound native read-profile locator. It can resolve only the companion layout's `../app/data/life-planner.sqlite`; it has no renderer, provider, command-line or environment path override.
- Native loopback health now exposes only the existing Workboard aggregate contract through a read-only SQLite connection when that packaged profile exists. It never returns a database path, record content, settings, credentials or SQL error.
- The Node runtime remains the only writer. The health route reports `compatibility-read-only`, `compatibility-no-profile`, or a redacted unavailable state; it does not migrate or repair the profile.
- Installed acceptance: clean build `a7b35632efdc0adb2e65c12742f710264b5f05e3` was packaged, installed and reported by the installed Node health endpoint. The native loopback endpoint reported `compatibility-read-only` and aggregate counts only (`2` active projects, `1` blocker, `2` pending approvals, `15` candidates) from the same installed profile; no profile path or user content was exposed.
- The installed `life-planner.sqlite` stayed at 192512 bytes with its existing 2026-07-27 timestamp through the update/read check. Browser-driven acceptance displayed the native shell and `Alt+F4` cleanly removed its process.

## Next

Add a formal native command/query boundary and architecture checks. No write route may be moved until a validated, transaction-bound native command has copied-profile replay and idempotency proof.
