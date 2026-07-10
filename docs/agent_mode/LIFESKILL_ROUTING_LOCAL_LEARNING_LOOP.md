# LifeSkill Routing and Local Learning Loop

## Status

- The routing and local-learning engine described here remain
  design/documentation only.
- The implemented local-learning write path is a separate, directly invoked
  review-inbox writer for validated candidate files only.
- The implemented read path is a separate, directly invoked, read-only
  review-inbox reader/list command.
- No runtime automation is added by this document.
- No OpenHands invocation is enabled.
- No browser/Puppeteer automation is enabled.
- No Claude, ChatGPT, Codex, or Fable account action is automated.
- No private memory or `source_of_truth` files are changed.
- This PR is separate from the LifeSkillSystem skill-library PR. It describes
  routing and learning flow only; it does not create or modify skill-library
  files.

## Purpose

This document captures the LifePlanSystem loop Alex described:

> The system looks at what it needs to do, checks for relevant LifeSkills, asks a cheaper chat engine to compress/prepare the right instructions, sends the compact handoff to Claude/Codex/Fable/ChatGPT, receives the result, then learns locally from what worked.

The goal is to reduce repeated prompt-writing and token cost while improving consistency, safety, and project memory over time.

## Core loop

```text
Alex request
  -> Task intake
  -> Task classification
  -> LifeSkill retrieval
  -> Cheap router/compressor chat engine
  -> Compact handoff packet
  -> Claude / ChatGPT / Codex / Fable execution
  -> Response capture
  -> Result review
  -> Local learning event
  -> Skill score / mistake warning / handoff / memory candidate
```

Short version:

```text
Need -> Retrieve Skills -> Compress -> Execute -> Review -> Learn -> Improve Skills
```

## Component responsibilities

| Component | Responsibility | Must not do |
|---|---|---|
| Task intake | Capture Alex's request and current context | Guess repo state without verification |
| Task classifier | Decide task type and risk level | Approve dangerous action |
| LifeSkill library | Store reusable skill instructions | Store secrets or private memory |
| Skill retriever | Find candidate skills | Execute actions |
| Cheap chat router/compressor | Select and compress relevant skills into a handoff packet | Perform final repo work or approve unsafe work |
| Handoff packet builder | Produce compact instructions for the selected agent | Hide stop boundaries |
| Puppeteer/browser bridge | Future transport-only delivery/capture layer for browser-based agents | Own safety decisions, bypass login/security, or run without explicit approval |
| Claude/ChatGPT/Codex/Fable | Do final reasoning or repo work according to the packet | Exceed explicit scope |
| Result reviewer | Check whether the output followed the packet | Silently promote changes |
| Local learning engine | Record lessons, skill scores, mistakes, and improvement candidates | Rewrite source-of-truth automatically |

## Skill vs automation boundary

A LifeSkill is an instruction asset: it can explain how to do a task, name
inputs, define stop conditions, and suggest validation. A LifeSkill is not an
automation permission grant.

Automation remains a separate, higher-risk layer. Any future automation must
have its own explicit approval, visible scope, validation, and rollback path.
Skill selection, skill scores, and cheap-router compression must never convert a
suggestion into permission to merge, upload, invoke OpenHands, call an external
agent, or edit durable memory.

## Task classification

The router should classify work before retrieving skills.

Suggested task types:

- `repo_prompt_generation`
- `repo_output_review`
- `pr_merge_safety_review`
- `openhands_safety_design`
- `skill_library_design`
- `memory_routing`
- `admin_drafting`
- `legal_admin_caution`
- `health_admin_support`
- `youtube_to_project_ideas`
- `job_cv_support`
- `game_build_research`
- `lmtr_lead_generation`
- `general_decision_support`

## Skill retrieval

The system should search the LifeSkill library for candidate skills using:

- task type
- trigger phrases
- required inputs
- safety level
- platform target
- whether repo access is needed
- whether external action is involved

Example:

```text
User asks: "next prompt"

Candidate skills:
- LifePlanSystem Next Move
- Codex Bulk Prompt Builder
- Stop-Boundary Safety Checklist
- Agent Output Reviewer
```

## Cheap chat router/compressor

The cheap router is used to save tokens and reduce clutter before handing work to a more expensive or more capable agent.

It receives:

```text
- user request
- current task classification
- relevant short context
- candidate skill metadata
- selected skill bodies, if needed
```

It outputs:

```text
- selected skills
- rejected skills with reason
- compressed execution rules
- safety boundaries
- required output shape
- escalation target
```

The cheap router should be allowed to recommend, condense, and prepare.

It must not:

- approve merges
- enable OpenHands
- promote source-of-truth
- upload skills to Claude/ChatGPT
- send external messages
- perform legal/medical/financial decisions
- bypass explicit approval gates

## Handoff packet format

A handoff packet should be compact and explicit.

```markdown
# Agent Handoff Packet

## Task
<one-paragraph task summary>

## Selected skills
- <skill name>: <why selected>

## Relevant context
<only the context needed for this task>

## Safety boundaries
- <hard stop rule>
- <hard stop rule>

## Required process
1. <step>
2. <step>
3. <step>

## Validation / review checks
- <check>
- <check>

## Output format
<exact final report format>

## Stop conditions
- <condition>
- <condition>
```

## Example: next prompt flow

```text
Alex asks: "next prompt"

LifePlanSystem classifies:
repo_prompt_generation

LifeSkill retrieval:
- LifePlanSystem Next Move
- Codex Bulk Prompt Builder
- Stop-Boundary Safety Checklist

Cheap router compresses:
Use the Codex bulk prompt shape, include current known repo state, include no-OpenHands boundary, include validation commands, stop before unsafe implementation.

Claude/ChatGPT produces:
A paste-ready prompt.

Local learning records:
Whether the prompt was useful, whether it missed repo-state verification, and whether the skill should be updated.
```

## Example: repo review flow

```text
Alex asks: "review GitHub and tell me what next"

LifePlanSystem classifies:
repo_output_review + pr_merge_safety_review

LifeSkill retrieval:
- Agent Output Reviewer
- PR Merge Safety Review
- How Far From Finishing Estimator

Cheap router compresses:
Ask GitHub-aware agent to verify PR state, merged status, open PRs, checks, safety status, and next prompt.

Fable/Codex/GitHub-aware agent executes:
Verifies repo state and returns structured report.

Local learning records:
Which assumptions were stale, which PRs were already merged, and whether future prompts need stronger Phase 0 verification.
```

## Local learning layer

Local learning should start as structured, reviewable logs rather than model fine-tuning.

The implemented safe subset is manual-only: a validated event can be written
only to `.lps/local-learning/review-inbox/`, then listed and validated by the
read-only reader. It lists only `.json` entries in deterministic filename order;
a missing inbox is an empty result and malformed or schema-invalid candidates
remain visible as invalid. Listing does not create, modify, move, approve,
reject, or promote candidates. A candidate is not memory, does not write to
`source_of_truth`, and does not enable a runtime local-learning engine.

A local learning event can record:

```json
{
  "task_type": "repo_prompt_generation",
  "selected_skills": [
    "lifeskillsystem-next-move",
    "codex-bulk-prompt-builder"
  ],
  "agent_target": "chatgpt",
  "result_quality": "success",
  "mistakes": [],
  "lesson": "Include verified GitHub state before writing next repo prompt.",
  "skill_update_candidate": "Add stronger Phase 0 repo verification rule.",
  "memory_route": "skill_improvement_candidate",
  "approval_required": true
}
```

Local learning routes:

- `ignore`
- `temporary_handoff`
- `mistake_warning`
- `skill_improvement_candidate`
- `memory_inbox_candidate`
- `source_of_truth_candidate_requires_approval`

Route meanings:

- `temporary_handoff`: useful only for the current thread or PR.
- `mistake_warning`: a local warning to show before similar future work.
- `skill_improvement_candidate`: proposed wording or metadata changes for a
  LifeSkill, queued for review.
- `memory_inbox_candidate`: possible memory item, queued for human triage.
- `source_of_truth_candidate_requires_approval`: durable-canonical candidate;
  never written directly and never promoted without explicit approval.

## Skill scoring

A future, separately approved local learning engine could maintain simple,
local skill scores.

Suggested fields:

- skill id
- task types where used
- success count
- failure count
- last used date
- common mistakes
- recommended improvements
- automation eligibility

Skill scores should influence retrieval, but not override safety gates.

## Prompt rule to bake into future agent prompts

Use this standing rule in future Codex/Fable/Claude prompts when relevant:

```text
Before doing the task, identify whether this should use the LifeSkill routing loop:
1. Classify the task type.
2. Identify relevant LifeSkills.
3. Compress only the necessary skill instructions into the working prompt.
4. Execute within the selected skill boundaries.
5. Return what skills were used, what worked, what failed, and any local-learning update candidate.
Do not auto-sync memory, promote source-of-truth, upload skills, call OpenHands, or perform external actions without explicit approval.
```

## Safety boundaries

The loop must preserve these boundaries:

- Skills can suggest actions; they do not authorize actions.
- Cheap router can compress; it does not approve dangerous work.
- Puppeteer/browser bridge can deliver and capture; it does not decide safety.
- Local learning can propose improvements; it does not silently rewrite durable memory.
- Local learning does not auto-sync memory to external accounts or other repos.
- Source-of-truth promotion always requires explicit approval.
- OpenHands real invocation remains separately gated.
- External account uploads require explicit approval.

## Implementation sequence

Completed safe foundations:

1. Skill library docs and starter instruction-only skills.
2. Skill metadata verifier.
3. Local learning event schema and validator.
4. Manual review-inbox writer for validated candidates.
5. Manual read-only review-inbox reader/list command.

Possible future slices, each requiring separate review:

1. Human-gated approval/reject staging workflow (not implemented).
2. Skill retrieval prototype using metadata only.
3. Cheap-router handoff packet design.
4. Puppeteer/browser bridge handoff transport design.
5. Response capture parser.
6. Result reviewer and skill-score update proposal.
7. Only later: approved automation candidates.
