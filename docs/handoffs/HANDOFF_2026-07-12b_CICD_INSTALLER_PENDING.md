# Handoff 2026-07-12 (b) — CI/CD installer pipeline (completed 2026-07-17), Serenity source-control review

Agent: Claude (Opus 4.8). Public repo only. Landed on `main`, mirrored to `UI`.

> Completed 2026-07-17. Hosted push run `29578272261` and release-targeted run `29578538752` passed. Release `1.0` contains the accepted installer with SHA-256 `4C0970D64983EC1F87CC4A165AA2A696FBC803D6ED39964521A1538E7B762D51`. See `HANDOFF_2026-07-17_FULL_SYSTEM_AUDIT.md` for exact acceptance evidence and remaining priorities.

This is a short follow-up to `HANDOFF_2026-07-12_SOURCE_CONTROL_ROADMAP_GIT_MGMT.md`.

## CI/CD installer pipeline — completed (roadmap item is `done`)

Goal (from the maintainer): pushing should set off GitHub installer creation via CI/CD so the user can create the pipeline installer at the repo end, AND the installer should be buildable locally without asking an agent in a terminal.

What was done (the "start"):
- Added `.github/workflows/build-installer.yml` — a STARTING DRAFT. On push to `main`, on a `v*` tag, or on manual dispatch it: `npm ci` → `npm run build` → `npm run package:portable` → install Inno Setup via choco → `ISCC.exe installer/LifePlannerPortable.iss` → upload the portable bundle and the installer as artifacts; tagged builds also attach the installer to a GitHub Release.
- Added the Dev Roadmap item **"CI/CD + local installer build"** with status `active` (in the seed in `server/index.js`), carrying resume notes.

Completion evidence added 2026-07-17:
1. **Hosted workflow validated.** Push run `29578272261` and release-targeted run `29578538752` passed on GitHub's Windows runner, including both artifact uploads and the Release attachment.
2. **In-app build control shipped.** Source provides the gated, non-blocking installer build endpoint and live status UI.
3. **Published binary accepted.** The exact Release `1.0` installer passed silent install, bundled-runtime health/UI checks, and silent uninstall; its digest is recorded above.

Both completion conditions passed, and the connected Dev Roadmap item is now `done`.

## Serenity source-control review (for parity / bug fixes)

Reviewed `D:\_Code_\Serenity` `Services/Infrastructure/GitService.cs` + `GitService.Methods.cs` (updated 2026-07-11) against our Express implementation. Findings:

- **Our security model is stronger, not weaker.** Serenity builds git commands as a single interpolated argument STRING (`Arguments = $"tag \"{tagName}\" -m \"{message.Replace("\"","\\\"")}\""`), which is why it needs manual quote-escaping. Ours uses `execFile` with argument ARRAYS plus `safeGitRef`/`safeGitUrl`, which avoids that injection class entirely. Nothing to adopt here — do NOT move to string interpolation.
- **Optional parity, not bugs (left unimplemented on purpose):**
  - Serenity injects the token into fetch/pull URLs too (`InjectTokenIntoUrl`), not just push. Ours only token-authenticates push. Fine for the public repo; only needed if we ever support private-repo fetch/pull without a credential helper.
  - Serenity runs a short `fetch` before computing ahead/behind, so its counts are fresher. Ours computes ahead/behind from local `@{upstream}` (can be stale until the user clicks Fetch). Auto-fetching on every status read is a network/latency tradeoff; left as a manual Fetch for now.
- Serenity has **no CI workflow** either, so nothing to borrow for the installer pipeline.

## Repo state

- `main` = `UI`, pushed, 0/0 with origin.
- No behavioural change to the running app in this handoff beyond the new roadmap seed entry (fresh installs only) and the CI workflow file. The workflow does nothing until it runs on GitHub.
