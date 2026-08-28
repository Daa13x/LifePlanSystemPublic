import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring check for the Capacity-Aware Daily Planner UI. Like the other
// *-ui verifiers this asserts the real client/server contract rather than copy,
// and — critically — that the frontend renders the server's transparent plan
// verbatim: it must NOT re-implement or re-run the ranking itself.

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ui = read('src/main.jsx');
const navigation = read('src/navigation.js');
const server = read('server/index.js');

// Isolate the planner UI so the "no client-side ranking" checks can't be
// satisfied (or broken) by unrelated code elsewhere in the file.
const sliceStart = ui.indexOf('const EMPTY_PLANNER_FORM');
const sliceEnd = ui.indexOf('function Knowledge(');
assert.ok(sliceStart !== -1 && sliceEnd !== -1 && sliceEnd > sliceStart, 'planner UI slice is present in src/main.jsx');
const planner = ui.slice(sliceStart, sliceEnd);

// --- navigation: Today is a Workboard tab and survives refresh via the hash ---
assert.match(navigation, /\{ id: 'today', label: 'Today' \}/, 'navigation registers the Today tab');
// A registered tab is what makes routeFromHash('#workboard/today') resolve, so
// the selection survives a reload through the existing navigation-state mechanism.
assert.match(ui, /route\.tab === 'today' && <DailyPlanner[^>]*refreshSignal=\{refreshSignal\}/, 'Workboard renders DailyPlanner for the today tab');
assert.match(ui, /function DailyPlanner\(/, 'DailyPlanner component exists');

// --- capacity modes: all seven, from the server, persisted via CSRF POST ---
assert.match(planner, /modes\.map\(/, 'capacity modes are rendered from the server list (not a hardcoded subset)');
assert.match(planner, /api\('\/api\/planner\/capacity', \{ method: 'POST', body: JSON\.stringify\(\{ mode \}\) \}\)/, 'mode changes persist through the capacity endpoint');
assert.doesNotMatch(planner, /CAPACITY_MODES\s*=/, 'the UI does not redefine the mode list');

// --- the frontend must not re-rank or re-score: it renders server order ---
assert.doesNotMatch(planner, /\.sort\(/, 'the planner UI never sorts tasks itself');
assert.doesNotMatch(planner, /scoreTask|planDay|capacityModeProfile/, 'the planner UI never reruns the ranking engine');
assert.match(planner, /visible\.filter\(\(task\) => !task\.blocker\)/, 'the Now list is the server visible list, only split by blocker');
assert.match(planner, /deferred\.filter\(\(task\) => !task\.blocker\)/, 'the Later list is the server deferred list, only split by blocker');
assert.match(planner, /\[\.\.\.visible, \.\.\.deferred\]\.filter\(\(task\) => task\.blocker\)/, 'blocked tasks are surfaced in their own section, never hidden');

// --- three honest sections ---
for (const heading of ['>Now<', '>Blocked<', '>Later<']) {
  assert.ok(planner.includes(heading), `planner renders the ${heading.replace(/[<>]/g, '')} section`);
}
assert.ok(planner.includes('>Recently completed<'), 'planner renders recent completion history separately');
assert.ok(planner.includes('Completion is not independent verification.'), 'planner distinguishes completion state from verification');
assert.ok(planner.includes('Legacy history unavailable · Verification unknown'), 'legacy completed tasks receive no fabricated history or verification');
assert.ok(planner.includes('History available (') && planner.includes(' · Unverified'), 'recorded lifecycle history is labelled unverified');

// --- every populated guidance field is shown ---
for (const field of ['activeStep', 'task.why', 'definitionOfDone', 'easierVersion', 'pausePoint', 'recoveryStep', 'task.blocker', 'task.deadline', 'task.effort', 'estimatedMinutes', 'task.reasons']) {
  assert.ok(planner.includes(field), `planner renders the ${field} guidance field`);
}

// --- task creation + editing cover the advanced backend fields ---
assert.match(planner, /api\('\/api\/planner\/tasks', \{ method: 'POST', body: JSON\.stringify\(form\) \}\)/, 'creating a task posts the full form');
assert.match(planner, /api\(`\/api\/planner\/tasks\/\$\{id\}`, \{ method: 'PATCH', body: JSON\.stringify\(editForm\) \}\)/, 'editing a task patches the existing endpoint');
for (const field of ['definitionOfDone', 'pausePoint', 'recoveryStep', 'consequenceOfDelay', 'estimatedMinutes', 'needsOthers', 'isRecovery']) {
  assert.ok(planner.includes(field), `the task form exposes the advanced ${field} field`);
}

// --- complete / pin / defer / edit controls hit the real endpoints ---
assert.match(planner, /api\(`\/api\/planner\/tasks\/\$\{id\}\/\$\{path\}`, \{ method: 'POST'/, 'task actions post to the per-action endpoints');
for (const action of ["'complete'", "'pin'", "'defer'"]) {
  assert.ok(planner.includes(`onAction(task.id, ${action})`), `the ${action} control is wired`);
}
assert.ok(planner.includes('onEdit(task)'), 'the edit control is wired');

// --- honest loading / empty / saving / error states, and form preserved on failure ---
assert.match(planner, /if \(loading && !day\) return <Empty/, 'an honest loading state is shown');
assert.ok(planner.includes('<Empty title="Nothing scheduled"'), 'an empty state is shown when there is nothing to do');
assert.match(planner, /role="alert"/, 'errors are surfaced to assistive tech');
assert.match(planner, /setError\(err\.message\)/, 'request errors are captured and displayed');
assert.match(planner, /'Adding…'|'Saving…'/, 'a saving state is shown while a request is in flight');
// The form is only cleared after the create/edit call resolves successfully, so
// a failed request leaves the user's typed values intact.
assert.match(planner, /const ok = await act\('create'[\s\S]*?if \(ok\) \{ setForm\(EMPTY_PLANNER_FORM\)/, 'the create form is preserved when the request fails');
assert.match(planner, /if \(ok\) setEditingId\(null\)/, 'the edit form is preserved when the request fails');

// --- the server endpoints the UI depends on exist and are bounded ---
assert.match(server, /app\.get\('\/api\/planner\/day'/, 'the day endpoint exists');
assert.match(server, /app\.get\('\/api\/planner\/capacity'/, 'the capacity read endpoint exists');
assert.match(server, /app\.post\('\/api\/planner\/capacity'/, 'the capacity write endpoint exists');
assert.match(server, /app\.post\('\/api\/planner\/tasks'/, 'the task create endpoint exists');
assert.match(server, /app\.patch\('\/api\/planner\/tasks\/:id'/, 'the task edit endpoint exists');
assert.match(server, /app\.get\('\/api\/planner\/tasks\/:id\/events'/, 'the append-only Planner history endpoint exists');
for (const action of ['complete', 'pin', 'defer']) {
  assert.match(server, new RegExp(`app\\.post\\('/api/planner/tasks/:id/${action}'`), `the ${action} endpoint exists`);
}

console.log('Capacity-aware daily planner UI wiring verification passed.');
