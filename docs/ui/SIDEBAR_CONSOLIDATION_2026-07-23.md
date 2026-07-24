# Sidebar consolidation

The application has five top-level destinations: Workboard, Chat, Knowledge, System, and Settings. The sidebar does not expose legacy panels as additional top-level destinations.

## Workboard

- **Overview** is the former Planner, renamed in its panel context only. It keeps planner refresh, add, review, and item actions.
- **Projects** retains project proposal and governed update flows.
- **Roadmap** retains the development-only roadmap and candidate scan.
- **Review** contains operational proposals only: tasks, projects, repository changes, workflows, agents, coding, and execution. It deliberately excludes memory updates and candidate promotions.
- **Completed** is a read-only index over existing done, archived, deprecated, superseded, completed-project, and done-roadmap records. It creates no copied records or migration.

## Knowledge

- **Memory** contains approved non-rule knowledge.
- **Candidates** is the only candidate-memory review location. It also lists governed changes to existing memory so neither category is silently lost.
- **Sources** displays the provenance and evidence already stored on memory and candidate records, and retains the existing Source Control workspace for repository provenance, history, and safe publication controls. Local coding runs are exposed from System/Runs instead of being duplicated here.
- **Rules** displays approved knowledge records with the `rule` type.
- **Calibration** retains the existing repository-backed calibration view.

The Candidates tab has a live badge based on pending/deferred candidate records. A matching badge appears on Knowledge in the main sidebar.

## System

- **Status** renders only the live bootstrap data already loaded by the app.
- **Repository** contains the existing repository proposal explorer.
- **Browser** and **Tools** retain their existing panels.
- **Runs** opens the existing source-control workspace on its Local Coding run view. The source-control tabs remain available as secondary controls, so no existing git or runner capability is removed.

## Compatible paths

Legacy paths normalize to the matching consolidated location: `/planner`, `/projects`, `/dev-roadmap`, `/approvals`, `/memory`, `/source`, `/calibration`, `/repository`, `/browser`, and `/tooling`. `/approvals?domain=memory` normalizes to Knowledge/Candidates; all other legacy approval links normalize to Workboard/Review.

There is no data migration. Existing SQLite records and API contracts remain the sources of truth.

## Verification

`npm run verify:navigation-consolidation` checks the exact primary and tab order, all legacy route mappings, canonical route generation, and memory versus operational approval routing. `npm run check` runs that verification and the production build.
