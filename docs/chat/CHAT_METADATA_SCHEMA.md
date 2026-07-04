# Chat Message Metadata Schema

Every chat message row (`chat_messages`) carries a `metadata` column (JSON
text, nullable for legacy rows). The UI parses it to render provider/source
labels. Unknown fields are preserved; missing fields mean "legacy message".

## User message metadata

| Field | Type | Meaning |
|---|---|---|
| `speaker_id` | string | Stable id for the speaker. `alex-default` until real speaker identification exists. |
| `speaker_label` | string | `Alex`, `Guest`, or `Unknown`. Session default is `Alex`; anything not identified is `Unknown`. |
| `speaker_confidence` | string | How the label was decided: `session-default`, `user-confirmed`, or `unknown`. |
| `source` | string | Where the message came from: `chat_ui`. |
| `created_at` | string | ISO timestamp (also stored in the row column). |

## Assistant message metadata

| Field | Type | Meaning |
|---|---|---|
| `answered_by` | string | `ChatGPT`, `Local model`, or `System fallback`. |
| `provider_type` | string | `browser_cloud`, `local_model`, or `system`. |
| `route` | string | `browser_connector`, `local_runtime`, or `none`. |
| `model_or_provider` | string | Concrete runtime, e.g. `chatgpt_browser`, `local endpoint (qwen…)`, `llama-cli`. |
| `checked_by` | string/null | Future: which provider verified this answer. `null` today. |
| `fallback_used` | boolean | True if the first-choice provider did not answer. |
| `fallback_reason` | string | Plain-English reason (from config/chat/failure-messages.yaml) when `fallback_used` is true. |
| `mode` | string | Router mode used: `auto` or `private` today. |
| `memory_status` | string | `chat_only` or `candidate_only` (candidates were created, nothing promoted). |
| `brain_context_used` | boolean | True only if the **answering provider's prompt** embedded safe brain excerpts. Today only the ChatGPT cloud prompt does; the local model prompt does not yet (planned enhancement). |
| `brain_context_available` | boolean | True if brain excerpts were loadable at send time, whether or not the answering provider received them. |
| `brain_configured` | boolean | True if a brain root is configured. |
| `brain_files` | string[] | Relative allowlist paths sent to the answering provider (empty when `brain_context_used` is false). |
| `brain_missing` | string[] | Allowlisted files that were not found under the brain root. |
| `approval_candidates_created` | number | Candidates created from this exchange. |
| `speaker_label` | string | Speaker label of the user message being answered. |

## Rules

- Metadata is display/audit data. It never grants authority: a cloud answer
  with any metadata is still a suggestion until Alex approves derived
  candidates.
- Known failures must produce a `fallback_reason` (or a `System fallback`
  message) in plain English — never a bare "Failed to fetch".
- Conversation history forwarded to a cloud provider contains prior **user**
  messages only: local-model answers may embed full private database context
  that must never reach a cloud provider.
