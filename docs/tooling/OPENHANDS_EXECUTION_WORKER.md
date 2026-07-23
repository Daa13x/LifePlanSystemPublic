# OpenHands Execution Worker / Local Coding Agent (first slice: dry-run / plan only)

This is the highest-risk layer, so the first version is **dry-run / plan only**.
It is a **gated local coding worker, not an autonomous agent**, and in this
version it does **not** edit code or invoke OpenHands at all. It exists to prove
every safety gate before any real code-editing executor is built.

## Flow

1. Request is created (Tooling panel) → `pending`.
2. A human **Approves** it → `approved` (runner gate 1).
3. A human gives a **second explicit confirmation** →
   `POST …/requests/:id/confirm-execution` records `executionConfirmed`.
4. A human runs the **execution plan (dry run)** →
   `POST …/requests/:id/execution-plan`. This evaluates every gate, writes a
   plan report, and sets status `execution-planned`. **No code is changed.**

## Safety gates (all evaluated before a plan is produced)

- `human_approval` — status must be `approved` (or already `execution-planned`).
- `second_confirmation` — `executionConfirmed === true` (distinct from approval).
- `allowed_paths_present` — the request must scope work to `allowedPaths`.
- `protected_path_scan` — no allowed/forbidden path may touch
  `source_of_truth/`, `memory/`, `.env`, `secrets/`, `data/`, `rules/`,
  `.git/`, `.lps/`, or `credentials`.
- `execution_branch_not_main_master` — a proven-local worker would use the
  controller-generated `local-agent/<id>` proposal branch from `main`.
- `execution_branch_available` — that branch must not already exist.
- `max_files_changed` — must be 1–5.
- `validation_command_allowlisted` — post-change validation must be
  `node --check server/index.js` or `npm run build` (exact match); arbitrary
  request commands are refused.

## What the dry run does NOT do

- Does not invoke OpenHands (no code is generated or applied).
- Does not create the worktree/branch, edit files, or run the validation.
- Never commits, pushes, merges, resets, deletes branches, force-pushes, or
  pushes to `main`/`master`.
- Never runs arbitrary request-supplied shell commands.

## OpenHands wiring (server-derived; request JSON can never override)

The future worker inherits LPS's configured local code endpoint, then its chat
endpoint, then a healthy bundled llama.cpp OpenAI-compatible endpoint. A
loopback hostname is translated to `host.docker.internal` only for a container.
OpenHands is optional and disabled by default; no Ollama-specific dependency or
credential is hard-coded.

The request cannot override the model endpoint, shell commands, protected
paths, or any Git operation.

## Report

Written to `.lps/tooling/openhands/reports/<id>.md`, including: request id,
proposed execution branch/worktree, changed files (none in dry run), diff
summary (none), validation output (planned only), refused/blocked actions,
protected-path scan result, max-files-changed result, and human next steps.

## Endpoints

- `POST /api/tooling/openhands/requests/:id/confirm-execution`
- `POST /api/tooling/openhands/requests/:id/execution-plan`

## Explicitly NOT in this version (future, separately-approved layers)

- Actually invoking OpenHands to generate/apply code inside the dedicated
  worktree.
- Running post-change validation on real changes.
- Any commit/push/PR — those remain manual, human-reviewed steps via the
  Source Control panel.

## Relationship to Agent Mode

- The OpenHands worker is an *implementation mechanism, not the brain*.
- Agent Mode proposals (see `docs/agent_mode/AGENT_MODE_STANDARD.md`) must still
  pass the OpenHands approval gates — they do not get a shortcut.
- Request approval, second execution confirmation, protected-path checks,
  allowlisted validation, the report, and human review all remain mandatory.
- Agent Mode does not bypass the Source Control panel gates for commit/push/PR.
