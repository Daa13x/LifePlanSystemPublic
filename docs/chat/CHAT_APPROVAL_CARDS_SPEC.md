# Chat Approval Cards Spec

Hard rule: **Life Planner may find what is worth saving. Alex decides what
becomes brain truth.** Nothing reaches memory or source-of-truth without an
explicit approval action.

## What a candidate approval card must show

Cards render from `memory_candidates` rows. A card is readable when Alex can
decide in under ~15 seconds without opening anything else. Required fields:

| Field | Backed by | Notes |
|---|---|---|
| Short title | `title` | One line, no truncated blobs. |
| Type | `type` | fact / preference / decision / decision rule / risk / open question / TODO / design rule / source idea / consultation. |
| Plain-English summary | `body` | The exact proposed memory text, not a transcript dump. |
| Why it might matter | `evidence` | One or two sentences. |
| Source | `evidence` / `session_id` / `source_message_id` | Conversation or file it came from. |
| Speaker | `speaker_label` | Alex / Guest / Unknown. |
| Confidence | `confidence` | 0–1, shown as %. |
| Sensitivity | `sensitivity` | `normal` or `sensitive` (health, money, people). Sensitive items should default to private-only handling. |
| Provider | `provider` | Who generated/verified it: `chatgpt_browser`, `local_planner_assistant`, `chat` (heuristic), etc. |
| Suggested destination | `suggested_destination` | Proposed brain file, e.g. `source_of_truth/decision_rules.md`. Suggestion only — no writes. |
| Proposed edit | `body` (+ future diff) | The exact text that would be appended if approved-and-synced (future). |
| Risks / uncertainty | `evidence` | Anything the reviewer should doubt. |
| Current status | `status` | candidate / deferred / approved / denied. |

## Approval actions

| Action | Today | Effect |
|---|---|---|
| Reject | implemented (`deny`) | Candidate marked denied. Nothing saved. |
| Keep as candidate | implemented (`defer`) | Stays in queue for later. |
| Edit wording | implemented (PATCH candidate) | Alex edits title/type/body/evidence/confidence before deciding. |
| Approve as memory | implemented (`approve`) | Becomes an active `knowledge_items` row in the local app database only. |
| Approve as TODO | design only | Future: approve with type `todo`, destination `docs/ACTIVE_TODO.md`. |
| Approve as open question | design only | Future: approve with type `open question`, destination `source_of_truth/open_questions.md`. |
| Approve and sync to source-of-truth | **design only — gated, not implemented** | See flow below. |

## Future approval-driven sync flow (design only, no writes today)

```
chat / source / observation
        ↓
candidate memory (memory_candidates row)
        ↓
approval card (this spec)
        ↓
Alex approves / edits / rejects
        ↓
approved item becomes a proposed safe file edit (exact diff shown)
        ↓
atomic append/write + backup of the target file
        ↓
audit trail entry (who approved, when, source candidate id)
        ↓
optional private Git commit, only when Alex approves the commit
```

Sync edit rules (all mandatory before any implementation):

- Only approved items can become durable brain edits.
- Source-of-truth promotion requires explicit, separate approval ("Approve and
  Sync" is never the default button).
- Writes must be path-confined to the configured brain root allowlist.
- Append-only where possible; never rewrite whole files.
- Atomic write pattern (write temp file, rename over target).
- Backup before modifying important files.
- Preserve existing formatting.
- Record provenance (candidate id, provider, conversation).
- Report the exact diff/change before and after approval.

## Current implementation notes (2026-07-03)

- Candidates are created from chat exchanges by a small heuristic extractor
  (`extractApprovalCandidates` in server/index.js) and stored only in the local
  app database. No private file is read for this and no file is written.
- The Memory and Approvals tabs render the card fields above; new columns
  (`speaker_label`, `provider`, `suggested_destination`, `sensitivity`) are
  nullable so legacy candidates still render.
