# Chat Draft → Verify → Accept Spec

Status: active design, first slice implemented 2026-07-03.

## What normal Chat is

Normal Chat (the Chat tab) is the main brain-aware chat interface for Life Planner.
It is not a separate consultation tool: the same page where Alex types is the page
that can read safe LifePlanSystem brain context, route the question to the best
available provider, and show clearly labelled answers.

## The pattern: draft → verify → accept

Chat uses a draft → verify → accept pattern inspired by DSpark, adapted to the
message/memory level.

Important wording: Life Planner does **not** implement DSpark token-level
speculative decoding. It borrows the architectural pattern only:

1. **Local/fast draft** — a local model (or a cheap heuristic) produces a first
   draft, shapes the prompt, or extracts context.
2. **Confidence/usefulness filtering** — weak or low-value drafts are filtered
   before anything expensive or external runs.
3. **Stronger verification** — a stronger provider (ChatGPT via the browser
   connector today; others later) answers or verifies.
4. **Accepted output** — only output that survives review becomes durable.

## Roles

- **Local model (Planner Assistant)** can act as drafter, checker, and private
  brain. It is the only provider that may receive unrestricted private context.
- **ChatGPT via browser connector** acts as cloud answerer/verifier when
  available. It receives only the safe, allowlisted, size-capped brain excerpts.
- **Local model verifying cloud output** (future): the local model can later
  verify/distill cloud answers before they are shown or saved.

## Memory governance (hard rules)

- Candidate memories must be reviewed before becoming brain truth.
- Cloud outputs are suggestions, not source-of-truth.
- Life Planner may find what is worth saving; **Alex decides what becomes brain
  truth**. Nothing is promoted into memory, source_of_truth, or private files
  without explicit approval.
- Approval-driven sync into private source-of-truth files is design-only for now
  (see CHAT_APPROVAL_CARDS_SPEC.md); no automatic writes exist.

## Current implemented slice (2026-07-03)

- Chat loads safe brain context from a configured brain root (allowlist +
  character budgets, no traversal, no secrets).
- Chat routes to ChatGPT through the existing Chrome connector when the
  connector is fresh and Temporary Chat is confirmed; otherwise it falls back to
  the local model, and finally to a clear setup message.
- Every assistant message stores provider metadata (see CHAT_METADATA_SCHEMA.md)
  and the UI labels who answered.
- Save-worthy points become readable memory candidates in the existing review
  queue. They never write to private files.
