# LifePlanSystemPublic Repository Tree and Ownership Map

Status: complete source-level ownership map for maintained runtime, packaging, verification, browser-extension, and reference areas. Generated, ignored, and user-data trees are identified separately; runtime verification remains separate.

Last updated: 2026-07-16

## 1. Repository role

`Daa13x/LifePlanSystemPublic` is the runnable, public-safe application repository. It owns the React UI, Express/SQLite runtime, browser connector, local tooling integrations, packaging, installer, CI workflow, and public collaboration/reference material.

It must not become the canonical location for private LifePlanSystem memories, Therapy context, credentials, or personal source-of-truth.

## 2. Maintained tree

```text
LifePlanSystemPublic/
├── .github/
│   └── workflows/
│       └── build-installer.yml
├── browser-extension/
│   └── lps-browser-agent/
│       ├── background.js
│       └── manifest.json
├── docs/
│   ├── agent_mode/
│   │   ├── skills/
│   │   ├── schemas/
│   │   ├── examples/
│   │   └── local-learning design/reference documents
│   ├── architecture/
│   ├── cookbook/
│   │   └── codebase/
│   ├── handoffs/
│   ├── tooling/
│   │   ├── openhands_invocation_examples/
│   │   ├── openhands_invocation_schemas/
│   │   └── OpenHands safety/design documents
│   └── ui/
├── installer/
│   ├── assets/
│   └── LifePlannerPortable.iss
├── public/
│   └── static application assets, including Life Planner branding
├── rules/
│   └── public/sanitised governance rules
├── scripts/
│   ├── build-installer.ps1
│   ├── package-portable.ps1
│   ├── list-local-learning-review-inbox.mjs
│   ├── write-local-learning-event.mjs
│   ├── verify-executor-enforcement.mjs
│   ├── verify-lifeskillsystem-skills.mjs
│   ├── verify-local-learning-event-schema.mjs
│   ├── verify-local-learning-event-validator.mjs
│   ├── verify-local-learning-event-writer.mjs
│   ├── verify-local-learning-review-inbox-reader.mjs
│   ├── verify-openhands-invocation-adapter.mjs
│   ├── verify-openhands-invocation-schemas.mjs
│   ├── verify-openhands-stop-boundary.mjs
│   └── verify-runcli-cwd.mjs
├── server/
│   ├── db.js
│   ├── executorEnforcement.js
│   ├── index.js
│   ├── localLearningEventValidator.js
│   ├── localLearningReviewInbox.js
│   ├── localLearningReviewInboxReader.js
│   ├── openhandsInvocationAdapter.js
│   └── runCliCwd.js
├── src/
│   ├── main.jsx
│   └── styles.css
├── LifePlanSystem_Public_Sanitized/
├── LifePlanSystem_Sanitised_UI_Scaffold_2026-06-29/
├── .gitignore
├── index.html
├── package.json
├── package-lock.json
├── README.md
└── vite.config.js
```

The two `LifePlanSystem_*` directories are sanitised reference/scaffold trees retained for collaboration history. They are copied into the current portable application bundle, but the maintained React/Express runtime does not use them as executable entry points.

## 3. File ownership

### Root configuration

| Path | Owner / purpose |
|---|---|
| `package.json` | Node dependencies, developer commands, packaging commands, and verification entry points. |
| `package-lock.json` | Reproducible npm dependency resolution for `npm ci`; packaging currently also supports a non-lock-preserving install path. |
| `vite.config.js` | React plugin, Vite development port `5173`, and hard-coded API proxy to `127.0.0.1:4177`. |
| `index.html` | Minimal browser document and React mount point. |
| `.gitignore` | Excludes dependencies, builds, runtime data, releases, caches, `.lps`, `.env`, logs, and local Claude state. |
| `README.md` | Public repository overview and operator instructions; it is not authoritative over conflicting source behavior. |

### Frontend

| Path | Owner / purpose |
|---|---|
| `src/main.jsx` | Entire maintained React application, all twelve panels, shared frontend helpers, client state, and API calls. |
| `src/styles.css` | Entire maintained visual system, dark/light variables, layouts, panel styles, Source Control and Roadmap styles, and limited desktop breakpoints. |
| `public/` | Static assets served by Vite and copied into `dist` during build. |

### Backend

| Path | Owner / purpose |
|---|---|
| `server/index.js` | Express startup, all API routes, Planner/chat/models/browser/Git/import/export/OpenHands orchestration, static serving, and periodic roadmap scan. |
| `server/db.js` | SQLite path selection, connection pragmas, schema creation, additive migrations, seeds, and database helpers. |
| `server/executorEnforcement.js` | Pure OpenHands path, branch, changed-file, limit, tool-constraint, and readiness enforcement. |
| `server/runCliCwd.js` | Pure repository-contained subprocess working-directory resolver. |
| `server/openhandsInvocationAdapter.js` | Disabled/non-authorizing future invocation adapter and result/status presentation helpers. |
| `server/localLearningEventValidator.js` | Pure validator for the local-learning event contract. |
| `server/localLearningReviewInbox.js` | Manual-only writer for validated candidates under `.lps/local-learning/review-inbox/`. |
| `server/localLearningReviewInboxReader.js` | Read-only deterministic candidate-listing and validation logic. |

Only `server/index.js`, `db.js`, executor enforcement, and `runCliCwd.js` are part of the main app runtime path. The local-learning writer/reader and disabled invocation adapter remain manually invoked or verification-only unless explicitly wired later.

### Browser extension

| Path | Owner / purpose |
|---|---|
| `browser-extension/lps-browser-agent/manifest.json` | Manifest V3 permissions, localhost and cloud-agent host permissions, and background worker declaration. |
| `browser-extension/lps-browser-agent/background.js` | Heartbeat/tab inventory, job polling, agent-tab selection, DOM prompt insertion, send action, response capture, and job result reporting. |

### Packaging and release

| Path | Owner / purpose |
|---|---|
| `scripts/package-portable.ps1` | Builds `release/LifePlannerPortable`, downloads/embeds Node, copies app/runtime files, strips blocked artifacts, creates launch/install command files, and writes a package manifest. |
| `scripts/build-installer.ps1` | Calls portable packaging, locates Inno Setup, compiles the installer, and verifies expected output. |
| `installer/LifePlannerPortable.iss` | Inno Setup metadata, file exclusions, shortcuts, post-install Chromium installation, and launch action. |
| `installer/assets/` | Installer/application icon and wizard artwork. |
| `.github/workflows/build-installer.yml` | Windows GitHub Actions pipeline for build, portable package, installer artifact, and optional Release attachment. |

### Verification and manual utilities

The `scripts/verify-*.mjs` files are deterministic verification entry points. They focus on safety boundaries and documentation/schema consistency rather than full UI/runtime acceptance.

The two non-verifier local-learning commands are intentionally not package-script shortcuts:

```text
scripts/write-local-learning-event.mjs
scripts/list-local-learning-review-inbox.mjs
```

They require direct manual invocation and are not imported by server startup.

### Documentation/reference areas

| Area | Ownership |
|---|---|
| `docs/cookbook/codebase/` | Developer-level source references maintained beside the runnable code. |
| `docs/tooling/` | OpenHands design, schemas, examples, safety matrices, and non-authorizing future-interface material. |
| `docs/agent_mode/` | LifeSkillSystem and local-learning contracts, examples, schemas, and instruction-only skills. |
| `docs/ui/` | Product/UI intent and scaffold specifications. |
| `docs/architecture/` | Public-safe architecture descriptions. |
| `docs/handoffs/` | Historical/current collaboration handoffs; must be checked for supersession before use. |
| `rules/` | Sanitised public governance rules, not the private brain's complete rule set. |
| `LifePlanSystem_*` | Legacy/sanitised collaboration scaffolds; reference-only from the maintained runtime's perspective. |

## 4. Generated and ignored trees

These are not source-controlled application code:

```text
node_modules/   installed dependencies
dist/           Vite production build
data/           live SQLite database, browser profiles, and Playwright browser cache
release/        portable bundle and installer output
.cache/         downloaded packaging inputs, including Node ZIP/extraction
.lps/           OpenHands requests/reports/worktrees and local-learning review inbox
.env            local environment/secrets
.claude/        local tool state
```

They may contain private state, large binaries, derived files, or transient execution artifacts. Do not add them to the public repository.

## 5. Runtime entry-point graph

```text
Development:
package.json npm run dev
  ├── node server/index.js
  └── vite --host 127.0.0.1
        └── index.html -> src/main.jsx -> src/styles.css

Production/portable:
Start Life Planner.cmd
  └── bundled node/node.exe app/server/index.js
        ├── server/db.js -> app/data/life-planner.sqlite
        ├── serves app/dist/
        └── exposes localhost API

Browser connector:
Chrome manifest -> background.js -> http://127.0.0.1:4177/api/browser/extension/*

Packaging:
package-portable.ps1 -> release/LifePlannerPortable/
build-installer.ps1 -> package-portable.ps1 -> Inno ISCC -> release/LifePlannerPortableSetup.exe
```

## 6. Source-of-truth boundaries

- React/Express/SQLite are the runnable app implementation.
- The public repository's sanitised Markdown/rules/scaffolds are design/reference content, not private personal truth.
- SQLite is canonical for current app runtime state, but exports are incomplete exchange formats rather than full recovery images.
- `.lps` files are canonical for the current OpenHands/local-learning file-backed queues because those features do not use SQLite.
- The private `Daa13x/LifePlanSystem` repository remains authoritative for private brain/governance content.

## 7. Maintenance rules

When adding a maintained file:

1. assign it to one ownership area above;
2. document whether it is runtime, manual-only, verification-only, reference-only, generated, or private runtime state;
3. add or update a package/script entry only when automatic invocation is intended;
4. update the packaging copy/exclusion policy when the file must or must not ship;
5. update the relevant codebase reference and verification inventory;
6. avoid adding a third competing implementation or source-of-truth tree.

## 8. Known structural risks

- `src/main.jsx`, `src/styles.css`, and `server/index.js` are large monoliths.
- Runtime, historical scaffold, and developer reference material coexist in one repository and some reference folders are copied into the installed app.
- The project has three persistence roots: SQLite under `data`, OpenHands/local-learning files under `.lps`, and user-selected model files outside or inside the repository.
- Fixed localhost ports are repeated across Vite, launch scripts, extension code, and manifest permissions.
- There is no generated authoritative tree manifest checked by CI; this document must be updated when files move or ownership changes.

## 9. Verification

```powershell
npm ci
npm run build
npm run verify:runtime-safety
```

Then inspect generated package ownership separately:

```powershell
npm run package:portable
Get-Content release/LifePlannerPortable/PACKAGED_FILES.txt
```

The package manifest proves what shipped in one build; it does not prove runtime behavior or privacy safety.