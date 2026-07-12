# Handoff 2026-07-12 — Full Source Control, Dev Roadmap + scanner, secret-leak fixes, full git management

Agent: Claude (Opus 4.8). Public repo only.
Branches: work landed on `main`; `UI` fast-forwarded to match (`UI` is a byte-identical backup mirror of `main`). Both at `660258a`, pushed, in sync with origin.
`fable-latest` (→ `origin/fable/chat-brain-router-2026-07-03`) was brought current by merging `main` in; it carries the brain-aware chat provider router on top of everything below.

This handoff documents a multi-part session so any agent picking up LPS has full context without re-deriving it.

---

## 1. Full Source Control panel (tabbed git cockpit)

Replaced the old single-scroll Source view with a tabbed panel in `src/main.jsx` (`SourceControl` component). Ported the feature set from the Serenity/MostlyArmless reference (`docs/attachments/ma-source-control/`), adapted to LPS's React/Express stack.

Tabs:
- **Changes** — changed-file list (stage / unstage / discard per file), staged preview, commit, side-by-side diff (`SideBySideDiff` + `computeLineDiff`, LCS with a positional fallback above 1500 lines), plus stash + discard-all (see §4).
- **History** — commit graph from `/api/source/history` (subject, short hash, author, relative time, ref badges).
- **Branches** — current/switch, create+switch, merge-into-current, delete (guards protected + current branch), full local+remote list.
- **Sync & Setup** — fetch, pull (ff-only), pull --rebase, confirmed push, remotes, GitHub PAT login, repo creation (GitHub/HF), tags (see §4).

Safety kept from `main`'s prior work: a repo-boundary banner (`boundaryLabel` / `isPublicCheckout`) warns when the checkout is the public app repo, and push refuses `main`/`master` and force pushes.

### GitHub PAT auth (important for agents)
- Stored in settings key `githubToken`; validated to start with `ghp_` or `github_pat_`.
- Used ONLY to build an ephemeral authenticated push URL at push time (`authenticatedRemoteUrl`). Never written into the git remote config, and scrubbed from any error text before returning to the client.
- Endpoints: `POST /api/source/token`, `POST /api/source/token/clear`. Status exposes `github.tokenConfigured` (boolean only).

---

## 2. Dev Roadmap — development-only build tracker

New nav item **"Dev Roadmap"** (`DevRoadmap` component). Deliberately SEPARATE from the life-assistant Planner/Projects/Memory — it is for build work only (features not built / partly built, dev todos, parked work). It must never mix with life goals; the UI says so explicitly.

- Table `roadmap_items` (`server/db.js`): title, detail, resume_notes, category (feature/fix/infra/chore/idea), status (planned/active/paused/parked/done), sort_order.
- Kanban board, 5 status columns. Per-card: start/pause/park/done, move up/down, edit, delete.
- **Parked items stay visible with resume notes** (user decision) so shelved work like OpenHands is roadmapped and resumable, not forgotten.
- Seeded once on an empty DB (`seedRoadmapIfEmpty`) with the real current build state. Seed only runs when the table is empty, so user edits/deletions are never overwritten.
- Endpoints: `GET/POST /api/roadmap`, `PATCH /api/roadmap/:id`, `POST /api/roadmap/:id/move`, `DELETE /api/roadmap/:id`.

---

## 3. Autonomous dev-task scanner

Backend, minimal, autonomous. Scans chat history and repo files for development-type tasks and stages them as roadmap CANDIDATES (LPS proposes, human accepts — mirrors the memory-candidate pattern). No user-facing tag system was added (LPS has none); the internal "tag" is the auto-classified category + source stored on each candidate.

- Table `roadmap_candidates` (dedupe_key UNIQUE; status candidate/accepted/dismissed).
- Dev-only by construction: a line must carry BOTH an intent cue (`DEV_INTENT`) AND a technical cue (`DEV_CUE`) to qualify, OR be a code comment marker (TODO/FIXME/HACK/XXX) or a build-flavoured markdown checklist item. This is what keeps life-assistant content (e.g. "call the dentist") OUT of the build roadmap — verified.
- Chat scan: last 400 messages. File scan: `src/`, `server/`, `docs/todos/` (comment markers + checklists only).
- Dedupe: skips anything already staged, dismissed, or already a live roadmap item.
- Runs deferred on startup and on a light 15-minute interval (`setInterval(...).unref()`), plus manual `POST /api/roadmap/scan`.
- Candidate endpoints: `GET /api/roadmap/candidates`, `POST /api/roadmap/candidates/:id/accept` (creates a `planned` roadmap item), `POST /api/roadmap/candidates/:id/dismiss`.

---

## 4. Full git management (no terminal needed)

Extended Source Control to cover the rest of everyday git.

- **Stash** (Changes tab): `POST /api/source/stash` (message, includeUntracked), `GET /api/source/stash`, `POST /api/source/stash/apply` (pop flag), `POST /api/source/stash/drop`.
- **Discard all** (Changes tab, armed confirm): `POST /api/source/discard-all` requires `{confirm:true}`; runs `git restore --worktree -- .`; untracked files are never auto-deleted; refuses mid-conflict.
- **In-app conflict resolution** (conflict banner): `POST /api/source/resolve` with `side` = `ours` | `theirs` | `mark` (stage current contents after manual edit). All three end by staging the file. Plus the existing abort.
- **Tags** (Sync tab): `GET /api/source/tags`, `POST /api/source/tags` (annotated if message, else lightweight), `POST /api/source/tags/delete`, `POST /api/source/tags/push` (confirmed, PAT-authenticated for HTTPS origins).

---

## 5. Security fixes (secret leaks)

Two real credential-leak fixes plus hardening. `SECRET_SETTING_KEYS = {hfToken, githubToken}` is the single secret list.

- `GET /api/export/json?mode=backup` (without `includeSecrets=1`) previously redacted `hfToken` but wrote the GitHub PAT in cleartext. Fixed.
- `GET /api/bootstrap` previously sent RAW settings — both tokens — to the browser. Fixed to use redacted settings.
- Unified redaction into one `readSettings({ redactSecrets })` reader; `readSettingsRedacted()` and `publicSettings()` both delegate to it.
- `POST /api/settings` skips a `[redacted]` placeholder so the settings form can round-trip without wiping the stored secret. **Do not remove the `[redacted]` marker** — an empty-field save would then wipe the token.

---

## Key architectural gotchas for future agents

- **node:sqlite `DatabaseSync` has NO `.transaction()`** (that is a better-sqlite3 API). Use explicit `db.exec('BEGIN')` / `COMMIT` / `ROLLBACK`. One bug from this was already fixed in `/api/roadmap/:id/move`.
- **`git for-each-ref` does NOT interpret `%x1f`** (that is a `git log` pretty-format token). Embed the actual separator character in the `--format` string. (Bug fixed in the tags endpoint.)
- **Dev Roadmap is not the life Planner.** Keep build/dev work in `roadmap_items`; never route it into `projects`/`knowledge_items`/planner.
- **Scanner is dev-only by design** — preserve the intent-cue AND dev-cue gate; loosening it will pull life content into the build roadmap.
- **PAT never leaves the server** and never enters the git remote config. Keep it that way.

---

## 6. Hardening pass (server, commit `aa8f4a3`)

- **Git argument-injection guards.** `runCli` uses `execFile` (no shell), so there is no shell-injection risk, but a value beginning with `-` would be parsed by git as an option. Added `safeGitRef()` (must start alphanumeric; git ref charset; rejects `..`, `.lock`, trailing `/`, `//`, `@{`) and `safeGitUrl()` (rejects leading `-` and control chars), applied to branch create/switch, merge, delete-branch, remote name+URL, and tag create/delete/push. The old tag-name regex allowed a leading dash — a tag named `-d` could be parsed as a flag. A remote URL of `--upload-pack=<cmd>` (a real git RCE vector on fetch/push) is now rejected.
- **Process-level safety nets.** `unhandledRejection` / `uncaughtException` handlers log instead of silently wedging the local server.
- **Final Express error handler.** Malformed JSON bodies and synchronous handler throws now return the `{ ok:false, error }` JSON shape instead of Express's default HTML error page.

## 7. Model manager — llama.cpp + HF (commit follows)

Extends the local model registry so downloaded-vs-download state is explicit and files are manageable from the UI (Settings → Local Model Registry).

- `model_registry` gains `hf_repo` / `hf_file` columns (CREATE + idempotent ALTER migration) so a model's Hugging Face origin is remembered.
- `GET /api/models`, `/scan`, `/assign`, and `/api/bootstrap` all return rows enriched with `exists` (is the `.gguf` still on disk). NOTE: bootstrap previously returned raw rows without `exists`, so the list always showed "File missing" on first load — fixed to use `modelsWithExists()`.
- `POST /api/models/:id/assign` now refuses to assign a model whose file is missing (409).
- `DELETE /api/models/:id`:
  - default → deletes the `.gguf` file from disk but **keeps the registry entry**, flipping it from "Downloaded" to a re-downloadable "Not downloaded" state; clears any assignment.
  - `{ purge: true }` → removes the entry entirely (for a stale local-scanned entry with no HF origin).
- `POST /api/models/:id/download` → re-downloads a deleted model from its stored HF origin back to its original path (guards: no origin → 400, already on disk → 409).
- UI states per row: Downloaded (Load + Delete), Not downloaded (Download + Remove), File missing/no-origin (Remove). Delete is an armed confirm since it removes a multi-GB file.

Design note: the "available to download" catalog is the HF suggestions panel above the registry; the registry itself now carries downloaded/needs-download status per the maintainer's spec ("lists should show if we have the model or if it needs downloading").

---

## How it was verified (reality, not assumed)

- `node --check server/index.js` and `npm run build`: pass throughout.
- Endpoints exercised against a throwaway git repo (`LIFE_PLANNER_DB` + cwd override) so stash/discard-all/resolve were safe: tags (annotated/light, create/list/delete, push-gate 428), stash (save/list/pop, pop safely refused over a dirty tree), discard-all (confirm gate + real restore), conflict resolve (`theirs` took the right side, 409 on a non-conflicted file).
- Full UI driven in a browser against the built app served into the scratch repo: all four Source tabs render; Dev Roadmap board + candidate scan + status changes work; a REAL merge conflict was resolved live via "Take theirs"; secret redaction confirmed (raw token appears 0× in export and bootstrap). Zero console errors.
- Hardening: verified against a scratch repo that branch `--force` and tag `-d` are rejected 400, valid `feature/ok-1` still creates, a malformed JSON body returns JSON 400, and remote URL `--upload-pack=evil` is rejected.
- Model manager: verified end-to-end that assign refuses a missing file (409), a default delete removes the `.gguf` from disk and flips the row to "Not downloaded" with a Download button (entry kept), purge removes the entry, and re-download guards (no origin → 400, already on disk → 409) fire. Confirmed in the browser that the row visibly flips Downloaded → Not downloaded after delete. Zero console errors.

---

## Repo state left behind

- `main` = `UI`, pushed, 0/0 with origin (tip advances with the commits described here).
- `fable-latest` = `main` + brain router, pushed to its remote (bring it current by merging `main` again after these commits if it is to carry them).
- No open conflicts, no stray branches created, no tags/releases pushed to origin.

## Remaining roadmap work (tracked in-app)

- **First-run setup / health gate** — `planned`. Guided checklist (model + git + Playwright) so a fresh launch is not inert. Recommended next feature.
- **OpenHands real invocation** — `parked` with resume notes. Groundwork under `docs/tooling/OPENHANDS_INVOCATION_*`. Resume = implement the local-only call boundary per `OPENHANDS_REAL_INVOCATION_ENABLEMENT_PLAN.md`; keep the invocation flag off until the gate + tests pass.

Discipline note from the maintainer: build ONE roadmap item fully before starting the next. The Dev Roadmap exists to enforce this.
