# Write Safety Model

## Modes

### Read-only

The app can read and display files but cannot write.

### Staged proposal

The AI creates a proposed Markdown change.

The user reviews it before anything is committed.

### Approved commit

The user approves the staged change and the app commits it.

## Required display before commit

Show:

- file path;
- summary of change;
- exact diff or proposed replacement;
- source/evidence;
- risk level;
- whether it touches sensitive or canonical areas.

## Never silently do

- delete records;
- promote memory;
- expose private content;
- rewrite governance;
- change source-of-truth;
- archive historical records;
- commit large structural changes.
