# ATTACHMENT — MostlyArmless context for Life Planner (2026-07-04)

From the MostlyArmless (MA) workspace, for LPS agents to read before their next pass.
MA is the sibling project: a local-first LCARS ship AI (D:\_Code_\Serenity). LPS and MA
share a Captain, a machine, and several hard-won lessons. This document carries the ones
that transfer.

## 1. Architecture direction the Captain has set for BOTH projects

These arrived as Captain directives on 2026-07-04 (canonical copies live in MA's brain.db
SystemDocs: `plan:continuity_exports`, `plan:knowledge_packets_and_db_evolution`).

**Knowledge/training split.** Knowledge (facts, provenance, Q&A reference, docs, history)
and behaviour training are different things — do not blur them. LPS already models this
well: `knowledge_items` + governed `approvals` is exactly the right shape. Keep knowledge
as first-class objects with provenance/confidence/tags; never flatten it into prompts.

**Context Objects.** Large text (code, documents, chat exports, reports) should be
referenced as structured objects, not pasted inline into prompts. A large request to a
cloud agent = short precise prompt + attached context packet — not a giant fragile paste.
LPS's chat context-file mechanism is the seed of this; grow it.

**Continuity exports.** Every system should be able to export a small portable bundle
(philosophy / history / current state) that lets a completely fresh AI session recover
project continuity without a thousand lines of pasted conversation. MA is building a
3-PDF pack (CORE / ChatStreams / CurrentState). LPS should aim for the same property:
its own docs/handoffs folder is halfway there — formalise "what/why", "what happened",
"where are we today".

**PostgreSQL horizon.** For long-running agent workflows with concurrent readers/writers,
SQLite eventually binds. The Captain's ruling: document the migration path now, migrate
gradually (side-by-side, one subsystem at a time, never delete until verified), no
big-bang rewrite. LPS is younger and smaller — it can adopt the schema discipline early
(IDs + provenance preserved, ownership per table documented).

## 2. Engineering lessons paid for in MA (the disease catalog, transferable subset)

MA keeps a 15-entry "disease catalog" of failure patterns. The ones LPS is most exposed to:

- **Lazy singleton**: a service registered but never constructed — feature looks wired,
  never runs, no errors. Cure: eager-resolve at boot; a "never worked + no errors" bug is
  this until proven otherwise.
- **Fake green**: UI reports success from an intermediate step (job queued, file written)
  rather than the outcome. Cure: report done only on runtime evidence of the outcome;
  failure restores the previous good state.
- **Silent swallow**: `catch {}` around the only place an error would have told the truth.
  Log every catch that crosses a feature boundary.
- **Dead-air blocking**: long operations with no progress surface. LPS's browser consult
  flow already streams status — keep that standard for model downloads and planner refresh.
- **Stale-as-fresh**: never render cached/stale state without an age marker. If a poll
  fails, say LINK LOST; don't keep painting the last snapshot as current.
- **Prompt-echo capture** (browser agents — LPS found this one first and MA adopted the
  fix): when scraping an assistant reply, slice off the echoed prompt, filter status text
  ("Thinking…"), scope reads to turns created after send, and never fall back to stale
  page text on assistant-rendered pages.

## 3. Training lesson that generalises to any local fine-tune LPS attempts

If LPS ever fine-tunes a local model on its own data: **mask the prompt from the loss**.
MA burned four training runs on one symptom (word-salad output) with four distinct root
causes: wrong chat template for the base family; mid-sentence truncation (seq len too
small); training on a stub prompt while production sends a 4KB one; and finally labels ==
input_ids over the whole sequence, which taught the model to memorise its own system
prompt (98% of gradient was prompt text). Completion-only loss + verifying the model
below the app with the production prompt is the only setup that survived.

## 4. Coordination

- MA's browser-agent extension (MA-Browser Control) and LPS's connector solve the same
  problem; capture hardening lessons flow both ways via handoff docs. Reference only —
  each project rewrites natively, no code copy-paste.
- LPS installers are analysed from D:\MA-Updates (`LifePlannerPortableSetup-<date>.exe`).
- A reference copy of MA's Source Control panel (LCARS git UI) ships alongside this
  attachment: `docs/attachments/ma-source-control/` — see its README for the endpoint
  contract if LPS wants a richer Source tab.
