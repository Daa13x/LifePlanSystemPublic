# Handoff: Local AI, Browser Egress, PDF, and Source Hardening

## Completed and proven

### Bundled local AI

- The portable package downloads and embeds pinned llama.cpp Windows CPU build
  `b8354`; the archive SHA-256 is pinned and verified before extraction.
- The installer/first launch downloads a pinned Qwen2.5 1.5B Q4_K_M starter
  GGUF outside the installer payload, verifies published size/SHA-256, then
  atomically promotes the `.partial` file.
- Server startup discovers bundled runtime/model paths and registers/assigns the
  starter model without requiring manual path vocabulary.
- Managed startup captures logs, polls health for 90 seconds, kills failed
  children, and reports ready only after health succeeds.
- GGUF downloads from the model picker query Hugging Face's published LFS size
  and digest, fsync a same-volume partial, atomically rename, assign, and start.
- A real Windows acceptance produced `LPS LOCAL READY` through the OpenAI API.

### Worker boundary

- Removed `/api/tooling/ollama/*`, automatic Ollama checks, hard-coded model, and
  hard-coded port 11434.
- OpenHands is persisted as `openHandsEnabled=false` by default. Disabled status
  returns without probing Docker. All worker mutation routes return 409 while it
  is disabled. Real invocation remains compile-time/server-side disabled.
- Future worker config follows `localCodeModelEndpoint/localCodeModelName`, then
  chat endpoint/model, then healthy bundled llama.cpp. Loopback is translated to
  `host.docker.internal` only for the Docker boundary.

### Browser/cloud boundary

- Added final server-side prompt assembly/classification and automatic redaction.
- Added preview API/UI. Sending requires a provider-bound SHA-256 confirmation.
- No connector job is created before confirmation passes.
- Do not close the broader roadmap job yet: provider-specific DOM adapters and
  deterministic stale-turn/login/selector fixtures are still required.

### Documents

- Added scoped JSON, Markdown, text, self-contained interactive HTML, and PDF
  exports. HTML has no remote assets and includes search/filter UI.
- Added PDF.js local extraction with magic, size, page, and text limits plus
  SHA-256 provenance and pending-review persistence.
- Disabled unsafe one-click public export pending explicit shareability design.

### Source tab

- Fetch now iterates every remote, prunes it, and uses encrypted GitHub PAT via
  ephemeral AskPass only where valid.
- Pull/rebase honor the configured upstream and fall back to origin/current.
- Remote branches can be tracked from the Branches tab.
- Main/master push is usable but requires ordinary confirmation plus an exact
  branch-bound second field; force push remains unavailable.
- Publication preflight crash from an undefined variable was fixed.
- Installer build refuses dirty/conflicted source and reports async status/logs.
- Disposable bare-remote acceptance proves fetch, behind, pull-to-disk, remote
  tracking, publication preflight, push gate, and installer status behavior.

## Next repair order

1. Split browser extension capture into provider adapters for ChatGPT, Claude,
   Gemini, and Grok. Record pre-send turn identity and require a new assistant
   turn plus provider-specific completion evidence. Never fall back to `main`.
2. Add deterministic DOM fixtures for streaming, stale prior answer, login or
   Cloudflare challenge, missing composer, selector drift, cancellation, and
   extension reload/port change.
3. Persist cloud egress previews/confirmations with provider, hash, redaction
   list, actor, and expiry if consultation audit history becomes a requirement.
4. Implement explicit per-record shareability classification, blocked/unknown
   preview, and transactionally safe public export before re-enabling it.
5. Add a GPU runtime lane only after hardware-specific CUDA/ROCm archives have
   pinned digests and CPU fallback acceptance. The universal CPU lane is the
   current reliable baseline.
6. Consider a second managed llama.cpp process on a separate port if users need
   simultaneous dedicated chat and coding GGUFs rather than separate configured
   endpoints or role switching.
7. Add PDF OCR for scanned/image-only documents as an optional downloaded tool;
   current import truthfully records `[No extractable text]` per image-only page.

## Never regress

- Do not reintroduce Ollama as an implicit requirement.
- Do not report llama-server ready before `/health` succeeds.
- Do not download directly to final model/runtime paths.
- Do not send a cloud prompt without final server assembly and hash confirmation.
- Do not label active/stable records public.
- Do not build a release artifact from a dirty or conflicted Source workspace.
- Do not mark provider capture complete from a generic DOM smoke test.
