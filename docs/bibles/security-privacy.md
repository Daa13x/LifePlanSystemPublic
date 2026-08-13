# LPS Security & Privacy Bible

Version: 1.0.0
Owner: LPS maintainer

## Purpose and scope
Protect personal data, secrets, local paths, and external egress.

## Hard invariants
- Protected paths and task scope fail closed.
- Sensitive browser egress requires review and confirmation.
- Import/export is classified and previewed before public sharing.
- Audit trails record confirmations and outcomes without exposing secrets.

## Allowed and forbidden
Allowed: redact, classify, preview, request confirmation, and report a blocked boundary.
Forbidden: sending sensitive content to a browser provider without review, bypassing export preview, exposing secret values, or using a prompt as a security control.

## Evidence and failure
Implemented by `server/mutationGuard.js`, `server/confirmations.js`, browser egress handling, and classified export routes; proved by `verify:browser-connector-safety`, `verify:classified-export-import`, `verify:durable-confirmations`, and `verify:workspace-path-guard`.
If classification is unknown, keep data local and ask for a decision.

## Examples
Good: “This attachment may contain private data; review the redacted browser prompt first.”
Bad: “I removed the secret from the visible text, so sending the file is safe.”
