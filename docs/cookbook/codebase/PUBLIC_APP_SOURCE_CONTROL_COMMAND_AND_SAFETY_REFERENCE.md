# LifePlanSystemPublic Source Control Command and Safety Reference

Status: complete source-level reference for the Source Control panel, Git command routes, authentication, protected-file checks, destructive-action gates, and known safety gaps; runtime verification remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/index.js        1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
server/runCliCwd.js    9142df399db72c3cadd07ed893b37143dbd8c9a5
src/main.jsx           4592881c34af44848dfc72e74895face6098a1da
```

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_REPOSITORY_PROPOSAL_AND_PROTECTED_PATH_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_SETTINGS_AND_SECRET_REGISTRY.md
docs/cookbook/codebase/PUBLIC_APP_EXPRESS_ENDPOINT_CATALOGUE.md
```

---

## 1. Purpose and mutation model

The Source panel is a direct local Git cockpit over the repository in `process.cwd()`.

It exposes:

- repository status and history;
- working-tree and per-file diffs;
- stage, unstage, commit, discard, and stash;
- branch creation, switching, merging, rebasing, and deletion;
- fetch, pull, and push;
- conflict resolution;
- remote management;
- GitHub and Hugging Face authentication/setup;
- repository creation;
- tags;
- installer-build launch/status.

Unlike repository file proposals, most Source Control mutations execute immediately. They do not enter the `approvals` table.

The current governance model is therefore:

```text
Repository Explorer file edits -> proposal and approval
Source Control Git operations   -> direct command after route/UI gates
```

This distinction is a product decision, not a technical necessity.

---

## 2. Command execution boundary

Git and related commands run through `runCli()` using argument arrays rather than a shell command string.

Properties:

- `execFile`-style execution avoids ordinary shell interpolation;
- default working directory is the runtime repository root;
- caller-supplied `cwd` is accepted only when `resolveRunCliCwd()` proves it remains inside the repository root;
- stdout/stderr, timeout, availability, and buffer-limit results are normalized;
- Source Control routes do not request alternate working directories.

`spawnCli()` is used for interactive authentication/browser processes. It starts detached, ignores standard I/O, and returns immediately.

### Working-directory guarantee

`server/runCliCwd.js` was introduced because an earlier executor path silently ran validation in the wrong directory. The current helper fails closed when a requested directory escapes the repository root.

This protects process location. It does not decide whether the active repository is public-safe.

---

## 3. Input validators

### `safeWorkspacePath`

Used for per-file Git actions. It requires a workspace-relative, non-traversing path under the runtime root.

### `isProtectedWorkspacePath`

Used to flag or reject runtime/private paths. Current protected prefixes, exact names, and extensions are documented in the repository-proposal reference.

### `safeGitRef`

Accepted form:

```text
starts alphanumeric
then letters, numbers, dot, underscore, slash, plus, or hyphen
maximum 255 characters
```

Explicitly rejects:

```text
..
.lock suffix
trailing slash
//
@{
```

It also prevents values beginning with `-`, avoiding Git option injection.

Git itself may still reject a string accepted by this simplified validator.

### `safeGitUrl`

Only rejects:

- empty values;
- values beginning with `-`;
- NUL/newline/carriage-return characters.

It does not restrict protocol, host, embedded credentials, Git remote-helper syntax, or repository ownership.

This is substantially weaker than the ref/path validation.

---

## 4. Status snapshot and parser

`gitStatusSnapshot()` runs in parallel:

```text
git status --short --branch
git diff --name-only --diff-filter=U
git branch --show-current
git rev-parse --abbrev-ref --symbolic-full-name @{upstream}
git rev-list --left-right --count HEAD...@{upstream}
```

It returns:

```text
branch
raw status
changedFiles
conflictFiles
hasConflicts
upstream
ahead
behind
counts by added/modified/deleted/untracked/protected
```

### `parseGitStatus` limitations

The parser uses fixed character positions from non-`-z` porcelain output.

Potentially ambiguous cases:

- renamed/copied paths represented as `old -> new`;
- quoted paths with unusual characters;
- paths containing literal ` -> `;
- protection classification on a combined rename string rather than both endpoints.

A rename between a protected and unprotected path can therefore be misclassified. Use `--porcelain=v1 -z` or v2 and parse both path records explicitly.

---

## 5. Read routes

### Repository status

```text
GET /api/source/status
```

Runs Git status/remotes/log/config plus `gh`, `hf`, and `winget` probes.

Returns:

- current root and branch;
- changed/protected/conflicted files;
- ahead/behind/upstream;
- remotes and recent log;
- configured Git identity;
- GitHub CLI/token state;
- Hugging Face CLI state;
- installation hints.

The UI derives a public/private/unknown checkout label from path and remote naming. The server does not enforce that label.

### General diff

```text
GET /api/source/diff
```

Runs:

```text
git diff --stat
git diff -- .
```

The detailed diff is truncated to 50,000 characters.

#### Critical protected-content leak

This route does not filter protected paths before returning diff text.

A tracked modified `.env`, database-adjacent text file, private document, or other sensitive tracked file can appear in the Source UI even though per-file diff and staging routes reject protected paths.

This route must be replaced by a filtered diff pipeline or refused whenever protected changes exist.

### Per-file diff

```text
GET /api/source/file-diff?path=...
```

Checks:

- workspace confinement;
- protected-path rejection;
- old content from `git show HEAD:path`;
- new content from working tree;
- NUL-based binary detection;
- 400,000-character per-side cap.

Returns added/modified/deleted classification and side-by-side content when safe enough to render.

### Branches, history, stash, and tags

```text
GET /api/source/branches
GET /api/source/history
GET /api/source/stash
GET /api/source/tags
```

These are read-only but can disclose branch names, commit subjects/authors, stash subjects, and tag metadata to the local UI.

### Installer status

```text
GET /api/source/build-installer
```

Reads in-memory installer-build state and output-tail metadata. Installer internals are documented separately.

---

## 6. Stage and unstage

### Stage all

```text
POST /api/source/stage-all
```

Gates:

1. no conflicts;
2. no changed file classified as protected.

Command:

```text
git add -A
```

The gate is intentionally conservative: one protected changed file blocks staging every otherwise safe file through this route.

Limitations:

- protection relies on the simplified porcelain parser;
- symlink/private-repository semantic boundaries are not checked;
- `git add -A` can stage deletions and renames across the full repository.

### Stage one file

```text
POST /api/source/stage-file
```

Checks workspace path and protected policy, then runs:

```text
git add -- <path>
```

### Unstage one/all

```text
POST /api/source/unstage-file
POST /api/source/unstage-all
```

Commands:

```text
git restore --staged -- <path>
git restore --staged .
```

Unstaging protected files is allowed, which is appropriate because it reduces publication risk.

---

## 7. Commit

Route:

```text
POST /api/source/commit
```

Gates:

- non-empty commit message;
- no conflicts;
- at least one staged file;
- no staged file classified as protected.

Command:

```text
git commit -m <message>
```

Limitations:

- no author override or signing support;
- no commit-template/body support;
- no pre-commit review hash recorded by Life Planner;
- no link to repository proposals or OpenHands reports;
- protection checks inspect current staged paths, not the complete repository history or content sensitivity;
- a previously committed private file can remain in history and later be pushed.

The route does not restrict committing on `main` or `master`; only push blocks those branch names.

---

## 8. Discard operations

### Discard one tracked file

```text
POST /api/source/discard-file
```

Checks workspace confinement and protected policy, confirms the file is tracked, then runs:

```text
git restore --worktree -- <path>
```

Untracked files are deliberately not deleted.

### Discard all tracked changes

```text
POST /api/source/discard-all
```

Requires:

```json
{"confirm": true}
```

Also refuses to run during conflicts.

Command:

```text
git restore --worktree -- .
```

Untracked files remain.

This action does not protect individual private paths: confirmation authorizes restoring all tracked files. It is destructive but usually recoverable from Git unless changes were never committed.

---

## 9. Stash lifecycle

Routes:

```text
GET  /api/source/stash
POST /api/source/stash
POST /api/source/stash/apply
POST /api/source/stash/drop
```

Create options:

- optional message;
- optional `--include-untracked`.

Apply options:

- `apply` or `pop`;
- numeric stash index, default zero;
- conflict state is reported.

Drop permanently removes the selected stash reference.

### Privacy behavior

Stash creation does not filter protected/private files. It can store sensitive tracked or untracked content inside `.git`.

That content is local and is not pushed by normal branch push, but it remains unencrypted repository data and may enter backups or forensic copies.

`stash drop` has no explicit confirmation gate in the backend.

---

## 10. Branch creation and checkout

### Create branch

```text
POST /api/source/branch
```

Runs:

```text
git switch -c <safe ref>
```

No clean-tree check is performed; current changes follow into the new branch.

### List branches

Returns local and remote branch names. Remote entries can appear as `origin/name`.

### Checkout

```text
POST /api/source/checkout
```

Gates:

- safe ref;
- no conflicts;
- clean tree unless `allowDirty=true`.

Command:

```text
git switch <branch>
```

Allowing a dirty switch is an explicit risk override but does not require a second backend confirmation.

Remote branch names are not converted into local tracking branches explicitly; behavior is left to Git.

---

## 11. Fetch, pull, and rebase

### Fetch

```text
git fetch --all --prune
```

This contacts every configured remote, not only `origin`.

### Pull

```text
git pull --ff-only origin <current branch>
```

Properties:

- refuses detached HEAD;
- hardcodes `origin`;
- fast-forward only;
- relies on Git to reject incompatible local state.

### Rebase

```text
git pull --rebase origin <current branch>
```

Properties:

- refuses detached HEAD;
- hardcodes `origin`;
- may rewrite local commits;
- reports conflicts;
- does not require an explicit confirmation flag.

Rebase is one of the highest-risk direct mutations in this panel and should require a deliberate confirmation summary.

---

## 12. Merge and conflict handling

### Merge

```text
POST /api/source/merge
```

Checks a safe branch name and prevents merging a branch into itself.

Command:

```text
git merge --no-edit <branch>
```

No clean-tree or explicit confirmation gate exists at the route level. Git may reject unsafe state, but route policy is limited.

### Abort merge/rebase

```text
POST /api/source/abort-merge
```

Attempts:

```text
git merge --abort
```

and falls back to:

```text
git rebase --abort
```

### Resolve one conflict

```text
POST /api/source/resolve
```

Modes:

```text
ours
theirs
mark
```

`ours`/`theirs` checks out the chosen side, then all modes stage the file.

#### Protected-path gap

The conflict-resolution route confines the path but does not reject protected paths before modifying and staging them.

A protected conflicted file can therefore be resolved/staged through this route. The later commit check may block it, but the working-tree mutation has already occurred and rename parsing may misclassify it.

---

## 13. Branch deletion

Route:

```text
POST /api/source/delete-branch
```

Gates:

- safe ref;
- cannot delete `main` or `master`;
- cannot delete current branch.

Commands:

```text
git branch -d <branch>
git branch -D <branch>   when force=true
```

Force deletion is available through a request boolean. The backend does not require a separate explicit confirmation token before `-D`.

Remote branch deletion is not supported.

---

## 14. Push boundary

Route:

```text
POST /api/source/push
```

Gates:

- current branch exists;
- branch is not `main` or `master`;
- force option is rejected;
- `confirm=true` is required.

Without stored token:

```text
git push -u origin <branch>
```

With stored GitHub token and an HTTPS origin:

```text
git push <ephemeral authenticated URL> HEAD:<branch>
```

The persistent remote is not rewritten with the token.

### Strong protections

- no force push;
- no direct `main`/`master` push;
- explicit confirmation;
- exact token string is scrubbed from returned errors;
- upstream is set separately after tokenized push.

### Critical repository-boundary gap

The backend does not prevent push when the active checkout is the private brain or an unknown repository.

The frontend displays a boundary label, but the server neither verifies repository identity nor scans the outgoing commit range for private paths/content.

A review branch containing private data can be pushed.

### Critical token-target gap

`authenticatedRemoteUrl()` injects the stored GitHub token into any HTTPS `origin`, not only `github.com`.

If `origin` points to an arbitrary HTTPS host, the GitHub token is sent to that host during push.

Token injection must be restricted to a strict host allowlist and repository URL parser.

### Error scrubbing limitation

Scrubbing replaces the exact raw token string. It may not remove URL-encoded, transformed, or indirectly echoed credential forms.

---

## 15. Remote management

Route:

```text
POST /api/source/remote
```

Behavior:

- validate remote name as a safe ref-like string;
- minimally validate URL;
- add or replace remote;
- return `git remote -v`.

### Risks

The URL validator permits any non-empty value not beginning with `-` and without control characters.

Consequences:

- embedded credentials can be persisted and displayed;
- non-HTTPS/SSH schemes are allowed;
- Git remote-helper forms are not explicitly rejected;
- an attacker or accidental configuration can redirect future fetch/pull/push;
- the stored GitHub-token push path can send a token to a malicious HTTPS origin.

Restrict accepted remotes to explicit HTTPS/SSH patterns and approved hosts, or require a high-visibility confirmation for unknown hosts.

---

## 16. Authentication and repository creation

### GitHub CLI login

```text
POST /api/source/login/github
```

Checks `gh --version`, then starts:

```text
gh auth login -w
```

The detached process has ignored standard I/O; the route expects browser/device flow completion outside the HTTP request.

### Hugging Face CLI login

Starts:

```text
hf auth login
```

Because standard I/O is ignored, runtime behavior must be verified carefully; an interactive terminal prompt may not be usable.

### GitHub repository creation

```text
POST /api/source/create/github
```

Requires authenticated `gh` and `owner/repo` syntax.

Visibility behavior:

```text
private only when visibility == "private"
otherwise public
```

Defaulting to public is dangerous for a privacy-oriented project. The route should default to private and require explicit confirmation for public creation.

### Hugging Face repository creation

Supports model, dataset, or space. It also defaults to public unless `visibility=private`.

---

## 17. Stored GitHub token

Routes:

```text
POST /api/source/token
POST /api/source/token/clear
```

Accepted prefixes:

```text
ghp_
github_pat_
```

The token is stored in the SQLite settings table and redacted from ordinary settings reads.

Limitations:

- plaintext at rest;
- generic settings endpoint can bypass prefix validation;
- no scope inspection;
- no host/repository binding;
- no expiry/last-used metadata;
- no OS keychain integration.

---

## 18. Tags

Routes:

```text
GET  /api/source/tags
POST /api/source/tags
POST /api/source/tags/delete
POST /api/source/tags/push
```

Create supports lightweight or annotated tags and optional target ref.

Delete is local-only and has no explicit confirmation field.

Push requires `confirm=true` and reuses the stored-token URL mechanism.

### Publication gap

Tag push does not block tags pointing to `main`, `master`, private commits, or historical sensitive content. A tag can publish commits that branch-push policy would refuse to push directly.

Token host restrictions are the same as normal push and currently insufficient.

---

## 19. Installer build from Source panel

Routes:

```text
GET  /api/source/build-installer
POST /api/source/build-installer
```

The POST starts a server-owned asynchronous child process and returns a snapshot. Build state is process memory and is lost on server restart.

The Source panel polls status. Packaging scripts and installer internals are separate cookbook scopes.

---

## 20. Direct-mutation matrix

| Action | Mutates working tree/index/history/remote | Backend confirmation |
|---|---|---|
| stage/unstage | index | none |
| commit | history | message/staged checks |
| discard file | working tree | none |
| discard all | working tree | `confirm=true` |
| stash/drop | `.git` state | none |
| checkout dirty | working tree/index context | `allowDirty=true` |
| rebase | history/working tree | none |
| merge | history/working tree | none |
| resolve | working tree/index | none |
| branch force delete | refs | `force=true`, no second confirm |
| push branch | remote | `confirm=true`; main/master and force blocked |
| push tag | remote | `confirm=true` |
| remote replace | Git config | none |
| create public repo | external service | visibility input; public default |

This table shows that only a subset of destructive or publishing actions has strong confirmation gates.

---

## 21. Restart and recovery

Persistent Git state survives restart:

- working tree/index;
- commits and refs;
- remotes;
- stash;
- tags;
- conflicts/rebase state.

In-memory UI/build state does not.

Recovery mechanisms:

- Git restore/checkout;
- merge/rebase abort;
- stash;
- reflog/manual Git CLI;
- remote history.

Life Planner does not expose reflog, reset, revert, cherry-pick, or remote branch deletion. Those remain manual operations.

---

## 22. Recommended hardening order

1. **Completed 2026-07-17:** filter or refuse the general diff when protected files are changed.
2. **Completed 2026-07-17:** enforce repository identity/public-private boundary on every publishing route.
3. **Completed 2026-07-17:** restrict remote URLs and token injection to approved hosts.
4. **Completed 2026-07-17:** default external repository creation to private.
5. **Completed 2026-07-17:** add protected-path checks to conflict resolution.
6. Parse porcelain `-z` output correctly, including both rename paths.
7. Require explicit confirmations for rebase, merge, force branch deletion, stash drop, and remote replacement.
8. Scan outgoing commits/tags for prohibited paths and secret patterns before publication.
9. Move tokens to an OS-protected credential store.
10. Link proposals/OpenHands reports to commits for auditability.

---

## 23. Runtime verification recipe

Use a disposable clone with a disposable remote.

1. Verify status, branches, history, stash, tags, and per-file diff.
2. Modify a protected tracked fixture and confirm per-file diff/stage reject it.
3. Confirm the general diff currently returns the protected fixture content; record as BROKEN.
4. Test rename parsing involving a protected endpoint.
5. Stage safe files individually and commit on a review branch.
6. Test dirty checkout with and without `allowDirty`.
7. Test merge/rebase conflicts and abort.
8. Test `ours`, `theirs`, and `mark` resolution using non-sensitive fixtures.
9. Confirm discard-all requires `confirm=true` and leaves untracked files.
10. Test normal and forced local branch deletion.
11. Test push confirmation, protected-branch refusal, and force refusal against a disposable remote.
12. Verify an unknown HTTPS origin is not used with a real token; use a fake credential in an isolated harness to demonstrate current host handling.
13. Confirm tag push can publish a tag on a protected-branch commit; record the policy gap without using private content.
14. Test repository creation only in a disposable account/organization and verify visibility defaults.
15. Restore or delete the disposable clone and remote.

Never run publication tests from the private brain or a repository containing real secrets.
