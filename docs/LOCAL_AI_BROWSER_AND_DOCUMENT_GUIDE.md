# Local AI, Browser Consultation, and Portable Documents

Status: implemented and acceptance-tested on Windows, 2026-07-22.

## What works without specialist setup language

Life Planner now treats a local model choice as an end-to-end action, not just a
database label. A fresh Windows installer contains a pinned llama.cpp CPU
runtime. Installation or first launch silently downloads the compact starter
GGUF, verifies its published size and SHA-256, registers it, assigns it to
Planner Assistant, starts llama-server hidden, polls `/health`, and records logs.

When a user later downloads or loads another GGUF, LPS stops the old managed
server, changes the assignment, starts the selected model, and waits for health.
An explicitly configured OpenAI-compatible chat endpoint takes precedence over
the bundled server. Coding workers can use a separate endpoint/model; when those
fields are blank they fall back to the chat endpoint or bundled llama.cpp.

## Local model roles

- `Planner Assistant` is the local chat/reasoning role.
- `Coding worker endpoint/model` is an optional separate OpenAI-compatible role.
- OpenHands is not required for local chat or browser consultation.
- OpenHands is optional, disabled by default, and performs no Docker probes while
  disabled. Future invocation remains disabled by the server safety boundary.
- Future worker configuration is server-derived. Request JSON cannot choose an
  endpoint, model, key, branch, or protected path.
- A configured loopback endpoint must also be explicitly verified as on-machine
  inference before it receives local-model Git authority. Unknown provenance is
  cloud-controlled. Cloud/browser advice never grants branch authority; see
  `docs/GIT_AUTHORITY_POLICY.md`.

## Cloud consultation flow

1. Choose ChatGPT, Claude, Gemini, Grok, or another browser target.
2. Write the question and optionally select local context files.
3. Use Local assist if desired. This runs through the configured local model.
4. Choose Preview before sending.
5. LPS assembles the final prompt, redacts high-confidence credentials, private
   keys, email addresses, and phone numbers, then displays the exact result.
6. Confirm that exact prompt and provider. Confirmation is bound to a SHA-256 of
   `provider + final prompt`; edits or provider changes invalidate it.
7. The Chrome connector sends the prompt in the user's signed-in browser.
8. Captured output remains advisory until the user saves/reviews it.

ChatGPT Temporary Chat remains a manual confirmation because LPS cannot prove
that browser setting from the page. Provider-specific stale-turn/login/selector
fixtures remain an open roadmap item; generic capture must not be called fully
complete until those fixtures pass.

## PDF and portable context

Settings > Import / Export can scope an export to everything, projects,
knowledge, the development roadmap, or chat history, then produce:

- PDF rendered locally by bundled Playwright Chromium;
- a self-contained searchable interactive HTML file;
- Markdown;
- plain text;
- structured JSON.

The interactive HTML contains no remote assets and applies a restrictive CSP.
PDF import runs locally through PDF.js, rejects non-PDF input and files over 15
MB/500 pages/2,000,000 extracted characters, stores a SHA-256 provenance marker,
and creates a `pending review` source document. SQLite remains canonical.

One-click public export is intentionally disabled. A local artifact can contain
whatever the user selected, but publication needs explicit shareability
classification and a confirmed final preview before it can be called safe.

## Logs and repair locations

- llama.cpp runtime: portable root `llama/`
- default/selected models: `app/data/models/` unless changed in Settings
- llama logs: `app/data/logs/llama-server.stdout.log` and `.stderr.log`
- runtime repair: `Install Local Model Runtime.cmd`
- provisioning source: `scripts/windows/Install-LlamaRuntime.ps1`

## Verification

```powershell
npm.cmd run verify:local-ai-docs
npm.cmd run verify:source-control-api
npm.cmd run verify:runtime-safety
npm.cmd run build
```

The one-time live acceptance additionally downloaded the pinned 986,048,768-byte
starter model, matched SHA-256
`1ADF0B11065D8AD2E8123EA110D1EC956DAB4AB038EAB665614ADBA04B6C3370`,
started llama.cpp build 8354, received `/health = ok`, and obtained the completion
`LPS LOCAL READY` through `/v1/chat/completions`.
