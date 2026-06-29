# System Architecture

## Purpose

LifePlanSystem is a Markdown/Git-backed personal operating system and AI coordination layer.

The system stores durable knowledge in a repository and uses AI models to help review, prioritise, plan, and propose updates.

## Main layers

```text
1. User Interface
2. AI Orchestration / Model Adapter
3. Repository Access Layer
4. Markdown Knowledge Base
5. Approval / Commit Layer
```

## 1. User Interface

The UI should provide:

- planner dashboard;
- chat grounded in files;
- memory review;
- approval queue;
- repository explorer;
- reasoning/calibration view;
- model selector/settings.

## 2. AI Orchestration

AI should be used for:

- summarising;
- ranking;
- extracting memory;
- drafting proposals;
- reviewing stale items;
- comparing evidence;
- creating plans.

AI should not silently edit canonical records.

## 3. Repository Access

The app may use:

- GitHub API;
- local git clone;
- filesystem access;
- hybrid local cache.

The repo remains canonical.

## 4. Markdown Knowledge Base

Suggested folders:

```text
rules/
docs/
templates/
source_of_truth/
source_of_truth/memory/
```

## 5. Approval / Commit Layer

Every meaningful change should show:

- target file;
- proposed diff;
- reason;
- risk level;
- source/provenance;
- approve/reject/edit controls;
- final commit SHA if committed.
