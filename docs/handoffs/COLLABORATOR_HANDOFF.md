# Collaborator Handoff

This is a clean handoff for helping build the public LifePlanSystem UI and architecture.

## Build goal

Create a UI/pass-through layer for a Markdown/Git-backed AI planning and memory system.

## Keep in mind

- The repository remains source-of-truth.
- The UI should not hide provenance.
- AI should suggest and explain changes; the user confirms important updates.
- Historical records should be preserved.
- Protected files should be handled carefully.
- Start with a small MVP.

## Best first prototype

- Dashboard.
- File browser.
- Chat with selected files.
- Review queue.
- Suggested update preview.

## Useful files

- `README.md`
- `SANITISATION_POLICY.md`
- `docs/architecture/SYSTEM_ARCHITECTURE.md`
- `docs/ui/UI_PRODUCT_SPEC.md`
- `docs/architecture/WRITE_SAFETY_MODEL.md`
- `docs/architecture/MEMORY_PIPELINE.md`
- `docs/architecture/MUTUAL_CALIBRATION_LAYER.md`
- `templates/AI_REPO_REVIEW_PROMPT.md`
