# UI Product Spec

## Goal

Create a control-centre UI for a repo-backed AI planning/memory system.

The UI should make the repository usable without requiring the user to manually browse GitHub files all the time.

## Primary screens

### Planner

Dashboard for:
- today's focus;
- blockers;
- waiting on user;
- next best action;
- stale/drifting items;
- day plan.

### Chat

A repo-grounded chat interface.

Required:
- show files used;
- distinguish source-of-truth from inference;
- allow staged proposals;
- do not silently edit repo.

### Memory Review

Shows items by lifecycle:

- New;
- Needs Review;
- Reviewed;
- Promoted;
- Archived;
- Superseded.

### Approval Queue

Shows proposed changes waiting for approval.

Each item should include:
- proposed change;
- target file;
- source;
- confidence;
- risk level;
- approve/reject/edit.

### Repository Explorer

Browse key Markdown files.

Features:
- search;
- recent files;
- preview;
- links between files;
- commit history links.

### Reasoning / Calibration

Shows:
- current hypotheses;
- confidence by domain;
- known blindspots;
- advice usefulness;
- user corrections.

### Settings / Model Selector

Controls:
- model provider;
- local model status;
- context window;
- repo access mode;
- write mode;
- privacy mode;
- theme.

## MVP

Build the smallest useful version:

1. Repo connection.
2. File browser.
3. Dashboard counts.
4. Chat with selected files.
5. Staged proposal output.
6. Manual approval/commit flow.

Do not start with complex agent orchestration.
