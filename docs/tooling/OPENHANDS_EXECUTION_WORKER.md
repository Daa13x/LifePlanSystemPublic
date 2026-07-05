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
- `execution_branch_not_main_master` — work would use a dedicated branch
  `openhands/exec-<id>`, never `main`/`master`.
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

## OpenHands wiring (fixed; request JSON can never override)

- Model: `openai/qwen2.5-coder:14b-gpu`
- Base URL: `http://host.docker.internal:11434/v1`
- API key: `dummy` (Ollama ignores it; no real key is stored)

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
