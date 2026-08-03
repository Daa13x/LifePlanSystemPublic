#!/usr/bin/env node
// Verify the transparent capacity-aware planner using the REAL
// server/capacityPlanner.js module. Local-only: no network, no server, no DB.
// Exit 0 = pass.

import {
  CAPACITY_MODES,
  DEFAULT_CAPACITY_MODE,
  normalizeCapacityMode,
  capacityModeProfile,
  scoreTask,
  planDay
} from '../server/capacityPlanner.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };
const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const inDays = (n) => new Date(NOW + n * 86400000).toISOString();

console.log('--- capacity planner verification ---');

// --- modes are explicit, never inferred ---
line(CAPACITY_MODES.length === 7 && CAPACITY_MODES.includes('overwhelmed') && CAPACITY_MODES.includes('high-focus'), 'seven explicit capacity modes are defined');
line(normalizeCapacityMode('LOW-ENERGY') === 'low-energy', 'a known mode is accepted case-insensitively');
line(normalizeCapacityMode('exhausted') === DEFAULT_CAPACITY_MODE && normalizeCapacityMode('') === 'normal', 'an unknown/empty mode falls back to normal (no silent medical state)');

// --- scoring is transparent: every score carries human-readable reasons ---
{
  const { score, reasons } = scoreTask({ title: 'A', importance: 3 }, 'normal', NOW);
  line(Number.isFinite(score) && Array.isArray(reasons) && reasons.some((r) => /importance/.test(r)), 'scoreTask returns a finite score with explanatory reasons');
}
line(scoreTask({ importance: 5 }, 'normal', NOW).score > scoreTask({ importance: 1 }, 'normal', NOW).score, 'higher importance raises the score');

// --- deadlines ---
line(scoreTask({ deadline: inDays(1) }, 'normal', NOW).score > scoreTask({ deadline: inDays(20) }, 'normal', NOW).score, 'a nearer deadline scores higher');
{
  const near = { deadline: inDays(1) };
  const urgentGain = scoreTask(near, 'urgent-deadline', NOW).score - scoreTask({}, 'urgent-deadline', NOW).score;
  const normalGain = scoreTask(near, 'normal', NOW).score - scoreTask({}, 'normal', NOW).score;
  line(urgentGain > normalGain, 'urgent-deadline mode weights the deadline more than normal mode');
  line(scoreTask({ deadline: inDays(-2) }, 'normal', NOW).reasons.some((r) => /past its deadline/.test(r)), 'an overdue task is flagged as past its deadline');
}

// --- effort is eased back in low-capacity modes ---
line(scoreTask({ effort: 5 }, 'low-energy', NOW).score < scoreTask({ effort: 5 }, 'normal', NOW).score, 'a high-effort task is eased back in low-energy mode');
line(scoreTask({ effort: 5 }, 'low-energy', NOW).reasons.some((r) => /eased back/.test(r)), 'the easing-back is explained to the user');

// --- blockers and recovery ---
line(scoreTask({ blocker: 'waiting on X' }, 'normal', NOW).score < scoreTask({}, 'normal', NOW).score, 'a blocked task is held back');
line(scoreTask({ isRecovery: true }, 'recovery-day', NOW).score > scoreTask({ isRecovery: true }, 'normal', NOW).score, 'a recovery step is lifted up on a recovery day');

// --- planDay shaping ---
const tasks = [
  { title: 'Taxes', importance: 5, deadline: inDays(2), effort: 4 },
  { title: 'Emails', importance: 2, effort: 2 },
  { title: 'Deep report', importance: 4, effort: 5, easierVersion: 'Draft one paragraph' },
  { title: 'Call plumber', importance: 3, needsOthers: true },
  { title: 'Tidy desk', importance: 1, effort: 1 },
  { title: 'Rest / short walk', importance: 2, isRecovery: true },
  { title: 'Blocked thing', importance: 4, blocker: 'need info' },
  { title: 'Read', importance: 1, effort: 2 }
];
const normalPlan = planDay(tasks, 'normal', NOW);
const overwhelmedPlan = planDay(tasks, 'overwhelmed', NOW);
line(normalPlan.visibleLimit === 7 && overwhelmedPlan.visibleLimit === 2, 'overwhelmed mode shows far fewer tasks than normal');
line(overwhelmedPlan.visible.length <= 2 && overwhelmedPlan.deferred.length >= tasks.length - 2, 'the rest of the day is deferred, not dropped');
line(overwhelmedPlan.deferred.every((t) => t.state === 'deferred' && /not a failure/i.test(t.deferReason)), 'deferred tasks are framed as a choice, never a failure');
line(overwhelmedPlan.visible.every((t) => Array.isArray(t.reasons) && t.reasons.length > 0), 'every shown task explains why it is there');

// easier version surfaces only in easier-preferring modes
{
  const low = planDay(tasks, 'low-energy', NOW).visible.concat(planDay(tasks, 'low-energy', NOW).deferred).find((t) => t.title === 'Deep report');
  const norm = normalPlan.visible.concat(normalPlan.deferred).find((t) => t.title === 'Deep report');
  line(low.presentedAs === 'easier' && low.activeStep === 'Draft one paragraph', 'low-energy surfaces the easier version of a big task');
  line(norm.presentedAs === 'full', 'normal mode keeps the full task');
}

// urgent-deadline surfaces the deadline task at the top; blocked stays visible-as-blocked
{
  const urgent = planDay(tasks, 'urgent-deadline', NOW);
  line(urgent.visible[0].title === 'Taxes', 'urgent-deadline puts the deadline task first');
  const all = urgent.visible.concat(urgent.deferred);
  const blocked = all.find((t) => t.title === 'Blocked thing');
  line(Boolean(blocked) && blocked.reasons.some((r) => /blocked/i.test(r)), 'a blocked task stays present and is shown as blocked, not hidden');
}

// pinning is an explicit user override: a low-priority pinned task stays visible
// even in a mode that would otherwise defer it
{
  const withPin = tasks.map((task) => (task.title === 'Read' ? { ...task, pinned: true } : task));
  const plan = planDay(withPin, 'overwhelmed', NOW);
  line(plan.visible.some((t) => t.title === 'Read'), 'a pinned task stays visible even in overwhelmed mode (user override)');
  line(plan.pinnedCount === 1, 'the plan reports how many tasks are pinned');
}

// no hidden clinical score: the only numeric ranking field is `score`, always paired with reasons
line(normalPlan.visible.every((t) => typeof t.score === 'number' && Array.isArray(t.reasons)), 'ordering exposes only a transparent score with reasons (no hidden clinical rating)');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll capacity-planner checks passed.');
process.exit(failures ? 1 : 0);
