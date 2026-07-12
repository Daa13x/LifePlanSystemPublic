# Handoff 2026-07-12 (b) — CI/CD installer pipeline STARTED (pending), Serenity source-control review

Agent: Claude (Opus 4.8). Public repo only. Landed on `main`, mirrored to `UI`.

This is a short follow-up to `HANDOFF_2026-07-12_SOURCE_CONTROL_ROADMAP_GIT_MGMT.md`.

## CI/CD installer pipeline — STARTED, not complete (roadmap item is `active`)

Goal (from the maintainer): pushing should set off GitHub installer creation via CI/CD so the user can create the pipeline installer at the repo end, AND the installer should be buildable locally without asking an agent in a terminal.

What was done (the "start"):
- Added `.github/workflows/build-installer.yml` — a STARTING DRAFT. On push to `main`, on a `v*` tag, or on manual dispatch it: `npm ci` → `npm run build` → `npm run package:portable` → install Inno Setup via choco → `ISCC.exe installer/LifePlannerPortable.iss` → upload the portable bundle and the installer as artifacts; tagged builds also attach the installer to a GitHub Release.
- Added the Dev Roadmap item **"CI/CD + local installer build"** with status `active` (in the seed in `server/index.js`), carrying resume notes.

What is deliberately NOT done (future agent, this is the pending task):
1. **Validate the workflow with a real Actions run.** It has never run on a hosted runner. Trigger it once (push to `main` or the "Run workflow" button), read the logs, and fix whatever the Windows runner surfaces. Likely friction points: `npm ci` needs the committed `package-lock.json` to match `package.json`; `choco install innosetup`; the PowerShell `package-portable.ps1` downloading Node + Playwright Chromium (size/time on the runner); artifact paths.
2. **In-app "Build installer" button** so the user can build locally without a terminal. Suggested shape: a gated, non-blocking `POST /api/source/build-installer` that runs `scripts/package-portable.ps1` (or `npm run package:inno`) and streams status back to the Source panel. The local scripts already exist: `npm run package:portable` and `npm run package:inno`.

Only mark the roadmap item `done` after BOTH a green CI run and the local-build button ship.

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
