// Deterministic regression coverage for src/localCommands.js -- the
// zero-API-key standalone Chat command matcher. localData.js (its only
// dependency) talks to a real on-device SQLite database via
// @capacitor-community/sqlite, which only exists inside a native
// Capacitor runtime -- there is no way to exercise it in a plain Node
// process the way this repo's other scripts/verify-*.mjs test the
// server. So this test mocks './localData.js' with node:test's built-in
// module mocking (stable since Node 22.3) and verifies localCommands.js's
// OWN logic: which text matches which pattern, what it calls, and how it
// replies -- including the ambiguity/not-found/error paths a real device
// test would be slow to exercise repeatedly.
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

const calls = [];
function resetCalls() { calls.length = 0; }

const fakeTasks = [
  { id: 'task-1', title: 'buy milk', status: 'active' },
  { id: 'task-2', title: 'email accountant', status: 'active' },
  { id: 'task-3', title: 'email landlord', status: 'active' },
  { id: 'task-4', title: 'write report', status: 'completed' },
  { id: 'task-5', title: 'archive old files', status: 'deferred' }
];

mock.module('../src/localData.js', {
  namedExports: {
    async localPlannerDay() {
      calls.push(['localPlannerDay']);
      return { mode: 'normal', visible: fakeTasks.filter((t) => t.status === 'active').slice(0, 1), deferred: [] };
    },
    async localListTasks() {
      calls.push(['localListTasks']);
      return fakeTasks;
    },
    async localCreateTask(body) {
      calls.push(['localCreateTask', body]);
      return { id: 'new-task', title: body.title };
    },
    async localCompleteTask(id) {
      calls.push(['localCompleteTask', id]);
    },
    async localDeferTask(id) {
      calls.push(['localDeferTask', id]);
    },
    async localUpdateTask(id, fields) {
      calls.push(['localUpdateTask', id, fields]);
    },
    async localCreateNote(body) {
      calls.push(['localCreateNote', body]);
      return { id: 'new-note', body: body.body };
    },
    async localListNotes() {
      calls.push(['localListNotes']);
      return [{ id: 'note-1', body: 'remember the gate code' }];
    },
    async localCreateMemoryCandidate(body) {
      calls.push(['localCreateMemoryCandidate', body]);
      return { id: 'new-candidate', body: body.body };
    }
  }
});

const { matchLocalCommand, isLocalCommandPattern, LOCAL_COMMAND_EXAMPLES } = await import('../src/localCommands.js');

test('today-summary matches and reads the local planner day', async () => {
  resetCalls();
  const result = await matchLocalCommand('What do I need to do today?');
  assert.equal(result.handled, true);
  assert.match(result.reply, /buy milk/);
  assert.deepEqual(calls, [['localPlannerDay']]);
});

test('list-goals filters to active tasks only', async () => {
  resetCalls();
  const result = await matchLocalCommand('What goals am I working on?');
  assert.equal(result.handled, true);
  assert.match(result.reply, /buy milk/);
  assert.doesNotMatch(result.reply, /write report/, 'a completed task must not appear as an active goal');
});

test('show-completed lists only completed tasks', async () => {
  resetCalls();
  const result = await matchLocalCommand('Show completed tasks.');
  assert.equal(result.handled, true);
  assert.match(result.reply, /write report/);
  assert.doesNotMatch(result.reply, /buy milk/);
});

test('mark-done resolves a single unambiguous match and completes it', async () => {
  resetCalls();
  const result = await matchLocalCommand('mark buy milk done');
  assert.equal(result.handled, true);
  assert.deepEqual(calls, [['localListTasks'], ['localCompleteTask', 'task-1']]);
  assert.match(result.reply, /Marked done: buy milk/);
});

test('mark-done refuses to guess between two ambiguous matches', async () => {
  resetCalls();
  const result = await matchLocalCommand('mark email done');
  assert.equal(result.handled, true);
  assert.ok(!calls.some((c) => c[0] === 'localCompleteTask'), 'must not complete either task when the match is ambiguous');
  assert.match(result.reply, /matches 2 tasks/);
  assert.match(result.reply, /email accountant/);
  assert.match(result.reply, /email landlord/);
});

test('mark-done reports a clear not-found message for no match', async () => {
  resetCalls();
  const result = await matchLocalCommand('mark nonexistent task done');
  assert.equal(result.handled, true);
  assert.ok(!calls.some((c) => c[0] === 'localCompleteTask'));
  assert.match(result.reply, /couldn't find an active task/);
});

test('defer resolves unambiguously and is honest about "until" not being scheduled', async () => {
  resetCalls();
  const result = await matchLocalCommand('defer buy milk until tomorrow');
  assert.equal(result.handled, true);
  assert.deepEqual(calls, [['localListTasks'], ['localDeferTask', 'task-1']]);
  assert.match(result.reply, /Deferred: buy milk/);
  assert.match(result.reply, /isn't scheduled yet/, 'must not silently pretend to honor a reactivation date it does not implement');
});

test('show-deferred lists only deferred-status tasks', async () => {
  resetCalls();
  const result = await matchLocalCommand('show deferred');
  assert.equal(result.handled, true);
  assert.match(result.reply, /archive old files/);
  assert.doesNotMatch(result.reply, /buy milk/);
});

test('reactivate moves a deferred task back to active', async () => {
  resetCalls();
  const result = await matchLocalCommand('reactivate archive old files');
  assert.equal(result.handled, true);
  assert.deepEqual(calls, [['localListTasks'], ['localUpdateTask', 'task-5', { status: 'active' }]]);
  assert.match(result.reply, /Reactivated: archive old files/);
});

test('add-task creates a task with the given title', async () => {
  resetCalls();
  const result = await matchLocalCommand('add buy stamps');
  assert.equal(result.handled, true);
  assert.deepEqual(calls, [['localCreateTask', { title: 'buy stamps' }]]);
  assert.match(result.reply, /Added: buy stamps/);
});

test('remember-that creates a memory candidate, never promotes silently', async () => {
  resetCalls();
  const result = await matchLocalCommand('remember that the gate code is 4821');
  assert.equal(result.handled, true);
  assert.deepEqual(calls, [['localCreateMemoryCandidate', { body: 'the gate code is 4821' }]]);
  assert.match(result.reply, /memory candidate \(not yet reviewed\)/);
});

test('note-capture creates a note via both "note:" and "capture:" prefixes', async () => {
  resetCalls();
  const a = await matchLocalCommand('note: pick up dry cleaning');
  assert.deepEqual(calls, [['localCreateNote', { body: 'pick up dry cleaning' }]]);
  resetCalls();
  const b = await matchLocalCommand('capture: call the plumber');
  assert.deepEqual(calls, [['localCreateNote', { body: 'call the plumber' }]]);
  assert.match(a.reply, /Noted: pick up dry cleaning/);
  assert.match(b.reply, /Noted: call the plumber/);
});

test('show-notes lists captured notes', async () => {
  resetCalls();
  const result = await matchLocalCommand('show notes');
  assert.equal(result.handled, true);
  assert.match(result.reply, /remember the gate code/);
});

test('unmatched free text is reported as not handled, never guessed at', async () => {
  resetCalls();
  const result = await matchLocalCommand('tell me a joke');
  assert.deepEqual(result, { handled: false });
  assert.deepEqual(calls, []);
});

test('isLocalCommandPattern is side-effect-free and matches without executing', async () => {
  resetCalls();
  assert.equal(isLocalCommandPattern('add buy milk'), true);
  assert.equal(isLocalCommandPattern('what is the weather'), false);
  assert.deepEqual(calls, [], 'pattern testing alone must never call a localData function');
});

test('every LOCAL_COMMAND_EXAMPLES entry is phrased so a real pattern actually matches it', async () => {
  const concreteExamples = LOCAL_COMMAND_EXAMPLES
    .map((example) => example
      .replace('<task>', 'buy milk')
      .replace('<fact>', 'the gate code is 4821')
      .replace('<text>', 'pick up dry cleaning'));
  for (const example of concreteExamples) {
    assert.ok(isLocalCommandPattern(example), `example does not match any real pattern: "${example}"`);
  }
});

console.log('Local command matcher verification passed.');
