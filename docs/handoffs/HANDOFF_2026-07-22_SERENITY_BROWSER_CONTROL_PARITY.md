# Serenity browser-control parity handoff

Date: 2026-07-22

Scope: source-backed comparison of `D:\_Code_\Serenity` browser control with LPS, implemented installation improvements, and the remaining work that should stay in the existing Dev Roadmap.

## What LPS adopted

Serenity reference: `data/source/Services/Automation/BrowserAgentConnectorService.cs`.

LPS now inspects Chrome's profile metadata and unpacked-extension registration through `server/browserExtensionInstall.js`. This is diagnostic and read-only. It does not edit Chrome preferences or bypass Chrome's protected extension controls.

The Tooling API and UI now distinguish:

- Extension files are present in the current LPS install.
- The extension is registered in a Chrome profile.
- The registered extension is enabled or disabled.
- Chrome loaded the exact current LPS folder, a content-equivalent current copy, or an older/different copy.
- The extension heartbeat is live for this LPS session.

The install/repair helper now:

1. Finds Chrome profiles from `Local State`, preferring the last-used and active profiles.
2. Reads each profile's `Secure Preferences` to locate the Life Planner Browser Agent registration.
3. Opens `chrome://extensions` in the detected profile using `--profile-directory`.
4. Opens the exact current extension folder in Explorer and copies its path.
5. Tells the user whether to Install, Enable, Reload, or wait for heartbeat.

Chrome still requires the user's own click for Developer mode, Load unpacked, Enable, and Reload. LPS intentionally does not use `--load-extension`, edit `Secure Preferences`, or automate Chrome's protected settings UI.

## Why this is better

The previous LPS status reduced installation truth to a 15-second heartbeat. A missing extension, disabled extension, stale unpacked path, and correct extension waiting for heartbeat all appeared as "Not loaded." That made repair instructions guesswork.

The new model separates durable Chrome registration from transient bridge connectivity. This produces a deterministic next action and avoids repeatedly asking users to reinstall a correctly loaded extension. Opening the detected profile also prevents users from loading the connector into a different Chrome profile than the one they actually use.

`scripts/verify-browser-extension-install.mjs` exercises exact-path, enabled, disabled, stale-version, profile-selection, and protected-boundary behavior against synthetic Chrome profile fixtures. It is part of `verify:runtime-safety`.

## Useful Serenity work not yet ported

These items are useful reference material, but they belong to existing LPS jobs and must not be treated as completed by this change.

### Provider-specific capture adapters

Serenity reference:

- `data/native/extensions/browser-agent/conversation-capture.js`
- `data/native/extensions/browser-agent/conversation-capture.test.cjs`

Serenity separates ChatGPT, Claude, Gemini, and NotebookLM selectors and tests ordered user/assistant turns plus timestamps. LPS still uses capture logic embedded in `browser-extension/lps-browser-agent/background.js`, including generic fallback behavior. Port the adapter boundary only as part of Dev Roadmap job `Cloud egress classification and provider-aware completion`, together with login challenge, stale-turn, streaming, selector-failure, and redaction/confirmation fixtures. Do not port selectors alone and call the privacy job complete.

### Extension popup and bridge diagnostics

Serenity reference:

- `data/native/extensions/browser-agent/popup.html`
- `data/native/extensions/browser-agent/popup.js`
- `data/native/extensions/browser-agent/bridge-config.json`
- `data/native/extensions/browser-agent/install-status-contract.test.cjs`

Serenity exposes bridge target, recent errors, popup/details URLs, detected tabs, heartbeat age, and installed extension ID. LPS should add a minimal popup that shows the redacted local bridge URL, connection state, last error, and a retry/reload hint. Never expose the connector token in popup text, logs, API responses, or screenshots.

### Non-blocking profile probes

Serenity caches Chrome profile probes and refreshes them in the background so locked or large profile files do not delay UI status. LPS's current synchronous probe is bounded by local file reads and is acceptable for the first parity slice, but the next agent should add a short-lived cache plus asynchronous refresh if telemetry shows Tooling latency or locked-profile delays.

### Content/version identity

LPS currently compares manifest name/version and required core files. Serenity also verifies its full extension payload. When LPS gains popup/adapters/icons, extend the required-file list and add a deterministic content digest so equal version numbers cannot hide stale unpacked content.

## Acceptance evidence

- `node --check server/browserExtensionInstall.js` passed.
- `node --check server/index.js` passed.
- `npm.cmd run verify:browser-extension-install` passed.
- `npm.cmd run verify:browser-connector-safety` passed.
- `npm.cmd run verify:runtime-safety` passed with browser installation and tray verification in the standard gate.
- `npm.cmd run build` passed: 1,576 modules transformed.
- Live Chrome diagnostic acceptance found the exact current extension registered in Chrome's `Default` profile and correctly reported it disabled with `requiresEnable: true`.
- The connected Dev Roadmap was read back after update: installer lifecycle job 14 is `done`; first-run job 4 and cloud egress/capture job 10 remain `planned` with updated resume notes.
- Final portable packaging passed and required `app/server/browserExtensionInstall.js`.
- Packaged tray acceptance on isolated port 4195 returned `/api/health`; tray PID 7260 and bundled Node PID 13884 both had no visible main window, and the listener executable was exactly `release/LifePlannerPortable/node/node.exe`. Generated database, log, browser marker, and pairing files were removed afterward.
- Final installer: `release/LifePlannerPortableSetup.exe`, 39,616,261 bytes, SHA-256 `A42B042BD000A48B755ADA740255CF448ABDBE25D77DED5B90693C5796F999B7`.
- Hosted `main` workflow evidence remains required after push; do not infer hosted success from local acceptance.

## Reciprocal Serenity handoff

LPS improvements useful to Serenity were posted through Serenity's canonical `data/scripts/db/write_chatstream.py` PostgreSQL lane. The verified row is `ma_chat.messages.id = 3629` in session 226 (`Serenity Bridge`) with `work:lps-browser-control-parity`, `status:planned`, `area:browser-control`, `owner:serenity`, and `priority:p1` tags.

The note recommends per-install authenticated extension calls, DPAPI-protected connector secrets, secret-free release packaging, and per-job random claim tokens with lease-bound completion. Serenity's current job reclaim logic uses timestamps but `CompleteJob` accepts only a numeric job ID, so stale worker completion deserves review.

## Next-agent rules

- Keep browser extension setup in Tooling and the connected Dev Roadmap; do not create a parallel installer screen with separate state.
- Treat heartbeat, registration, enabled state, loaded path, and content version as separate facts.
- Never claim Chrome installation is automatic. The user owns Chrome's protected clicks.
- Do not read browser cookies, copy a personal Chrome profile, or write Chrome preference files.
- Keep connector tokens DPAPI-protected at rest, redacted from APIs, and omitted from packaged manifests.
- Update both the relevant Dev Roadmap job and this handoff when provider adapters or popup diagnostics ship.
