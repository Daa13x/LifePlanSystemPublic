# LifePlanSystemPublic Backend Helper and Process Map

Status: complete source-level inventory of named backend helpers and long-lived process state in `server/index.js`; imported enforcement modules have adjacent dedicated references still to be completed.

Last updated: 2026-07-16

Source snapshot:

```text
Repository: Daa13x/LifePlanSystemPublic
Primary file: server/index.js
Blob SHA: 1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
Adjacent modules: server/db.js, server/executorEnforcement.js, server/runCliCwd.js
```

The backend is a single Express module containing startup, route handlers, SQL, filesystem access, browser automation, model execution, Git operations, installers, and OpenHands orchestration. This reference maps its named helper functions and process-owned state so maintainers can trace routes without reading the monolith linearly.

---

## 1. Startup and process-owned state

Startup order:

```text
import modules
→ migrate()
→ seedRoadmapIfEmpty()
→ install process error handlers
→ create Express app
→ register middleware/routes/static/error handler
→ listen on 127.0.0.1
→ schedule roadmap scanner
```

### Long-lived in-memory state

| State | Purpose | Restart behaviour |
|---|---|---|
| `managedLlamaServer` | Child process started by the app | Lost; external process state may diverge if shutdown is abnormal |
| `browserContext`, `browserPage` | App-owned persistent Playwright context/page | Lost; profile files persist under `data/browser-profile` |
| `browserMode`, `browserLaunchNote` | Describes active controlled-browser mode | Lost |
| `cdpBrowser` | CDP attachment to dedicated debug Chrome | Lost; Chrome profile/process may remain |
| `browserAgentJobSeq`, `browserAgentJobs` | Connector job queue/results | Entire queue lost |
| `browserExtensionState` | Last heartbeat and tab summaries | Lost; connector becomes disconnected until next heartbeat |
| `installerBuildState` | Current installer build progress/output | Lost; generated artifacts remain |
| `dockerCommand` | Selected Docker CLI path after fallback | Resets to `docker` |
| `openHandsRequestSeq` | Suffix for request IDs | Resets; timestamp component reduces collision risk |

### Startup helpers

- `seedRoadmapIfEmpty()` — seeds known build-state items only when `roadmap_items` is empty.
- `runDevTaskScan(reason)` — invokes the dev-task scanner and logs newly staged candidates.

Process handlers log `unhandledRejection` and `uncaughtException` without exiting. They prevent silent shutdown but do not roll back partially completed multi-step operations.

---

## 2. Installer-build helpers

| Function | Responsibility |
|---|---|
| `emptyInstallerBuildState()` | Returns canonical idle state |
| `appendInstallerBuildOutput(chunk)` | Appends output with 120,000-character rolling cap |
| `summarizeInstallerArtifacts()` | Checks portable installer file/directory targets |
| `installerBuildSnapshot()` | Combines state and current artifact metadata |
| `installerBuildCommand()` | Selects `powershell.exe` on Windows or `pwsh` elsewhere |
| `startInstallerBuild()` | Starts one non-shell child process, captures output/status, and refuses duplicate concurrent start |

The process runs `scripts/build-installer.ps1` from the repository root. Build status is not durable.

---

## 3. Response, timing, and subprocess primitives

| Function | Responsibility and boundary |
|---|---|
| `ok(res, data)` | Standard `{ok:true,data}` JSON response |
| `fail(res, status, message)` | Standard `{ok:false,error}` JSON response |
| `sleep(ms)` | Promise delay used by connector polling |
| `runCli(command, args, options)` | Executes with `execFile`, bounded timeout/buffer, no ordinary shell, and confined working directory |
| `spawnCli(command, args)` | Detached fire-and-forget process from repository root |
| `copyTextToSystemClipboard(text)` | Tries platform clipboard commands in order |
| `npmInstall(args)` | Runs platform npm with fifteen-minute timeout |
| `npxRun(args)` | Runs platform npx with twenty-minute timeout |

### `runCli` safety model

`runCli` delegates working-directory validation to imported `resolveRunCliCwd(root, requestedCwd)`.

It returns structured result fields rather than throwing for normal command failure:

```text
available
ok
code
signal
timedOut
outputLimitHit
timeoutMs
maxBufferBytes
stdout
stderr
```

Windows `.cmd` commands use a shell because `execFile` cannot directly execute them there. Other calls remain shell-free.

---

## 4. Workspace, Git argument, and secret safety helpers

| Function / constant | Responsibility |
|---|---|
| `safeWorkspacePath(relativePath)` | Rejects empty, NUL, absolute, UNC, traversal, and root-escape paths |
| `isProtectedWorkspacePath(filePath)` | Blocks runtime data, build output, models, databases, logs, secrets, Git, and `.lps` paths |
| `SAFE_GIT_REF` | Allowed initial/ref characters before Git-specific checks |
| `safeGitRef(value)` | Rejects option-like, oversized, `..`, `.lock`, trailing slash, `//`, and `@{` refs |
| `safeGitUrl(value)` | Rejects empty, option-like, NUL, CR, and LF values |
| `SECRET_SETTING_KEYS` | Current secret settings: `hfToken`, `githubToken` |
| `GITHUB_PAT_PREFIXES` | Accepted stored PAT prefixes |
| `githubTokenConfigured()` | Boolean stored-token check |
| `authenticatedRemoteUrl(remoteUrl, token)` | Builds ephemeral HTTPS URL with token userinfo; does not alter remote config |

`isProtectedWorkspacePath` currently blocks roots such as `.git/`, `data/`, `dist/`, `node_modules/`, `release/`, `.cache/`, and `.lps/`; environment files; and database/model/log extensions.

Important distinction: OpenHands has a stricter mandatory forbidden-path registry imported from `executorEnforcement.js`, including private brain locations such as `source_of_truth`, memory, rules, secrets, `.env`, data, Git, and `.lps`.

---

## 5. Git parsing and repository-state helpers

| Function | Responsibility |
|---|---|
| `parseRemotes(remoteText)` | Collapses fetch/push lines into one remote record |
| `parseGitStatus(statusText)` | Parses short status rows and marks staged/protected files |
| `gitStatusSnapshot()` | Collects status, conflicts, branch, upstream, ahead/behind, and counts |
| `looksBinary(text)` | NUL-byte check for text diff display |

`gitStatusSnapshot` is the shared source for staging, commit, checkout, rebase, merge, conflict, and Source panel gates.

Imported Git/OpenHands parsers:

- `parsePorcelainPaths`
- `isChangedFileAllowed`
- `enforceChangedFiles`

These operate on actual isolated-worktree changes and remain in `executorEnforcement.js` for independent verification.

---

## 6. Database convenience and memory-candidate helpers

| Function | Responsibility |
|---|---|
| `allRows(sql, params)` | Prepared statement `.all()` wrapper |
| `row(sql, params)` | Prepared statement `.get()` wrapper |
| `classifyCandidate(text)` | Heuristic chat-memory type classifier |
| `createCandidateFromMessage(sessionId, messageId, content)` | Creates candidate for messages of at least 24 characters |
| `consultationCandidate(candidate)` | Recognises cloud-consultation candidate records |
| `normalizedMemoryCandidate(candidate)` | Normalises consultation type/title before approval |

Candidate extraction is intentionally simple keyword classification. It does not use a model and does not promote automatically.

---

## 7. Planner aggregation and refresh helpers

| Function | Responsibility |
|---|---|
| `browserConnectorConnected()` | Heartbeat freshness check under fifteen seconds |
| `browserSetupText(status, connected)` | Human-readable browser setup state |
| `normalizeBrowserBlocker(item, status, connected)` | Rewrites the seeded browser blocker according to live setup |
| `plannerData()` | Aggregates active knowledge, approvals, candidates, stale items, buckets, summary, and next best item |
| `refreshPlannerState()` | Stages an approval to archive the browser blocker when setup becomes ready |

### Planner rules encoded here

- archived/deprecated/superseded knowledge is excluded;
- stale means old review date, explicit stale status, or confidence below `0.55`;
- focus types are goal/project/decision/reminder/current state with active/stable status;
- next best precedence is pending approval, blocker, memory candidate, focus, then any item;
- refresh does not directly retire governed memory—it creates an approval.

These rules deserve a separate behaviour reference and tests; this document records ownership only.

---

## 8. Development-roadmap scanner helpers

| Function / constant | Responsibility |
|---|---|
| `DEV_INTENT` | Required action/todo cue |
| `DEV_CUE` | Required technical cue |
| `DEV_CHECKLIST` | Unchecked Markdown task recognition |
| `CODE_MARKER` | TODO/FIXME/HACK/XXX comment recognition |
| `classifyDevTask(text)` | Maps candidate to fix/infra/idea/feature |
| `cleanTaskTitle(text)` | Normalises and truncates title |
| `devTaskCandidateFrom(rawLine)` | Requires valid size plus technical/action criteria |
| `dedupeKey(sourceKind, title)` | SHA-1 key for normalised title |
| `roadmapAlreadyKnows(title)` | Checks live roadmap duplicate |
| `stageDevCandidate(input)` | Inserts only unseen candidate |
| `scanChatForDevTasks(limitMessages)` | Scans recent chat lines |
| `scanFilesForDevTasks()` | Scans selected source/docs roots and extensions |
| `scanDevTasks()` | Runs both scanners and returns counts/errors |

File scanning is capped at 600 files and 400,000 characters per file. Roots are `src`, `server`, and `docs/todos`; blocked directories include runtime/build/vendor locations.

---

## 9. Model and chat-runtime helpers

| Function | Responsibility |
|---|---|
| `assignedPlannerModel()` | Returns most recently updated Planner Assistant assignment |
| `modelsWithExists()` | Adds current file-existence flag to registry rows |
| `readChatContextFiles(sessionId)` | Reads attached files with 10,000-character total budget |
| `buildAssistantPrompt(sessionId, userMessage)` | Builds approved-memory, pending-candidate, file-context, governance-aware prompt |
| `localModelStatus()` | Reports model/endpoint/CLI/server configuration and managed-process state |
| `runEndpointModel(endpoint, modelName, prompt)` | Calls OpenAI-compatible `/v1/chat/completions` |
| `runLlamaCli(llamaCliPath, modelPath, prompt)` | Runs llama-cli with fixed token/temperature settings |
| `runPlannerAssistant(sessionId, userMessage)` | Runtime router: managed endpoint, configured endpoint, llama-cli, or safe fallback |

### Runtime precedence

```text
managed llama-server
→ configured OpenAI-compatible endpoint
→ configured existing llama-cli + assigned model
→ unavailable/runtime-error fallback
```

`runEndpointModel` has no explicit AbortSignal timeout. `runLlamaCli` has a five-minute timeout and 4 MiB output cap.

---

## 10. Browser URL, profile, and capability helpers

| Function | Responsibility |
|---|---|
| `normalizeBrowserUrl(value)` | Accepts HTTP(S) URL or domain and normalises to HTTPS |
| `browserChallengeResult(input)` | Detects auth errors, Cloudflare/human checks, insecure-browser rejection, CAPTCHA cues |
| `defaultCloudAgentUrl(targetAgent, fallback)` | Defaults ChatGPT/Gemini/Grok/Claude URL |
| `tabMatchesAgent(url, hosts)` | Host match for tab reporting |
| `emptyAgentTabMap()` | Empty per-agent status map |
| `agentTabsFromUrls(tabs)` | Groups tab summaries by cloud agent |
| `chatGptUnavailableResult(input)` | Extends challenge detection with signed-out composer detection |
| `browserProfileDir()` | App-owned Playwright profile path |
| `chromeDebugProfileDir()` | Dedicated real-Chrome debug profile path |
| `browserAgentExtensionDir()` | Unpacked extension directory |
| `chromeExecutablePath()` | Windows Chrome path lookup |
| `chromeDebugEndpointAvailable(endpoint)` | Short CDP endpoint probe |
| `launchChromeDebugging(url)` | Starts dedicated Chrome with remote debugging and waits for endpoint |
| `pageMatchesHost(page, host)` | Matches existing CDP page to target host |
| `realChromePage(url)` | Attaches over CDP and reuses/creates matching page |
| `controlledBrowserPage()` | Starts app-owned persistent Chrome/Chromium context |
| `resetBrowserProfile()` | Closes context and deletes only app-owned browser-profile directory |
| `packageAvailable(packageName)` | Dynamic-import availability probe; currently appears unused |
| `browserAutomationStatus()` | Reports Playwright package and Chromium executable state |

### Browser mode distinction

- **real Chrome debug profile** — dedicated Chrome profile attached over CDP; used for automatic ChatGPT consultation.
- **app-controlled Chrome/Chromium profile** — Playwright persistent context; used for generic controlled opening/fallback.
- **normal installed Chrome/external browser** — launched without reading cookies; manual paste/capture path.
- **Chrome connector** — extension in the user's normal profile; primary browser-agent path.

---

## 11. Browser-context egress and prompt helpers

| Function | Responsibility |
|---|---|
| `selectedContextFiles(paths)` | Dedupes, confines, rejects protected files, and applies file/total character limits |
| `buildCloudConsultationPrompt(input)` | Builds external consultant prompt with explicit advisory/no-authority language |
| `buildBrowserAgentAssistPrompt(input)` | Builds local-model prompt that rewrites but does not answer the user draft |
| `runBrowserPromptAssistant(input)` | Routes local assist through model runtime with safe fallback |

Egress limits are eight files, 8,000 characters per file, and 24,000 total characters.

---

## 12. ChatGPT browser automation helpers

| Function | Responsibility |
|---|---|
| `firstVisibleLocator(page, selectors, timeout)` | Tries selector list until one visible element is found |
| `chatGptComposer(page)` | Finds known composer selectors |
| `waitForChatGptComposerAfterManualClearance(page, timeout)` | Waits up to ten minutes for login/challenge clearance |
| `extractChatGptAnswer(page)` | Extracts latest assistant text using selector fallbacks |
| `waitForChatGptAnswer(page, previousAnswer)` | Waits up to three minutes for a stable new answer and no stop button |
| `runChatGptConsultation({prompt,url})` | Opens debug Chrome, fills/sends prompt, waits for answer, returns browser metadata |

Selector maintenance is fragile by nature. Any ChatGPT UI change can break composer/send/answer detection. The extension has its own selector/capture logic and must be documented separately.

---

## 13. External browser and installer-launch helpers

| Function | Responsibility |
|---|---|
| `openExternalBrowser(url)` | Uses Windows URL handler, macOS `open`, or Linux `xdg-open` |
| `openChromeBrowser(url)` | Uses discovered Chrome path/app registration/platform launcher |

Neither helper reads browser cookies. Clipboard copy is a separate explicit operation.

---

## 14. Settings and import/export helpers

| Function | Responsibility |
|---|---|
| `readSettings({redactSecrets})` | Reads JSON-encoded settings and optionally redacts known secrets |
| `readSettingsRedacted()` | Safe client-facing settings read |
| `publicSettings(includeSecrets)` | Export-facing wrapper; explicit backup may include secrets |
| `importPreview(data)` | Counts supported rows, duplicates, and ignored sections |

Normal bootstrap/settings/export calls must use redacted reads. The explicit backup query can request secrets and therefore has a materially different risk class.

---

## 15. OpenHands status and request-file helpers

| Function / constant | Responsibility |
|---|---|
| `probeHttp(url, timeoutMs)` | Short reachability probe |
| `runDocker(args, options)` | Runs Docker and falls back to Docker Desktop CLI on Windows |
| `readOpenHandsRequests()` | Reads request JSON files and resolves report paths |
| `openHandsRequestFile(id)` | Strict ID validation and directory confinement |
| `loadOpenHandsRequest(id)` | Loads one confined request file |
| `changedTrackedFiles()` | Captures current porcelain status lines for validation-run before/after comparison |
| `RUNNER_VALIDATION_ALLOWLIST` | Fixed commands: server syntax check and frontend build |
| `RUNNER_DEFAULT_VALIDATION` | Default server syntax check |

Request files are stored under `.lps/tooling/openhands/requests`; reports and patches under `.lps/tooling/openhands/reports`. These are deliberately protected from normal repo browsing and Source Control staging.

---

## 16. OpenHands execution-plan helpers

| Function | Responsibility |
|---|---|
| `proposedExecutionBranch(id)` | Builds controller-owned `local-agent/*` proposal branch |
| `branchExists(name)` | Checks local branch ref |
| `resolveBaseBranchCommit(baseBranch)` | Resolves validated base branch to full commit SHA |
| `normalizeStoredBaseBranch(request)` | Revalidates and normalises stored base branch |
| `evaluateExecutionPlan(request)` | Evaluates approval, confirmation, paths, branch pins, base commit, max files, and validation gates |
| `invokeOpenHandsExecutor(toolConstraints, readiness)` | Refuses missing constraints/readiness and returns disabled result while invocation flag is false |

Fixed execution configuration:

```text
model: openai/qwen2.5-coder:14b-gpu
base URL: http://host.docker.internal:11434/v1
real invocation: disabled
```

Imported executor-enforcement helpers:

- `OPENHANDS_MANDATORY_FORBIDDEN`
- `normalizeRequestPath`
- `violatesMandatoryForbidden`
- `validateExecutorBaseBranch`
- `OPENHANDS_EXECUTOR_LIMITS`
- `checkWorktreeValidationSetup`
- `checkExecutorMaxFilesChanged`
- `summarizeExecutorCommandResult`
- `limitExecutorReportText`
- `buildOpenHandsInvocationConstraints`
- `buildOpenHandsInvocationReadiness`
- `parsePorcelainPaths`
- `isChangedFileAllowed`
- `enforceChangedFiles`

The `/execute` handler owns the remaining orchestration inline: create isolated worktree from pinned commit, probe readiness, invoke the disabled adapter, inspect actual changed files, capture untracked files via intent-to-add, write binary-safe patch, run allowlisted validation, write report, and preserve/remove worktree according to whether a real diff exists.

---

## 17. Source-control authentication and file-diff helpers

| Function / constant | Responsibility |
|---|---|
| `githubTokenConfigured()` | Reports whether PAT exists without revealing value |
| `authenticatedRemoteUrl(remoteUrl, token)` | Ephemeral one-command authenticated HTTPS URL |
| `looksBinary(text)` | Prevents binary content from entering side-by-side text view |
| `FILE_DIFF_MAX_BYTES` | 400,000-character display cap per side |
| `PROTECTED_PUSH_BRANCHES` | `main`, `master` |

Most Source Control behaviour is implemented inline in route handlers rather than reusable service functions. This is a major extraction opportunity.

---

## 18. Function ownership by side effect

### Pure or nearly pure

```text
normalizeBrowserUrl
consultationCandidate
normalizedMemoryCandidate
browserChallengeResult
defaultCloudAgentUrl
tabMatchesAgent
emptyAgentTabMap
agentTabsFromUrls
chatGptUnavailableResult
buildCloudConsultationPrompt
buildBrowserAgentAssistPrompt
safeGitRef
safeGitUrl
parseRemotes
parseGitStatus
classifyCandidate
classifyDevTask
cleanTaskTitle
devTaskCandidateFrom
dedupeKey
proposedExecutionBranch
looksBinary
importPreview
```

### Database reads/writes

```text
seedRoadmapIfEmpty
allRows
row
createCandidateFromMessage
assignedPlannerModel
readChatContextFiles
buildAssistantPrompt
modelsWithExists
plannerData
refreshPlannerState
roadmapAlreadyKnows
stageDevCandidate
scanChatForDevTasks
readSettings
readSettingsRedacted
publicSettings
```

### Filesystem/process/network

```text
installer helpers
runCli
spawnCli
copyTextToSystemClipboard
browser profile/Chrome helpers
browser automation helpers
selectedContextFiles
model runtime calls
openExternalBrowser
openChromeBrowser
npmInstall
npxRun
gitStatusSnapshot
scanFilesForDevTasks
probeHttp
runDocker
OpenHands request/report helpers
branchExists
resolveBaseBranchCommit
evaluateExecutionPlan
invokeOpenHandsExecutor
```

---

## 19. Failure and recovery behaviour

- Most command failures are converted into structured `runCli` results, then translated by routes.
- Browser automation uses explicit waits and returns blocked/setup-gated states where possible.
- Managed llama-server state is known only for a child started by this process.
- Installer, connector, and browser state is in memory and must be rediscovered after restart.
- SQLite writes are usually individual statements; only roadmap reordering uses explicit `BEGIN/COMMIT/ROLLBACK`.
- Approval application can perform multiple operations before approval status is updated; there is no cross-filesystem/database transaction.
- OpenHands worktree execution has a `finally` cleanup path and preserves a worktree when a real diff exists.
- Static error handling keeps API responses JSON-shaped, but process-level exception survival is not equivalent to subsystem recovery.

---

## 20. Known defects and extraction priorities

### Confirmed or strongly indicated

- `packageAvailable()` appears unused.
- Browser selectors are hard-coded and vulnerable to external UI changes.
- The local endpoint model call lacks an explicit timeout/cancellation signal.
- Browser connector jobs are not durable and can remain in memory after clients abandon a request.
- `server/index.js` has extensive inline route logic that is difficult to unit test independently.
- Generic settings accept arbitrary keys and depend on a small manual secret registry.
- Direct SQL and synchronous filesystem access occur throughout request handlers.
- Process-level exception handlers may keep a process alive after inconsistent partial state.

### Recommended extraction order

1. `services/workspaceSafety.js`
2. `services/gitService.js`
3. `services/modelRuntime.js`
4. `services/browserConsultation.js`
5. `services/approvalService.js`
6. `services/openHandsService.js`
7. route modules by subsystem
8. shared request validation/schema layer

Preserve behaviour and verify each extraction against the endpoint catalogue before deleting monolith code.

---

## 21. Verification commands

```powershell
node --check server/index.js
npm run build
node scripts/verify-run-cli-cwd.mjs
node scripts/verify-executor-enforcement.mjs
```

Use the actual committed script names present in the repository; the complete verification-script inventory remains a separate cookbook task.

Runtime checks should include subprocess timeout/output-limit paths, protected-path refusals, settings redaction, model-runtime fallback, browser challenge handling, connector restart loss, approval stale conflicts, and OpenHands invocation-disabled enforcement.

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_EXPRESS_ENDPOINT_CATALOGUE.md
docs/cookbook/codebase/PUBLIC_APP_UI_ENDPOINT_CATALOGUE.md
docs/cookbook/codebase/PUBLIC_APP_FRONTEND_COMPONENT_AND_API_MAP.md
docs/cookbook/codebase/PUBLIC_APP_CORE_ANATOMY.md
```
