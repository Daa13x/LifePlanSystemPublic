// Chat command discovery is a thin presentation adapter over the universal
// action registry. It does not own execution, permission, risk, confirmation,
// or audit behaviour: every entry names one registered action and the live API
// enriches it from that action's authoritative contract.

export const CHAT_COMMANDS = Object.freeze([
  { command: '/status', actionId: 'system.status', intent: 'system_status', label: 'System status', description: 'Show a concise local health summary.', category: 'Read' },
  { command: '/model', actionId: 'system.models', intent: 'model_query', label: 'Current model', description: 'Show the assigned local Planner Assistant.', category: 'Read' },
  { command: '/runs', actionId: 'system.runs', intent: 'recent_runs', label: 'Recent runs', description: 'List recent local runs.', category: 'Read' },
  { command: '/today', actionId: 'planner.today', intent: 'planner_today', label: 'Today', description: 'Read the current Daily Planner view.', category: 'Read' },
  { command: '/projects', actionId: 'workboard.list', intent: 'workboard_list', label: 'Projects', description: 'List active Workboard projects.', category: 'Read' },
  { command: '/blockers', actionId: 'workboard.list', intent: 'blocked_query', label: 'Blockers', description: 'List currently blocked Workboard items.', category: 'Read' },
  { command: '/open-today', actionId: 'navigation.planner', label: 'Open Today', description: 'Navigate this window to Today.', category: 'Navigate', direct: true, customizable: true },
  { command: '/workboard', actionId: 'navigation.workboard', label: 'Open Workboard', description: 'Navigate this window to the Workboard.', category: 'Navigate', direct: true, customizable: true },
  { command: '/diagnostics', actionId: 'navigation.system', label: 'Open Diagnostics', description: 'Open System diagnostics outside Chat.', category: 'Navigate', direct: true, customizable: true },
  { command: '/settings', actionId: 'navigation.settings', label: 'Open Settings', description: 'Open LifePlanSystem settings.', category: 'Navigate', direct: true, customizable: true },
  { command: '/add-task', usage: '/add-task <title>', actionId: 'planner.propose_create', label: 'Add Planner task', description: 'Prepare a task proposal for Allow or Decline.', category: 'Propose', direct: true }
].map((entry) => Object.freeze(entry)));

const BY_COMMAND = new Map(CHAT_COMMANDS.map((entry) => [entry.command, entry]));

export function explicitChatCommand(message) {
  const text = String(message || '').trim();
  const command = text.match(/^(\/[a-z][a-z0-9-]*)(?:\s|$)/i)?.[1]?.toLowerCase();
  return command ? BY_COMMAND.get(command) || null : null;
}

export function explicitChatCommandIntent(message) {
  return explicitChatCommand(message)?.intent || null;
}

export function buildChatCommandCatalog(actions) {
  const contracts = new Map((actions || []).map((action) => [action.id, action]));
  return CHAT_COMMANDS.map((entry) => {
    const action = contracts.get(entry.actionId);
    if (!action) throw new Error(`Chat command ${entry.command} targets unknown action ${entry.actionId}.`);
    return {
      ...entry,
      permission: action.permission,
      risk: action.risk,
      confirmation: action.confirmation,
      available: action.availability?.available !== false
    };
  });
}
