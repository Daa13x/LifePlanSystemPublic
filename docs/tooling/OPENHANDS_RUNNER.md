# OpenHands Approved Request Runner (first safe layer)

This is the **gated runner**, not an autonomous agent. It is the first execution
layer on top of the OpenHands Tooling request store (see
`OPENHANDS_REQUESTS.md`). It deliberately does very little, safely.

## What it does

1. A human **Approves** a stored request (`POST …/requests/:id/approve`). This
   records `status: "approved"`, `approvedBy`, and `approvedAt` — the explicit
   human approval the runner requires.
2. A human **Runs** the approved request (`POST …/requests/:id/run`). The runner:
   - refuses unless `status === "approved"`;
   - re-checks the mandatory protected-path block list against the request's
     `allowedPaths`;
   - runs **only** a command from a fixed allowlist;
   - snapshots the working tree before/after to measure files the run changed,
     and enforces `maxFilesChanged` against that real effect;
   - writes a report to `.lps/tooling/openhands/reports/<id>.md`;
   - sets `status` to `validated` or `validation-failed`.
3. The report is viewable via `GET …/requests/:id/report`.

## Validation allowlist (the only commands the runner may run)

- `node --check server/index.js`
- `npm run build`

A request's `testCommand` is honoured **only if it exactly matches** an allowlist
entry. Anything else is refused — the runner never executes arbitrary commands
supplied by a request. If no `testCommand` is given, it defaults to
`node --check server/index.js`.

## What it never does

- Never invokes OpenHands to edit code (no code changes are made by this layer).
- Never commits, pushes, merges, resets, deletes, force-pushes, or stash-pops.
- Never touches `source_of_truth/`, `memory/`, `.env`, `secrets/`, `data/`,
  `rules/`, `.git/`, `.lps/` contents beyond writing its own report, or
  credentials.
- Never runs on a request that is not explicitly approved.

## Endpoints

- `POST /api/tooling/openhands/requests/:id/approve`
- `POST /api/tooling/openhands/requests/:id/run`
- `GET  /api/tooling/openhands/requests/:id/report`

## Intentionally NOT in this version

- Actual OpenHands code execution against the request objective.
- Any commit/push/PR on a request's behalf (those remain separate manual,
  approved steps).
- Running validation inside an external `targetRepoPath` — the allowlisted
  commands run in the LPS workspace only.
