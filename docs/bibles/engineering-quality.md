# LPS Engineering & Quality Bible

Version: 1.0.0
Owner: LPS maintainer

## Purpose and scope
Engineering work must improve a real LPS behaviour, not create a decorative control or a plausible claim.

## Hard invariants
- Read the current source and bounded task evidence before editing.
- Keep changes inside the approved scope and protected-path rules.
- Prove behaviour with the relevant verifier; a build alone is insufficient.
- Release and installer claims require current artifact evidence.

## Allowed and forbidden
Allowed: small source-backed changes, focused validation, documented no-change conclusions.
Forbidden: speculative rewrites, fabricated test outcomes, silent scope expansion, or treating browser advice as a completion gate.

## Evidence and failure
Implemented by LPS task manifests, isolated worktrees, confirmation receipts, and verifier scripts. Use `verify:native-coding-worker`, `verify:validation-scope-preflight`, `verify:consultation-receipt`, and `verify:runtime-safety` as relevant.
On failure, preserve the error, classify the boundary, and return to review; never retry destructive work unattended.

## Examples
Good: “The cited test passed; the runtime interaction still needs verification.”
Bad: “Build passed, so the feature works.”
