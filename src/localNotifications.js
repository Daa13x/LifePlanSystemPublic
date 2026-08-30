// Phase 3: local task-deadline reminders, entirely on-device via
// @capacitor/local-notifications -- no server, no push service, no network.
// Notification actions (Done/Later) call straight into src/localData.js so
// acting on a reminder does exactly what tapping the same button in the app
// would do -- one lifecycle owner, not a second copy of task-completion
// logic living in a notification handler.

import { Capacitor } from '@capacitor/core';

const ACTION_TYPE = 'lps-task-reminder';
let listenersRegistered = false;
let registeringActions = null;

// The plugin requires a 32-bit integer notification id; tasks are keyed by
// UUID. A deterministic hash (not a mapping table to keep in sync) means
// scheduling, rescheduling, and cancelling a given task's reminder always
// resolve to the same id without persisting anything extra. FNV-1a for a
// well-distributed 32-bit value, masked to Android's signed-int range
// (0x7FFFFFFF, not Math.abs -- abs(-2147483648) overflows back out of range).
function notificationIdFor(taskId) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < taskId.length; i += 1) {
    hash ^= taskId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash & 0x7fffffff) || 1;
}

async function loadPlugin() {
  if (!Capacitor.isNativePlatform()) return null;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  return LocalNotifications;
}

export async function ensureNotificationPermission() {
  const plugin = await loadPlugin();
  if (!plugin) return false;
  const current = await plugin.checkPermissions();
  if (current.display === 'granted') return true;
  const requested = await plugin.requestPermissions();
  return requested.display === 'granted';
}

// Wires "Done"/"Later" notification actions to the same local task
// functions the app's own UI uses. Call once at app startup (idempotent --
// re-registering the same action type/listener is harmless, but this still
// guards against attaching duplicate listeners across re-renders).
export async function registerReminderActions({ onDone, onDefer }) {
  const plugin = await loadPlugin();
  if (!plugin || listenersRegistered) return;
  // A transient failure here must not permanently prevent retry for the
  // rest of the process -- only mark registered once both calls actually
  // succeed, and let a concurrent caller await the same in-flight attempt
  // rather than double-register.
  if (registeringActions) return registeringActions;
  registeringActions = (async () => {
    await plugin.registerActionTypes({
      types: [{
        id: ACTION_TYPE,
        actions: [
          { id: 'done', title: 'Done' },
          { id: 'later', title: 'Later' }
        ]
      }]
    });
    await plugin.addListener('localNotificationActionPerformed', async (event) => {
      const taskId = event.notification?.extra?.taskId;
      if (!taskId) return;
      // The plugin's cancel() only removes a PENDING alarm, not a
      // notification already delivered and sitting in the shade -- a tap on
      // a stale one must not silently apply. onDone/onDefer are expected to
      // check current status and no-op (or throw a caught error) if it's
      // no longer meaningful; that check lives with the task lifecycle in
      // src/localData.js, not duplicated here.
      if (event.actionId === 'done') await onDone(taskId);
      else if (event.actionId === 'later') await onDefer(taskId);
    });
    listenersRegistered = true;
  })();
  try {
    await registeringActions;
  } finally {
    registeringActions = null;
  }
}

// Schedules (or reschedules, replacing any existing one) a reminder for a
// task's deadline. A task with no deadline, or one already completed/
// deferred/parked, has nothing to schedule -- callers should cancel instead.
export async function scheduleTaskReminder(task) {
  const plugin = await loadPlugin();
  if (!plugin) return;
  const id = notificationIdFor(task.id);
  // Cancel any existing alarm for this task FIRST, unconditionally -- a
  // deadline edited to a past/invalid value, or a task no longer active,
  // must not leave the previous alarm still armed just because the new
  // value doesn't qualify for a fresh one.
  await plugin.cancel({ notifications: [{ id }] });
  if (!task.deadline || task.status !== 'active') return;
  const at = new Date(task.deadline);
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return;
  await plugin.schedule({
    notifications: [{
      id,
      title: 'LifePlanSystem',
      body: task.title,
      schedule: { at },
      actionTypeId: ACTION_TYPE,
      extra: { taskId: task.id }
    }]
  });
}

export async function cancelTaskReminder(taskId) {
  const plugin = await loadPlugin();
  if (!plugin) return;
  await plugin.cancel({ notifications: [{ id: notificationIdFor(taskId) }] });
}

// Called after every task-list load/mutation (Today's own refresh, a
// deterministic Chat command, a notification action) -- not just once at
// startup: @capacitor/local-notifications' own Android side already
// persists scheduled alarms across a reboot (it ships its own
// RECEIVE_BOOT_COMPLETED receiver, merged into the app manifest by Gradle),
// but this is a cheap, idempotent safety net regardless -- it reconciles
// reminders against the CURRENT task list, so a task completed/deferred/
// deleted anywhere doesn't leave a stale reminder behind.
//
// Serialized (never run two reconciliations concurrently): each run reads
// pending state, then cancels/reschedules based on what it read, so an
// older, still-in-flight run finishing after a newer one could otherwise
// re-schedule a reminder the newer run just correctly cancelled.
let reconcileChain = Promise.resolve();
export function reconcileAllReminders(activeTasksWithDeadlines) {
  reconcileChain = reconcileChain
    .catch(() => {}) // a prior run's failure must not wedge the queue
    .then(() => reconcileAllRemindersNow(activeTasksWithDeadlines));
  return reconcileChain;
}

async function reconcileAllRemindersNow(activeTasksWithDeadlines) {
  const plugin = await loadPlugin();
  if (!plugin) return;
  const pending = await plugin.getPending();
  const known = new Set(activeTasksWithDeadlines.map((t) => notificationIdFor(t.id)));
  const stale = pending.notifications.filter((n) => n.extra?.taskId && !known.has(n.id));
  if (stale.length) await plugin.cancel({ notifications: stale.map((n) => ({ id: n.id })) });
  for (const task of activeTasksWithDeadlines) await scheduleTaskReminder(task);
}
