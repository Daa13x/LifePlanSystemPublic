export const PRIMARY_NAVIGATION = [
  { id: 'chat', label: 'Chat' },
  { id: 'knowledge', label: 'Knowledge', defaultTab: 'memory' },
  { id: 'system', label: 'System', defaultTab: 'status' },
  { id: 'workboard', label: 'Workboard', defaultTab: 'overview' }
];

// Closed Beta v0.1: a phone tester only needs the core LPS journey (Chat,
// Today/Projects/Cards/Completed). Knowledge/System/Roadmap/Review are
// desktop-oriented dev tooling (repository, browser automation, source
// control, calibration) that a beta tester should never land on by
// accident. Hidden from the mobile nav only -- nothing here is deleted or
// removed from the desktop app.
export const MOBILE_PRIMARY_NAVIGATION = PRIMARY_NAVIGATION.filter((entry) => entry.id === 'chat' || entry.id === 'workboard');

export const SECTION_TABS = {
  workboard: [
    { id: 'overview', label: 'Overview' },
    { id: 'today', label: 'Today' },
    { id: 'projects', label: 'Projects' },
    { id: 'cards', label: 'Cards' },
    { id: 'roadmap', label: 'Roadmap' },
    { id: 'review', label: 'Review' },
    { id: 'completed', label: 'Completed' }
  ],
  knowledge: [
    { id: 'memory', label: 'Memory' },
    { id: 'candidates', label: 'Candidates' },
    { id: 'sources', label: 'Sources & Source Control' },
    { id: 'rules', label: 'Rules' },
    { id: 'calibration', label: 'Calibration' }
  ],
  system: [
    { id: 'status', label: 'Status' },
    { id: 'setup', label: 'Setup & Recovery' },
    { id: 'repository', label: 'Repository' },
    { id: 'browser', label: 'Browser' },
    { id: 'tools', label: 'Tools' },
    { id: 'runs', label: 'Runs' },
    { id: 'feedback', label: 'Feedback' },
    { id: 'quality', label: 'Quality' }
  ]
};

export const MOBILE_SECTION_TABS = {
  workboard: SECTION_TABS.workboard.filter((tab) => ['today', 'projects', 'cards', 'completed'].includes(tab.id))
};

const LEGACY_ROUTES = {
  '/planner': { section: 'workboard', tab: 'overview' },
  '/projects': { section: 'workboard', tab: 'projects' },
  '/dev-roadmap': { section: 'workboard', tab: 'roadmap' },
  '/approvals': { section: 'workboard', tab: 'review' },
  '/memory': { section: 'knowledge', tab: 'memory' },
  '/source': { section: 'knowledge', tab: 'sources' },
  '/calibration': { section: 'knowledge', tab: 'calibration' },
  '/repository': { section: 'system', tab: 'repository' },
  '/browser': { section: 'system', tab: 'browser' },
  '/tooling': { section: 'system', tab: 'tools' }
};

function knownTab(section, tab) {
  return SECTION_TABS[section]?.some((entry) => entry.id === tab);
}

function defaultTab(section) {
  return PRIMARY_NAVIGATION.find((entry) => entry.id === section)?.defaultTab || null;
}

export function routeFor(section, tab = null, sessionId = null) {
  if (section === 'chat') return `#chat${sessionId ? `/${encodeURIComponent(sessionId)}` : ''}`;
  if (section === 'settings') return '#settings';
  const fallback = defaultTab(section);
  if (!fallback) return '#chat';
  return `#${section}${tab && tab !== fallback ? `/${encodeURIComponent(tab)}` : ''}`;
}

export function routeFromHash(hash = '') {
  const value = String(hash || '').replace(/^#/, '').replace(/^\/+|\/+$/g, '');
  if (!value) return { section: 'chat', tab: null, sessionId: null, legacy: true };
  const parts = value.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  const section = parts[0];
  if (section === 'chat') {
    if (parts.length > 2) return { section: 'chat', tab: null, sessionId: null, legacy: true };
    return { section: 'chat', tab: null, sessionId: parts[1] || null, legacy: false };
  }
  if (section === 'settings') return { section: 'settings', tab: null, sessionId: null, legacy: parts.length !== 1 };
  const fallback = defaultTab(section);
  const tab = parts[1] || fallback;
  if (!fallback || !knownTab(section, tab) || parts.length > 2) return { section: 'chat', tab: null, sessionId: null, legacy: true };
  return { section, tab, sessionId: null, legacy: false };
}

export function routeFromLocation(pathname = '/', search = '', hash = '') {
  if (hash) return routeFromHash(hash);
  const normalized = `/${String(pathname).replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '') || '/';
  const legacy = LEGACY_ROUTES[normalized];
  if (legacy) {
    const memoryApproval = normalized === '/approvals' && new URLSearchParams(search).get('domain') === 'memory';
    return { ...(memoryApproval ? { section: 'knowledge', tab: 'candidates' } : legacy), sessionId: null, legacy: true };
  }
  return { section: 'chat', tab: null, sessionId: null, legacy: true };
}

export function isMemoryApproval(approval = {}) {
  const action = String(approval.action_type || approval.actionType || '').toLowerCase();
  const payload = typeof approval.payload === 'string' ? approval.payload : JSON.stringify(approval.payload || {});
  return action.includes('memory') || /memory candidate|memory review|promot(e|ion)/i.test(payload);
}

export function approvalDestination(approval = {}) {
  return isMemoryApproval(approval)
    ? { section: 'knowledge', tab: 'candidates' }
    : { section: 'workboard', tab: 'review' };
}
