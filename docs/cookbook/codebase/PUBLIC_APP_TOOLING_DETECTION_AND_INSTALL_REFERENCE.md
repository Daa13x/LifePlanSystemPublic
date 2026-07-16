# LifePlanSystemPublic Tooling Detection and Install Reference

Status: complete source-level reference for the Tooling panel, runtime probes, supported local installs, browser-connector setup assistance, and OpenHands/Ollama service controls; runtime verification remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/index.js  1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
src/main.jsx     4592881c34af44848dfc72e74895face6098a1da
package.json     39205a498cf380731f947259346eb54d15ae9320
```

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_BROWSER_CONNECTOR_AND_CONTEXT_EGRESS_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_OPENHANDS_REQUEST_AND_WORKTREE_LIFECYCLE_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_SOURCE_CONTROL_COMMAND_AND_SAFETY_REFERENCE.md
```

---

## 1. Purpose and authority boundary

The Tooling panel reports whether local dependencies and companion services are available, and performs a very small set of explicit setup actions.

It does not provide a general package manager or shell. The maintained automatic install allowlist is:

```text
playwright          -> npm install playwright
playwrightChromium  -> npx playwright install chromium
```

Other dependencies are detected or linked to, not installed by the backend:

```text
Node.js
npm
GitHub CLI
Hugging Face CLI
winget
Docker/OpenHands
Ollama
Chrome extension
```

Primary routes:

```text
GET  /api/tooling/status
POST /api/tooling/install
GET  /api/browser/extension/install-info
POST /api/browser/extension/install-helper
GET  /api/tooling/openhands/status
POST /api/tooling/openhands/start
POST /api/tooling/openhands/stop
GET  /api/tooling/ollama/status
GET  /api/tooling/ollama/model-status
```

---

## 2. General tooling status

`GET /api/tooling/status` runs these probes in parallel:

| Tool | Probe | Meaning of ready |
|---|---|---|
| Node | `node --version` | command exits successfully |
| npm | platform-specific npm command plus `--version` | command exits successfully |
| GitHub CLI | `gh auth status` | CLI exists and reports authenticated |
| Hugging Face CLI | `hf auth whoami` | CLI exists and reports authenticated |
| winget | `winget --version` | executable is on the server process PATH |
| Playwright | dynamic `import('playwright')` | package resolves in the app runtime |
| Chromium | `chromium.executablePath()` plus filesystem check | Playwright browser executable exists |

The route returns command output or error text for display. It does not normalize semantic versions or enforce supported version ranges.

### Status limitations

- A successful version/auth command does not prove the tool can perform every later operation.
- `gh auth status` and `hf auth whoami` can be unavailable when the app was launched with a narrower PATH than an interactive terminal.
- Only Docker has a Windows fallback executable path; Node, npm, GitHub CLI, Hugging Face CLI, and winget do not.
- Status is sampled on request and is not persisted.
- There is no timeout/cancellation in the React API client, although backend command probes have their own command-level limits.

---

## 3. Supported install operations

Route:

```text
POST /api/tooling/install
```

Request:

```json
{"tool":"playwright"}
```

or:

```json
{"tool":"playwrightChromium"}
```

### Playwright package

Runs:

```text
npm install playwright
```

Execution properties:

- working directory is the current runtime repository root;
- timeout is 15 minutes;
- output buffer is 4 MiB;
- it can modify `package.json`, the lockfile, and `node_modules`;
- the operation is not routed through the approval table.

Although Playwright is already declared in the current `package.json`, reinstalling can still change lockfile/dependency state.

### Playwright Chromium

Runs:

```text
npx playwright install chromium
```

Execution properties:

- working directory is the runtime root;
- timeout is 20 minutes;
- output buffer is 4 MiB;
- browser binaries normally go to Playwright's platform cache, not into SQLite;
- download size, destination, and network source are controlled by Playwright.

### Install gate limitations

- The backend allowlists the tool name, but there is no second confirmation or approval record.
- There is no process lock; repeated clicks or multiple local callers can start concurrent installs.
- There is no progress stream. The HTTP request returns only after completion/failure.
- A timeout or process interruption can leave partially changed dependencies or a partial browser cache.
- The app does not snapshot or roll back `package.json`, lockfile, or `node_modules`.

---

## 4. Browser connector setup assistance

`GET /api/browser/extension/install-info` returns:

- the unpacked extension directory;
- manifest path;
- whether a heartbeat was seen within 15 seconds;
- `chrome://extensions` instructions.

`POST /api/browser/extension/install-helper`:

1. copies the extension folder path to the system clipboard;
2. opens `chrome://extensions` in installed Chrome;
3. asks the user to enable Developer mode and choose Load unpacked.

It cannot install or enable the extension automatically.

The connector's actual protocol, hard-coded port, permissions, heartbeat, tab inventory, job queue, and selector maintenance are documented separately.

### UI wording mismatch

The Tooling UI says Playwright is needed for “external browser and tab control.” Normal external-browser and installed-Chrome launch routes do not require Playwright. Playwright is required for controlled-browser automation and CDP fallback behavior, not for every browser-opening action.

---

## 5. GitHub and Hugging Face setup

The Tooling panel only displays download/documentation links when the CLIs are missing.

It does not run:

```text
winget install --id GitHub.cli
pip install -U huggingface_hub[cli]
```

Login actions live in Source Control:

```text
POST /api/source/login/github
POST /api/source/login/hf
```

The Tooling panel's install hints are advisory strings. They are not guaranteed to match the user's platform, Python environment, package policy, or organization rules.

---

## 6. OpenHands and Docker service control

The Tooling panel delegates detailed worker behavior to the OpenHands subsystem, but it exposes status/start/stop controls.

Fixed values:

```text
container name: openhands-app
UI URL:        http://localhost:3000
```

### Status

`GET /api/tooling/openhands/status` checks:

- Docker CLI version;
- one container whose name begins with `openhands-app` in formatted `docker ps -a` output;
- HTTP reachability of the local UI.

On Windows, `runDocker()` falls back to Docker Desktop's standard CLI path when `docker` is not on PATH.

### Start and stop

```text
POST /api/tooling/openhands/start -> docker start openhands-app
POST /api/tooling/openhands/stop  -> docker stop openhands-app
```

The backend never runs `docker run`, pulls an image, creates a container, edits its configuration, or deletes it.

Start probes HTTP once after the container command; the returned HTTP result may still be unreachable while OpenHands is warming up.

---

## 7. Ollama and coder-model checks

Fixed values:

```text
Ollama URL: http://127.0.0.1:11434
Required model label: qwen2.5-coder:14b-gpu
```

`GET /api/tooling/ollama/status` calls `/api/version` with a three-second timeout.

`GET /api/tooling/ollama/model-status` calls `/api/tags` and checks for an exact model-name match. It also returns installed names containing `coder`.

Suggested OpenHands configuration is fixed to:

```text
model:   openai/qwen2.5-coder:14b-gpu
baseUrl: http://host.docker.internal:11434/v1
apiKey:  dummy
```

### Ollama limitations

- The URL and model are not configurable through the Tooling API.
- Equivalent tags or renamed models do not satisfy the exact-match check.
- The app does not start Ollama or pull the model.
- A successful Ollama probe does not prove the OpenHands container can resolve `host.docker.internal` on every platform.

---

## 8. Persistence and restart behavior

Tooling status itself is process/runtime state and is recalculated.

Persistent changes caused by tooling include:

```text
package.json / lockfile / node_modules   Playwright package install
Playwright browser cache                 Chromium install
Chrome extension registration            user Chrome profile
Docker container state/config            external Docker installation
Ollama models                             external Ollama storage
```

The SQLite database does not record an installation audit trail.

Browser-extension connection state is in memory and becomes disconnected after server restart until the next extension heartbeat.

The Docker command fallback path is process memory and resets to `docker` on server restart.

---

## 9. Security and operational findings

1. Tool installs are real repository/machine mutations but bypass the approval ledger.
2. The localhost API has no caller authentication; another local process can request an allowed install.
3. Install operations are not serialized and have no resumable progress state.
4. Command output may reveal local paths and environment details to the UI.
5. Status checks prove command availability, not compatibility with this project.
6. The extension helper opens a privileged Chrome settings page but still requires manual user actions.
7. OpenHands start/stop controls one fixed container only, which is safer than arbitrary Docker commands but assumes ownership of that name.
8. Hard-coded OpenHands/Ollama URLs and model labels limit portability.

---

## 10. Verification recipe

Use a disposable checkout where dependency changes are acceptable.

1. Record `git status --short` and hashes of `package.json` and the lockfile.
2. Call `GET /api/tooling/status`; compare Node/npm output with direct terminal commands.
3. Verify missing CLIs appear as missing rather than crashing the route.
4. Run the Playwright install only when repository mutations are approved.
5. Re-run status and confirm the package probe changes appropriately.
6. Run the Chromium install only when the browser download is approved.
7. Confirm `chromium.executablePath()` exists afterward.
8. Test connector install helper and verify no automatic extension installation occurred.
9. With Docker stopped, verify OpenHands status is honest and start fails clearly.
10. With an existing `openhands-app` container, test start, warm-up status, UI open, and stop.
11. Test Ollama unavailable, available-without-model, and exact-model-present states.
12. Restart the server and confirm all ephemeral status is recalculated.
13. Inspect `git diff` for unexpected dependency changes.

Do not mark Tooling `RUNTIME VERIFIED` until these checks are recorded in a dated acceptance record.