# Browser Round Trip Manual Test - 2026-07-01

Status: code implemented for local testing. No auto-save, memory sync, source-of-truth sync, public sync, push, merge, or PR is included.

## Files Changed

- `server/index.js`
- `src/main.jsx`
- `src/styles.css`
- `docs/todos/BROWSER_ROUND_TRIP_MANUAL_TEST_2026-07-01.md`

Existing local changes from earlier work may also be present in this temp UI clone:

- `docs/todos/ACTIVE_TODO.md`

## Intended Automatic Flow

1. Open Browser panel.
2. Select `ChatGPT` as Cloud consultant.
3. Select one or more LifePlanSystem context files.
4. Type a message in `Local draft to critique`.
5. Confirm Temporary Chat is on if that guardrail is enabled.
6. Click `Run automatic consultation`.
7. Backend receives draft and selected context paths.
8. Backend opens the persistent controlled browser profile.
9. Backend opens ChatGPT.
10. Backend pastes the prepared prompt.
11. Backend submits the message.
12. Backend waits for the assistant response to stop changing.
13. Backend returns the response to the frontend.
14. Frontend fills the response box automatically.
15. User chooses what to keep. Nothing is saved automatically.

## Manual Test Checklist

- [ ] Reload `http://127.0.0.1:5173/`.
- [ ] Open Browser panel.
- [ ] Confirm the primary helper text describes automatic consultation.
- [ ] Confirm manual paste is labelled as fallback, not the main path.
- [ ] Confirm `Run automatic consultation` is disabled with no draft.
- [ ] Type a short test draft.
- [ ] Add one safe context file.
- [ ] If Temporary Chat guardrail is enabled, confirm `Run automatic consultation`, `Copy + Open`, and `Copy + Normal` stay blocked until the checkbox is ticked.
- [ ] Confirm `Copy temp setup` remains available and copies only the Temporary Chat setup note.
- [ ] Click `Run automatic consultation`.
- [ ] If ChatGPT asks for login, verification, Cloudflare, or human confirmation, confirm the UI shows a clear blocked status and does not bypass it.
- [ ] After signing in or completing verification manually in the persistent controlled browser profile, run again.
- [ ] Confirm ChatGPT receives the prepared prompt.
- [ ] Confirm the app waits for the response.
- [ ] Confirm the final answer box fills automatically.
- [ ] Confirm no memory candidate appears until the user clicks `Save response candidate`.
- [ ] Confirm `Save chat log later` and `Sync everything later` remain disabled future options.
- [ ] Confirm `Save nothing` clears the captured response without saving.

## Expected Blocked States

- ChatGPT login required.
- ChatGPT human verification required.
- ChatGPT auth error page.
- Controlled browser rejected as insecure.
- Composer not found after page load.
- Response timed out before completion.

## Notes

- The persistent profile is app-local under `data/browser-profile`.
- The app does not read or copy the user's installed Chrome cookies.
- Cloud responses remain advisory until explicitly saved/reviewed.
