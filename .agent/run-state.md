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
