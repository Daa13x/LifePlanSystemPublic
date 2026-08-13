# Reference-Material Boundary

LifePlanSystem is an independent application. Its runtime, prompts, agent
skills, policy, architecture decisions, validation, and release process must be
derived from LPS-owned requirements and LPS-owned executable evidence.

## Mostly Armless material

Mostly Armless/Serenity Bibles, Sacred Laws, handbooks, prompt doctrine,
LoRA-adapter behavior, and related internal materials are proprietary to Mostly Armless.
They are **not LPS specifications**, system prompts, operating rules, acceptance
criteria, or fallback behavior.

They may be inspected only as high-level historical reference when the
maintainer explicitly places them in scope. Such inspection must not copy their
text, assume their model adapter or companion systems exist, make their rules
normative, or cause LPS to emulate their failure behavior. A reference finding
is useful only after it has been independently restated as an LPS requirement
and proved through LPS source and tests.

No LPS agent may load, quote, summarize into prompts, route against, or use a
Mostly Armless Bible/doctrine artifact as operational harness context. If an
LPS task depends on a behavior that only that material defines, stop and obtain
an LPS-specific requirement from the maintainer. In particular, an absent
Serenity orchestrator or LoRA adapter is not an LPS setup fault: LPS must not
seek, mock, prompt-emulate, or provide a fallback for that proprietary system.

## Permitted external reference use

External code or material can inform an engineering question only when all of
the following remain true:

1. LPS reimplements the small idea in its own stack and names its own contract.
2. LPS tests prove the behavior without an external model, LoRA, database,
   browser profile, prompt bundle, or private asset.
3. The result retains LPS's local-model provenance, sealed task/evidence,
   detached isolation, independent validation, explicit human confirmation,
   and human Git authority boundaries.
4. Documentation calls the external item reference-only and does not present it as LPS doctrine.

This boundary deliberately favors an honest missing requirement over a copied
or partially reconstructed proprietary system.

## MA-lock

`npm.cmd run verify:ma-lock` is an enforcement boundary, not merely a written
rule. It scans LPS operational paths and staged changes for known Mostly
Armless proprietary doctrine and implementation signatures. The pre-commit
hook runs its staged-change mode before a commit can be created.

The lock deliberately cannot prove that arbitrary unknown text is harmless.
When material might contain Mostly Armless internals but does not match a known
signature, it is a maintainer-review stop. Do not add it “for reference” and
do not weaken the lock to make a transfer convenient.
