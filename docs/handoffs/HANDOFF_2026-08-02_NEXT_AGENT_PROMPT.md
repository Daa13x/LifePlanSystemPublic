# Next Agent Continuation Prompt

Use this file as the starting prompt for the next LifePlanSystem coding agent.
Verify every statement against the current checkout before changing code. Do not
restart completed work merely because an older handoff still describes it as
pending.

## Repository and Git authority

- Work only in `D:\_Code_\lps`, the Daa13x LifePlanSystemPublic checkout.
- Cloud-controlled agents write only on `main`. Do not create, switch, request,
  push, or recommend a development branch or branch-backed coding worktree.
- Before the first write and again before commit or push, run:

```powershell
npm.cmd run policy:cloud-main
git status --short --branch
```

- Use the maintainer's configured identity. Never add AI authorship, contributor,
  sign-off, or co-author metadata. Before committing, run:

```powershell
npm.cmd run verify:maintainer-attribution
```

- Pull only with a clean-tree fast-forward. Do not reset away local work.
- The local coding controller is also branchless. It uses a detached worktree at
  the sealed `main` commit, then applies an explicitly reviewed patch directly to
  unchanged `main`. It never commits or pushes.

## Work completed on 2026-08-02

The local coding system is now an operational, governed loop rather than a task
prompt with no tools.

- `da6e178` removed all local-model branch creation and integration behavior.
- `3d88ddc` added bounded read-only repository tools: approved-path file listing,
  literal search, and ranged file reads. The controller executes tools rather
  than trusting model claims and records the complete trace and result hashes.
- `b37ed5e` raised managed llama.cpp coding context to 16,384 tokens, exposes
  active versus required context, and restarts an undersized managed runtime
  before coding inference.
- The worker already supports bounded text create/replace/delete proposals,
  changed-file limits, exact task and patch hashes, detached validation,
  run approval, separate apply approval, restart recovery, and audit evidence.
- Server-owned validation profiles include syntax, frontend, runtime, and project
  checks. The model cannot provide arbitrary shell commands.
- System > Runs displays prepared evidence, tool calls, patch, model route,
  validator evidence, hashes, and audit history. Source Control remains the only
  staging, commit, pull, push, and installer surface.
- Cloud/browser advice remains optional untrusted context. It cannot expand
  scope, approve work, modify files, or trigger Git.
- OpenHands is optional, disabled, and not part of the local coding path. Do not
  reintroduce Ollama checks or make OpenHands a prerequisite.

The detailed operational contract and acceptance evidence are in
`docs/handoffs/HANDOFF_2026-08-02_LOCAL_CODING_OPERATIONAL_LOOP.md`.

## Installer portability repair

During the requested installer rebuild, `scripts/build-native.ps1` failed because
it hard-coded `C:\Users\alexl\AppData\Local\LifePlanSystem\dotnet-sdk-9`.
The script now discovers .NET in this order:

1. explicit `-DotNetPath` or `LIFE_PLANNER_DOTNET`;
2. `DOTNET_ROOT\dotnet.exe`;
3. the current user's managed `%LOCALAPPDATA%\LifePlanSystem\dotnet-sdk-9`;
4. `dotnet.exe` on `PATH`.

It rejects a resolved SDK unless `dotnet --version` reports major version 9.
This machine currently resolves `C:\Users\Captain\.dotnet\dotnet.exe` version
`9.0.312`. Do not restore a user-specific absolute path.

Direct native publish succeeded after this repair. MSBuild still reports a
non-fatal `MSB3277` conflict between `WindowsBase` versions 4.0 and 5.0 through
the WebView2 WPF dependency. The executable is produced, but a future native
dependency cleanup should align the target framework/reference set and remove
that warning before warning-as-error enforcement is introduced.

Installer acceptance is not complete until all of these are observed after the
handoff commit:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1
Get-FileHash release\LifePlannerPortableSetup.exe -Algorithm SHA256
Get-FileHash D:\MA-Updates\LifePlannerPortableSetup.exe -Algorithm SHA256
```

The two hashes must match. Do not report success from an old artifact.

## Immediate operational prerequisite

The checked-in development database currently has no `model_registry` rows. The
coding controller is implemented, but a real local coding acceptance run needs a
capable GGUF downloaded and assigned to the coding role, or another endpoint
whose inference and weights are explicitly verified local. Merely binding a
loopback URL does not prove local provenance.

After configuration, prove one real task end to end:

1. create a narrow task with explicit editable paths and validation profile;
2. prepare evidence and exercise repository tools;
3. approve local inference;
4. verify the live checkout remains unchanged while the patch is in review;
5. separately approve the exact patch hash;
6. verify Source Control shows only the expected unstaged files;
7. independently review, validate, commit, and push through Source Control.

Never add arbitrary shell, network, browser, commit, push, or automatic apply
authority to the model merely to make a test pass.

## Canonical outstanding roadmap

The live `data\life-planner.sqlite` roadmap had ten non-done records at this
handoff: one active, eight planned, and one parked. Re-query it before selecting
work because status can change through the app.

Priority work:

- Finish the active Brain-aware Chat provider router.
- Complete the first-run setup and health gate for database, Git, model runtime,
  browser connector, installer version, and offline operation.
- Require explicit shareability classification and preview for exports, then
  make import/recovery fully validated and transactional.
- Finish provider-specific browser completion evidence and DOM fixtures. Final
  cloud prompts are already classified/redacted and confirmation-bound to the
  provider and prompt hash; do not duplicate that completed work.
- Make chat, consultation, model, and import multi-row writes transactional and
  idempotent under retry and injected failure.
- Centralize Repository Explorer realpath containment, including junction and
  reparse traversal defenses and safe parent validation for creates.
- Finish local API/coding durability: transactional state, single-use approval
  nonce and expiry, compare-and-swap lease/heartbeat, process-tree cancellation,
  final-path handle checks, and adversarial restart/replay/junction tests. CSRF
  and durable confirmations already exist, so verify before replacing them.
- Add release checksums, SBOM, provenance, and optional protected-secret signing
  without describing unsigned builds as trusted.
- Remove remaining desktop-only layout assumptions and prove 360px, keyboard,
  focus, contrast, and automated accessibility behavior.
- Leave OpenHands parked unless the maintainer explicitly enables it.

Full older repair context is in:

- `docs/handoffs/HANDOFF_2026-07-22_NATIVE_CODING_WORKER_AND_REGULUS_REVIEW.md`
- `docs/handoffs/HANDOFF_2026-07-22_SERENITY_BROWSER_CONTROL_PARITY.md`
- `docs/handoffs/HANDOFF_2026-07-22_LOCAL_AI_PDF_SOURCE_HARDENING.md`
- `docs/handoffs/HANDOFF_2026-07-17_NEXT_AGENT_REPAIR_QUEUE.md`

Treat old line numbers and status claims as leads, not current proof.

## Required verification discipline

For local coding changes, run at minimum:

```powershell
node --check server/nativeCodingWorker.js
node --check server/index.js
git diff --check
npm.cmd run verify:native-coding-worker
npm.cmd run verify:browser-assisted-coding
npm.cmd run verify:runtime-safety
npm.cmd run build
```

Use narrower relevant tests while iterating, but do not substitute them for the
full runtime-safety gate before publication. Distinguish local test evidence from
installed-app evidence, connected browser evidence, hosted CI evidence, and
release-asset evidence. Never claim one proves another.

## Recommended next implementation order

1. Configure and prove a real local GGUF coding run without weakening provenance
   or approval controls.
2. Complete coding approval/state durability and process-tree cancellation.
3. Complete Repository Explorer canonical-path containment so every source read
   and proposal path shares the same boundary.
4. Finish transactional writes and public/cloud classification paths.
5. Complete first-run health gating and responsive/accessibility acceptance.
6. Add release integrity artifacts and verify the hosted release separately.

Keep roadmap status and resume notes current as each item is genuinely proven.
Do not mark a task done solely because code exists.

GIT AUTHORITY POLICY ACTIVE - all model automation is branchless; cloud models work only on main, and approved local models use detached worktrees with reviewed apply directly to main.
