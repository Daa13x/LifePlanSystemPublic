# Agent Mode Standard

Status: governance/scaffolding only. **Docs and schema first; executable
behaviour later, and only through separate, explicitly-approved PRs.**

## Purpose

Describe how LifePlanSystem may, in the future, propose and implement its own
improvements **safely** — as a human-gated self-improvement *proposal* system,
never an autonomous self-modifying AI. This document exists so the governance
is written down and reviewed **before** any executable skill-builder exists.

## Scope

- Defines the Agent Mode lifecycle, permission tiers, and approval gates.
- Defines record/manifest schemas (capability gaps, skill manifests, registry).
- Describes how a future executor relates to the existing OpenHands worker and
  the Source Control panel.

Out of scope (this document changes none of it): server behaviour, API routes,
UI, model invocation, memory, or `source_of_truth`.

## Non-goals — Agent Mode must NOT mean

- AI edits itself without approval.
- AI modifies `source_of_truth` directly.
- AI promotes memory automatically.
- AI enables new tools without approval.
- AI commits generated code automatically.
- AI pushes automatically.
- AI merges automatically.
- AI grants itself new permissions.
- AI writes private memory unless explicitly approved.

## Human-gated lifecycle

```
capability gap detected
→ proposal created                 (capability_gap record; no execution)
→ plan generated                   (dry-run plan; reuse execution-plan gate)
→ USER APPROVAL                    (explicit, per item)
→ safe branch/worktree implementation  (isolated; invocation still gated)
→ tests / protected-path checks    (allowlisted validation; enforce real diff)
→ diff / report                    (full diff preserved for review)
→ HUMAN REVIEW                     (a person reads the diff)
→ optional PR / merge gate         (via the gated Source Control panel)
→ optional skill registry entry    (status flips to approved only by a human)
→ memory candidate to INBOX        (only if explicitly approved; never auto)
```

Every arrow that produces or activates code or memory is a human gate. Models
may **draft and plan**; they may not self-activate.

## Permission tiers

| Level | Capability | Confirmation |
|---|---|---|
| 0 | Chat / planning only | none |
| 1 | Read public/project docs | none |
| 2 | Write sandbox/worktree only | gated at creation (approval + 2nd confirmation) |
| 3 | Run allowlisted validation commands | allowlist only |
| 4 | Browser/app control | **explicit per-action human confirmation** |
| 5 | Memory / source_of_truth candidate handling | **explicit per-action human confirmation; append/candidate-only, never auto-promote or in-place rewrite** |
| 6 | OS/device control | **explicit per-action human confirmation — OUT OF SCOPE for now** |

Levels 4–6 require explicit per-action human confirmation. **Level 6 is out of
scope for now.** Any level that can affect state outside a disposable worktree
(4, 5, 6) is a per-action grant, never a standing one.

## Approval gates

- **Gate 1 — request approval:** a human approves a proposal/request.
- **Gate 2 — second execution confirmation:** a separate, explicit confirmation
  before any implementation step.
- **Gate 3 — human diff review:** a person reads the produced diff/report.
- **Gate 4 — commit/push/PR/merge:** performed only through the gated Source
  Control panel, each a separate human action.
- **Gate 5 — registry activation:** a skill is inert until a human sets its
  manifest `status: approved` and `runtime_enabled: true` (future).
- **Gate 6 — memory promotion:** a candidate reaches INBOX only if explicitly
  approved; nothing is promoted to `source_of_truth` automatically.

Push, PR, and merge are always **separate** approvals — one never cascades into
the next.

## Relationship to the OpenHands executor

The OpenHands worker is an *implementation mechanism*, not the brain. A future
Agent Mode plan would be carried out by the gated worktree executor, which:
runs in an isolated worktree on a dedicated `openhands/exec-<id>` branch (never
`main`/`master`), enforces allowed/forbidden/protected paths and
`maxFilesChanged` against the real diff, runs only allowlisted validation, and
writes a report. **Real OpenHands invocation is currently OFF** and must stay
OFF until the 7 documented blockers are fixed on a separate approved branch.
Agent Mode scaffolding does not authorize execution.

## Relationship to the Source Control panel

Agent Mode never commits, pushes, merges, or force-pushes on its own. All
version-control actions go through the existing Source Control panel gates
(explicit push confirmation, main/master refusal, `--ff-only` pull, no
destructive actions). Agent Mode does not bypass those gates.

## Relationship to memory / source_of_truth

Agent Mode may *propose* memory candidates. It never writes `source_of_truth`,
never rewrites memory in place, and never auto-promotes. Approved candidates go
to the memory INBOX for human review only, and only when explicitly approved.

## What is not built yet

- No runtime skill loader or executable skills system.
- No new API routes, model/tool invocation, or UI wiring.
- No auto-commit/push/merge, no memory-promotion, no `source_of_truth` writes.
- The registry (`registry.example.yaml`) is **non-executable example
  documentation**, not read by any runtime code.

## Future work (separate PRs only)

- Wiring capability-gap and skill records into a review-only store.
- A registry that runtime code consults — only after the manifest schema and
  activation gates are reviewed and approved.
- Enabling the real executor (after its 7 blockers are fixed).

## Hard rule

**Docs/schema first; executable behaviour later, and only through separate PRs
that each pass their own approval gate.** This document confers no runtime
capability.
