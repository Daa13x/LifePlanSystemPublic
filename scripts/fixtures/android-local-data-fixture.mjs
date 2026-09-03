// Browser-only deterministic native-data fixture for verify-android-ui.mjs.
// The production Android build never imports this module; Vite aliases it only
// inside the UI verifier so populated phone layouts can be exercised without a
// device SQLite bridge.

const now = '2026-09-03T08:00:00.000Z';
let capacityMode = 'normal';
let tasks = [{
  id: 'phone-task-1',
  title: 'Test',
  why: 'Prove the phone Planner stays useful without a PC.',
  nextAction: 'Use one of the task actions below.',
  activeStep: 'Use one of the task actions below.',
  definitionOfDone: 'The action completes without controls colliding.',
  easierVersion: 'Open the task and read its next step.',
  pausePoint: '', recoveryStep: '', blocker: '', consequenceOfDelay: '',
  importance: 4, effort: 2, estimatedMinutes: 15, deadline: '',
  needsOthers: false, isRecovery: false, status: 'active', pinned: false,
  reasons: ['High-value phone-native work'], presentedAs: 'full',
  createdAt: now, updatedAt: now
}];
let projects = [{ id: 'phone-project-1', name: 'Android beta', status: 'active', owner: 'user', confidence: 0.9, next_action: 'Verify the populated layout.', shareability: 'private' }];
let sessions = [{ id: 'phone-chat-1', title: 'New planning chat', pinned: 0, deleted: 0, created_at: now, updated_at: now }];
let messages = [
  { id: 'phone-message-1', session_id: 'phone-chat-1', role: 'user', content: 'Show today', created_at: now },
  { id: 'phone-message-2', session_id: 'phone-chat-1', role: 'assistant', content: 'Your phone-native task **Test** is ready. You do not need a PC for Today, projects, notes, or this local command reply.', metadata: '{}', created_at: now }
];

function bodyOf(options = {}) {
  return options.body ? JSON.parse(options.body) : {};
}

function plannerDay() {
  const active = tasks.filter((task) => task.status === 'active');
  return {
    mode: capacityMode,
    modes: ['normal', 'low-energy', 'overwhelmed', 'urgent-deadline', 'recovery-day', 'pain-illness', 'high-focus'],
    visible: active.filter((task) => !task.deferred),
    deferred: active.filter((task) => task.deferred),
    recentlyCompleted: tasks.filter((task) => task.status === 'completed'),
    visibleLimit: 5,
    pinnedCount: active.filter((task) => task.pinned).length
  };
}

export async function localPlannerApi(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = bodyOf(options);
  if (path === '/api/planner/day' && method === 'GET') return plannerDay();
  if (path === '/api/planner/capacity' && method === 'POST') { capacityMode = body.mode; return plannerDay(); }
  if (path === '/api/planner/tasks' && method === 'GET') return tasks;
  if (path === '/api/planner/tasks' && method === 'POST') {
    const task = { ...tasks[0], ...body, id: `phone-task-${tasks.length + 1}`, activeStep: body.nextAction || '', status: 'active', pinned: false, reasons: ['Added on this phone'], createdAt: now, updatedAt: now };
    tasks = [...tasks, task];
    return task;
  }
  const taskMatch = /^\/api\/planner\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch && method === 'PATCH') {
    tasks = tasks.map((task) => task.id === taskMatch[1] ? { ...task, ...body, activeStep: body.nextAction ?? task.activeStep } : task);
    return tasks.find((task) => task.id === taskMatch[1]);
  }
  const actionMatch = /^\/api\/planner\/tasks\/([^/]+)\/(complete|defer|pin)$/.exec(path);
  if (actionMatch) {
    const [, id, action] = actionMatch;
    tasks = tasks.map((task) => task.id !== id ? task : action === 'complete' ? { ...task, status: 'completed' } : action === 'defer' ? { ...task, deferred: true } : { ...task, pinned: !task.pinned });
    return tasks.find((task) => task.id === id);
  }
  throw new Error(`No Android UI fixture handler for ${method} ${path}.`);
}

export async function localChatApi(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = bodyOf(options);
  if (path === '/api/chat/sessions' && method === 'GET') return sessions.filter((session) => !session.deleted);
  if (path === '/api/chat/sessions' && method === 'POST') {
    const session = { id: `phone-chat-${sessions.length + 1}`, title: body.title || 'New planning chat', pinned: 0, deleted: 0, created_at: now, updated_at: now };
    sessions = [...sessions, session];
    return session;
  }
  const messagesMatch = /^\/api\/chat\/sessions\/([^/]+)\/messages$/.exec(path);
  if (messagesMatch && method === 'GET') return messages.filter((message) => message.session_id === messagesMatch[1]);
  const sessionMatch = /^\/api\/chat\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch && method === 'PATCH') {
    sessions = sessions.map((session) => session.id === sessionMatch[1] ? { ...session, ...body } : session);
    return sessions.find((session) => session.id === sessionMatch[1]);
  }
  throw new Error(`No Android UI fixture handler for ${method} ${path}.`);
}

export async function localListMessages(sessionId) { return messages.filter((message) => message.session_id === sessionId); }
export async function localAppendMessage(sessionId, role, content) {
  const message = { id: `phone-message-${messages.length + 1}`, session_id: sessionId, role, content, metadata: '{}', created_at: now };
  messages = [...messages, message];
  return message;
}
export async function localListTasks() { return tasks; }
export async function localPlannerDay() { return plannerDay(); }
export async function localCreateTask(body) { return localPlannerApi('/api/planner/tasks', { method: 'POST', body: JSON.stringify(body) }); }
export async function localUpdateTask(id, body) { return localPlannerApi(`/api/planner/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); }
export async function localCompleteTask(id) { return localPlannerApi(`/api/planner/tasks/${id}/complete`, { method: 'POST' }); }
export async function localDeferTask(id) { return localPlannerApi(`/api/planner/tasks/${id}/defer`, { method: 'POST' }); }
export async function localListProjects() { return projects; }
export async function localCreateProject(body) { const project = { id: `phone-project-${projects.length + 1}`, status: 'active', owner: 'user', confidence: 0.75, shareability: 'private', ...body }; projects = [...projects, project]; return project; }
export async function localUpdateProject(id, body) { projects = projects.map((project) => project.id === id ? { ...project, ...body } : project); return projects.find((project) => project.id === id); }
export async function localListProjectCards() { return []; }
export async function localCreateNote(body) { return { id: 'phone-note-1', ...body }; }
export async function localListNotes() { return []; }
export async function localCreateMemoryCandidate(body) { return { id: 'phone-memory-1', ...body }; }
export async function localSyncSettings() { return { paired: false, baseUrl: '', serverId: '', serverLabel: '' }; }
export async function localSetSyncPairing() { return { paired: true }; }
export async function localRemoveSyncPairing() { return { paired: false }; }
export async function localSyncNow() { return { status: 'not_paired', applied: 0, conflicts: 0 }; }
