# LifePlanSystemPublic Portable, Installer, and CI Reference

Status: complete source-level reference for the portable file layout, packaging scripts, Inno Setup installer, and GitHub Actions build/release workflow. Successful runtime installation and a successful hosted workflow run remain separate acceptance evidence.

Last updated: 2026-07-16

Source snapshots:

```text
scripts/package-portable.ps1             ccc6331200e5116d480f794a30ba295dcb056f46
scripts/build-installer.ps1               b6f70806c34e68ee8ec58d5341fb409e24201c69
installer/LifePlannerPortable.iss         e99654ae5620c4f7131cc698c09c58f07deaf204
.github/workflows/build-installer.yml     459db778a5726bef088a38ca3aa5a0fa96474f1d
package.json                              39205a498cf380731f947259346eb54d15ae9320
README.md                                 675cefc55dc822467b870fc36d1f78cb8c0c9c2f
```

## 1. Build entry points

```text
npm run package:portable
  -> powershell -ExecutionPolicy Bypass -File scripts/package-portable.ps1

npm run package:inno
  -> package-portable.ps1
  -> ISCC.exe installer/LifePlannerPortable.iss

scripts/build-installer.ps1
  -> package-portable.ps1
  -> locate Inno Setup 6
  -> compile LifePlannerPortable.iss
  -> verify release/LifePlannerPortableSetup.exe exists

GitHub Actions Build Installer
  -> npm ci
  -> npm run build
  -> install Inno Setup
  -> scripts/build-installer.ps1 -SkipDependencyInstall -SkipBuild
```

## 2. Portable packaging inputs

Default Node version:

```text
24.15.0 win-x64
```

Download source:

```text
https://nodejs.org/dist/v<version>/node-v<version>-win-x64.zip
```

Cached under:

```text
.cache/node-v<version>-win-x64.zip
.cache/node-v<version>-win-x64/
```

The script does not verify a checksum or signature for the downloaded Node archive. HTTPS and the upstream host are the only implemented download-integrity boundaries.

Before copying files, the script normally runs:

```text
npm install --no-save --package-lock=false
npm run build
```

`-SkipDependencyInstall` and `-SkipBuild` may suppress those steps. The default install path is not the same reproducibility model as `npm ci`: it explicitly avoids writing/using a generated package lock for that operation, although the repository's existing lock file remains present.

## 3. Portable output layout

Output root:

```text
release/LifePlannerPortable/
├── app/
│   ├── dist/
│   ├── browser-extension/
│   ├── server/
│   ├── node_modules/
│   ├── package.json
│   ├── package-lock.json
│   ├── README.md
│   ├── .gitignore
│   ├── LifePlanSystem_Public_Sanitized/
│   └── LifePlanSystem_Sanitised_UI_Scaffold_2026-06-29/
├── node/
│   └── embedded Node.js runtime
├── Install Playwright Chromium.cmd
├── PACKAGED_FILES.txt
├── PORTABLE_README.md
├── Run Server Console.cmd
└── Start Life Planner.cmd
```

The application sources `src/`, development scripts, installer sources, Git metadata, and general documentation are not copied as runnable source. Production frontend assets come from `dist/`.

### Copied legacy/reference trees

Both sanitised scaffold folders are copied into the installed app even though the maintained React/Express runtime does not import them as executable modules. This increases package size and creates potential user confusion about which tree is authoritative.

## 4. Exclusion and cleanup policy

The script removes nested Playwright `.local-browsers` directories from packaged `node_modules`.

It recursively removes matches for:

```text
data
.env
*.sqlite
*.sqlite3
*.db
*.gguf
*.safetensors
*.onnx
*.log
.win32-*
.rollup-*
```

This is intended to exclude private runtime state, databases, models, logs, and platform-specific temporary binaries.

### Exclusion limitations

- Pattern-based recursive deletion can remove any directory named `data`, including a legitimate dependency or reference subdirectory.
- Only the exact `.env` name is listed; variants are not explicitly named here.
- The script does not scan copied text for credentials or personal information.
- It assumes the source checkout itself is public-safe.
- It does not fail when an expected application input is absent; each copied item is conditional.

`PACKAGED_FILES.txt` records the final relative files after cleanup. It is the primary build-time evidence of package contents.

## 5. Launch command files

### `Start Life Planner.cmd`

Behavior:

1. sets `LIFE_PLANNER_PORT=4177`;
2. sets `PLAYWRIGHT_BROWSERS_PATH=app\data\ms-playwright`;
3. invokes the Chromium installer when that directory appears empty;
4. starts bundled Node and `server\index.js` in a minimized command window;
5. waits a fixed two seconds;
6. opens `http://127.0.0.1:4177/`.

Limitations:

- no readiness/health polling before opening the browser;
- no single-instance or existing-port check;
- no managed shutdown when the browser closes;
- no database path override, so data defaults under installed `app\data`;
- fixed port duplicates extension and Vite assumptions.

### `Run Server Console.cmd`

Runs the same server in the foreground for visible logs and diagnosis.

### `Install Playwright Chromium.cmd`

Installs Chromium using the embedded Node runtime and packaged Playwright CLI into:

```text
app\data\ms-playwright
```

The script exits early if the target contains any entry. It does not validate that the browser installation is complete, correct-version, or executable.

## 6. Chromium packaging truth

Chromium is not embedded in the portable payload by `package-portable.ps1`.

The intended model is:

```text
installer post-install or first launch
  -> Install Playwright Chromium.cmd
  -> network download into app/data/ms-playwright
```

The current README statement that the portable build “also installs Playwright Chromium into the bundled app dependencies” is misleading. The portable build creates the installer command; installation occurs later when that command runs.

This means first use may require network access and can fail due to proxy, antivirus, permissions, CDN availability, or version/cache issues.

## 7. Build-installer wrapper

`scripts/build-installer.ps1`:

- forwards Node version, configuration, dependency-skip, and build-skip options;
- searches standard Program Files locations for Inno Setup 6;
- compiles the `.iss` file;
- requires `release/LifePlannerPortableSetup.exe` to exist afterward.

### Confirmed parameter mismatch

The wrapper declares and conditionally forwards:

```text
-SkipPlaywrightInstall
```

The current `package-portable.ps1` parameter block does not declare that switch. Calling the wrapper with `-SkipPlaywrightInstall` therefore sends an unsupported named parameter and should fail before packaging. The normal GitHub Actions command does not currently pass the switch.

## 8. Inno Setup internals

Application metadata:

```text
Name:       Life Planner
Version:    0.1.0
Publisher:  Life Planner
Architecture: x64
AppId:      fixed GUID
Output:     release/LifePlannerPortableSetup.exe
```

Installation properties:

- default install directory uses `{autopf}\Life Planner`;
- `PrivilegesRequired=lowest`;
- application is uninstallable;
- optional desktop shortcut;
- Start Menu shortcut;
- branded setup, wizard, and application icons;
- LZMA2 solid compression.

The `[Files]` section recursively copies the portable tree and repeats exclusions for `app\data`, root `.env`, database/model/log patterns.

Post-install actions:

1. run `Install Playwright Chromium.cmd` hidden and wait for it;
2. offer to launch `Start Life Planner.cmd`.

### Installer limitations and unresolved behavior

- version `0.1.0` is hard-coded rather than derived from `package.json` or a tag;
- no code signing is configured;
- no publisher URL, support URL, license, or privacy notice is configured;
- Chromium download failure can make installation fail or leave browser fallback setup incomplete;
- upgrade and uninstall handling for runtime-created `app\data` has not been acceptance-tested;
- the installer writes mutable user state beneath the application directory rather than a dedicated per-user data directory;
- the installed launcher is a `.cmd`, not a native process supervisor.

## 9. GitHub Actions workflow

Triggers:

```text
push to main
push of any tag
release published
manual workflow_dispatch
```

The manual input may specify an existing release tag.

Permissions:

```text
contents: write
```

Build environment:

```text
windows-latest
Node 24.15.0
Inno Setup installed through Chocolatey
```

Main steps:

1. checkout;
2. setup Node;
3. `npm ci`;
4. `npm run build`;
5. install Inno Setup;
6. run shared installer builder with dependency/build steps skipped;
7. upload `LifePlannerPortable` artifact;
8. upload `LifePlannerPortableSetup` artifact;
9. on a release/tag target, attach the installer EXE to a GitHub Release.

Concurrency is grouped by release tag, ref, or run ID and does not cancel in-progress builds.

## 10. CI truth and gaps

The workflow source still labels itself a starting draft and states that a real GitHub Actions run has not been validated. Source presence is not CI success evidence.

Additional gaps:

- no verification scripts run before packaging;
- no API/runtime smoke test;
- no launch/health test of the portable bundle;
- no installer install/uninstall test;
- no package-content privacy scanner beyond packaging patterns;
- no checksum/SBOM/signature artifact;
- no dependency audit or license report;
- no release-note generation;
- broad `contents: write` permission applies to the job even for non-release builds;
- actions are version-tag pinned, not commit-SHA pinned.

## 11. Local verification recipe

```powershell
npm ci
npm run build
npm run verify:runtime-safety
powershell -ExecutionPolicy Bypass -File scripts/package-portable.ps1 -SkipDependencyInstall -SkipBuild
Get-Content release/LifePlannerPortable/PACKAGED_FILES.txt
```

Inspect that the package excludes private/runtime artifacts, then run:

```text
release\LifePlannerPortable\Run Server Console.cmd
```

Verify:

```text
GET http://127.0.0.1:4177/api/health
```

For the installer:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1 -SkipDependencyInstall -SkipBuild
```

Then test on a disposable Windows user or VM:

- clean install;
- first-launch Chromium setup;
- application launch and database creation;
- restart persistence;
- upgrade behavior;
- uninstall behavior and handling of user-created data.

## 12. Acceptance status rule

Use these independently:

```text
Portable source documented      DONE
Portable bundle built           STATIC EXISTS until a recorded build succeeds
Portable launch verified        RUNTIME VERIFIED only after clean launch/health test
Installer source documented     DONE
Installer compiled              STATIC EXISTS until actual EXE build evidence exists
Installer install verified      RUNTIME VERIFIED only after clean install test
Workflow source documented      DONE
GitHub Actions pipeline         SETUP-GATED until a successful hosted run is recorded
Release attachment              SETUP-GATED until a tagged/release run proves it
```