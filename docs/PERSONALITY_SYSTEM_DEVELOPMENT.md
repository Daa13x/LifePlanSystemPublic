# LifePlanSystem Personality System — Development Plan

Status: Stable profile and bounded local behaviour wiring implemented; adaptation and provider-wide identity remain planned
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

## 2. Current implementation

The first durable profile is now represented as structured data rather than a single prose prompt.

### IMPLEMENTED — bounded behaviour and capability selection

The default profile now affects a small deterministic decision policy in `server/chatIntent.js` after explicit commands and established natural-language intents have had first refusal. High inquisitiveness, practicality and resource-consciousness can select one smallest relevant registered read; high scepticism can select one evidence check or state uncertainty when no relevant authorised read exists.

Current personality-selected reads reuse the universal action registry:

- `planner.today` for Today questions and Planner completion verification;
- `system.runs` for the latest-run failure question;
- `workboard.list` for current project progress evidence;
- `knowledge.search` for one approved-evidence check of a confident implementation claim.

The trusted invocation source is `personality-reasoning`. It has an explicit four-action allowlist. It cannot call proposal, navigation, cloud, repository, or write actions. The action registry remains the permission/risk/confirmation owner.

The result returns in the same assistant turn. Assistant metadata and `chat_audit` record the invocation source, selection reason, action ID, risk, confirmation requirement, verification flag, result, and correlation ID without exposing noisy traces in normal Chat.

### IMPLEMENTED — authority and evidence boundaries

- Consequential phrasing such as task creation is excluded from personality execution and continues through the existing proposal → Allow/Decline → receipt flow.
- `Add buy milk to today.` is supported by the existing Planner proposal action; it is not a silent write.
- Confident unsupported crash-causation claims are not mirrored. Chat states that Windows event/dump evidence is required because no registered Chat crash-diagnostic read currently exists.
- Today now returns five compact recent-completion identities from the existing Planner aggregation so a completion claim can be checked without a new capability.
- Recent run summaries can carry a bounded existing failure/readiness reason and report path when the authoritative run request contains them.

### IMPLEMENTED — behavioural regression proof

Focused pure, HTTP/SQLite and rendered-browser tests cover inquisitive retrieval, sceptical verification, casual-chat no-call behaviour, insufficient evidence, one-call routing, write confirmation, all current task-mode compositions, consultation context continuity, correlated audit metadata, and same-turn result continuity.

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

## 5. PLANNED — editable personality profile

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

## 6. PLANNED — revisions and experimentation

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

## 7. PLANNED — user adaptation

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

## 8. PARTIAL — behavioural evaluation

Personality is now tested by behaviour rather than only by checking prompt text. Deterministic fixtures cover the dominant traits and authority boundary. Broader model-evaluated tone/recognisability evaluation remains planned.

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

## 9. PARTIAL — trait interaction testing

Single-trait testing is not enough. The implemented selector already requires inquisitive + practical + resource-conscious thresholds for proactive reads, which prevents high curiosity from becoming fan-out. Broader interaction evaluation remains planned.

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

## 10. DEFERRED — provider-agnostic identity

The local Planner Assistant and every current task mode compile the stable profile. The long-term target is for the same LPS personality to survive changes in the underlying model. External/provider prompt compilation remains deferred because it must reuse the existing reviewed privacy/egress and spending boundaries rather than silently transmitting identity or context.

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

1. Keep the database-backed profile, bounded decision policy, action-registry and rendered Chat verifiers green.
2. Add a read-only Personality view in Settings.
3. Add explicit edit/save/reset controls with revisions.
4. Separate stable core from per-user communication preferences.
5. Add feedback-driven evaluation before any automatic adaptation.
6. Extend the compiled identity consistently across eligible provider routes only through reviewed egress/spending authority.
7. Measure whether users can recognise the LPS identity across different models.

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
