# LifePlanSystemPublic / Life Planner

Public-safe Life Planner UI and local-first planning assistant. This repository contains the runnable app plus the sanitised collaboration scaffold.

## Public Scaffold Purpose

LifePlanSystemPublic is a clean collaboration scaffold for designing a UI around a Markdown/Git-backed LifePlanSystem. It deliberately excludes private memories, therapy context, health details, relationship details, legal details, and personal source-of-truth.

Core rules:

- Repository/Markdown remains source-of-truth.
- AI proposes; user approves meaningful changes.
- Historical records are preserved.
- Facts, hypotheses, predictions, preferences, and interpretations are separated.
- Important claims should have provenance and confidence.
- The UI must not become a second competing memory system.

Start here for scaffold context:

- `docs/ui/UI_PRODUCT_SPEC.md`
- `docs/architecture/SYSTEM_ARCHITECTURE.md`
- `rules/LIS_RULES_SANITISED.md`
- `docs/handoffs/COLLABORATOR_HANDOFF.md`

---


Local-first desktop planning assistant and repo control centre. The app is designed to help a user decide what deserves attention next, review memory safely, browse source files, and stage repo writes behind explicit approval.

This repository is `Daa13x/LifePlanSystemPublic`; its default branch is `main`.

## Current Capabilities

- Local SQLite database at `data/life-planner.sqlite`.
- Planner dashboard fed from stored goals, blockers, waiting items, approvals, stale items, and memory candidates.
- Persistent chat sessions with rename, pin, delete, full history, and candidate memory extraction.
- Memory governance flow: chat or consultation input -> candidate -> reviewed -> approved -> active memory.
- Approval queue with approve, deny, and defer.
- Repository explorer for Markdown/JSON/YAML/text files.
- Staged repository write proposals. The app does not silently edit source-of-truth files.
- Source control screen for local Git status, diff, branches, remotes, stage, commit, and push.
- Tooling screen that detects and can locally install Playwright plus its Chromium runtime for external browser/tab control.
- Browser/cloud consultation workflow. Cloud output is saved as reviewable suggestion only.
- Local model registry for `.gguf` files, Planner Assistant assignment, and Hugging Face GGUF download.
- JSON and Markdown import/export.
- Manual local-learning support is limited to a directly invoked review-inbox
  writer and read-only reader/list command. The writer places validated
  candidate files only in `.lps/local-learning/review-inbox/`; the reader lists
  and validates `.json` candidates there in deterministic filename order. A
  missing inbox is an empty result and is not created. The reader does not
  modify, move, approve, or reject candidates. Candidates are not memory,
  nothing is promoted automatically, no `source_of_truth` path is written, and
  no runtime local-learning engine is enabled.
- Dark mode by default.

## Local Install

Requirements:

- Node.js 24 or newer.
- npm.
- Git.
- Optional: GitHub CLI for login-driven GitHub workflows.
- Optional: Hugging Face CLI for HF login workflows.

Install dependencies:

```bash
npm install
```

Run the app:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

The API runs on:

```text
http://127.0.0.1:4177/
```

Build check:

```bash
npm run build
```

## Local Tooling Bootstrap

The Tooling tab can install Playwright browser-control dependencies locally:

```bash
npm install playwright
npx playwright install chromium
```

GitHub CLI is an OS-level dependency:

```powershell
winget install --id GitHub.cli
gh auth login
```

Hugging Face CLI is optional:

```bash
pip install -U huggingface_hub[cli]
hf auth login
```

HF tokens can also be stored through the Settings screen instead of CLI login.

## Portable One-Folder Build

The app can be prepared as a self-contained portable folder with a bundled Node runtime:

```powershell
npm run package:portable
```

The portable build also installs Playwright Chromium into the bundled app dependencies for external browser consultation.

Output:

```text
release/LifePlannerPortable/
```

Run:

```text
release/LifePlannerPortable/Start Life Planner.cmd
```

That starts the local server and opens:

```text
http://127.0.0.1:4177/
```

Runtime data is stored inside:

```text
release/LifePlannerPortable/app/data/
```

Do not commit or publish that `data` folder.

### Inno Setup Installer

Install Inno Setup, then run:

```powershell
npm run package:inno
```

or manually:

```powershell
npm run package:portable
ISCC.exe installer/LifePlannerPortable.iss
```

Installer output:

```text
release/LifePlannerPortableSetup.exe
```

The installer places the same one-folder portable app layout under the selected install directory. It does not embed private runtime data from `data/`.

## Data And Privacy

Canonical app runtime state is local-first and stored under `data/`, which is ignored by Git.

Do not commit:

- `data/`
- local SQLite databases
- `.env`
- model files
- HF tokens
- private chat exports
- private MostlyArmless or LifePlanSystem data

Cloud agents and external browser consultations are advisory only. Their responses do not become memory unless reviewed and approved.

## Repository Setup

The canonical repository is `Daa13x/LifePlanSystemPublic`, with `main` as its
default branch.

Verify the current checkout before making changes:

```bash
git remote -v
git status --short --branch
```

## Pulling Fresh Changes

From the `Daa13x/LifePlanSystemPublic` repository:

```bash
git fetch origin
git switch main
git pull --ff-only origin main
npm install
npm run build
npm run dev
```

If local work exists:

```bash
git status --short
git stash push -u -m "local work before pull"
git pull --ff-only origin main
git stash pop
npm install
npm run build
```

## Public-Safe Defaults

This repo does not hardcode private keys, private domains, private bots, or private MostlyArmless configuration. The included `LifePlanSystem_*` folders are sanitized public-safe reference scaffolds only. They remain repository-only references and are intentionally excluded from portable and installer release payloads.
