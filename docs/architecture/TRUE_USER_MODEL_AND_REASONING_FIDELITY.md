# True User Model and Reasoning Fidelity

## Purpose

LifePlanSystem should collect enough evidence over time to build a high-fidelity model of a user's reasoning, values, preferences, constraints, communication patterns, decision patterns, and blindspots.

The goal is not to make every assistant sound like the user.

The goal is to make the system increasingly able to represent what is genuinely true about the user while remaining evidence-based, correctable, and non-sycophantic.

## Core principle

Do not build an imitation of the user.

Build an evidence-based model of how the user tends to think, decide, feel, communicate, and change their mind.

Prioritise:

- fidelity to evidence;
- fidelity to values;
- fidelity to reasoning patterns;
- fidelity to constraints;
- fidelity to correction history;
- fidelity to uncertainty.

Do not prioritise:

- copying wording;
- copying typos;
- always sounding like the user;
- always agreeing with past user opinions;
- treating old user beliefs as permanent truth;
- turning personality into a fixed identity cage.

## Model layers

### Language and communication style

Track, where useful:

- vocabulary;
- humour style;
- directness preferences;
- tolerance for bluntness;
- preferred explanation length;
- recurring phrases;
- sensitivity to tone;
- whether the user wants emotional reflection, practical action, or both.

### Reasoning style

Track:

- how the user tests claims;
- what evidence changes their mind;
- what assumptions they challenge;
- when they prefer systems over one-off fixes;
- when they prefer concrete examples;
- how they compare options;
- what they treat as meaningful uncertainty.

### Decision style

Track:

- repeated decision rules;
- trade-offs;
- risk tolerance;
- regret patterns;
- avoidance patterns;
- over- or under-estimation patterns;
- what kinds of actions actually get completed.

### Values and identity anchors

Track stable values only when evidence is strong.

Values should be reviewable, not frozen forever.

### Blindspots and calibration patterns

Track with care:

- repeated underestimation;
- repeated overestimation;
- catastrophising patterns;
- minimising distress;
- avoidance loops;
- over-focusing on one relief path;
- system-expansion traps;
- when good ideas become too large to act on.

## No forced mimicry rule

Future assistants do not need to sound like the user all the time.

Mimicry may be useful only for drafting messages in the user's voice, generating examples of phrasing, or checking whether a draft sounds unlike the user.

Mimicry should not replace judgement, impersonate the user, make decisions on the user's behalf, bypass uncertainty, or weaken anti-sycophancy.

## Failure modes

Avoid:

- building a caricature of the user;
- mistaking crisis-state behaviour for permanent identity;
- mistaking humour for literal belief;
- treating old memories as current without review;
- copying writing style while missing values and constraints;
- overfitting to recent chats;
- using the model to justify what the user wants in the moment;
- making the system less correctable.
