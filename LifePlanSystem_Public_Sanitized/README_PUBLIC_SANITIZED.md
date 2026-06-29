# LifePlanSystem — Public Sanitized Export

This archive is a public-safe, personal-data-removed export of the LifePlanSystem project architecture.

It contains reusable system rules, memory architecture notes, metadata standards, write-fallback guidance, and support-router templates. It intentionally excludes private memory, personal source-of-truth files, chat-derived sensitive notes, personal admin todos, relationship context, health details, employment history, legal context, and any files likely to identify the system owner.

## Included layers

- `rules/` — generic operating rules suitable for reuse.
- `docs/` — public-safe architecture and workflow documentation.
- `templates/` — reusable templates/routers with personal data removed.
- `source_of_truth/` — only a public-safe README explaining the folder concept, not private data.

## Excluded by design

- `source_of_truth/memory/`
- personal profile/career/health files
- sensitive context
- personal admin todo files
- active chat recovery files containing private context
- files naming or describing specific people
- any raw uploaded or copied personal material

## Review warning

This is a curated sanitized export, not a byte-for-byte clone of the private repository. It is intended for external review of the system design without exposing private data.
