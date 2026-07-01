# Browser Consultation Test Checklist — 2026-06-30

Repo: `Daa13x/LifePlanSystemPublic`  
Branch: `UI`

## Issue

Browser > Consultation Draft appears to do nothing when text such as `test` is typed.

Important: this app uses **Playwright**, not Puppeteer.

Typing in the local draft box currently only updates front-end state. It does not automatically build a prompt, open a browser, or save a consultation.

## Evidence already seen

The app has shown:

```text
Planner refresh complete. No governed changes proposed.
```

That means the planner route and backend connection probably work, but it does not prove the Browser panel works.

## Files to inspect

```text
src/main.jsx
src/styles.css
server/index.js
server/db.js
package.json
vite.config.js
```

Likely areas:

```text
BrowserConsult component
GET /api/browser/capabilities
POST /api/browser/open
/api/consultations routes
```

## Checks to run

1. Planner check
   - Go to Planner.
   - Click refresh.
   - Record whether the planner success message appears.

2. Browser draft check
   - Go to Browser.
   - Type `test` into “Local draft to critique”.
   - Confirm typing alone only updates the box.

3. Build prompt check
   - Click “Build prompt”.
   - Confirm a generated consultation prompt appears.

4. Copy check
   - Click “Copy”.
   - Confirm clipboard copy works or record the error.

5. Playwright capability check
   - Check `GET /api/browser/capabilities`.
   - Record whether Playwright is available.
   - If unavailable, check Tooling > Install Playwright.

6. Open browser check
   - Use URL `https://chatgpt.com/`.
   - Click “Open”.
   - Confirm whether a Playwright browser opens or record the exact error.

7. Copy + Open check
   - Type `test`.
   - Click “Copy + Open”.
   - Expected: prompt builds, copies, consultation row is created, browser opens, and the UI gives a useful result/error.

8. Save consultation check
   - Paste test text into captured response.
   - Click “Save as reviewable suggestion”.
   - Confirm it appears in Consultation History.
   - Confirm nothing is promoted automatically.

## UX fix target

Make Browser feedback clearer. Add visible helper text such as:

```text
Typing here only drafts local text. Click Build prompt to generate the consultation prompt. Click Copy + Open to use Playwright browser automation.
```

If buttons are disabled, show why:

- Playwright unavailable;
- no draft entered;
- browser busy;
- backend/browser route error.

## Report format

```text
Planner refresh test:
Browser draft typing test:
Build prompt test:
Copy test:
Playwright capability:
Open browser test:
Copy + Open test:
Save consultation test:
Was this Puppeteer or Playwright?:
Root cause:
Fix made:
Remaining issue:
Commits:
How Alex should test it:
```
