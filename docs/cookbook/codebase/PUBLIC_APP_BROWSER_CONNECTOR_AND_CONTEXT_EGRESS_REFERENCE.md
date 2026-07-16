# LifePlanSystemPublic Browser Connector and Context-Egress Reference

Status: complete source-level reference for Browser consultation modes, context selection, consultation persistence, Chrome-extension jobs, direct Playwright/CDP automation, manual fallbacks, capture selectors, and privacy/safety gaps; runtime verification remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/index.js                                      1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
src/main.jsx                                         4592881c34af44848dfc72e74895face6098a1da
browser-extension/lps-browser-agent/background.js   d6d139b5f16e291dbe963e08793b7cb553d662b8
browser-extension/lps-browser-agent/manifest.json   13599ad298f16aea312bca44f58e5ab145c90f7a
```

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_SETTINGS_AND_SECRET_REGISTRY.md
docs/cookbook/codebase/PUBLIC_APP_CHAT_AND_LOCAL_MODEL_EXECUTION_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_REPOSITORY_PROPOSAL_AND_PROTECTED_PATH_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_MEMORY_APPROVAL_AND_PROJECT_GOVERNANCE_REFERENCE.md
```

---

## 1. Purpose and trust model

The Browser subsystem lets Life Planner ask an external web agent for advisory critique while preserving a review boundary before any result becomes local memory.

Supported named agents:

```text
ChatGPT
Gemini
Grok
Claude
Other web agent (frontend/custom URL)
```

Core rule:

```text
cloud response -> reviewable suggestion -> explicit save -> memory candidate -> user decision
```

A cloud response does not directly update `knowledge_items`, projects, Planner state, files, or Git.

The system supports multiple transport modes:

1. Chrome connector in the user's normal Chrome profile;
2. dedicated real Chrome profile with remote debugging;
3. app-owned persistent Playwright browser profile;
4. installed Chrome opened for manual paste;
5. operating-system default external browser;
6. clipboard-only/manual fallback.

These modes have materially different privacy, authentication, and reliability properties.

---

## 2. Main routes

Consultation persistence:

```text
GET   /api/consultations
POST  /api/consultations
PATCH /api/consultations/:id
```

Browser status and execution:

```text
GET  /api/browser/capabilities
GET  /api/browser/agent-tabs
POST /api/browser/open
POST /api/browser/consult
POST /api/browser/assist-prompt
POST /api/browser/reset-profile
POST /api/browser/copy-prompt
POST /api/browser/open-external
POST /api/browser/open-chrome
```

Extension installation/protocol:

```text
GET  /api/browser/extension/install-info
POST /api/browser/extension/install-helper
POST /api/browser/extension/heartbeat
GET  /api/browser/extension/next
POST /api/browser/extension/jobs/:id
```

---

## 3. Consultation database lifecycle

Table:

```text
consultations
```

Important fields:

```text
title
local_draft
target_agent
prompt
opened_url
opened_title
sent_at
captured_at
external_response
status
created_at
updated_at
```

### Create

`POST /api/consultations` requires a non-empty `local_draft`.

It may also record:

- target agent;
- prepared prompt;
- opened page metadata;
- sent timestamp.

Default title:

```text
External consultation
```

Default target:

```text
manual browser
```

### Patch

`PATCH /api/consultations/:id` can update prompt, page metadata, timestamps, response, and status.

When a non-empty `external_response` is stored for the first time, the server creates one memory candidate:

```text
type       consultation
source     cloud consultation
confidence 0.45
status     candidate
```

Later edits to the same consultation response do not create another candidate because candidate creation checks whether the previous response was empty.

### Provenance limitations

The server trusts the patch request. It does not cryptographically prove that a response came from the named agent or extension.

Any local caller able to reach the route can insert an external response and trigger candidate creation.

---

## 4. Frontend save boundary

`BrowserConsult` keeps draft/prompt/response state locally while the consultation is active.

The frontend exposes an explicit save choice. Captured output is not automatically promoted to active memory.

The maintained save path stores the response on the consultation, which creates a reviewable memory candidate. Other displayed future save/sync options are disabled.

`Save nothing` clears the local captured response.

This is an important boundary, but it is UX plus route behavior rather than a formal capability token. A direct caller can still patch a consultation.

---

## 5. Context selection and egress

`selectedContextFiles(paths)` is the server-side egress reader.

Limits:

```text
maximum selected paths: 8
maximum characters per file: 8,000
maximum combined characters: 24,000
```

For each path it:

1. deduplicates and trims input;
2. confines it to the current workspace;
3. rejects `isProtectedWorkspacePath()` matches;
4. requires an existing regular file;
5. reads UTF-8 text;
6. truncates according to per-file and total limits;
7. returns path, truncation flag, and content.

The generated cloud prompt identifies selected files and includes their content in fenced text blocks.

### Context boundary strengths

- explicit path list;
- server-side read, not arbitrary client-provided file content;
- workspace confinement;
- protected-path check;
- bounded count/size;
- response reports which paths were included and truncated.

### Critical private-brain gap

The protected-path function is public-app oriented and does not automatically block private-brain locations such as `source_of_truth/`, `rules/`, or other sensitive folders.

If the runnable app is started with the private repository as `process.cwd()`, selected private documents can be sent to a cloud agent.

Repository identity and a cloud-egress allowlist must be enforced independently of generic protected-file rules.

### No content-classification gate

Allowed files are not scanned for:

- credentials;
- personal identifiers;
- sensitive health/therapy content;
- private memory markers;
- export restrictions.

Path acceptance is currently the only backend privacy classification.

---

## 6. Prompt construction

### Cloud consultation prompt

`buildCloudConsultationPrompt()` tells the external agent to:

- act as a consultant;
- critique the local draft;
- identify missing context and risky assumptions;
- treat selected context as background only;
- avoid claiming authority over memory/priorities/plans;
- return a suggestion that requires review.

### Local prompt assistance

`POST /api/browser/assist-prompt` optionally asks the configured local Planner Assistant to rewrite the user's draft into a better external-agent prompt.

It uses the same context-selection limits and can run through:

1. managed llama-server;
2. configured OpenAI-compatible local endpoint;
3. configured llama-cli;
4. unavailable/runtime-error fallback.

The helper is instructed not to answer the external question itself.

---

## 7. Temporary Chat gate

For ChatGPT requests, `POST /api/browser/consult` checks:

```text
temporary_chat_required !== false
temporary_chat_confirmed === true
```

When required but not confirmed, sending is refused.

The frontend provides manual setup instructions and states that Life Planner cannot verify ChatGPT's actual mode.

### Bypass characteristics

This is a caller-declared gate:

- a direct caller can set `temporary_chat_required=false`;
- the extension does not inspect or verify Temporary Chat state;
- the connector can reuse an existing ChatGPT tab/conversation;
- the server does not create a guaranteed new temporary conversation.

The gate is informed consent UX, not technical verification.

---

## 8. Chrome connector architecture

The connector is a Manifest V3 background service worker.

Permissions:

```text
tabs
scripting
```

Host permissions:

```text
http://127.0.0.1:4177/*
ChatGPT/auth.openai.com
Gemini/accounts.google.com
Grok/x.com
Claude
```

Server URL is hardcoded:

```text
http://127.0.0.1:4177
```

The extension does not read settings from Life Planner and does not follow `LIFE_PLANNER_PORT` or `browserAgentPort`.

---

## 9. Connector heartbeat and tab inventory

Every poll cycle calls `visibleTabs()` and sends every open HTTP(S) tab's:

```text
id
title
url
```

to:

```text
POST /api/browser/extension/heartbeat
```

The server stores up to 100 tabs in process memory and marks the connector fresh for 15 seconds.

### Privacy implication

The connector reports all visible HTTP(S) tab URLs and titles, not only ChatGPT/Gemini/Grok/Claude tabs.

URLs and titles can reveal:

- private searches;
- account or document identifiers;
- internal systems;
- health, financial, or relationship topics;
- browsing habits.

No page body, cookie, password, or form data is included in heartbeat, but URL/title inventory is still sensitive.

The heartbeat should filter to approved agent hosts before transmission, or require explicit opt-in for broader tab discovery.

---

## 10. Connector authentication gap

Extension protocol routes have no application-level authentication or per-install secret.

Any process able to reach the loopback server can:

- submit a fake heartbeat and appear connected;
- provide fake tab inventory;
- claim the next pending job;
- read the full prompt and target URL;
- submit a forged answer/status for a known job ID.

Loopback binding reduces network exposure but is not an authorization system against other local processes.

Recommended protocol:

- generate an install-specific secret;
- require an authenticated heartbeat;
- issue per-job claim tokens;
- bind completion to the claimant;
- expire/revoke credentials;
- avoid returning a job to unauthenticated GET callers.

---

## 11. Connector job lifecycle

Server state:

```text
browserAgentJobs Map
browserAgentJobSeq integer
browserExtensionState {lastSeen, tabs}
```

Job fields:

```text
id
status
targetAgent
url
prompt
createdAt
updatedAt
result
error
```

Statuses accepted by completion route:

```text
pending
claimed
sent
answered
blocked
error
```

### Create

`POST /api/browser/consult` creates a `pending` job when:

- mode is `myChromeConnector`;
- heartbeat is fresher than 15 seconds;
- prompt/context/Temporary Chat gates pass.

### Claim

`GET /api/browser/extension/next` selects the oldest `pending` job, changes it to `claimed`, and returns:

```text
id
targetAgent
url
prompt
```

### Complete

`POST /api/browser/extension/jobs/:id` accepts status/error/url/title/answer/message and replaces the in-memory result.

### Wait

The original consultation request polls the in-memory job for up to 240 seconds and returns answered/blocked/error/timeout.

### Restart behavior

All connector state and jobs are lost on server restart.

No consultation/job reconciliation occurs after restart.

---

## 12. Job reliability defects

### Claimed jobs are not retried

`next` only returns `pending` jobs.

If the extension claims a job and then crashes, sleeps, loses permission, or closes the target tab, the job remains `claimed` and cannot be claimed again.

There is no lease expiry or requeue mechanism.

### No cancellation

The server has no route to cancel a pending/claimed job. The extension cannot be told to stop after the user abandons a request.

### No pruning

Completed and timed-out jobs remain in the process `Map` until restart. Repeated consultations create an unbounded process-memory collection.

### Timeout mismatch

Extension timings can exceed server wait time:

```text
composer search: up to 240 seconds
response capture: up to 90 seconds
server consultation wait: 240 seconds total
```

The server may return timeout while the extension continues working and later posts an answer that the original caller no longer receives.

### No result lookup

There is no user-facing route to retrieve a late result by job ID after the original request times out.

---

## 13. Extension tab selection

`tabForJob(job)`:

1. maps target agent to known hosts;
2. queries all tabs;
3. reuses the first matching tab;
4. focuses its window;
5. otherwise creates a new tab using job URL/default URL.

### Conversation-selection risk

Reusing the first matching cloud-agent tab can inject the prompt into:

- an unrelated existing conversation;
- a normal saved ChatGPT chat;
- a tab containing sensitive prior context;
- the wrong account/workspace.

The connector does not create or verify a dedicated conversation/session.

A safer design would require the user to select the exact tab or create a new isolated tab and confirm its state.

### Custom-agent limitation

Unknown target agents have no host mapping. The extension may open the requested URL, but `chrome.scripting.executeScript` fails when the manifest lacks host permission.

`Other web agent` therefore is not a generally functional automatic connector mode without optional host permissions or a manual flow.

---

## 14. Composer injection

The extension injects `runContentSend(prompt)` into the selected tab.

Composer selectors include generic patterns:

```text
[data-testid="prompt-textarea"]
#prompt-textarea
textarea placeholder/aria-label Message
contenteditable textbox
any contenteditable
any textarea
```

It waits up to 240 one-second iterations.

Injection behavior:

- focus selected node;
- set `textContent` for contenteditable or `.value` for form controls;
- dispatch input/change events;
- find a send button or synthesize Enter.

### Risks

- broad fallback selectors can choose the wrong editable control;
- page changes can break event assumptions;
- Enter fallback may insert a newline or trigger an unintended action;
- no prompt preview is shown inside the extension immediately before click/send;
- no page-origin recheck occurs inside the injected function.

---

## 15. Response capture

Preferred ChatGPT capture:

```text
[data-message-author-role="assistant"]
```

Generic fallbacks:

```text
message-content
[data-testid="conversation-turn"]
.model-response-text
main
```

The extension:

- snapshots assistant-turn count and previous text before sending;
- ignores several English reasoning/status labels;
- avoids old ChatGPT assistant turns by requiring a post-send turn index;
- treats text stable for three one-second ticks as complete;
- truncates captured text to 12,000 characters;
- gives up after 90 seconds.

### Capture strengths

The current ChatGPT logic specifically avoids a prior bug where stale earlier answers were returned.

### Capture weaknesses

- generic agent fallback can capture an entire `main` element;
- non-ChatGPT agents do not have agent-specific turn boundaries;
- status filtering is English and phrase-specific;
- a three-second pause can be mistaken for completion;
- the extension does not inspect a Stop/Generating button before declaring completion;
- 90 seconds may be shorter than long agent responses;
- rich content, citations, tables, code structure, and attachments are flattened to text;
- a page can spoof expected selectors/content.

The direct Playwright ChatGPT path has different selectors and checks, so the two implementations can diverge.

---

## 16. Manifest V3 service-worker behavior

The extension uses:

```text
setInterval(poll, 1500)
onInstalled -> poll
onStartup   -> poll
```

Manifest V3 background service workers can be suspended when idle. A normal JavaScript interval is not a durable scheduler across suspension.

The extension does not use `chrome.alarms` or another wake mechanism.

Consequences can include:

- stale heartbeat;
- connector appearing disconnected;
- pending jobs not being claimed until another event wakes the worker.

This must be runtime-tested across browser idle/sleep/restart conditions.

---

## 17. Direct dedicated-Chrome/CDP mode

`realChromePage(url)` uses a dedicated Chrome profile under:

```text
data/chrome-debug-profile
```

Chrome is launched with:

```text
--remote-debugging-port=9222
--remote-allow-origins=http://127.0.0.1:9222
--user-data-dir=<dedicated profile>
--start-maximized
```

Playwright attaches through:

```text
http://127.0.0.1:9222
```

Properties:

- separate from the user's default Chrome profile;
- cookies/login persist in the dedicated profile;
- existing page matching target host can be reused;
- page can be navigated by Life Planner;
- port/profile are hardcoded.

### Security note

The CDP endpoint has no Life Planner authentication. Another local process able to access port 9222 can potentially inspect/control that dedicated browser session.

### Reset mismatch

`POST /api/browser/reset-profile` deletes only:

```text
data/browser-profile
```

It does not delete:

```text
data/chrome-debug-profile
```

Therefore the endpoint does not reset the dedicated debug-Chrome cookies/session used by direct ChatGPT automation.

---

## 18. App-owned Playwright profile

`controlledBrowserPage()` uses:

```text
data/browser-profile
```

It attempts:

1. installed Chrome channel with persistent context;
2. Playwright Chromium fallback.

It is non-headless and maximized.

The profile persists cookies and storage until reset.

This profile is intentionally not the user's normal signed-in Chrome profile. Google/ChatGPT authentication may reject it.

The reset route safely verifies the deletion target remains under the app's `data` folder before recursive removal.

---

## 19. Direct consultation mode defect

When `browserAgentMode` is anything other than `myChromeConnector`, `/api/browser/consult` calls:

```text
runChatGptConsultation({prompt, url})
```

That function is ChatGPT-specific:

- ChatGPT composer selectors;
- ChatGPT blocked-state detection;
- ChatGPT assistant-response selectors;
- ChatGPT-oriented error messages.

The route still allows Gemini, Grok, Claude, or custom URLs.

Thus non-connector automatic mode is not a generic cloud-agent adapter. For non-ChatGPT targets it is likely broken or capable of interacting with/capturing the wrong elements.

The mode should either be restricted to ChatGPT or dispatch to agent-specific adapters.

---

## 20. Direct ChatGPT automation

`runChatGptConsultation()`:

1. requires dedicated real Chrome/CDP attachment;
2. navigates to target URL;
3. waits up to ten minutes for manual login/human clearance and a composer;
4. records previous assistant answer;
5. fills and sends prompt;
6. waits up to three minutes for a new stable assistant answer;
7. detects challenge/auth pages;
8. returns answer/page/profile/mode metadata.

Unlike extension capture, direct waiting checks for a visible Stop button before declaring a stable answer complete.

Failure returns blocked metadata or throws a timeout/runtime error.

---

## 21. Generic controlled open

`POST /api/browser/open`:

- validates URL;
- tries dedicated real Chrome first, then app-owned controlled browser;
- navigates with a 45-second timeout;
- reads page title/current URL;
- captures up to 1,200 characters of visible body text;
- reports detected challenge state;
- optionally updates a consultation as sent.

The visible excerpt is returned to the Life Planner UI. It may contain sensitive page content.

This route does not save the excerpt to SQLite by itself.

---

## 22. Manual browser and clipboard flows

### Copy prompt

`POST /api/browser/copy-prompt` writes prompt text to the system clipboard using:

```text
clip.exe
pbcopy
wl-copy
xclip
xsel
```

Clipboard contents remain available to other applications until overwritten.

### Open external

Copies optional prompt, then opens the OS default browser.

### Open installed Chrome

Copies optional prompt, then opens installed Chrome/default Chrome registration.

These routes do not read cookies or capture the response automatically.

They may update consultation opened/sent metadata.

### Privacy note

A consultation prompt can contain local file content. Copying it places that content in the global clipboard, outside Life Planner's database and protected-path controls.

The UI should show a clear content summary and provide a clipboard-clear action.

---

## 23. Agent-tab discovery

`GET /api/browser/agent-tabs`:

1. uses extension heartbeat inventory when fresh;
2. otherwise probes CDP port 9222;
3. maps tabs to named agent hosts;
4. returns tab IDs, titles, URLs, and counts.

This is status only. It does not prove:

- correct account;
- correct conversation;
- Temporary Chat;
- login readiness;
- permission to send selected context.

Frontend readiness should not treat an open matching tab as sufficient consent.

---

## 24. Extension installation helper

`GET /api/browser/extension/install-info` returns:

- extension directory;
- manifest path;
- current heartbeat-based installed flag;
- manual Load unpacked instructions.

`POST /api/browser/extension/install-helper`:

- copies extension directory to clipboard;
- opens `chrome://extensions` in Chrome;
- leaves Developer mode and Load unpacked as manual steps.

There is no:

- extension version handshake;
- manifest/hash verification;
- update mechanism;
- permission-difference review;
- support for configured server port.

---

## 25. Capability and readiness mismatches

### Frontend automatic gate

The frontend can combine connector readiness with Playwright/Chromium readiness even though connector mode does not require Playwright Chromium. This can unnecessarily disable the preferred connector path.

### Capability route

`GET /api/browser/capabilities` reports Playwright/Chromium and external-browser support, but connector state is obtained separately through agent-tabs/install-info.

### Port authority

The server can use `LIFE_PLANNER_PORT`, and settings can store `browserAgentPort`, but extension code/manifest remain fixed at 4177.

### CDP authority

Port 9222 and profile paths are also hardcoded.

A central browser configuration contract is required.

---

## 26. Data-retention matrix

| Data | Storage | Restart behavior |
|---|---|---|
| consultation draft/prompt/response metadata | SQLite when explicitly created/patched | persists |
| generated memory candidate | SQLite after first saved response | persists |
| selected context contents in active HTTP request | process/request memory | lost after request |
| connector prompt/job/result | process `Map` | lost |
| heartbeat tab URL/title inventory | process memory | lost |
| app-owned Playwright cookies/profile | `data/browser-profile` | persists |
| dedicated CDP Chrome cookies/profile | `data/chrome-debug-profile` | persists |
| clipboard prompt | OS clipboard | persists until replaced/cleared |
| cloud conversation | external provider | provider-dependent |

Life Planner's local deletion does not delete provider-side chats or browser-profile data unless the relevant profile is explicitly reset.

---

## 27. Safety and privacy findings

High priority:

1. connector routes have no authentication or claim token;
2. all HTTP(S) tab URLs/titles are reported in heartbeat;
3. connector can reuse the wrong existing conversation;
4. Temporary Chat is not technically verified;
5. private-repository context is not categorically blocked;
6. selected content has no sensitive-content classifier;
7. server/extension timeout mismatch loses late answers;
8. claimed jobs are never requeued;
9. completed jobs are never pruned;
10. direct non-connector mode is ChatGPT-specific despite accepting other agents;
11. debug-Chrome profile is not reset by reset-profile;
12. extension and CDP ports are hardcoded;
13. generic selectors can capture wrong/incomplete content;
14. clipboard fallback creates a separate sensitive-data channel.

---

## 28. Recommended hardening order

1. Add authenticated extension pairing and per-job claim tokens.
2. Filter heartbeat to approved agent tabs only.
3. Add explicit exact-tab selection and display account/conversation warning.
4. Enforce public-safe repository identity and context allowlists for cloud egress.
5. Add sensitive-content review/consent summary before send or clipboard copy.
6. Add job leases, cancellation, late-result lookup, expiry, and pruning.
7. Align server and extension timeouts.
8. Replace service-worker interval dependence with durable Chrome alarms/events.
9. Restrict direct automation to ChatGPT until agent-specific adapters exist.
10. Add per-agent selectors, generation-state checks, and captured-origin validation.
11. Separate reset actions for Playwright and debug-Chrome profiles.
12. Centralize ports/profile paths and generate matching extension configuration.
13. Add extension version/protocol handshake.
14. Add clipboard clear and warning behavior.
15. Record structured egress audit metadata without storing unnecessary content.

---

## 29. Runtime verification recipe

Use synthetic, non-sensitive context and disposable cloud conversations/accounts where permitted.

1. Verify capabilities with Playwright absent/present and Chromium absent/present.
2. Load the extension and confirm heartbeat freshness.
3. Observe whether unrelated HTTP(S) tab URLs/titles are sent; record current privacy behavior.
4. Spoof a heartbeat from a local test client and confirm the current unauthenticated gap.
5. Create a connector job and claim it from a test client; confirm prompt disclosure without a claim secret.
6. Submit a forged result in the isolated test and confirm current acceptance.
7. Crash/disable extension after claim and verify job remains claimed until timeout.
8. Let a connector operation exceed 240 seconds and inspect late-result behavior.
9. Repeat jobs and inspect process-memory growth.
10. Verify exact selected context limits: 8 files, 8,000 each, 24,000 total.
11. Attempt current protected paths and private-brain-named synthetic folders.
12. Test ChatGPT Temporary Chat confirmation behavior and direct API bypass flags without real private content.
13. Verify connector reuse of an existing tab versus new-tab creation.
14. Test ChatGPT, Gemini, Grok, and Claude selectors separately; record false capture/incomplete output.
15. Test MV3 worker suspension after idle and browser restart.
16. Test direct dedicated-Chrome ChatGPT flow and CDP port exposure.
17. Run reset-profile and confirm debug-Chrome profile remains; record mismatch.
18. Test external/Chrome clipboard flow, then clear clipboard.
19. Save one synthetic response and confirm exactly one memory candidate is created.
20. Delete all synthetic consultation/profile/test artifacts.

Do not send private LifePlanSystem memory, therapy content, credentials, or real personal documents during acceptance testing.
