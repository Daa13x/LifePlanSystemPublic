# Chat control classification — 2026-09-03

This records the implemented P0 Chat simplification. It is an interface audit,
not a new action, permission, tool, or scheduler owner. Registered behaviour
remains in `server/actionRegistry.js` and `server/chatCapabilities.js`; command
discovery is a thin adapter over those live contracts.

| Previous Chat control | Classification | Implemented surface |
| --- | --- | --- |
| Conversation list | `KEEP_IN_CHAT` | Collapsible sidebar; collapsed by default on Android. |
| New chat | `KEEP_IN_CHAT` | Conversation sidebar. |
| Rename chat | `KEEP_IN_CHAT` | Pencil beside the compact title. |
| Pin / delete chat | `CONTEXTUAL_ONLY` | Compact header and row hover actions. |
| Attach Knowledge | `CONTEXTUAL_ONLY` | Paperclip panel; uses existing Knowledge actions. |
| Use Workboard | `CONTEXTUAL_ONLY` | Paperclip panel; uses existing Workboard actions. |
| Propose task / card | `CONTEXTUAL_ONLY` | Paperclip panel; existing proposal and Allow/Decline confirmation. |
| Add Planner task | `EXPOSE_AS_COMMAND` | `/add-task <title>` plus contextual form; both use `planner.propose_create`. |
| Attach repo file | `CONTEXTUAL_ONLY` | Paperclip panel. |
| Upload local text file | `CONTEXTUAL_ONLY` | Paperclip panel; bounded local conversation context. |
| Add file | `REMOVE_DUPLICATE` | Folded into the repo-file selector and single paperclip surface. |
| Check status | `EXPOSE_AS_COMMAND` | Natural language or `/status` through `system.status`. |
| Check model | `EXPOSE_AS_COMMAND` | Natural language or `/model` through `system.models`. |
| Recent runs | `EXPOSE_AS_COMMAND` | Natural language or `/runs` through `system.runs`. |
| Check Today | `EXPOSE_AS_COMMAND` | Natural language or `/today` through `planner.today`. |
| Open Today | `EXPOSE_AS_COMMAND` | `/open-today` through `navigation.planner`. |
| Open Workboard | `EXPOSE_AS_COMMAND` | `/workboard` through `navigation.workboard`. |
| Open System / runtime diagnostics | `MOVE_TO_SETTINGS_OR_DIAGNOSTICS` | System → Status/Diagnostics; `/diagnostics` remains callable. |
| Assign / change model | `MOVE_TO_SETTINGS_OR_DIAGNOSTICS` | Settings → Local Model Registry; `/settings` remains callable. |
| Provider/model cloud controls | `CONTEXTUAL_ONLY` | Paperclip panel; exact-prompt review and provider gates are unchanged. |
| Runtime/model/context/capability cards | `MOVE_TO_SETTINGS_OR_DIAGNOSTICS` | Removed from default Chat; System and structured message details retain evidence. |
| Developer/test controls | `MOVE_TO_SETTINGS_OR_DIAGNOSTICS` | Existing System / Setup & Recovery / Tools surfaces. |

Default Chat is therefore: compact header, conversation, composer, and one
paperclip entry point. Suggestions are enabled by default but may be hidden in
Settings; that preference never changes registry permissions, confirmation,
approval, or hard human gates.
