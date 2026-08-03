// Transparent, capacity-aware day planning. Pure (no DB / IO) so it can be
// unit-tested directly against the same code the server will use.
//
// Principles this encodes deliberately:
//   * No clinical or hidden "capacity score" — the current mode is set
//     EXPLICITLY by the user, never inferred or diagnosed by the system.
//   * Every ordering decision is explainable: scoreTask returns a `reasons`
//     list so the UI can show WHY a task is where it is.
//   * Deferral is never failure: tasks beyond the day's visible limit are
//     returned as `deferred` with a plain, non-shaming reason, not hidden.
//   * Lower-capacity modes show fewer tasks, ease back high-effort work, and can
//     surface an easier version and recovery steps — always as suggestions the
//     user can override.

export const CAPACITY_MODES = ['normal', 'low-energy', 'overwhelmed', 'urgent-deadline', 'recovery-day', 'pain-illness', 'high-focus'];
export const DEFAULT_CAPACITY_MODE = 'normal';

export function normalizeCapacityMode(value) {
  const mode = String(value || '').toLowerCase().trim();
  return CAPACITY_MODES.includes(mode) ? mode : DEFAULT_CAPACITY_MODE;
}

// Per-mode shaping knobs. These are transparent settings, not a diagnosis:
//   visible        — how many tasks to show at once (small = calmer list);
//   effortBias     — how much high-effort work is eased back (negative = eased);
//   deadlineWeight — how strongly deadlines pull work forward;
//   prefersEasier  — surface a task's easier version when it has one;
//   surfaceRecovery— lift recovery / self-care steps toward the top.
const MODE_PROFILE = {
  'normal': { visible: 7, effortBias: 0, deadlineWeight: 1, prefersEasier: false, surfaceRecovery: false },
  'low-energy': { visible: 3, effortBias: -2, deadlineWeight: 1, prefersEasier: true, surfaceRecovery: false },
  'overwhelmed': { visible: 2, effortBias: -3, deadlineWeight: 0.5, prefersEasier: true, surfaceRecovery: true },
  'urgent-deadline': { visible: 5, effortBias: 0, deadlineWeight: 3, prefersEasier: false, surfaceRecovery: false },
  'recovery-day': { visible: 2, effortBias: -3, deadlineWeight: 0.5, prefersEasier: true, surfaceRecovery: true },
  'pain-illness': { visible: 2, effortBias: -3, deadlineWeight: 0.5, prefersEasier: true, surfaceRecovery: true },
  'high-focus': { visible: 5, effortBias: 1, deadlineWeight: 1.5, prefersEasier: false, surfaceRecovery: false }
};

export function capacityModeProfile(mode) {
  return MODE_PROFILE[normalizeCapacityMode(mode)];
}

function clamp(value, low, high, fallback = low) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
}

function daysUntil(deadline, now) {
  if (!deadline) return null;
  const time = Date.parse(deadline);
  return Number.isFinite(time) ? (time - now) / 86400000 : null;
}

// Score one task transparently for the current mode. Returns { score, reasons }.
// The reasons array is the whole point: it is the human-readable explanation of
// the ordering, so nothing about the priority is hidden from the user.
export function scoreTask(task, mode = DEFAULT_CAPACITY_MODE, now = Date.now()) {
  const profile = capacityModeProfile(mode);
  const reasons = [];
  let score = 0;

  const importance = clamp(task.importance ?? 3, 1, 5, 3);
  score += importance * 4;
  reasons.push(`importance ${importance}/5`);

  const days = daysUntil(task.deadline, now);
  if (days !== null) {
    const proximity = days <= 0 ? 20 : Math.max(0, 20 - days);
    score += proximity * profile.deadlineWeight;
    reasons.push(days <= 0 ? 'past its deadline' : `deadline in about ${Math.max(0, Math.round(days))} day(s)`);
  }

  const effort = clamp(task.effort ?? 3, 1, 5, 3);
  score += (effort - 3) * profile.effortBias;
  if (profile.effortBias < 0 && effort >= 4) reasons.push('high-effort, eased back for your current capacity');
  if (profile.effortBias > 0 && effort >= 4) reasons.push('high-effort, a good fit for a high-focus day');

  if (task.blocker) { score -= 15; reasons.push('blocked — its blocker needs clearing first'); }
  if (task.needsOthers) { score -= 3; reasons.push('waiting on another person'); }
  if (task.isRecovery && profile.surfaceRecovery) { score += 25; reasons.push('a recovery step, lifted up for today'); }

  return { score, reasons };
}

// Order and shape the day for the given mode. Returns:
//   { mode, visibleLimit, visible, deferred }
// visible tasks carry their score + reasons and the step to actually do
// (`activeStep`, the easier version in easier-preferring modes); deferred tasks
// are explicitly "not today", never failed, and blocked tasks stay visible-as-
// blocked rather than being hidden.
export function planDay(tasks, mode = DEFAULT_CAPACITY_MODE, now = Date.now()) {
  const resolvedMode = normalizeCapacityMode(mode);
  const profile = capacityModeProfile(resolvedMode);
  const scored = (Array.isArray(tasks) ? tasks : []).map((task) => {
    const { score, reasons } = scoreTask(task, resolvedMode, now);
    const useEasier = profile.prefersEasier && Boolean(task.easierVersion);
    return {
      ...task,
      score,
      reasons,
      presentedAs: useEasier ? 'easier' : 'full',
      activeStep: useEasier ? task.easierVersion : (task.nextAction || null)
    };
  }).sort((a, b) => b.score - a.score || String(a.title || '').localeCompare(String(b.title || '')));

  // Pinned tasks are the user's explicit override: they stay visible even beyond
  // the mode's limit. Remaining slots are filled by score; the rest are deferred.
  const pinned = scored.filter((task) => task.pinned);
  const rest = scored.filter((task) => !task.pinned);
  const remainingSlots = Math.max(0, profile.visible - pinned.length);
  const visible = [...pinned, ...rest.slice(0, remainingSlots)]
    .sort((a, b) => b.score - a.score || String(a.title || '').localeCompare(String(b.title || '')));
  const deferred = rest.slice(remainingSlots).map((task) => ({
    ...task,
    state: 'deferred',
    deferReason: 'held for another day to keep today manageable — this is a choice, not a failure'
  }));
  return { mode: resolvedMode, visibleLimit: profile.visible, pinnedCount: pinned.length, visible, deferred };
}
