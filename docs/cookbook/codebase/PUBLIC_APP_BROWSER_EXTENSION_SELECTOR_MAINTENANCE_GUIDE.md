# LifePlanSystemPublic Browser Extension Selector and Capture Maintenance Guide

Status: complete source-level maintenance guide for `browser-extension/lps-browser-agent/background.js`, DOM selector fallbacks, response-stability logic, supported hosts, local job protocol, and safe update procedure. Live cloud-site compatibility remains runtime-verified evidence only.

Last updated: 2026-07-16

Source snapshots:

```text
browser-extension/lps-browser-agent/background.js  d6d139b5f16e291dbe963e08793b7cb553d662b8
browser-extension/lps-browser-agent/manifest.json   13599ad298f16aea312bca44f58e5ab145c90f7a
server/index.js                                     1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
src/main.jsx                                        4592881c34af44848dfc72e74895face6098a1da
```

## 1. Role

The Chrome extension connects the local Life Planner server to cloud-agent tabs in the user's normal Chrome profile.

It:

1. reports visible HTTP(S) tab titles/URLs to the localhost server;
2. polls for the oldest pending browser job;
3. finds or opens a tab for the target agent;
4. injects `runContentSend` into the page;
5. finds the composer and enters the prompt;
6. submits the prompt;
7. waits for a stable response;
8. posts the result back to the local server.

It does not directly persist memory or edit LifePlanSystem files.

## 2. Fixed local endpoint

```js
const LPS = 'http://127.0.0.1:4177';
```

The manifest grants:

```text
http://127.0.0.1:4177/*
```

Both must match the running API. The saved `browserAgentPort` setting does not currently rewrite either value.

A port change requires coordinated edits to:

- extension background constant;
- extension host permissions;
- Vite proxy when development should use the same new API port;
- portable launch scripts;
- server environment/launch configuration;
- relevant documentation and tests.

## 3. Supported named hosts

```text
ChatGPT: chatgpt.com, auth.openai.com
Gemini:  gemini.google.com, accounts.google.com
Grok:    grok.com, x.com
Claude:  claude.ai
```

`hostMatches()` parses the URL and accepts exact host or subdomain suffix.

The extension can accept a custom job URL from the server, but script execution is limited by `manifest.json` host permissions. Adding a new named provider requires both agent constants and manifest host permissions.

## 4. Job polling protocol

Interval:

```text
1,500 ms
```

Each poll:

```text
POST /api/browser/extension/heartbeat
GET  /api/browser/extension/next
```

If a job is returned, `handleJob()` processes it and posts:

```text
POST /api/browser/extension/jobs/:id
```

The extension also polls on installation and Chrome startup.

### Protocol limitations

- no extension/server pairing secret;
- no request signature;
- no job lease expiry;
- no connector identity;
- no cancellation message;
- no retry/backoff distinction between server closed and malformed response;
- server marks a job `claimed` as soon as it is returned, so an extension crash can strand it.

Selector work must not accidentally obscure these protocol-level concerns.

## 5. Tab inventory and selection

`visibleTabs()` calls `chrome.tabs.query({})` and returns every tab with an HTTP(S) URL:

```text
id
title
url
```

The server later groups known agent tabs. The extension itself does not filter heartbeat data to named cloud agents.

`tabForJob()`:

1. obtains the configured host list for `job.targetAgent`;
2. searches all tabs for the first matching host;
3. activates/focuses that tab;
4. otherwise creates a new tab using the job URL or agent default.

Risks:

- the first matching tab may be the wrong conversation/account;
- multiple matching tabs are not disambiguated;
- an existing authentication page may match an agent host;
- the selected tab is brought to the foreground;
- custom/unknown agents have an empty host list and therefore always open a new tab.

## 6. Composer selectors

Current ordered fallback list:

```text
[data-testid="prompt-textarea"]
#prompt-textarea
textarea[placeholder*="Message"]
textarea[aria-label*="Message"]
div[contenteditable="true"][role="textbox"]
div[contenteditable="true"]
textarea
```

The script checks visibility by bounding rectangle and retries once per second for up to 240 iterations.

### Maintenance principles

- Keep provider-specific stable attributes before generic fallbacks.
- Never place a broad selector above a provider-specific one.
- Require an actually visible, usable element.
- Prefer semantic/test IDs, roles, or labels over generated class names.
- Avoid selectors that can match search, feedback, title, or hidden editor fields.
- Do not add selectors for security/challenge inputs.
- Record the provider and date when adding a fallback.

### Composer failure result

When none is found:

```text
status: blocked
error: No browser-agent composer was found...
```

This should remain a safe refusal rather than guessing at a generic input.

## 7. Prompt insertion

The injected function:

1. focuses the selected composer;
2. writes `textContent` for contenteditable elements or `value` for standard controls;
3. dispatches an `InputEvent`;
4. dispatches a `change` event;
5. waits 300ms.

Some React/web-component editors may require native setters, selection ranges, `beforeinput`, keyboard/paste events, or provider-specific editor APIs. When a site stops recognizing inserted text, update the event strategy separately from selector changes.

Never simulate credential entry, solve verification challenges, or bypass Temporary Chat confirmation.

## 8. Send selectors

Current ordered list:

```text
[data-testid="send-button"]
[data-testid="composer-submit-button"]
button[aria-label*="Send"]
button[type="submit"]
```

The first visible, enabled match is clicked. When none is found, the script dispatches Enter keydown on the composer.

Risks:

- generic `button[type="submit"]` can select the wrong form;
- `aria-label*="Send"` can match unrelated send/share controls;
- Enter behavior can differ for multiline editors and IME composition;
- only `keydown` is dispatched, not full keyboard event sequence.

A selector update should prove both that the intended button is selected and that disabled/stop/regenerate controls are not selected.

## 9. Response selectors

Current list:

```text
[data-message-author-role="assistant"]
message-content
[data-testid="conversation-turn"]
.model-response-text
main
```

ChatGPT receives special behavior: when assistant-role nodes exist, only new assistant turns at or after the pre-send turn count are considered. The function deliberately does not fall back to older turns or generic containers in that case.

For other page structures, the script tries the remaining selectors in order, newest visible node first.

### Generic fallback risk

`main` is very broad and can include:

- the prompt;
- navigation text;
- conversation history;
- status messages;
- legal banners;
- unrelated page content.

Provider-specific response extraction should be added before relying on `main`.

## 10. Status-text filtering

The script removes or rejects common transient labels such as:

```text
Thinking
Thought for ... seconds/minutes
Reasoning
Analyzing
Searching
Working
```

The purpose is to avoid treating a stable reasoning-status label as the completed answer.

Maintenance risk: provider wording changes can produce false completion, while an answer that legitimately begins with one of these words may be stripped.

Status filters should be narrowly anchored and backed by captured examples.

## 11. Prompt-echo removal

`extractResponseText()` normalizes whitespace, then:

- removes status prefixes;
- if the response container includes the exact normalized prompt, slices after the last prompt occurrence;
- caps output at 12,000 characters.

Risks:

- exact whitespace normalization may fail against formatted/quoted prompts;
- an answer that repeats the prompt near its end can be sliced incorrectly;
- 12,000 characters may truncate important content without a dedicated truncation flag;
- page text is flattened, losing Markdown, links, tables, and code formatting.

## 12. Pre-send snapshot

Immediately before submit:

```text
beforeTurnCount = assistantTurnCount()
beforeText      = readLatestResponse()
```

This is essential. It prevents late-rendering old conversation history from being mistaken for the new answer.

For ChatGPT, a response identical to the previous answer is still accepted when the assistant turn count increased.

Any selector refactor must preserve the pre-send snapshot and new-turn boundary.

## 13. Stability and timeout

After sending, the script polls once per second for up to 90 ticks.

A response is considered complete after the same non-empty response text is observed for three consecutive ticks.

This is a heuristic, not a provider completion signal.

Failure modes:

- streaming pauses for three seconds before continuing;
- a status/error message remains stable;
- continuously changing timestamps/citations prevent stability;
- tool-use UI updates after the main answer;
- long reasoning exceeds 90 seconds;
- hidden/virtualized nodes alter visibility.

When the loop expires, the result is `blocked` with a timeout message.

## 14. Result contract

Successful injected result:

```json
{
  "status": "answered",
  "url": "current page URL",
  "title": "document title",
  "answer": "captured text",
  "message": "Prompt sent and response captured..."
}
```

Blocked result includes `status`, URL/title where available, and `error`.

`handleJob()` forwards the injected result to the server. Exceptions become `status: error`.

The server trusts the extension's report; there is no cryptographic provenance.

## 15. Safe selector-change workflow

1. Reproduce the failure in a non-sensitive test conversation.
2. Record provider, URL host, browser version, date, and observed DOM role/test attributes.
3. Determine whether the failure is composer selection, insertion, send, response selection, or completion detection.
4. Add the narrowest stable selector before generic fallbacks.
5. Confirm the selector does not match hidden, authentication, challenge, feedback, or unrelated controls.
6. Test in a fresh conversation and a conversation with prior turns.
7. Test repeated identical answers and long streaming responses.
8. Confirm no old answer is captured.
9. Confirm timeout remains a safe failure.
10. Reload the unpacked extension and restart the local server if protocol code changed.
11. Record the result in a dated runtime acceptance file.

## 16. Provider test matrix

For each supported provider, test:

```text
signed-in composer found
signed-out state refuses safely
new blank chat
existing multi-turn chat
prompt containing code/newlines
answer containing code/table/list
answer identical to previous answer
long streaming answer
provider error/rate-limit message
manual user stops generation
multiple matching tabs
90-second timeout
```

ChatGPT additionally requires manual Temporary Chat confirmation at the application layer; the extension cannot verify that mode.

## 17. Privacy test matrix

Verify:

- only intended context appears in the outgoing prompt;
- no other tab contents are read;
- heartbeat metadata is understood and acceptable;
- response is not persisted until the explicit consultation save action;
- extension job/result routes are bound to localhost;
- protected/private-brain paths are blocked by the server before job creation;
- screenshots, cookies, storage, and credentials are not copied by the extension.

## 18. Recommended hardening before production use

- pair extension and server with a per-install secret;
- filter heartbeat to known agent hosts and minimize tab metadata;
- add job lease, reclaim, cancellation, expiry, and pruning;
- bind a job to a chosen tab rather than first host match;
- separate provider adapters/selectors;
- return capture truncation/completion metadata;
- add extension-level unit tests with static DOM fixtures;
- add Playwright extension integration tests against local mock pages;
- centralize port configuration and generate manifest/background values from one source;
- remove or heavily constrain the generic `main` response fallback.

## 19. Current conclusion

The connector has thoughtful protections against stale ChatGPT answers and transient reasoning labels, but its provider compatibility depends on fragile DOM heuristics. Selector changes must be narrow, provider-aware, privacy-preserving, and runtime-tested; they must never be treated as a mechanism for bypassing sign-in, verification, consent, or Temporary Chat requirements.