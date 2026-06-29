# Repo Write Fallback Checklist

Status: public-safe checklist

## Purpose

Use this checklist when a repository edit does not commit cleanly.

## Rules

- Do not say a change is done unless a commit succeeded.
- If a write fails, say what failed.
- Retry with a smaller file if useful.
- Split large changes into smaller commits.
- Keep generic docs neutral and reusable.
- Put private detail in the right memory holding file, not broad system docs.
- Use pointers where possible instead of repeating sensitive content.
- Report partial success clearly.

## Partial success format

```text
Partly successful.

Committed:
1. <commit> — <file> — <summary>

Still not written:
- <item>

Reason:
- <known or likely reason>
```

## Batch ledger format

```text
Batch commit ledger:
1. <commit> — <file> — <summary>
2. <commit> — <file> — <summary>
```

## Retry guide

After a failed write:

1. Try a shorter version.
2. Try fewer concepts in one file.
3. Use neutral wording.
4. Move private details to memory holding files.
5. Stop after repeated failure and record what remains incomplete.
