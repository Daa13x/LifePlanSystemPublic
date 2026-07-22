# OpenHands Task Requests

OpenHands (http://localhost:3000) is a **local worker, not the brain**. Life
Planner is the brain and approval gate. External agents (Claude, Codex,
ChatGPT) may *request* minor work, but nothing executes automatically:
requests are stored as review files and every gate is always on.

## How to submit a request

`POST http://127.0.0.1:4177/api/tooling/openhands/requests`

```json
{
  "title": "Fix stale README badge",
  "objective": "One focused change: update the CI badge URL in README.md.",
  "requestedBy": "claude",
  "targetRepoPath": "",
  "baseBranch": "main",
  "allowedPaths": ["README.md"],
  "forbiddenPaths": [],
  "testCommand": "npm run build",
  "maxFilesChanged": 1
}
```

Stored requests land in `.lps/tooling/openhands/requests/<id>.json` (gitignored,
never committed). Completed work reports belong in
`.lps/tooling/openhands/reports/<id>.md`.

## Fields the server adds/enforces

- `id`, `createdAt`, `status: "pending"`, `riskLevel`
- `requiresApprovalBeforeRun / BeforeCommit / BeforePush`: **always `true`**
  in this version regardless of input.
- `maxFilesChanged`: clamped to 1–5.
- `forbiddenPaths`: the mandatory block list is always appended.

## Hard blocks (requests are rejected, not stored)

- `allowedPaths` overlapping: `source_of_truth/`, `memory/`, `.env`,
  `secrets/`, `data/`, `rules/`, `.git/`, `.lps/`, `credentials`
- Titles/objectives that reference API keys, tokens, passwords, or secrets.

## Minor work definition

One focused objective; max 3–5 files; no DB migrations, no source_of_truth or
memory edits, no .env/secrets edits, no public/private boundary changes; must
run tests/build; must produce a report before any commit/push is considered.

## What is intentionally NOT automated yet

- Executing requests through OpenHands (no approval-queue-driven runner yet).
- Installing or updating OpenHands.
- Any commit/push on behalf of a request.

## Model wiring (for a future OpenHands worker)

OpenHands is optional, disabled by default, and does not trigger Docker or model
probes until explicitly enabled. Its future model configuration is derived by
the server from LPS settings in this order:

1. `localCodeModelEndpoint` and `localCodeModelName`;
2. the configured chat endpoint and model;
3. the healthy bundled llama.cpp OpenAI-compatible endpoint.

Loopback hosts are translated to `host.docker.internal` only when producing a
container-facing configuration. Requests cannot supply or override the model,
endpoint, or credential. Do not reintroduce an Ollama-specific dependency.
