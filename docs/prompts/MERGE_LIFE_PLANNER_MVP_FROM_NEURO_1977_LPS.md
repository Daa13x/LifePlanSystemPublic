# Merge Prompt — Life Planner MVP from neuro-1977/lps

Date added: 2026-06-29
Source repo: `https://github.com/neuro-1977/lps`
Status: public-safe merge workflow captured; merge not executed by ChatGPT connector.

---

## Goal

Merge the Life Planner MVP from `neuro-1977/lps` into this repository carefully, preserving existing public architecture files and keeping local-only files out of commits.

---

## Workflow

### 1. Inspect target repo

```bash
git status --short --branch
git remote -v
```

Review:

- folder structure;
- package files;
- README/docs layout;
- existing app files.

### 2. Add source remote

```bash
git remote add lps https://github.com/neuro-1977/lps.git
git fetch lps
```

### 3. Create merge branch

```bash
git switch -c merge/life-planner-mvp
```

### 4. Merge carefully

```bash
git merge lps/main --allow-unrelated-histories
```

Do not blindly accept either side.

### 5. Conflict strategy

- `README.md`: combine rather than overwrite.
- `.gitignore`: union both sets.
- `package.json`: merge dependencies and scripts intentionally.
- `docs/`, `rules/`, `source_of_truth/`, `templates/`: preserve public architecture files; place incoming reference docs under a clear folder if needed.
- `src/`, `server/`, `index.html`, `vite.config.js`: keep incoming app unless this repo already has an app; if needed, namespace under `apps/life-planner`.
- Do not commit local runtime data, environment files, generated build output, databases, model files, or tokens.

### 6. Build

```bash
npm install
npm run build
```

Optional dev check:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

### 7. Commit

```bash
git add -A
git commit -m "Merge Life Planner MVP"
```

### 8. Report

Report:

- files moved or renamed;
- conflicts and resolutions;
- build result;
- remaining follow-up;
- branch and commit SHA.

---

## Project philosophy

- Chat is candidate memory, not memory.
- AI systems advise; they do not decide.
- Meaningful changes need confirmation.
- Local runtime data remains local.
- The repository remains source-of-truth.

---

## Connector note

This file records the merge workflow. The ChatGPT GitHub connector cannot run local shell commands or perform the actual git merge/build from this chat.
