# LPS C# Native-Core + WebView2 Architecture Review

## Executive verdict

Correct direction, materially incomplete as supplied. The requested v5 file was not present in the attachment or current checkout, so a line-by-line comparison would be invented. This review records that evidence gap and supplies a standalone v6 replacement.

The supplied doctrine supports C# authority, JavaScript rendering-only, database truth, DPAPI credentials, honest disconnected UI, failure evidence and installed acceptance. The concrete controls below are engineering recommendations, with official platform support noted in v6.

## Doctrine alignment matrix

| Source | Principle | v5 evidence | Required correction |
|---|---|---|---|
| Sacred Laws Law 21 | JS renders; C# owns business and data logic | v5 absent | Ban new React/Node domain decisions and test the boundary. |
| Project Bible | database truth, DPAPI, no hardcoded paths | v5 absent | One SQLite writer and verified AppData backup/recovery. |
| Android Bible | views are not truth; offline state must be honest | v5 absent | Native-derived provider state and stale/offline UI. |
| Failure Bible | failures are evidence | v5 absent | Run-state, reproduction, rollback and installed evidence. |
| Hayley handbook | C# build/runtime pressure matters | v5 absent | Small executable phases with installed acceptance. |
| Microsoft WebView2 docs | navigation can be cancelled; messages are explicit host events | v5 absent | Separate trusted/provider views and validated message capability. |

## Critical issues

1. **Critical: no Node exit gate.** Failure: permanent C# wrapper around a Node brain. Correction: parity matrix, native-only writes, two native installed releases and Node-free payload. Blocks cutover.
2. **Critical: no single-writer rule.** Failure: Node/C# SQLite contention or divergent truth. Correction: native writer from Phase 2; compatibility calls are read-only/proxied. Blocks migration.
3. **Critical: provider trust boundary undefined.** Failure: provider content accesses privileged host capabilities. Correction: separate WebView profiles, navigation/resource policy, schema/capability validation. Blocks provider views.
4. **Critical: installer rollback/data rule undefined.** Failure: stale install or database loss. Correction: verified backup, copied-profile rehearsal, no automatic DB downgrade, installed commit proof. Blocks distribution.
5. **High: API hosting, migration ownership, provider policy, update model and process/profile isolation remain ambiguous.** Defaults are selected in v6.

## Missing decisions and recommended defaults

| Decision | Default | Why |
|---|---|---|
| Compatibility API hosting | In-process ASP.NET Core loopback compatibility endpoint; native services own contracts | Keeps React migration incremental without making HTTP the domain authority. |
| Database ownership | Native process exclusively owns migrations and writes | Avoids dual writers and SQLite lock ambiguity. |
| Migration tracking | Schema journal table with id, checksum, app build, state and timestamps | Makes interrupted work and support diagnosis observable. |
| Compatibility routing | Explicit route inventory, read-only proxy unless native command handler exists | Prevents hidden Node ownership. |
| Provider policy | Versioned registry and API-first adapter; browser-assisted only where permitted | Prevents unsupported scraping and false execution labels. |
| Update model | Side-by-side/staged payload swap plus data-preserving installer transaction | App rollback must not imply database downgrade. |
| Testing hooks | Stable native health endpoint, test-only contract fixture import, no production debug backdoor | Allows installed proof without privileged WebView access. |
| Recovery | Verified backup before migration, journal inspection, restore drill and support bundle | Converts recovery claims into repeatable evidence. |
| Process ownership | One native parent, Job Object for owned child processes, bounded graceful shutdown then fallback | Prevents stale Node/build/provider helpers. |
| Browser/profile isolation | Main and each provider use distinct WebView user-data directories | Stops cookie/capability bleed across trust boundaries. |

## Scope and practicality

WinForms remains the appropriate host because the target is Windows-only, has an existing React interface, needs a tray shell and needs the lowest-risk native migration. WPF, WinUI 3, Avalonia, MAUI and Electron do not remove the authority, data or provider-security problems. Selecting one now would dangerously couple shell replacement to ownership migration. The work must be a programme, not one rewrite: phase gates in v6 deliberately make every phase independently executable and reversible at the binary level.

## v5 to v6 change log

Added: ownership map, single writer, capability protocol, provider policy, copied-profile rehearsal, Node exit gate, machine-checkable evidence.  
Changed: migration becomes small executable phases; installed tray app is the acceptance target.  
Removed: implied permanent Node runtime, scraping default and dual writers.  
Deferred: trimming/AOT and alternate UI frameworks until native parity is proven.

## Residual risks

Database edge cases require a copied real-profile rehearsal and restore drill. Provider policy changes require a versioned registry and review. WebView isolation requires hostile-navigation/message tests. Node parity requires replayed contract corpus and two installed native-only releases.

## Evidence classification

Doctrine statements above are supported by the supplied MostlyArmless exports: Sacred Laws pages 2-8, Project Bible pages 84-95, Failure Bible page 27, Android Bible pages 3-9, Installer Rules pages 64-65 and Hayley handbook pages 6-7. Platform mechanisms are external official guidance: Microsoft Learn WebView2 navigation events and WebMessageReceived documentation, .NET Generic Host and hosted-services guidance, Microsoft.Data.Sqlite documentation, and WebView2 distribution guidance. The specific design defaults in this review are engineering recommendations, not claimed doctrine.
