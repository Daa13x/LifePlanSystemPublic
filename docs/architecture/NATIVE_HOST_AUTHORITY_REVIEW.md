# Native Host Authority Review

**Status:** Evidence-based review of the *current* code. **No migration or rewrite is authorised by this document.** Per the viable-system feedback, a WinForms/C#-first migration, Electron replacement, or "native host as operating system" re-architecture requires a separate, evidence-backed decision.

This review documents which layer owns each security-sensitive responsibility today, confirms there is no conflicting duplicated authority, and records where the boundary should stay.

## Layers (from actual code)

| Layer | What it is | Entry point |
| --- | --- | --- |
| **Native host** | .NET 9 WinForms + WebView2 desktop shell | `native/LifePlanSystem.Native/Program.cs` → `MainForm.cs` |
| **Local server** | Node/Express app; all `/api` logic, data, and safety | `server/index.js` (binds `127.0.0.1:4177`) |
| **React UI** | Presentation only, served as `dist/` by the server | `src/main.jsx` |
| **Launcher / tray** | Starts/stops the server + local model processes | portable launcher / tray script |
| **Installer** | Packages and updates the app on disk | Inno Setup (`installer/`), build scripts |

The native host **does not** run app logic: `MainForm` points its WebView2 at `http://127.0.0.1:4177/` and nothing else (`WebViewSecurityPolicy.IsTrustedMainUri` = http + `127.0.0.1` + port `4177`). The main compatibility view has **no** native command channel — `WebViewSecurityPolicy.IsPermittedMainMessage` returns `false` by design; the only native command accepted is `open-provider-window` for `chatgpt`, gated by the trusted-origin check.

## Ownership of security-sensitive responsibilities

| Responsibility | Owning layer | Evidence |
| --- | --- | --- |
| **Process lifecycle** | Native host (shell) + launcher (server) | `Program.cs` single-instance gate (`SingleInstanceGate`), Generic Host start/graceful `StopAsync`; the server process is launcher-managed, not spawned by the host |
| **Local file access / app database** | Local server | `server/db.js` (`node:sqlite`) owns the app DB and all reads/writes behind `/api` |
| **Secrets** | Native host (provider) + server (app) | `Providers/ProviderSecretStore.cs` uses DPAPI (CurrentUser); "secrets never enter SQLite or logs". Server keeps its own secret-setting endpoints separate |
| **Native dialogs** | Native host | `MainForm` / `Program.cs` `MessageBox` (init failure, already-running) |
| **Tray behaviour** | Launcher / tray script | tray script owns tray + start/stop of node/llama; not the native host, not React |
| **Browser control (embedded view)** | Native host | `MainForm` WebView2 hardening: DevTools off, context menus off, `NewWindowRequested` blocked, `PermissionRequested` → Deny, `NavigationStarting` cancels non-trusted URIs; `ProviderWindowForm` isolated profile + host allow-list |
| **Browser control (external automation)** | Local server | server Chrome connector / Playwright scout — a *different* browser for a *different* purpose (observe/report), governed by the egress guard |
| **Updates / installer** | Installer + build scripts | Inno Setup `.iss` (excludes `app\data\*`), build-provenance scripts |
| **Backups** | Native host + server | `Recovery/NativeBackupService.cs` creates a hashed (SHA-256) verified copy; `server/setupRecovery.js` + `server/confirmations.js` own staged, confirmed restore |
| **Recovery** | Local server | staged swap-on-next-start restore behind durable confirmations (`confirmations.js`) |
| **Shutdown** | Native host (shell) + launcher (server) | `Program.cs` `finally` graceful host stop; server stop via launcher |

## Is authority duplicated? No.

- **App-data mutations** are the server's authority alone: origin/CSRF mutation guard (`mutationGuard.js`), durable confirmations (`confirmations.js`), agent-proposal approvals (`/api/approvals`), and the egress guard. This is correct — the data and logic live there.
- **The view/browser boundary** is the native host's authority alone: only native code can enforce WebView2-level policy (permissions, downloads, navigation, isolated profiles). The host deliberately disables its own command surface for the main view, deferring all logic to the server.
- The two never contend: the server does not drive the WebView, and the native host does not mutate app data.

**One nuance to keep watching:** "browser control" legitimately appears in two places — the native **embedded** WebView (presentation of the local app + the isolated provider window) and the server's **external** Chrome connector (read-only automation). These are distinct browsers with distinct purposes and should not be merged into one authority.

## Decision

Keep the current split. Security-sensitive orchestration is already in the right layers:

- keep **app-data safety** (mutation guard, confirmations, approvals, egress) in the **server**;
- keep the **view/browser trust boundary** (origin gate, permission/download denial, isolated profiles, DPAPI secrets) in the **native host**;
- keep **React presentation-only** — do not move working logic across a layer to satisfy a metaphor.

## Cross-layer contract tests already in place

- `verify:native-provider-window` — the native provider window's isolation, allow-list, deny-by-default permissions/downloads, and trusted-origin gate.
- `verify:mutation-csrf`, `verify:durable-confirmations`, `verify:governance-safety`, `verify:egress-guard` — the server's authority boundary.
- `verify:authority-boundary` — the human-authority / copilot contract (lifecycle, high-risk classification, approval-is-not-proof).

Any change that moves a responsibility across these layers must add a contract test for the changed boundary **and** carry a separate evidence-backed decision — this review does not authorise one.
