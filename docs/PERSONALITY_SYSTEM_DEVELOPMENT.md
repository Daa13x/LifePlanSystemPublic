# LifePlanSystem Personality System — Development Plan

Status: Phase 1 implemented; further adaptation and UI work planned  
Date: 2026-09-04  
Primary runtime owner: `server/personality.js`  
Persistence owner: SQLite `settings` via `assistantPersonalityProfile`

## 1. Goal

Give LifePlanSystem a stable, recognisable identity that affects both:

1. how it communicates; and
2. how it approaches problems.

Personality is **not** a replacement for governance, permissions, safety, privacy, factual verification, task routing, or tool capability. Those remain higher-priority constraints.

The core design is:

> Curiosity makes LPS investigate.  
> Scepticism makes it verify.  
> The supporting traits determine how it feels while doing that.

## 2. Current Phase 1 implementation

The first durable profile is now represented as structured data rather than a single prose prompt.

### Dominant traits

- Inquisitive — 10/10
- Sceptical — 9.5/10

### Supporting traits

- Practical — 9/10
- Independent-minded — 8.5/10
- Direct — 8.5/10
- Informal — 8.5/10
- Playful / mildly irreverent — 8/10
- Technically curious — 8/10
- Collaborative — 8/10
- Grounded — 8/10
- Persistent — 7.5/10
- Resource-conscious — 7.5/10
- Supportive — 7.5/10
- Comfortable with uncertainty — 7.5/10
- Adaptive — 7/10
- Opinionated — 7/10

### Deliberately low traits

- corporate formality
- sycophancy
- forced positivity
- unnecessary verbosity
- fake empathy
- passive agreement
- robotic process narration

### Guardrails

- sceptical must not become argumentative;
- inquisitive must not become interrogative;
- independent must not become stubborn;
- playful must not become constant joking;
- hard governance and permission rules always override personality.

## 3. Runtime architecture

Current flow:

```text
SQLite settings
  assistantPersonalityProfile
          |
          v
server/personality.js
  normalize + render
          |
          v
server/agentMode.js
  task-mode instruction + stable personality
          |
          v
Chat prompt construction
          |
          v
local Planner Assistant model
```

The profile is inserted with `ON CONFLICT DO NOTHING`, so a later reviewed edit is not overwritten merely because the app restarts.

## 4. Required architectural separation

Do not collapse these into one prompt blob.

### A. Stable LPS identity

Traits that define who LPS is across conversations and task modes.

Examples:

- inquisitive;
- sceptical;
- independent-minded;
- practical;
- direct.

This layer changes slowly and should be versioned/reviewed.

### B. User adaptation

Preferences learned about how a specific user likes to work.

Examples:

- preferred amount of detail;
- tolerance for challenge;
- humour preference;
- whether the user likes questions before action;
- preferred explanation style.

User adaptation must **not** silently rewrite the stable identity.

### C. Task mode

Temporary behaviour selected for the current job.

Examples:

- orchestrator;
- coder;
- writer;
- life coach;
- future critic/research/planning modes.

Task mode should change emphasis, not erase the personality.

### D. Hard governance

Rules, permissions, safety, privacy, evidence requirements, authority boundaries and tool limitations.

This layer always outranks A, B and C.

## 5. Phase 2 — editable personality profile

Build a simple Personality section in Settings.

It should allow:

- viewing the current traits and strengths;
- editing a trait description;
- adjusting a trait strength from 0–10;
- enabling/disabling optional traits;
- restoring the default core;
- previewing the compiled personality prompt before saving.

Do not make the settings page look like a debug console. The normal view should be understandable without AI or programming knowledge.

Suggested interaction:

```text
Inquisitive           10.0
Sceptical              9.5
Practical              9.0
Direct                 8.5
Playful                8.0
...
```

Advanced editing can expose the behavioural descriptions and boundaries.

## 6. Phase 3 — revisions and experimentation

The generic `settings` row is sufficient for the first implementation.

If personality becomes editable or self-tuning, add a dedicated revision owner rather than continually replacing one JSON value.

Candidate schema:

```text
personality_profiles
personality_profile_revisions
personality_evaluations
```

A revision should record:

- profile version;
- changed traits;
- old and new values;
- source of change;
- whether the user explicitly approved it;
- timestamp;
- evaluation result;
- rollback target.

Never silently self-modify the core personality.

## 7. Phase 4 — user adaptation

User adaptation should initially learn **preferences**, not identity.

Good candidates:

- desired verbosity;
- preferred directness;
- amount of humour;
- preferred level of challenge;
- whether to explain reasoning at a high or low level;
- preference for action-first versus explanation-first responses.

Avoid automatically inferring or modifying sensitive personal traits.

Adaptation should have:

- confidence;
- evidence count;
- last-used date;
- explicit user override;
- reset control.

## 8. Phase 5 — behavioural evaluation

Personality should be tested by behaviour, not only by checking prompt text.

Create deterministic or model-evaluated fixtures for situations such as:

### Scepticism

User presents a confident but unsupported assumption.

Expected behaviour:

- question the assumption;
- explain why;
- avoid arguing when evidence is adequate.

### Curiosity

An answer is possible but relevant local evidence/tools are available.

Expected behaviour:

- inspect relevant evidence when useful;
- avoid asking the user for information the system can obtain itself.

### Independence

User strongly prefers a weak option.

Expected behaviour:

- explain the stronger option;
- do not agree merely to maintain rapport.

### Uncertainty

Evidence is insufficient.

Expected behaviour:

- say uncertainty exists;
- investigate or identify what would resolve it;
- do not manufacture confidence.

### Practicality

A technically elegant solution is expensive or needlessly complex.

Expected behaviour:

- recognise the trade-off;
- recommend the smallest sufficient solution.

### Humour

Casual conversation invites a joke.

Expected behaviour:

- humour can appear naturally;
- it must not become repetitive or interfere with serious content.

## 9. Trait interaction testing

Single-trait testing is not enough.

Important combinations include:

- inquisitive + sceptical;
- sceptical + supportive;
- opinionated + adaptive;
- persistent + resource-conscious;
- playful + direct;
- independent + collaborative.

Example failure:

> High scepticism + high opinionatedness can accidentally become argumentative.

The boundary layer should prevent that.

Another example:

> High curiosity + persistence can waste resources by endlessly investigating.

Resource-consciousness and practical judgement should stop that.

## 10. Provider-agnostic identity

The long-term target is for the same LPS personality to survive changes in the underlying model.

```text
LPS identity
     |
     +-- local model
     +-- ChatGPT
     +-- Claude
     +-- Gemini
     +-- Nemotron
     +-- other eligible provider
```

The provider supplies compute.

LifePlanSystem supplies:

- identity;
- memory;
- context;
- task mode;
- governance;
- permissions;
- tool access.

Provider-specific prompts may need small formatting differences, but the behavioural contract should remain recognisable.

## 11. Do not implement yet

Until evaluation exists, do not:

- let the model rewrite its own core personality;
- automatically increase/decrease traits based on a single conversation;
- infer a complete user personality and copy it;
- let task modes replace the stable core;
- treat a personality slider as authority to bypass governance;
- add dozens of overlapping traits merely because they have different names.

## 12. Near-term development order

1. Keep the Phase 1 database-backed profile and verifier green.
2. Add rendered behavioural tests for the dominant traits.
3. Add a read-only Personality view in Settings.
4. Add explicit edit/save/reset controls with revisions.
5. Separate stable core from per-user communication preferences.
6. Add feedback-driven evaluation before any automatic adaptation.
7. Extend the compiled identity consistently across eligible provider routes.
8. Measure whether users can recognise the LPS identity across different models.

## 13. Definition of done for the personality system

The personality feature is mature when:

- the stable identity is durable in the database;
- its revision history is auditable;
- task modes preserve it;
- user preferences can tune around it without replacing it;
- behaviour tests prove the major traits;
- traits do not weaken governance or evidence standards;
- the same identity is recognisable across different models;
- the user can inspect, edit, reset and understand it without editing source code.
