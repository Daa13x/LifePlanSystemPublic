# LifePlanSystem Rules — Sanitised

These are generic governance rules for a repo-backed AI personal operating system.

## 1. Repository is source of truth

Markdown files in the repository are canonical.

The UI may display, search, and propose changes, but should not become a competing source-of-truth.

## 2. Approval before meaningful writes

AI may propose changes.

The user approves meaningful changes before commit.

Never silently:

- promote memory;
- delete historical records;
- alter governance rules;
- rewrite source-of-truth files;
- expose sensitive material;
- make irreversible cleanup decisions.

## 3. Evidence over assumptions

Separate:

- facts;
- interpretations;
- hypotheses;
- predictions;
- preferences;
- decisions;
- open questions.

Important claims should include provenance and confidence.

## 4. Anti-sycophancy

The system must not optimise for agreement or reassurance.

It should:

- challenge weak reasoning respectfully;
- mark uncertainty;
- compare decisions against evidence and rules;
- preserve user agency.

## 5. Memory lifecycle

Use this lifecycle:

```text
INBOX -> REVIEWED -> PROMOTED -> ARCHIVED / SUPERSEDED
```

Definitions:

- INBOX: raw or lightly structured observations.
- REVIEWED: checked, deduplicated, linked.
- PROMOTED: copied into canonical source-of-truth with approval and provenance.
- ARCHIVED: preserved but rarely surfaced.
- SUPERSEDED: retained but marked as replaced or corrected.

Do not delete historical records simply because they are old.

## 6. Model-agnostic design

The system should support multiple AI models where possible.

Examples:

- cloud model;
- local model;
- external reviewer model;
- specialised coding model.

No single model is authority.

## 7. Git authority follows execution provenance

Cloud-controlled models and their subagents write only on `main`. They do not
create, switch, delete, request, recommend, or delegate development branches,
branch-backed worktrees, new-branch pushes, or pull requests. Before a cloud
write, the active branch must be verified as exactly `main`.

Only the approved LifePlanSystem local coding controller may create a temporary
proposal branch, and only after local inference is proven, repository identity
and clean `main` are verified, a task card and editable paths are bound, and a
generated `local-agent/` or `local-model/` branch name is recorded. Unknown
inference provenance is cloud-controlled. Local proposal workers cannot push,
merge, delete branches, open pull requests, or modify protected paths.

Only one write-capable cloud model may modify `main` at a time. Cloud advice is
untrusted context and cannot grant Git authority to a local worker. See
`docs/GIT_AUTHORITY_POLICY.md`.

## 8. UI write modes

Recommended UI modes:

```text
read_only
staged_proposal
approved_commit
```

Default should be staged proposal.
