# MA Source Control panel — reference attachment (2026-07-04)

MostlyArmless's in-app git panel, attached so LPS can lift the *design* into its Source
tab if wanted. REFERENCE ONLY — rewrite natively in LPS's stack (plain JSX + express),
do not paste TSX or C# in.

## Files

- `LcarsSourceControl.tsx.txt` — the full React panel (721 lines, LCARS-styled). The
  transferable parts are the data model and interaction flow, not the styling.
- `endpoint-snapshot-excerpt.cs.txt` — the backend routes the panel talks to (C#,
  HttpListener). Shows the snapshot construction and each action route.

## The contract that makes it work (language-agnostic)

`GET /api/ui/source-control` returns one snapshot object:

```
{
  branch, summary, repoUrl, repositoryPath,
  hasChanges, isAhead, isBehind, aheadCount, behindCount,
  generatedNoiseCount, generatedNoisePaths[],     // build noise counted separately,
                                                  // never shown as "your changes"
  changedFiles: [{ path, status, staged }],
  history: [{ hash, subject, author, date, refs[] }],
  branches: [],
  error,                                          // honest error string, never a fake OK
  patConnected                                    // token present = push enabled
}
```

Actions are small POSTs: `/commit` (message in body), `/push`, `/pull`, `/pat` (store
token). File diff via `GET /file?path=` returning `{ oldContent, newContent }` — the UI
renders its own side-by-side diff.

## Design decisions worth keeping

1. **One snapshot endpoint** — the panel never assembles state from multiple calls, so
   it can't render a half-true picture.
2. **Generated-noise split** — build artifacts are counted and listed separately from
   real changes; commit UI shows only the real ones. Kills the "300 changed files"
   paralysis.
3. **PAT stored server-side** — the browser never holds the token; `patConnected` is the
   only thing the UI knows.
4. **Errors are data** — `error` is part of the snapshot; the panel renders it as a
   banner instead of pretending the repo is clean.
5. **Diff before commit** — clicking a changed file loads old/new content in-panel;
   committing blind is possible but never the default path.

LPS's existing Source tab (github repo field + commit message box) can grow into this
shape incrementally: snapshot endpoint first, then changed-file list, then diffs.
