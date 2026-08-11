# Reaver UI and Browser Harness Handoff — 2026-08-11

## Checkpoint purpose

This is a bounded implementation checkpoint, not a blanket UI sign-off. The request was to audit LPS displays and settings for drift, placeholders, and faulty wiring, comparing the browser extension with Serenity only where a capability earned its place. Concrete defects were repaired; resume the evidence-first audit rather than assume every surface is finished.

The durable procedure is the LPS-specific Reaver skill at `docs/agent_mode/skills/reaver-mode/SKILL.md`. It requires observable evidence, functional tracing, and an explicit keep, repair, defer, or remove decision. It does not prescribe copying Serenity controls or wording.

## Git authority

Work began on synchronized `main` through `npm.cmd run policy:agent-start`. No branch, worktree, force push, or AI attribution is permitted. Before follow-up work, repeat `npm.cmd run policy:agent-start`, `npm.cmd run policy:cloud-main`, and `git status --short --branch`; this handoff is not synchronization proof. Only one write-capable cloud agent may use this checkout at a time.

## Completed changes

### Local coding-controller evidence gate

`server/nativeCodingWorker.js` now treats a final model proposal as an assessment, not authority. Final responses must declare `action: "propose_edits"`, numeric `confidence` from 0 to 1, and meaningful `evidence_basis`. The worker stores action, confidence, evidence basis, source references, and evidence hash in its ledger. It ends in `needs-evidence` below 0.70 confidence before any isolated edit is applied. The console exposes the assessment and lets an operator run again with evidence or reject it. Legacy records show confidence was not captured instead of falsely rendering 0%.

Coverage and documentation: `scripts/verify-native-coding-worker.mjs`, `scripts/verify-browser-assisted-coding.mjs`, and `docs/handoffs/HANDOFF_2026-08-02_LOCAL_CODING_OPERATIONAL_LOOP.md`.

### Browser extension improvements that earned their place

The LPS extension formerly depended on service-worker polling alone; MV3 suspension could leave local bridge status stale. It now has a small popup and alarm wake-up path. `manifest.json` declares popup and alarms permission; `background.js` schedules and handles the poll alarm on install/startup and exposes internal status; `popup.html` and `popup.js` show bridge reachability, bridge URL, last successful poll, supported LPS tabs, a real refresh action, and Chrome extension management.

The scope is deliberately narrow: no secret display, remote-control surface, second settings model, Serenity branding, or copied controls. `scripts/verify-browser-extension-install.mjs` verifies assets and manifest/runtime contract.

### UI reality repairs

The System Runs view now renders the controller evidence ledger. Browser Consultation uses provider-neutral language instead of promising a ChatGPT response. Two disabled non-functional promise controls were removed. Disabled primary/danger controls now use visibly neutral styling rather than resembling actionable primary controls. `scripts/verify-ui-reality.mjs` guards these contracts.

### Repository source-list correctness

The file-list route previously showed protected/private directories that its editor would refuse. `server/index.js` now applies the same protected-path predicate while enumerating and skips symlink entries. `server/sourceControlSafety.js` recognizes `.agent`, `.agents`, `source_of_truth`, and `rules` as protected segments. `scripts/verify-source-control-safety.mjs` and `scripts/verify-source-control-api.mjs` cover the predicate and disposable live API behavior; the latter cleans fixtures before its existing clean-status checks.

### LPS Reaver Mode skill

The new Reaver Mode skill was scaffolded with the standard skill creator and rewritten for LPS. Its loop is: inventory the surface, make a reproducible observation, trace UI to state/API, classify the finding, repair verified defects, add proof, and report remaining unknowns. It lives in `docs/agent_mode/skills/reaver-mode/`, is indexed in `docs/agent_mode/AGENT_MODE_DOCS_INDEX.md`, and includes `agents/openai.yaml`. The LPS skill verifier now accepts nested YAML metadata as well as legacy top-level fields.

## Evidence observed

These passed during this checkpoint and should be rerun after later edits: syntax checks for `server/nativeCodingWorker.js` and `server/index.js`; `verify:native-coding-worker`; `verify:browser-assisted-coding`; `verify:browser-extension-install`; `verify:source-control-safety`; `verify:source-control-api`; `verify:ui-reality`; `verify:lifeskillsystem-skills`; `npm.cmd run build`; and `git diff --check`.

The runtime safety suite also completed with loop-evaluate HTTP checks passing. It is rerun in this checkpoint’s final validation because controller safety and UI contracts changed. Browser inspection used a disposable local API database and Vite process; those processes are test infrastructure, not deployment evidence. The captured UI observations are retained under `output/playwright/` as five dated checkpoint screenshots: System Runs, a legacy-ledger state, Settings, Browser Consultation, and Browser disabled-state treatment.

## Next audit queue

1. Exercise every visible System, Knowledge, Workboard, Chat, and Browser control in a clean local session. Capture a screenshot, state transition, and API/store path before deciding whether it is real.
2. Search for residual placeholder language, disabled controls, hard-coded default displays, and optimistic success copy. Trace source and refresh behavior rather than trusting the label.
3. Compare settings controls to persisted state and runtime consumers. Remove controls with no supported behavior; wire only controls with a clear owner, persistence, and observable effect.
4. Evaluate extension ideas against the local-only bridge contract. Keep additions only when they improve visibility, reliability, accessibility, or recovery of an existing LPS workflow.
5. Add the smallest durable verifier for every repair: direct contracts plus a browser observation when the state is user-visible.

## Release closeout

Before a later checkpoint is claimed complete, run the required validations, build with `scripts/build-installer.ps1`, copy the verified installer to `D:\MA-Updates\LifePlannerPortableSetup.exe`, and compare SHA-256 hashes. Do not hand-edit build metadata to simulate a release. Then run the policy cloud-main gate, maintainer-attribution verifier, intentional staging and commit, `npm.cmd run sync:publish`, and `npm.cmd run policy:agent-finish`.

GIT AUTHORITY POLICY ACTIVE - all model automation is branchless; cloud models work only on main, and approved local models use detached worktrees with reviewed apply directly to main.
