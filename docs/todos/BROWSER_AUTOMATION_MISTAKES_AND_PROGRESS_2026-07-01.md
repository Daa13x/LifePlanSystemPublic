# Browser Automation Mistakes and Progress - 2026-07-01

Purpose: keep a persistent local record of Browser / Cloud Consultant failures, false assumptions, blockers, and fix attempts so the same loop is not repeated without new evidence.

## Current Problem Summary

The Browser panel is intended to take a local message, build the final consultation prompt, send it to ChatGPT through browser automation, wait for the answer, capture the answer, and fill the final answer box in LifePlanSystem without saving or syncing anything until the user chooses.

The app plumbing is now partly working: `/api/browser/capabilities` and `/api/planner` return JSON through both backend and Vite proxy routes. The remaining hard blocker is that ChatGPT may reject or challenge Playwright-controlled browsers.

## Expected Browser Flow

1. User types a message inside LifePlanSystem.
2. User selects a consultant/model option.
3. The app builds the final prompt with selected local context.
4. The app calls `POST /api/browser/consult`.
5. The backend opens or reuses a visible controlled browser.
6. ChatGPT opens.
7. The prompt box is found.
8. The prompt is pasted.
9. The prompt is submitted.
10. The app waits for a response.
11. The response is detected and captured.
12. The final answer box is filled.
13. Nothing is saved, synced, committed, or promoted until the user chooses.

## Actual Observed Browser Flow

- API/proxy route wiring works after the dev server was restarted from the active UI folder.
- Browser capability detection returns JSON and reports Playwright and Chromium installed.
- Planner loads data and no longer gets stuck on the Vite HTML JSON parse error.
- Browser panel shows a controlled-browser warning for ChatGPT.
- Manual fallback can fill the final answer box and show explicit save choices.
- No test/mock provider existed before this loop.
- Full ChatGPT browser round trip has not been proven.

## What Currently Works

- `GET /api/browser/capabilities` through backend and Vite proxy returns JSON.
- `GET /api/planner` through backend and Vite proxy returns JSON.
- Manual fallback response entry updates the final answer box.
- The UI shows explicit save choices after a response is present.
- The app does not auto-save a manually entered response.

## What Currently Fails or Remains Unproven

- Full ChatGPT automation is still unproven.
- ChatGPT may block controlled browsers with login, auth, or human-verification checks.
- The previous frontend API helper blindly parsed non-JSON responses and showed raw JSON parse errors.
- The Browser panel did not previously have a deterministic mock/test provider round trip.

## Mistakes Made So Far

- Claimed or implied progress before the user could test the full intended loop.
- Treated Playwright progress as the only meaningful progress.
- Let a Vite fallback HTML page reach the frontend as if it were JSON.
- Did not separate API/proxy health, backend reachability, Playwright, Chromium, ChatGPT blocker, mock provider, and manual fallback status clearly enough.
- Tested backend availability before confirming the frontend was hitting the same route through the Vite proxy.
- Needed a dev server restart before the current proxy config was actually loaded.

## False Assumptions Made So Far

- That Browser was fixed once capability detection worked.
- That the active private repo contained the UI source.
- That the full ChatGPT route could be treated as working because Playwright and Chromium were installed.
- That a manual fallback was enough without a deterministic route proving final answer box wiring.

## Things Tested That Worked

- `GET /api/browser/capabilities` on the backend.
- `GET /api/browser/capabilities` through the Vite proxy after restart.
- `GET /api/planner` on the backend.
- `GET /api/planner` through the Vite proxy after restart.
- Manual response paste into the final answer box.
- Save choice display after a manual response.
- Clearing the manual response with "Save nothing".

## Things Tested That Failed

- `/api/...` through the stale Vite server returned HTML instead of JSON.
- Browser panel previously stayed on "Checking browser automation status" because the frontend received HTML instead of JSON.
- Planner previously stayed on "Loading planner context..." for the same route/proxy issue.
- Full ChatGPT controlled-browser automation has not passed end to end.

## Current Blocker

ChatGPT may reject or challenge Playwright-controlled browser sessions. This must not be bypassed. If it appears, the app should show the exact blocker and guide the user to mock/manual fallback.

## Next Safest Fix

Add a deterministic test/mock provider route through `POST /api/browser/consult`, add frontend status and stage visibility, and harden frontend JSON handling so non-JSON API responses produce a readable error instead of a raw parse crash.

## Do Not Repeat

- Do not say Browser works unless the full intended loop is observed.
- Do not treat Playwright/Chromium detection as proof of ChatGPT automation.
- Do not keep retrying the same ChatGPT controlled-browser path when a login or human-verification blocker is visible.
- Do not parse API responses as JSON until the content type is checked.
- Do not test only port `4177`; also test the same route through `5173`.
- Do not forget to restart the backend after changing backend routes.

## Evidence

- Active UI source files inspected:
  - `src/main.jsx`
  - `server/index.js`
  - `vite.config.js`
  - `package.json`
- Relevant routes:
  - `GET /api/browser/capabilities`
  - `POST /api/browser/consult`
  - `GET /api/planner`
- Relevant commands:
  - `curl.exe -s -i http://127.0.0.1:4177/api/browser/capabilities`
  - `curl.exe -s -i http://127.0.0.1:5173/api/browser/capabilities`
  - `curl.exe -s -i http://127.0.0.1:5173/api/planner`
- Route evidence after restart:
  - `4177/api/browser/capabilities`: `200 application/json`
  - `5173/api/browser/capabilities`: `200 application/json`
  - `5173/api/planner`: `200 application/json`

## Current Loop Notes

- Last relevant failure 1: stale Vite server returned HTML for `/api/...`.
- Last relevant failure 2: frontend blindly parsed HTML as JSON.
- Last relevant failure 3: ChatGPT controlled-browser automation is not proven and may be blocked by verification.
- Different this time: add persistent logging, JSON validation, visible status/stage evidence, and a mock provider before attempting more ChatGPT automation.

## Loop Update - 2026-07-01 18:55

### Tests Run

- Restarted the local dev server from the active UI folder after backend changes.
- `GET /api/browser/capabilities` returned JSON through backend port `4177`.
- `GET /api/browser/capabilities` returned JSON through frontend/proxy port `5173`.
- `POST /api/browser/consult` with `Test/mock provider` returned JSON through backend port `4177`.
- `POST /api/browser/consult` with `Test/mock provider` returned JSON through frontend/proxy port `5173`.
- Malformed JSON sent to `POST /api/browser/consult` returned JSON error bodies through both ports.
- Unknown `/api` route returned JSON 404 bodies through both ports.
- In-app Browser UI test selected `Test/mock provider`, typed a local draft, clicked `Run automatic consultation`, showed four ok run-log stages, and filled the final answer box with `Browser round trip test passed.`
- Consultation History stayed at the same visible captured rows during the mock test. Nothing was saved automatically.
- `npm run check` completed successfully.

### Result

The Browser panel plumbing is now proven with the deterministic mock provider. This proves the app path from local draft -> backend route -> generated prompt -> response -> final answer box -> explicit save choices.

This does not prove the real ChatGPT controlled-browser round trip. ChatGPT can still block controlled browsers with login or verification checks, and the app must not bypass those checks.

### Fixes Made In This Loop

- Hardened frontend API parsing so non-JSON API responses become readable route/content-type errors instead of raw `Unexpected token '<'` crashes.
- Added JSON error handling for malformed backend request bodies.
- Added JSON 404 handling for unknown `/api` routes.
- Added a deterministic `Test/mock provider` route for Browser panel wiring tests.
- Added Browser health/status cards and a run-log stage panel.
- Avoided displaying a full local Chromium executable path in the UI.

### Do Not Repeat

- Do not claim real ChatGPT automation works from the mock-provider pass.
- Do not retry the real ChatGPT controlled-browser loop while a login or verification blocker is visible.
- Do not test only the backend port. Every API route used by the frontend must also be tested through the Vite proxy port.
- Do not leave API error paths returning HTML.

### Next Safest Action

Keep the mock/manual fallback path stable, then improve the real ChatGPT route only by surfacing clear blocker states and asking the user to complete login or verification in the visible browser when required.
