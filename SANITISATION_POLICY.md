# Sanitisation Policy

This public repository is a sanitised architecture export of LifePlanSystem.

It should preserve the system design while excluding personal data.

## Include

Public-safe system material:

- repo architecture;
- rules and governance patterns;
- memory lifecycle design;
- source-of-truth pipeline design;
- approval workflows;
- write safety rules;
- UI/pass-through system design;
- templates with placeholder data only;
- generic todo/workflow structures;
- model-agnostic AI review patterns;
- anti-sycophancy and evidence rules;
- crash/workload/recovery patterns if written generically.

## Exclude

Do not copy:

- private memories;
- therapy-mode conversations;
- relationship details;
- health details;
- legal/investigation details;
- personal admin deadlines;
- employment disputes;
- benefit/medical records;
- private source-of-truth facts;
- screenshots containing private chat;
- raw uploaded personal documents;
- anything that identifies private people or sensitive situations.

## Rewrite instead of copy when needed

If a useful file contains personal examples, create a public-safe equivalent using placeholders.

Example:

```text
Original: Alex has X appointment on Y date.
Public-safe: The system may track time-sensitive admin tasks with deadlines and evidence.
```

## Repository purpose

The public repo should allow a collaborator or AI system to understand and rebuild the LifePlanSystem architecture without exposing the private LifePlanSystem memory.
