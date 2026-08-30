import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clipboard,
  Clock3,
  Download,
  FileText,
  FolderKanban,
  Github,
  GitBranch,
  GitMerge,
  Globe2,
  History,
  KeyRound,
  RotateCcw,
  ListChecks,
  MessageSquareText,
  Moon,
  Pause,
  Play,
  Plus,
  Route,
  RefreshCcw,
  SearchCheck,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  Wrench,
  X
} from 'lucide-react';
import './styles.css';
import { PRIMARY_NAVIGATION, MOBILE_PRIMARY_NAVIGATION, SECTION_TABS, MOBILE_SECTION_TABS, isMemoryApproval, routeFor, routeFromLocation } from './navigation.js';
import { renderMarkdown } from './markdown.js';
import { awaitChatSendResult, isChatSendOriginActive, isLatestChatConnectionRequest } from './chatSendClient.js';
import {
  normalizeDetailMode,
  parseMessageMetadata,
  hasStructuredMetadata,
  buildDetailRows,
  parseLegacyAssistantMessage,
  buildLegacyDetailRows
} from './messageDetail.js';
import { Capacitor } from '@capacitor/core';

// On desktop/web the frontend is always served BY the same Express server it
// talks to, so a relative '' base is correct and every call is same-origin.
// On a native Android build the WebView serves the bundled dist/ files from
// their own origin (capacitor://localhost), so relative API calls would
// silently 404 -- there is no server at that origin. The server itself
// binds only to 127.0.0.1 (LOOPBACK ONLY, a deliberate security choice --
// see server/index.js's own app.listen call and its "no public firewall
// rule is needed for local use" documentation elsewhere in this file).
// That is NOT changed here: the supported closed-beta connection path is
// `adb reverse tcp:4177 tcp:4177` over a USB-connected/authorized device,
// which makes the DEVICE's own 127.0.0.1:4177 forward to the desktop's
// loopback server -- so the native base URL below still targets
// 127.0.0.1, exactly like the desktop build, without ever exposing the
// server to the wider LAN.
// A hosted Closed Beta deployment (a remote HTTPS server a tester's phone
// reaches without adb reverse/the desktop being on) is a different origin
// than 127.0.0.1 -- so on native this is user-configurable, not a constant.
// Persisted with plain localStorage: it is per-installation configuration,
// not a secret, and each Capacitor app has its own isolated WebView storage.
function readNativeServerUrl() {
  try { return localStorage.getItem('lps.serverUrl') || 'http://127.0.0.1:4177'; } catch { return 'http://127.0.0.1:4177'; }
}
let API = Capacitor.isNativePlatform() ? readNativeServerUrl() : '';
function setNativeServerUrl(url) {
  API = url;
  try { localStorage.setItem('lps.serverUrl', url); } catch { /* private-browsing storage denial; API still updates in-memory */ }
}

// The bearer token issued by /api/auth/register or /api/auth/login on a
// hosted (LIFE_PLANNER_MULTI_USER) deployment. Desktop and an adb-reverse-
// connected phone talking to a plain single-user server never need this --
// it stays null and every request is implicitly the one local user, exactly
// as before multi-user support existed.
function readAuthToken() {
  try { return localStorage.getItem('lps.authToken') || ''; } catch { return ''; }
}
let authToken = Capacitor.isNativePlatform() ? readAuthToken() : '';
function setAuthToken(token) {
  authToken = token || '';
  try {
    if (token) localStorage.setItem('lps.authToken', token);
    else localStorage.removeItem('lps.authToken');
  } catch { /* private-browsing storage denial; authToken still updates in-memory */ }
}

function openNativeProviderWindow(provider) {
  const bridge = window.chrome?.webview;
  if (!bridge?.postMessage) return false;
  bridge.postMessage(JSON.stringify({ type: 'open-provider-window', provider }));
  return true;
}

function ChatGptMark({ size = 18, ...props }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M12 3.1a4.7 4.7 0 0 1 7.8 3.52v3.11" />
    <path d="M18.18 5.55a4.7 4.7 0 0 1 1.02 8.5l-2.68 1.55" />
    <path d="M20.1 12.65a4.7 4.7 0 0 1-6.76 5.23l-2.69-1.55" />
    <path d="M15.94 18.2a4.7 4.7 0 0 1-7.8-3.52v-3.1" />
    <path d="M5.82 18.45a4.7 4.7 0 0 1-1.02-8.5l2.68-1.55" />
    <path d="M3.9 11.35a4.7 4.7 0 0 1 6.76-5.23l2.69 1.55" />
    <path d="m12 8.25 3.25 1.88v3.74L12 15.75l-3.25-1.88v-3.74L12 8.25Z" />
  </svg>;
}

const navIcons = { workboard: ListChecks, chat: MessageSquareText, knowledge: Brain, system: Wrench, settings: Settings };
const IS_NATIVE = Capacitor.isNativePlatform();
const VISIBLE_NAVIGATION = IS_NATIVE ? MOBILE_PRIMARY_NAVIGATION : PRIMARY_NAVIGATION;
// On native, only expose the tab lists for sections a phone tester can
// actually reach (Workboard) -- spreading the full desktop SECTION_TABS
// here would let the menu's subpage preview render Knowledge/System tabs
// (e.g. via the Chat screen's `selectedSection = 'knowledge'` default)
// even though those sections are absent from MOBILE_PRIMARY_NAVIGATION.
const VISIBLE_SECTION_TABS = IS_NATIVE ? MOBILE_SECTION_TABS : SECTION_TABS;
const nav = VISIBLE_NAVIGATION.map((entry) => ({ ...entry, icon: navIcons[entry.id] }));

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let csrfToken = '';

// The local server rejects mutations that lack the per-runtime token, so a
// cross-site page cannot drive the app. Fetch it once, lazily, on the first
// mutation and reuse it; a 403 clears it so the next call re-fetches (e.g. after
// a server restart issued a fresh token).
async function mutationToken() {
  if (csrfToken) return csrfToken;
  try {
    const response = await fetch(`${API}/api/csrf-token`);
    const payload = await response.json();
    if (payload.ok) csrfToken = payload.data.token;
  } catch {
    // Leave empty; the mutation will 403 and surface a reload prompt.
  }
  return csrfToken;
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (MUTATION_METHODS.has(method)) headers['X-LPS-CSRF'] = await mutationToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  // headers spread last so the merged/token headers win over any options.headers.
  const response = await fetch(`${API}${path}`, { ...options, headers });
  const payload = await response.json();
  if (!payload.ok) {
    if (response.status === 403) csrfToken = '';
    if (response.status === 401 && authToken) setAuthToken('');
    throw new Error(payload.error || 'Request failed');
  }
  return payload.data;
}

// ---------------------------------------------------------------------------
// Renderer navigation bridge (client half).
// This window registers with the server, subscribes to its own authenticated
// command channel, and acknowledges each navigation command after applying it.
// Applying a command means setting the in-app hash to the server-resolved
// canonical route and letting the existing hashchange listener drive the real
// navigation — the SPA's single source of routing truth, never re-implemented
// here. The command is non-programmable: only a "navigate" verb carrying an
// in-app hash route is ever honoured; anything else is acknowledged FAILED.
// Navigation is a per-window view concern, so the window registers once on load.
// ---------------------------------------------------------------------------

const RENDERER_WINDOW_ID = (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : `win-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let rendererBinding = null;      // { rendererId, token } once registered
let rendererSource = null;       // the open EventSource command channel
let rendererHeartbeat = null;    // heartbeat interval id
let rendererStarted = false;
let rendererReadyPromise = Promise.resolve(false);

function getRendererBinding() {
  return rendererBinding;
}

function closeRendererStream() {
  if (rendererSource) { try { rendererSource.close(); } catch { /* already closed */ } rendererSource = null; }
  if (rendererHeartbeat) { clearInterval(rendererHeartbeat); rendererHeartbeat = null; }
}

async function registerRenderer(chatSessionId = null) {
  try {
    const data = await api('/api/renderer/register', {
      method: 'POST',
      body: JSON.stringify({ windowId: RENDERER_WINDOW_ID, chatSessionId: chatSessionId == null ? null : String(chatSessionId) })
    });
    rendererBinding = { rendererId: data.rendererId, token: data.token };
    return await openRendererStream(data.heartbeatMs);
  } catch {
    rendererBinding = null;
    return false;
  }
}

function openRendererStream(heartbeatMs) {
  if (!rendererBinding || typeof EventSource === 'undefined') return Promise.resolve(false);
  closeRendererStream();
  const { rendererId, token } = rendererBinding;
  const source = new EventSource(`${API}/api/renderer/${encodeURIComponent(rendererId)}/commands?token=${encodeURIComponent(token)}`);
  rendererSource = source;
  source.addEventListener('command', (event) => { applyRendererCommand(event.data); });
  rendererReadyPromise = new Promise((resolve) => {
    let settled = false;
    const settle = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(ready);
    };
    const timeout = setTimeout(() => settle(false), 3000);
    source.addEventListener('ready', () => settle(true), { once: true });
    source.addEventListener('error', () => {
      if (source.readyState === EventSource.CLOSED) settle(false);
    });
  });
  source.onerror = () => {
    // The browser auto-reconnects transient drops. Persistent failure (e.g. the
    // server pruned this window) is recovered by the heartbeat re-registering.
    if (source.readyState === EventSource.CLOSED) scheduleRendererRecovery();
  };
  rendererHeartbeat = setInterval(() => { sendRendererHeartbeat(); }, Math.max(5000, Number(heartbeatMs) || 20000));
  return rendererReadyPromise;
}

let rendererRecoveryTimer = null;
function scheduleRendererRecovery() {
  if (rendererRecoveryTimer) return;
  rendererRecoveryTimer = setTimeout(async () => {
    rendererRecoveryTimer = null;
    closeRendererStream();
    rendererBinding = null;
    await registerRenderer();
  }, 3000);
}

async function sendRendererHeartbeat() {
  const binding = rendererBinding;
  if (!binding) return;
  try {
    const result = await api(`/api/renderer/${encodeURIComponent(binding.rendererId)}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ token: binding.token })
    });
    if (result && result.alive === false) scheduleRendererRecovery();
  } catch {
    // Heartbeat failures are recovered on the next tick; never surface to the user.
  }
}

async function applyRendererCommand(raw) {
  const binding = rendererBinding;
  let envelope;
  try { envelope = JSON.parse(raw); } catch { return; }
  // Targeting guard: only apply a command addressed to this exact renderer.
  if (!binding || !envelope || envelope.rendererId !== binding.rendererId) return;
  let status = 'FAILED';
  let detail = '';
  const intended = envelope.command === 'navigate' && typeof envelope.route === 'string' && envelope.route.startsWith('#')
    ? routeFromLocation('/', '', envelope.route)
    : null;
  if (intended && !intended.legacy) {
    try {
      if (window.location.hash !== envelope.route) window.location.hash = envelope.route;
      const applied = routeFromLocation(window.location.pathname, window.location.search, window.location.hash);
      if (applied.section === intended.section && (applied.tab ?? null) === (intended.tab ?? null)) status = 'APPLIED';
      else detail = 'route did not settle on the intended section';
    } catch {
      detail = 'navigation apply failed';
    }
  } else {
    detail = 'unsupported or non-canonical navigation command';
  }
  try {
    await api(`/api/renderer/${encodeURIComponent(binding.rendererId)}/ack`, {
      method: 'POST',
      body: JSON.stringify({
        commandId: envelope.commandId,
        correlationId: envelope.correlationId,
        token: binding.token,
        commandToken: envelope.commandToken,
        status,
        detail
      })
    });
  } catch {
    // If the ack cannot be delivered the server times the command out; never invent success.
  }
}

function startRendererBridge(chatSessionId) {
  if (rendererStarted) return;
  rendererStarted = true;
  registerRenderer(chatSessionId);
  window.addEventListener('beforeunload', () => {
    const binding = rendererBinding;
    if (!binding) return;
    // Best-effort clean shutdown so a closed window frees its renderer promptly.
    // A keepalive fetch (not sendBeacon) can carry the cached CSRF header the
    // mutation guard requires; if it does not land, the idle sweeper prunes it.
    try {
      fetch(`${API}/api/renderer/${encodeURIComponent(binding.rendererId)}/unregister`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-LPS-CSRF': csrfToken },
        body: JSON.stringify({ token: binding.token })
      }).catch(() => {});
    } catch { /* the idle sweeper prunes it regardless */ }
  });
}

async function invokeNeutralAction(name, args = {}, chatSessionId = null) {
  // Every visible surface uses the same neutral gateway. Navigation actions add
  // this window's authenticated renderer binding as trusted request context;
  // neither the action arguments nor an agent can choose that binding.
  const body = { args, session_id: chatSessionId };
  if (name.startsWith('navigation.')) {
    let binding = getRendererBinding();
    if (!binding) await registerRenderer(chatSessionId);
    else await rendererReadyPromise;
    binding = getRendererBinding();
    if (binding) body.renderer = binding;
  }
  const result = await api(`/api/actions/${encodeURIComponent(name)}/invoke`, { method: 'POST', body: JSON.stringify(body) });
  if (!['success', 'needs_confirmation', 'needs_approval'].includes(result.status)) {
    throw new Error(result.error?.message || `Action ${name} did not complete.`);
  }
  return result;
}

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

function Pill({ children, tone = 'default' }) {
  return <span className={cx('pill', `pill-${tone}`)}>{children}</span>;
}

function Empty({ title, body }) {
  return (
    <div className="empty">
      <Circle size={18} />
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function ItemRow({ item, compact = false, children }) {
  return (
    <div className={cx('item-row', compact && 'compact-row')}>
      <div className="item-main">
        <div className="item-title">{item.title}</div>
        <div className="item-meta">
          <span>{item.type || item.action_type}</span>
          {item.project_name && <span>{item.project_name}</span>}
          {item.priority && <span>{item.priority}</span>}
          <span>{item.owner || (item.action_type ? 'approval' : 'user')}</span>
          {item.confidence !== undefined && item.confidence !== null && <span>{Math.round(Number(item.confidence) * 100)}%</span>}
        </div>
      </div>
      <Pill tone={item.status === 'active' || item.status === 'stable' ? 'good' : item.status === 'blocked' ? 'bad' : 'warn'}>
        {item.status || 'pending'}
      </Pill>
      {children}
    </div>
  );
}

function ThemeToggle({ theme, setTheme }) {
  const dark = theme === 'dark';
  return (
    <div className="theme-radio" role="radiogroup" aria-label="Theme">
      <button
        className={cx('theme-choice', dark && 'lit')}
        role="radio"
        aria-checked={dark}
        onClick={() => setTheme('dark')}
      >
        <span className="radio-dot"><Moon size={13} /></span>
        <span>Dark</span>
      </button>
      <button
        className={cx('theme-choice', !dark && 'lit')}
        role="radio"
        aria-checked={!dark}
        onClick={() => setTheme('light')}
      >
        <span className="radio-dot"><Sparkles size={13} /></span>
        <span>Light</span>
      </button>
    </div>
  );
}

function controlledBrowserWarningForUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'auth.openai.com') {
      return 'ChatGPT usually rejects the app-controlled browser profile with a repeating human check. This is not your signed-in Chrome profile; use Copy + Chrome for your normal logged-in Chrome.';
    }
    if (host === 'accounts.google.com' || host === 'gemini.google.com') {
      return 'Google sign-in rejects controlled or embedded browsers. Use External to open it in your normal browser.';
    }
  } catch {
    return '';
  }
  return '';
}

function isChatGptUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    return host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'auth.openai.com';
  } catch {
    return false;
  }
}

function temporaryChatSetupNote() {
  return [
    'Temporary Chat setup for Life Planner consultation:',
    '',
    '1. In ChatGPT, start a new chat.',
    '2. Click the pill-shaped Temporary button in the top-right corner.',
    '3. Confirm the chat shows Temporary Chat mode.',
    '4. Return to Life Planner, tick "Temporary Chat is on", then click Copy to copy the full consultation prompt.',
    '',
    'Do not paste the Life Planner consultation prompt into a normal saved ChatGPT chat.'
  ].join('\n');
}

const CLOUD_AGENTS = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
  { name: 'Grok', url: 'https://grok.com/' },
  { name: 'Claude', url: 'https://claude.ai/new' },
  { name: 'Other web agent', url: '' }
];

function githubRepoFromRemote(url = '') {
  const value = String(url || '').trim();
  if (!value) return '';
  const sshMatch = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) return sshMatch[1];
  try {
    const parsed = new URL(value);
    if (parsed.hostname !== 'github.com') return '';
    return parsed.pathname.replace(/^\/+/, '').replace(/\.git$/i, '');
  } catch {
    return '';
  }
}

function githubWebUrlFromRemote(url = '') {
  const repo = githubRepoFromRemote(url);
  return repo ? `https://github.com/${repo}` : '';
}

function repoBoundaryLabel(repoPath = '', repoName = '') {
  const pathText = String(repoPath || '').toLowerCase();
  const repoText = String(repoName || '').toLowerCase();
  if (repoText === 'daa13x/lifeplansystempublic' || pathText.includes('lps-public') || pathText.includes('lifeplansystempublic')) {
    return 'Public app checkout';
  }
  if (repoText === 'daa13x/lifeplansystem' || pathText.endsWith('lifeplansystem')) {
    return 'Private repo checkout';
  }
  return 'Current local checkout';
}

function App() {
  const [route, setRoute] = useState(() => routeFromLocation(window.location.pathname, window.location.search, window.location.hash));
  const [theme, setTheme] = useState(() => localStorage.getItem('life-planner-theme') || 'dark');
  const [boot, setBoot] = useState(null);
  const [planner, setPlanner] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [memory, setMemory] = useState({ candidates: [], items: [] });
  const [projects, setProjects] = useState([]);
  const [models, setModels] = useState([]);
  const [settings, setSettings] = useState({});
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [notice, setNotice] = useState('');
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('life-planner-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (route.legacy) window.history.replaceState({}, '', routeFor(route.section, route.tab, route.sessionId));
  }, [route]);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation(window.location.pathname, window.location.search, window.location.hash));
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onPopState);
    };
  }, []);

  // Register this window with the server-side navigation bridge exactly once so
  // authenticated navigation commands can be delivered to it and acknowledged.
  useEffect(() => { startRendererBridge(selectedSession); }, []);

  function navigate(section, tab = null, sessionId = null) {
    const next = { section, tab: tab || nav.find((entry) => entry.id === section)?.defaultTab || null, sessionId, legacy: false };
    const path = routeFor(next.section, next.tab, next.sessionId);
    if (path !== window.location.hash) window.history.pushState({}, '', path);
    setRoute(next);
  }

  function openRepositorySyncFromShell() {
    navigate('system', 'repository');
    setNotice('Open System / Repository to review the private repository target and run its safe fast-forward sync.');
  }

  async function openChatGptSyncFromShell() {
    if (openNativeProviderWindow('chatgpt')) {
      setNotice('Opened ChatGPT in its separate Life Planner provider window. Sign in there; it uses an isolated browser profile and does not send LPS data automatically.');
      return;
    }
    try {
      await api('/api/browser/open-external', { method: 'POST', body: JSON.stringify({ url: 'https://chatgpt.com/' }) });
      setNotice('Opened ChatGPT in your normal browser. Sign in there, then keep the LPS Browser Agent enabled to connect the session.');
    } catch (error) {
      setNotice(`Could not open ChatGPT sign-in: ${error.message}`);
    }
  }

  async function refreshAll() {
    const [data, mem, pendingApprovals] = await Promise.all([
      api('/api/bootstrap'),
      api('/api/memory'),
      api('/api/approvals').catch(() => null)
    ]);
    setBoot(data);
    setPlanner(data.planner);
    setProjects(data.projects);
    setModels(data.models);
    setSettings(data.settings || {});
    setSessions(data.sessions);
    setSelectedSession((current) => current && data.sessions.some((session) => session.id === current) ? current : data.sessions[0]?.id || null);
    setMemory(mem);
    setApprovals(pendingApprovals || data.planner.approvals || []);
  }

  async function refreshCurrentView() {
    if (refreshBusy) return;
    setRefreshBusy(true);
    setNotice('Refreshing current view...');
    try {
      await refreshAll();
      if (selectedSession) {
        setMessages(await api(`/api/chat/sessions/${selectedSession}/messages`));
      }
      setRefreshSignal((value) => value + 1);
      setNotice('Refresh complete.');
    } catch (err) {
      setNotice(`Refresh failed: ${err.message}`);
    } finally {
      setRefreshBusy(false);
    }
  }

  useEffect(() => {
    refreshAll().catch((err) => setNotice(err.message));
  }, []);

  useEffect(() => {
    if (route.section !== 'chat' || !route.sessionId || sessions.length === 0) return;
    const session = sessions.find((item) => String(item.id) === String(route.sessionId));
    if (session) setSelectedSession(session.id);
    else navigate('chat');
  }, [route.section, route.sessionId, sessions]);

  useEffect(() => {
    if (!selectedSession) return;
    api(`/api/chat/sessions/${selectedSession}/messages`).then(setMessages).catch((err) => setNotice(err.message));
  }, [selectedSession]);

  const activeSession = useMemo(() => sessions.find((session) => session.id === selectedSession), [sessions, selectedSession]);

  async function reloadPlanner() {
    const [nextPlanner, nextMemory, pendingApprovals] = await Promise.all([
      api('/api/planner'),
      api('/api/memory'),
      api('/api/approvals').catch(() => null)
    ]);
    setPlanner(nextPlanner);
    setMemory(nextMemory);
    setApprovals(pendingApprovals || nextPlanner.approvals || []);
  }

  async function runPlannerRefresh() {
    const result = (await invokeNeutralAction('planner.refresh', {}, selectedSession)).data;
    setPlanner(result.planner);
    setMemory(await api('/api/memory'));
    setApprovals(await api('/api/approvals').catch(() => result.planner.approvals || []));
    setNotice(result.message);
  }

  async function proposeCodingTask(draft) {
    return invokeNeutralAction('coding.propose_task', draft, selectedSession);
  }

  async function confirmCodingTask(confirmation) {
    return api(`/api/chat/sessions/${selectedSession}/coding/confirm`, {
      method: 'POST',
      body: JSON.stringify({ confirmationId: confirmation.confirmationId, token: confirmation.token })
    });
  }

  async function proposeWorkboardItemUpdate(itemId, changes) {
    return invokeNeutralAction('workboard.propose_update', { type: 'item', id: itemId, changes }, selectedSession);
  }

  async function confirmWorkboardItemUpdate(confirmation) {
    return api(`/api/chat/sessions/${selectedSession}/workboard/confirm`, {
      method: 'POST',
      body: JSON.stringify({ confirmationId: confirmation.confirmationId, token: confirmation.token })
    });
  }

  async function proposeFeedbackTriage(feedbackId, status) {
    return invokeNeutralAction('feedback.propose_triage', { id: feedbackId, status }, selectedSession);
  }

  async function confirmFeedbackTriage(confirmation) {
    return api(`/api/chat/sessions/${selectedSession}/feedback/confirm`, {
      method: 'POST',
      body: JSON.stringify({ confirmationId: confirmation.confirmationId, token: confirmation.token })
    });
  }

  const candidateCount = memory.candidates.filter((candidate) => ['candidate', 'deferred'].includes(candidate.status)).length;
  const operationalApprovalCount = approvals.filter((approval) => !isMemoryApproval(approval)).length;
  const completedWorkboardCount = projects.filter((project) => ['done', 'completed', 'archived'].includes(project.status)).length;
  const navigation = (
    <NavigationMenu
      route={route}
      navigate={navigate}
      candidateCount={candidateCount}
      operationalApprovalCount={operationalApprovalCount}
      completedWorkboardCount={completedWorkboardCount}
    />
  );

  return (
    <div className="app-shell">
      <main className="main">
        <header className="topbar">
          <button className="app-logo" onClick={() => navigate('chat')} aria-label="Life Planner home" title="Life Planner home">
            <img src="/life-planner-logo.png" alt="" />
          </button>
          {navigation}
          <div className="topbar-heading">
            <p>{route.section === 'workboard' ? 'Plan, prioritise, review, and complete work from one operational space.' : route.section === 'knowledge' ? 'Review memory candidates, evidence, rules, and calibration without auto-promotion.' : route.section === 'system' ? 'Inspect real local status, repository, browser, tooling, and run state.' : route.section === 'settings' ? 'Configure local-only models, runtime paths, and application preferences.' : 'One source of truth, many views. Chat becomes candidate memory only after review.'}</p>
          </div>
          <div className="top-actions">
            {!IS_NATIVE && <button className="icon-button sync-service-button" onClick={openRepositorySyncFromShell} aria-label="Open private GitHub repository sync" title="Private GitHub repository sync"><Github size={18} /><RefreshCcw className="sync-service-corner" size={10} aria-hidden="true" /></button>}
            {!IS_NATIVE && <button className="icon-button sync-service-button" onClick={openChatGptSyncFromShell} aria-label="Open ChatGPT provider window" title="Open ChatGPT provider window"><ChatGptMark size={18} /><RefreshCcw className="sync-service-corner" size={10} aria-hidden="true" /></button>}
            <button className="icon-button" onClick={refreshCurrentView} disabled={refreshBusy} aria-label="Refresh" title={refreshBusy ? 'Refreshing current view...' : 'Refresh current view'}>
              <RefreshCcw size={18} />
            </button>
            <ThemeToggle theme={theme} setTheme={setTheme} />
            {!IS_NATIVE && <button className={cx('icon-button', route.section === 'settings' && 'active')} onClick={() => navigate('settings')} aria-label="Open Settings" aria-current={route.section === 'settings' ? 'page' : undefined} title="Open Settings">
              <Settings size={18} />
            </button>}
          </div>
        </header>
        {notice && (
          <div className="notice-banner" role="status">
            <span>{notice}</span>
            <button
              className="notice-dismiss"
              type="button"
              onClick={() => setNotice('')}
              aria-label="Dismiss notification"
              title="Dismiss notification"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        )}

        {route.section === 'workboard' && <Workboard route={route} navigate={navigate} planner={planner} projects={projects} setProjects={setProjects} refresh={reloadPlanner} refreshAll={refreshAll} runRefresh={runPlannerRefresh} proposeCodingTask={proposeCodingTask} confirmCodingTask={confirmCodingTask} proposeWorkboardItemUpdate={proposeWorkboardItemUpdate} confirmWorkboardItemUpdate={confirmWorkboardItemUpdate} setNotice={setNotice} refreshSignal={refreshSignal} />}
        {route.section === 'chat' && (
          <Chat
            sessions={sessions}
            activeSession={activeSession}
            selectedSession={selectedSession}
            setSelectedSession={setSelectedSession}
            setSessions={setSessions}
            messages={messages}
            setMessages={setMessages}
            refreshAll={refreshAll}
            setNotice={setNotice}
            navigate={navigate}
            settings={settings}
          />
        )}
        {route.section === 'knowledge' && <Knowledge route={route} navigate={navigate} memory={memory} refresh={reloadPlanner} setNotice={setNotice} refreshSignal={refreshSignal} />}
        {route.section === 'system' && <System route={route} selectedSession={selectedSession} boot={boot} planner={planner} sessions={sessions} models={models} setNotice={setNotice} refresh={reloadPlanner} refreshSignal={refreshSignal} proposeFeedbackTriage={proposeFeedbackTriage} confirmFeedbackTriage={confirmFeedbackTriage} />}
        {route.section === 'settings' && (
          <SettingsView
            settings={settings}
            setSettings={setSettings}
            models={models}
            setModels={setModels}
            setNotice={setNotice}
            openPrivateRepositorySync={openRepositorySyncFromShell}
            openChatGptSync={openChatGptSyncFromShell}
          />
        )}
      </main>
    </div>
  );
}

function NavigationMenu({ route, navigate, candidateCount, operationalApprovalCount, completedWorkboardCount }) {
  const [open, setOpen] = useState(false);
  const menuEntries = nav.filter((entry) => entry.id !== 'chat');
  const selectedSection = route.section === 'chat' ? 'knowledge' : route.section;
  const [previewSection, setPreviewSection] = useState(selectedSection);
  const selected = nav.find((entry) => entry.id === selectedSection);
  const preview = nav.find((entry) => entry.id === previewSection);
  const SelectedIcon = selected?.icon || Route;
  const tabBadges = { candidates: candidateCount || null, review: operationalApprovalCount || null, completed: completedWorkboardCount || null };
  return (
    <nav className="navigation-menu" aria-label="Main navigation">
      <button className={cx('nav-item', 'nav-chat-link', route.section === 'chat' && 'selected')} onClick={() => { navigate('chat'); setOpen(false); setPreviewSection('knowledge'); }} aria-current={route.section === 'chat' ? 'page' : undefined}>
        <MessageSquareText size={18} /><span>Chat</span>
      </button>
      <div className="nav-menu-anchor">
        <button className="nav-trigger" onClick={() => { setPreviewSection(selectedSection); setOpen((value) => !value); }} aria-expanded={open} aria-controls="main-navigation-options">
          {SelectedIcon && <SelectedIcon size={18} />}
          <span>{selected?.label || 'Menu'}</span>
          <ChevronDown size={18} className={cx('nav-trigger-chevron', open && 'open')} aria-hidden="true" />
        </button>
        {open && (
          <div id="main-navigation-options" className="nav-options">
            {menuEntries.map((entry) => {
              const Icon = entry.icon;
              return <button key={entry.id} className={cx('nav-item', route.section === entry.id && 'selected')} onMouseEnter={() => setPreviewSection(entry.id)} onFocus={() => setPreviewSection(entry.id)} onClick={() => { setPreviewSection(entry.id); navigate(entry.id); }} aria-current={route.section === entry.id ? 'page' : undefined}>
                <Icon size={18} /><span>{entry.label}</span>
                {entry.id === 'workboard' && operationalApprovalCount > 0 && <span className="nav-badge" aria-label={`${operationalApprovalCount} operational approvals awaiting review`}>{operationalApprovalCount}</span>}
                {entry.id === 'knowledge' && candidateCount > 0 && <span className="nav-badge" aria-label={`${candidateCount} memory candidates awaiting review`}>{candidateCount}</span>}
              </button>;
            })}
            {VISIBLE_SECTION_TABS[previewSection] && <div className="nav-subpages" onMouseEnter={() => setPreviewSection(previewSection)} style={{ '--active-index': menuEntries.findIndex((entry) => entry.id === previewSection) }} aria-label={`${preview?.label} pages`}>
              {VISIBLE_SECTION_TABS[previewSection].map((tab) => <button key={tab.id} className={cx('nav-subpage', route.section === previewSection && route.tab === tab.id && 'selected')} onClick={() => { setPreviewSection(previewSection); navigate(previewSection, tab.id); }}>
                <span>{tab.label}</span>{tabBadges[tab.id] ? <span className="nav-badge">{tabBadges[tab.id]}</span> : null}
              </button>)}
            </div>}
          </div>
        )}
      </div>
    </nav>
  );
}

function Workboard({ route, navigate, planner, projects, setProjects, refresh, refreshAll, runRefresh, proposeCodingTask, confirmCodingTask, proposeWorkboardItemUpdate, confirmWorkboardItemUpdate, setNotice, refreshSignal }) {
  const completedCount = projects.filter((project) => ['done', 'completed', 'archived'].includes(project.status)).length;
  return (
    <section className="section-shell">
      {route.tab === 'overview' && <Planner planner={planner} refresh={refresh} runRefresh={runRefresh} proposeCodingTask={proposeCodingTask} confirmCodingTask={confirmCodingTask} proposeWorkboardItemUpdate={proposeWorkboardItemUpdate} confirmWorkboardItemUpdate={confirmWorkboardItemUpdate} setNotice={setNotice} navigate={navigate} />}
      {route.tab === 'today' && <DailyPlanner setNotice={setNotice} refreshSignal={refreshSignal} />}
      {route.tab === 'projects' && <Projects projects={projects} setProjects={setProjects} setNotice={setNotice} refreshAll={refreshAll} />}
      {route.tab === 'cards' && <LayeredWorkboard setNotice={setNotice} refreshSignal={refreshSignal} />}
      {route.tab === 'roadmap' && <DevRoadmap setNotice={setNotice} refreshSignal={refreshSignal} />}
      {route.tab === 'review' && <ApprovalQueue scope="operational" setNotice={setNotice} refreshPlanner={refresh} />}
      {route.tab === 'completed' && <CompletedWorkboard setNotice={setNotice} refreshSignal={refreshSignal} />}
    </section>
  );
}

const CAPACITY_MODE_LABELS = {
  'normal': 'Normal',
  'low-energy': 'Low energy',
  'overwhelmed': 'Overwhelmed',
  'urgent-deadline': 'Urgent deadline',
  'recovery-day': 'Recovery day',
  'pain-illness': 'Pain / illness',
  'high-focus': 'High focus'
};

const EMPTY_PLANNER_FORM = {
  title: '', why: '', nextAction: '', definitionOfDone: '', easierVersion: '', pausePoint: '', recoveryStep: '',
  importance: 3, effort: 3, estimatedMinutes: '', deadline: '', blocker: '', consequenceOfDelay: '', needsOthers: false, isRecovery: false
};

// Build the edit form's controlled values from a server task object. The day
// view returns engine tasks in camelCase (see plannerTaskToEngine); we mirror
// those field names so edits PATCH straight back through the aliases the server
// already accepts — the frontend never invents its own contract.
function plannerFormFromTask(task) {
  return {
    title: task.title || '',
    why: task.why || '',
    nextAction: task.nextAction || '',
    definitionOfDone: task.definitionOfDone || '',
    easierVersion: task.easierVersion || '',
    pausePoint: task.pausePoint || '',
    recoveryStep: task.recoveryStep || '',
    importance: task.importance ?? 3,
    effort: task.effort ?? 3,
    estimatedMinutes: task.estimatedMinutes ?? '',
    deadline: task.deadline ? String(task.deadline).slice(0, 10) : '',
    blocker: task.blocker || '',
    consequenceOfDelay: task.consequenceOfDelay || '',
    needsOthers: Boolean(task.needsOthers),
    isRecovery: Boolean(task.isRecovery)
  };
}

// Shared field set for the create and edit forms. Kept as one component so the
// full guidance model the backend supports is editable in both places.
function PlannerTaskFields({ form, setForm, disabled }) {
  const set = (key) => (event) => {
    const target = event.target;
    const value = target.type === 'checkbox' ? target.checked : target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };
  const setNumber = (key) => (event) => setForm((current) => ({ ...current, [key]: Number(event.target.value) }));
  return (
    <>
      <label className="field">Title
        <input value={form.title} disabled={disabled} onChange={set('title')} placeholder="What is the task?" required />
      </label>
      <label className="field">The exact next action
        <input value={form.nextAction} disabled={disabled} onChange={set('nextAction')} placeholder="The single next physical step" />
      </label>
      <label className="field">Why it matters
        <input value={form.why} disabled={disabled} onChange={set('why')} placeholder="Optional — the reason this is worth doing" />
      </label>
      <label className="field">Definition of done
        <input value={form.definitionOfDone} disabled={disabled} onChange={set('definitionOfDone')} placeholder="Optional — how you'll know it's finished" />
      </label>
      <label className="field">An easier version
        <input value={form.easierVersion} disabled={disabled} onChange={set('easierVersion')} placeholder="Optional — a smaller version for low-capacity days" />
      </label>
      <label className="field">Pause point
        <input value={form.pausePoint} disabled={disabled} onChange={set('pausePoint')} placeholder="Optional — a safe place to stop partway" />
      </label>
      <label className="field">Recovery step
        <input value={form.recoveryStep} disabled={disabled} onChange={set('recoveryStep')} placeholder="Optional — a restorative follow-up" />
      </label>
      <label className="field">Blocker
        <input value={form.blocker} disabled={disabled} onChange={set('blocker')} placeholder="Optional — what must clear before this can move" />
      </label>
      <label className="field">If it slips
        <input value={form.consequenceOfDelay} disabled={disabled} onChange={set('consequenceOfDelay')} placeholder="Optional — the honest consequence of delay" />
      </label>
      <div className="quick-add-row">
        <label className="field">Importance
          <select value={form.importance} disabled={disabled} onChange={setNumber('importance')}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <label className="field">Effort
          <select value={form.effort} disabled={disabled} onChange={setNumber('effort')}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <label className="field">Estimated minutes
          <input type="number" min="0" step="5" value={form.estimatedMinutes} disabled={disabled} onChange={set('estimatedMinutes')} placeholder="Optional" />
        </label>
        <label className="field">Deadline
          <input type="date" value={form.deadline} disabled={disabled} onChange={set('deadline')} />
        </label>
      </div>
      <div className="quick-add-row">
        <label className="field checkbox-field"><input type="checkbox" checked={form.needsOthers} disabled={disabled} onChange={set('needsOthers')} /> Needs someone else</label>
        <label className="field checkbox-field"><input type="checkbox" checked={form.isRecovery} disabled={disabled} onChange={set('isRecovery')} /> Recovery / self-care</label>
      </div>
    </>
  );
}

// One task card, sharing its layout across the Now, Blocked and Later sections.
// It renders whatever guidance fields are populated and, when this task is being
// edited, swaps in the shared edit form in place.
function PlannerTaskCard({ task, section, busy, editing, editForm, setEditForm, onEdit, onCancelEdit, onSaveEdit, onAction }) {
  if (editing) {
    return (
      <div className="item-row" key={task.id}>
        <form className="propose-form" onSubmit={(event) => { event.preventDefault(); onSaveEdit(task.id); }}>
          <PlannerTaskFields form={editForm} setForm={setEditForm} disabled={Boolean(busy)} />
          <div className="button-row">
            <button type="submit" className="primary" disabled={Boolean(busy) || !editForm.title.trim()}>{busy === `edit:${task.id}` ? 'Saving…' : 'Save changes'}</button>
            <button type="button" className="secondary" disabled={Boolean(busy)} onClick={onCancelEdit}>Cancel</button>
          </div>
        </form>
      </div>
    );
  }
  const meta = [];
  if (task.deadline) meta.push(`Due ${String(task.deadline).slice(0, 10)}`);
  if (Number.isFinite(task.effort)) meta.push(`Effort ${task.effort}/5`);
  if (Number.isFinite(task.importance)) meta.push(`Importance ${task.importance}/5`);
  if (task.estimatedMinutes) meta.push(`~${task.estimatedMinutes} min`);
  return (
    <div className="item-row" key={task.id}>
      <div className="item-main">
        <div className="item-title">{task.pinned ? '📌 ' : ''}{task.title}{task.presentedAs === 'easier' ? ' · easier version' : ''}</div>
        {task.activeStep && <div className="item-meta"><span><strong>Next:</strong> {task.activeStep}</span></div>}
        {task.why && <div className="item-meta"><span><strong>Why:</strong> {task.why}</span></div>}
        {task.definitionOfDone && <div className="item-meta"><span><strong>Done when:</strong> {task.definitionOfDone}</span></div>}
        {task.presentedAs !== 'easier' && task.easierVersion && <div className="item-meta"><span><strong>Easier option:</strong> {task.easierVersion}</span></div>}
        {task.pausePoint && <div className="item-meta"><span><strong>Pause point:</strong> {task.pausePoint}</span></div>}
        {task.recoveryStep && <div className="item-meta"><span><strong>Recovery:</strong> {task.recoveryStep}</span></div>}
        {task.blocker && <div className="item-meta"><span>⛔ <strong>Blocked:</strong> {task.blocker}</span></div>}
        {task.consequenceOfDelay && <div className="item-meta"><span><strong>If it slips:</strong> {task.consequenceOfDelay}</span></div>}
        {meta.length > 0 && <div className="item-meta"><span>{meta.join(' · ')}</span></div>}
        {Array.isArray(task.reasons) && task.reasons.length > 0 && <div className="item-meta"><span><em>Why here: {task.reasons.join('; ')}</em></span></div>}
        {section === 'later' && task.deferReason && <div className="item-meta"><span><em>{task.deferReason}</em></span></div>}
      </div>
      <div className="button-row">
        {section !== 'later' && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => onAction(task.id, 'complete')}>{busy === `complete:${task.id}` ? 'Saving…' : 'Done'}</button>}
        <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => onAction(task.id, 'pin')}>{task.pinned ? 'Unpin' : (section === 'later' ? 'Pin to today' : 'Pin')}</button>
        {section !== 'later' && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => onAction(task.id, 'defer')}>Not today</button>}
        <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => onEdit(task)}>Edit</button>
      </div>
    </div>
  );
}

// Capacity-Aware Daily Planner. The user picks the capacity mode; the server
// shapes the day transparently (every task carries its own `reasons`), and the
// user can override anything — pin a task to keep it, defer it as a choice, or
// edit its guidance. The frontend renders the server's order verbatim; it never
// re-ranks or re-scores tasks itself.
function formatPlannerCompletionTime(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : ` · ${parsed.toLocaleString()}`;
}

const EMPTY_PLANNER_EVIDENCE_FORM = { evidenceKind: 'user_assertion', claim: '', reference: '', completionEventId: null, supersedesEvidenceId: null };

function plannerEvidenceKindLabel(kind) {
  return ({ user_assertion: 'User statement', artifact_reference: 'Artifact reference', external_reference: 'External reference' })[kind] || kind;
}

function PlannerEvidencePanel({ task, onChanged }) {
  const [evidence, setEvidence] = useState([]);
  const [form, setForm] = useState(EMPTY_PLANNER_EVIDENCE_FORM);
  const [revokeId, setRevokeId] = useState(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [attachKey, setAttachKey] = useState(null);
  const [revokeKey, setRevokeKey] = useState(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [nextBeforeId, setNextBeforeId] = useState(null);

  const loadEvidence = async ({ beforeId = null } = {}) => {
    try {
      const page = await api(`/api/planner/tasks/${task.id}/evidence${beforeId ? `?beforeId=${beforeId}` : ''}`);
      setEvidence((current) => beforeId ? [...page.items, ...current] : page.items);
      setNextBeforeId(page.nextBeforeId);
      setError(null);
    }
    catch (err) { setError(err.message); }
  };
  useEffect(() => { loadEvidence(); }, [task.id]);

  async function attach(event) {
    event.preventDefault();
    if (!form.claim.trim()) return;
    setWorking(true);
    setError(null);
    const requestKey = attachKey || crypto.randomUUID().replaceAll('-', '');
    setAttachKey(requestKey);
    try {
      await api(`/api/planner/tasks/${task.id}/evidence`, {
        method: 'POST',
        headers: { 'X-LPS-Idempotency-Key': requestKey },
        body: JSON.stringify({ ...form, completionEventId: form.completionEventId || task.latestCompletionEventId })
      });
      setForm(EMPTY_PLANNER_EVIDENCE_FORM);
      setAttachKey(null);
      await loadEvidence();
      await onChanged();
    } catch (err) { setError(err.message); }
    finally { setWorking(false); }
  }

  async function revoke() {
    if (!revokeId || !revokeReason.trim()) return;
    setWorking(true);
    setError(null);
    const requestKey = revokeKey || crypto.randomUUID().replaceAll('-', '');
    setRevokeKey(requestKey);
    try {
      await api(`/api/planner/tasks/${task.id}/evidence/${revokeId}/revoke`, {
        method: 'POST',
        headers: { 'X-LPS-Idempotency-Key': requestKey },
        body: JSON.stringify({ reason: revokeReason })
      });
      setRevokeId(null);
      setRevokeReason('');
      setRevokeKey(null);
      await loadEvidence();
      await onChanged();
    } catch (err) { setError(err.message); }
    finally { setWorking(false); }
  }

  const activeForLatest = evidence.filter((item) => item.status === 'active' && item.completionEventId === task.latestCompletionEventId);
  return (
    <details>
      <summary>Supporting evidence ({task.supportingEvidenceCount}) · Unverified</summary>
      <small>Evidence is attached to this recorded completion only. It supports your record but is not independent verification.</small>
      {error && <p className="form-error" role="alert">{error}</p>}
      {evidence.length > 0 && (
        <div className="table-list">
          {evidence.map((item) => (
            <div className="item-row" key={item.id}>
              <div className="item-main">
                <div className="item-meta"><span><strong>{plannerEvidenceKindLabel(item.evidenceKind)}</strong> · {item.status} · unverified</span></div>
                <div>{item.claim}</div>
                {item.reference && <div className="item-meta"><span>{item.reference}</span></div>}
                <div className="item-meta"><span>Completion event #{item.completionEventId}{item.supersedesEvidenceId ? ` · replaces evidence #${item.supersedesEvidenceId}` : ''}</span></div>
                {item.replacedByEvidenceId && <div className="item-meta"><span>Replaced by evidence #{item.replacedByEvidenceId}</span></div>}
                {item.revocationReason && <div className="item-meta"><span>Revoked: {item.revocationReason}</span></div>}
              </div>
              {item.status === 'active' && (
                <div className="button-row">
                  <button type="button" className="secondary" disabled={working} onClick={() => { setForm((current) => ({ ...current, completionEventId: item.completionEventId, supersedesEvidenceId: item.id })); setAttachKey(null); }}>Replace</button>
                  <button type="button" className="secondary" disabled={working} onClick={() => { setRevokeId(item.id); setRevokeReason(''); setRevokeKey(null); }}>Revoke</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {nextBeforeId && <button type="button" className="secondary" disabled={working} onClick={() => loadEvidence({ beforeId: nextBeforeId })}>Load older evidence</button>}
      {revokeId && (
        <div className="propose-form">
          <label className="field">Why evidence #{revokeId} is being revoked
            <input value={revokeReason} disabled={working} onChange={(event) => { setRevokeReason(event.target.value); setRevokeKey(null); }} maxLength="1000" />
          </label>
          <div className="button-row">
            <button type="button" className="secondary" disabled={working || !revokeReason.trim()} onClick={revoke}>Confirm revocation</button>
            <button type="button" className="secondary" disabled={working} onClick={() => { setRevokeId(null); setRevokeKey(null); }}>Cancel</button>
          </div>
        </div>
      )}
      <form className="propose-form" onSubmit={attach}>
        {form.supersedesEvidenceId && <p><small>Replacement for evidence #{form.supersedesEvidenceId}. The earlier record will remain visible as replaced.</small></p>}
        <label className="field">Evidence kind
          <select value={form.evidenceKind} disabled={working} onChange={(event) => { setForm((current) => ({ ...current, evidenceKind: event.target.value, reference: '' })); setAttachKey(null); }}>
            <option value="user_assertion">User statement</option>
            <option value="artifact_reference">Artifact reference</option>
            <option value="external_reference">External reference</option>
          </select>
        </label>
        <label className="field">What supports this completion
          <textarea value={form.claim} disabled={working} maxLength="1000" onChange={(event) => { setForm((current) => ({ ...current, claim: event.target.value })); setAttachKey(null); }} required />
        </label>
        {form.evidenceKind !== 'user_assertion' && (
          <label className="field">{form.evidenceKind === 'artifact_reference' ? 'Relative artifact path' : 'http(s) URL'}
            <input value={form.reference} disabled={working} maxLength="500" onChange={(event) => { setForm((current) => ({ ...current, reference: event.target.value })); setAttachKey(null); }} required />
          </label>
        )}
        <div className="button-row">
          <button type="submit" className="secondary" disabled={working || !form.claim.trim()}>{working ? 'Saving…' : (form.supersedesEvidenceId ? 'Save replacement' : 'Attach supporting evidence')}</button>
          {form.supersedesEvidenceId && <button type="button" className="secondary" disabled={working} onClick={() => { setForm((current) => ({ ...current, completionEventId: null, supersedesEvidenceId: null })); setAttachKey(null); }}>Cancel replacement</button>}
        </div>
        {activeForLatest.length === 0 && <small>No active supporting evidence is attached to this completion.</small>}
      </form>
    </details>
  );
}

function DailyPlanner({ refreshSignal }) {
  const [day, setDay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_PLANNER_FORM);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_PLANNER_FORM);

  const load = async () => {
    try { setDay(await api('/api/planner/day')); setError(null); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [refreshSignal]);

  // Run a mutation, then reload the day. Returns whether the mutation itself
  // succeeded so callers can keep a form's values intact when a request fails.
  async function act(label, work) {
    setBusy(label);
    setError(null);
    let succeeded = false;
    try { await work(); succeeded = true; }
    catch (err) { setError(err.message); }
    await load();
    setBusy(null);
    return succeeded;
  }

  const setMode = (mode) => act(`mode:${mode}`, () => api('/api/planner/capacity', { method: 'POST', body: JSON.stringify({ mode }) }));
  const taskAction = (id, path) => act(`${path}:${id}`, () => api(`/api/planner/tasks/${id}/${path}`, { method: 'POST', body: JSON.stringify({}) }));

  async function addTask(event) {
    event.preventDefault();
    if (!form.title.trim()) return;
    const ok = await act('create', () => api('/api/planner/tasks', { method: 'POST', body: JSON.stringify(form) }));
    if (ok) { setForm(EMPTY_PLANNER_FORM); setShowAdd(false); }
  }
  function startEdit(task) { setEditingId(task.id); setEditForm(plannerFormFromTask(task)); }
  async function saveEdit(id) {
    if (!editForm.title.trim()) return;
    const ok = await act(`edit:${id}`, () => api(`/api/planner/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(editForm) }));
    if (ok) setEditingId(null);
  }

  if (loading && !day) return <Empty title="Loading your day" body="Preparing a capacity-aware plan." />;
  if (!day) {
    return (
      <div className="panel">
        <p className="form-error" role="alert">Couldn't load your day: {error || 'unknown error'}.</p>
        <div className="button-row"><button className="primary" onClick={() => { setLoading(true); load(); }}>Try again</button></div>
      </div>
    );
  }

  const { mode, modes, visible, deferred, visibleLimit, pinnedCount, recentlyCompleted = [] } = day;
  // Split the server's tasks into sections WITHOUT reordering: blocked work is
  // pulled out so it is never silently mixed into (or hidden from) the day.
  const blocked = [...visible, ...deferred].filter((task) => task.blocker);
  const nowTasks = visible.filter((task) => !task.blocker);
  const laterTasks = deferred.filter((task) => !task.blocker);

  const cardProps = (task, section) => ({
    task, section, busy,
    editing: editingId === task.id,
    editForm, setEditForm,
    onEdit: startEdit, onCancelEdit: () => setEditingId(null), onSaveEdit: saveEdit, onAction: taskAction
  });

  return (
    <div className="stacked-panels">
      <div className="panel wide-panel">
        <div className="panel-heading">
          <div><h2>Today</h2><p>A capacity-aware plan. You choose the mode; it shapes the day, and you can override anything.</p></div>
          <Pill tone={mode === 'normal' ? 'good' : 'info'}>{CAPACITY_MODE_LABELS[mode] || mode}</Pill>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="button-row">
          <label className="field">Capacity mode
            <select value={mode} disabled={Boolean(busy)} onChange={(event) => setMode(event.target.value)} aria-label="Capacity mode">
              {modes.map((option) => <option key={option} value={option}>{CAPACITY_MODE_LABELS[option] || option}</option>)}
            </select>
          </label>
          <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => setShowAdd((value) => !value)}>{showAdd ? 'Close' : 'Add task'}</button>
          {busy && busy.startsWith('mode:') && <span className="muted" role="status">Saving…</span>}
        </div>
        <p><small>Showing up to {visibleLimit} task(s) in <strong>{CAPACITY_MODE_LABELS[mode] || mode}</strong>{pinnedCount ? `, ${pinnedCount} pinned` : ''}. Deferring is a choice, not a failure — nothing is lost.</small></p>
        {showAdd && (
          <form className="propose-form" onSubmit={addTask}>
            <PlannerTaskFields form={form} setForm={setForm} disabled={Boolean(busy)} />
            <div className="button-row">
              <button type="submit" className="primary" disabled={Boolean(busy) || !form.title.trim()}>{busy === 'create' ? 'Adding…' : 'Add to plan'}</button>
            </div>
          </form>
        )}
      </div>

      <div className="panel">
        <div className="panel-heading"><div><h2>Now</h2><p>What today is shaped around. Every task shows why it is here.</p></div><Pill tone="info">{nowTasks.length}</Pill></div>
        {nowTasks.length ? (
          <div className="table-list">
            {nowTasks.map((task) => <PlannerTaskCard key={task.id} {...cardProps(task, 'now')} />)}
          </div>
        ) : <Empty title="Nothing scheduled" body="Add a task above, or enjoy the space." />}
      </div>

      {blocked.length > 0 && (
        <div className="panel">
          <div className="panel-heading"><div><h2>Blocked</h2><p>Shown, not hidden — each one names what must clear first.</p></div><Pill tone="warn">{blocked.length}</Pill></div>
          <div className="table-list">
            {blocked.map((task) => <PlannerTaskCard key={task.id} {...cardProps(task, 'blocked')} />)}
          </div>
        </div>
      )}

      {laterTasks.length > 0 && (
        <div className="panel">
          <div className="panel-heading"><div><h2>Later</h2><p>Held for another day — a choice, not a failure.</p></div><Pill tone="default">{laterTasks.length}</Pill></div>
          <div className="table-list">
            {laterTasks.map((task) => <PlannerTaskCard key={task.id} {...cardProps(task, 'later')} />)}
          </div>
        </div>
      )}

      {recentlyCompleted.length > 0 && (
        <div className="panel">
          <div className="panel-heading"><div><h2>Recently completed</h2><p>Recorded Planner status and lifecycle history. Completion is not independent verification.</p></div><Pill tone="good">{recentlyCompleted.length}</Pill></div>
          <div className="table-list">
            {recentlyCompleted.map((task) => (
              <div className="item-row" key={task.id}>
                <div className="item-main">
                  <div className="item-title">{task.title}</div>
                  <div className="item-meta"><span>Completed{formatPlannerCompletionTime(task.completedAt)}</span></div>
                  <div className="item-meta"><span>{task.completionHistoryAvailable ? `History available (${task.completionEventCount} completion event${task.completionEventCount === 1 ? '' : 's'}) · ${task.supportingEvidenceCount} active supporting evidence record${task.supportingEvidenceCount === 1 ? '' : 's'} · Unverified` : 'Legacy history unavailable · Verification unknown'}</span></div>
                  {task.completionHistoryAvailable
                    ? <PlannerEvidencePanel task={task} onChanged={load} />
                    : <details><summary>What this means</summary><small>This task predates Planner lifecycle history. LPS will not invent a past event, supporting evidence binding, or verification result. Reopen and complete it to create a truthful completion event.</small></details>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Layered Workboard cards -------------------------------------------------
// Each card is a layered VIEW of one canonical work order (server /api/workboard
// /cards). The five layers are navigable by layer buttons (an ARIA tablist),
// keyboard, or an intentional hover+wheel; empty layers are shown honestly as
// "nothing recorded yet" rather than fabricated. Title/status/owner/blocker are
// pinned across every layer.
const CARD_LAYERS = [
  { id: 'glance', label: 'Glance' },
  { id: 'context', label: 'Context' },
  { id: 'execution', label: 'Execution' },
  { id: 'proof', label: 'Proof' },
  { id: 'history', label: 'History' }
];

function LayerEmpty({ label }) {
  return <p className="muted">Nothing recorded yet for {label}. This layer stays empty until canonical data exists.</p>;
}

function CardLayerBody({ card, layer }) {
  if (layer === 'glance') {
    const g = card.glance;
    return (
      <dl className="card-facts">
        <div><dt>Status</dt><dd>{card.pinned.status}</dd></div>
        <div><dt>Owner</dt><dd>{card.pinned.owner}</dd></div>
        <div><dt>Confidence</dt><dd>{g.confidence != null ? `${Math.round(g.confidence * 100)}%` : '—'}</dd></div>
        <div><dt>Progress</dt><dd>{g.progress ? `${g.progress.done}/${g.progress.total} done (${Math.round(g.progress.ratio * 100)}%)` : 'not tracked'}</dd></div>
      </dl>
    );
  }
  if (layer === 'context') {
    const c = card.context;
    if (!c.populated) return <LayerEmpty label="Context" />;
    return (
      <div className="card-lines">
        {c.recap && <p><strong>Recap:</strong> {c.recap}</p>}
        {c.latestEvidence && <p><strong>Latest evidence:</strong> {c.latestEvidence}</p>}
        {c.sourceSummary && <p><strong>Source:</strong> {c.sourceSummary}</p>}
        {c.lastReviewed && <p><strong>Last reviewed:</strong> {c.lastReviewed}</p>}
        <p className="muted">{c.linkedItemCount} linked item(s).</p>
      </div>
    );
  }
  if (layer === 'execution') {
    const e = card.execution;
    if (!e.populated) return <LayerEmpty label="Execution" />;
    return (
      <div className="card-lines">
        {e.activeAction && <p><strong>Active / next:</strong> {e.activeAction}</p>}
        {e.blocker && <p><strong>⛔ Blocker:</strong> {e.blocker}</p>}
        {e.subtasks.length > 0 && <ul className="card-subtasks">{e.subtasks.map((s) => <li key={s.id}>{s.title} <span className="muted">· {s.status || 'unknown'}</span></li>)}</ul>}
      </div>
    );
  }
  if (layer === 'proof') {
    const p = card.proof;
    if (!p.populated) return <LayerEmpty label="Proof" />;
    return <ul className="card-subtasks">{p.verifications.map((v, i) => <li key={i}><strong>{v.kind || 'verification'}:</strong> {v.detail || '—'} <span className="muted">· {v.at || ''} {v.actor ? `· ${v.actor}` : ''}</span></li>)}</ul>;
  }
  const h = card.history;
  if (!h.populated) return <LayerEmpty label="History" />;
  return (
    <ol className="card-history">
      {h.events.map((ev) => <li key={ev.id}><strong>{ev.type}</strong>{ev.fromStatus || ev.toStatus ? ` (${ev.fromStatus || '—'} → ${ev.toStatus || '—'})` : ''}{ev.detail ? `: ${ev.detail}` : ''} <span className="muted">· {ev.at || ''} {ev.actor ? `· ${ev.actor}` : ''}</span></li>)}
    </ol>
  );
}

function LayeredCard({ card }) {
  const storageKey = `lps-card-layer-${card.id}`;
  const [index, setIndex] = useState(() => {
    try { const saved = Number(localStorage.getItem(storageKey)); if (Number.isInteger(saved) && saved >= 0 && saved < CARD_LAYERS.length) return saved; } catch { /* no storage */ }
    return 0;
  });
  const [hovered, setHovered] = useState(false);
  const go = (next) => {
    const clamped = Math.max(0, Math.min(CARD_LAYERS.length - 1, next));
    setIndex(clamped);
    try { localStorage.setItem(storageKey, String(clamped)); } catch { /* remember-last-layer is best-effort */ }
  };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); go(index + 1); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); go(index - 1); }
    else if (event.key === 'Home') { event.preventDefault(); go(0); }
    else if (event.key === 'End') { event.preventDefault(); go(CARD_LAYERS.length - 1); }
  };
  // Wheel changes layers ONLY while the card is intentionally hovered, and never
  // hijacks normal page scrolling otherwise.
  const onWheel = (event) => {
    if (!hovered) return;
    event.preventDefault();
    go(index + (event.deltaY > 0 ? 1 : -1));
  };
  const layer = CARD_LAYERS[index];
  const populated = card.populatedLayers || [];
  const statusTone = card.pinned.status === 'active' ? 'info' : card.pinned.status === 'blocked' ? 'warn' : card.pinned.status === 'done' ? 'good' : 'default';
  return (
    <div className="layered-card" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onWheel={onWheel}>
      <div className="layered-card-pinned">
        <div><h3>{card.pinned.title || 'Untitled card'}</h3><small>{card.pinned.owner}</small></div>
        <Pill tone={statusTone}>{card.pinned.status}</Pill>
      </div>
      {card.pinned.blocker && <p className="card-pinned-blocker" role="status">⛔ {card.pinned.blocker}</p>}
      <div className="layered-card-main">
        <div className="card-scrub-rail" aria-hidden="true">
          {CARD_LAYERS.map((l, i) => <span key={l.id} className={cx('scrub-seg', i === index && 'current', populated.includes(l.id) && 'has-data')} />)}
        </div>
        <div className="layered-card-content">
          <div className="card-layer-tabs" role="tablist" aria-label="Card layers" aria-orientation="vertical" onKeyDown={onKeyDown}>
            {CARD_LAYERS.map((l, i) => (
              <button
                key={l.id} role="tab" id={`tab-${card.id}-${l.id}`}
                aria-selected={i === index} aria-controls={`panel-${card.id}`} tabIndex={i === index ? 0 : -1}
                className={cx('card-layer-tab', i === index && 'selected', !populated.includes(l.id) && 'empty-layer')}
                title={populated.includes(l.id) ? l.label : `${l.label} — nothing recorded yet`}
                onClick={() => go(i)}
              >{l.label}</button>
            ))}
          </div>
          <div className="card-layer-panel" id={`panel-${card.id}`} role="tabpanel" aria-labelledby={`tab-${card.id}-${layer.id}`} tabIndex={0}>
            <h4>{layer.label} <span className="muted">· layer {index + 1} of {CARD_LAYERS.length}</span></h4>
            <CardLayerBody card={card} layer={layer.id} />
          </div>
        </div>
      </div>
    </div>
  );
}

function LayeredWorkboard({ setNotice, refreshSignal }) {
  const [cards, setCards] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => { try { const data = await api('/api/workboard/cards'); if (live) setCards(data); } catch (err) { setNotice(err.message); } })();
    return () => { live = false; };
  }, [refreshSignal]);
  if (!cards) return <Empty title="Loading cards" body="Assembling canonical work orders." />;
  if (!cards.length) return <Empty title="No Workboard cards yet" body="Create a project in the Projects tab; it becomes a layered card here." />;
  return (
    <div className="panel">
      <div className="panel-heading"><div><h2>Cards</h2><p>Each card is a layered view of one canonical work order. Empty layers stay honestly empty.</p></div><Pill tone="info">{cards.length}</Pill></div>
      <div className="layered-card-grid">{cards.map((card) => <LayeredCard key={card.id} card={card} />)}</div>
    </div>
  );
}

function Knowledge({ route, navigate, memory, refresh, setNotice, refreshSignal }) {
  const candidateCount = memory.candidates.filter((candidate) => ['candidate', 'deferred'].includes(candidate.status)).length;
  return (
    <section className="section-shell">
      {route.tab === 'memory' && <Memory memory={memory} refresh={refresh} mode="memory" />}
      {route.tab === 'candidates' && (
        <div className="stacked-panels">
          <Memory memory={memory} refresh={refresh} mode="candidates" />
          <ApprovalQueue scope="memory" setNotice={setNotice} refreshPlanner={refresh} />
        </div>
      )}
      {route.tab === 'sources' && <KnowledgeSources memory={memory} setNotice={setNotice} refreshSignal={refreshSignal} />}
      {route.tab === 'rules' && <KnowledgeRules memory={memory} />}
      {route.tab === 'calibration' && <Calibration setNotice={setNotice} refreshSignal={refreshSignal} />}
    </section>
  );
}

function System({ route, selectedSession, boot, planner, sessions, models, setNotice, refresh, refreshSignal, proposeFeedbackTriage, confirmFeedbackTriage }) {
  return (
    <section className="section-shell">
      {route.tab === 'status' && <SystemStatus boot={boot} planner={planner} sessions={sessions} models={models} setNotice={setNotice} refreshSignal={refreshSignal} />}
      {route.tab === 'setup' && <SetupRecovery boot={boot} selectedSession={selectedSession} setNotice={setNotice} refreshSignal={refreshSignal} />}
      {route.tab === 'repository' && <RepositoryExplorer setNotice={setNotice} refreshSignal={refreshSignal} />}
      {route.tab === 'browser' && <BrowserConsult setNotice={setNotice} refresh={refresh} refreshSignal={refreshSignal} />}
      {route.tab === 'tools' && <Tooling setNotice={setNotice} refreshSignal={refreshSignal} />}
      {route.tab === 'runs' && <SourceControl setNotice={setNotice} refreshSignal={refreshSignal} initialTab="coding" availableTabs={['coding']} />}
      {route.tab === 'feedback' && <FeedbackReview setNotice={setNotice} refreshSignal={refreshSignal} proposeFeedbackTriage={proposeFeedbackTriage} confirmFeedbackTriage={confirmFeedbackTriage} />}
      {route.tab === 'quality' && <QualityReview setNotice={setNotice} refreshSignal={refreshSignal} />}
    </section>
  );
}

// Unified review surface for the quality engines: the failure taxonomy (with
// confirmation-gated remediation proposals) and the measured cost-routing
// summary. Read + triage only — nothing here changes prompts, rules, or
// behaviour automatically.
function QualityReview({ setNotice, refreshSignal }) {
  const [failures, setFailures] = useState(null);
  const [routing, setRouting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [evaluationDrafts, setEvaluationDrafts] = useState({});
  const load = async () => {
    try { setFailures(await api('/api/failures')); setRouting(await api('/api/routing/summary')); }
    catch (err) { setNotice(err.message); }
  };
  useEffect(() => { load(); }, [refreshSignal]);
  const triage = async (id, status) => {
    setBusy(true);
    try { await api(`/api/failures/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); }
    catch (err) { setNotice(err.message); } finally { setBusy(false); }
  };
  const updateEvaluationDraft = (id, patch) => setEvaluationDrafts((drafts) => ({ ...drafts, [id]: { ...(drafts[id] || {}), ...patch } }));
  const updateEvaluationCount = (id, phase, category, value) => setEvaluationDrafts((drafts) => ({
    ...drafts,
    [id]: { ...(drafts[id] || {}), [phase]: { ...(drafts[id]?.[phase] || {}), [category]: value } }
  }));
  const evaluateFailure = async (item) => {
    if (busy) return;
    const draft = evaluationDrafts[item.id] || {};
    const categories = failures.categories || [];
    if (!draft.regressionRef?.trim() || !categories.length || !categories.every((category) => draft.before?.[category] !== undefined && draft.before[category] !== '' && draft.after?.[category] !== undefined && draft.after[category] !== '')) {
      return setNotice('Add a regression/test reference and complete every before/after failure count.');
    }
    const before = Object.fromEntries(categories.map((category) => [category, Number(draft.before[category])]));
    const after = Object.fromEntries(categories.map((category) => [category, Number(draft.after[category])]));
    setBusy(true);
    try {
      const result = await api(`/api/failures/${item.id}/evaluations`, { method: 'POST', body: JSON.stringify({ regressionRef: draft.regressionRef, before, after }) });
      setNotice(result.converted
        ? `Failure #${item.id} converted through passing evaluation #${result.evaluation.id}. No behaviour changed automatically.`
        : `Evaluation #${result.evaluation.id} did not pass: ${result.evaluation.reason}`);
      await load();
    } catch (err) { setNotice(err.message); } finally { setBusy(false); }
  };
  if (!failures || !routing) return <Empty title="Loading quality signals" body="Gathering failures and routing evidence." />;
  const proposals = failures.proposals || [];
  return (
    <div className="stacked-panels">
      <div className="panel">
        <div className="panel-heading"><div><h2>Failures</h2><p>Recorded failures for reviewed self-improvement. A single failure changes nothing; only a confirmed one proposes a reviewed candidate.</p></div><Pill tone="info">{failures.failures.length}</Pill></div>
        {proposals.length > 0 && (
          <div className="source-warning info" role="status">
            <strong>Confirmed failures proposing reviewed follow-ups</strong>
            <ul>{proposals.map((proposal) => <li key={proposal.id}>#{proposal.id} {proposal.category} → {proposal.kind}</li>)}</ul>
          </div>
        )}
        {failures.failures.length ? (
          <div className="table-list">
            {failures.failures.map((item) => (
              <div className="item-row" key={item.id}>
                <div className="item-main">
                  <div className="item-title">{item.category} <span className="muted">· {item.status}</span></div>
                  {item.evidence && <div className="item-meta"><span>{item.evidence}</span></div>}
                  <div className="item-meta"><span>{item.source ? `${item.source} · ` : ''}{item.task_ref ? `task ${item.task_ref} · ` : ''}{item.run_id ? `run ${item.run_id} · ` : ''}{item.created_at}</span></div>
                </div>
                <div className="button-row">
                  {item.status === 'observed' && <button className="secondary" disabled={busy} onClick={() => triage(item.id, 'confirmed')}>Confirm</button>}
                  <button className="secondary" disabled={busy} onClick={() => triage(item.id, 'dismissed')}>Dismiss</button>
                </div>
                {item.status === 'confirmed' && (
                  <details className="evaluation-form">
                    <summary>Evaluate refinement</summary>
                    <p className="muted">Conversion requires a complete before/after snapshot. A passing evaluation marks this failure converted and records evidence only; it never changes prompts, rules, memory, or runtime behaviour.</p>
                    <label>Regression or test reference<input value={evaluationDrafts[item.id]?.regressionRef || ''} onChange={(event) => updateEvaluationDraft(item.id, { regressionRef: event.target.value })} maxLength={200} /></label>
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead><tr><th>Failure category</th><th>Before</th><th>After</th></tr></thead>
                        <tbody>{(failures.categories || []).map((category) => (
                          <tr key={category}>
                            <td>{category}</td>
                            <td><input aria-label={`${category} before count`} type="number" min="0" max="1000000" step="1" value={evaluationDrafts[item.id]?.before?.[category] ?? ''} onChange={(event) => updateEvaluationCount(item.id, 'before', category, event.target.value)} /></td>
                            <td><input aria-label={`${category} after count`} type="number" min="0" max="1000000" step="1" value={evaluationDrafts[item.id]?.after?.[category] ?? ''} onChange={(event) => updateEvaluationCount(item.id, 'after', category, event.target.value)} /></td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                    <button className="secondary" disabled={busy} onClick={() => evaluateFailure(item)}>Evaluate and convert if passing</button>
                  </details>
                )}
                {item.evaluations?.length > 0 && (
                  <details className="evaluation-history">
                    <summary>Recorded evaluations ({item.evaluations.length})</summary>
                    {item.evaluations.map((evaluation) => (
                      <div className="item-meta" key={evaluation.id}>
                        <strong>#{evaluation.id} · {evaluation.improved ? 'passed' : 'did not pass'} · {evaluation.regressionRef}</strong>
                        <span>{evaluation.reason}</span>
                        <code>before {JSON.stringify(evaluation.before)} · after {JSON.stringify(evaluation.after)}</code>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
          </div>
        ) : <Empty title="No open failures" body="Nothing recorded for review." />}
      </div>

      <div className="panel">
        <div className="panel-heading"><div><h2>Routing evidence</h2><p>Measured route outcomes are compared only within complete model, effort, and cost-unit provenance. Legacy or incomplete evidence stays visible but is excluded. Recommendations do not change execution routes automatically.</p></div><Pill tone="default">{routing.observationCount}</Pill></div>
        {routing.routes.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Task class</th><th>Route</th><th>Model / effort</th><th>Cost unit</th><th>Attempts</th><th>Success rate</th><th>Avg attempt cost</th><th>Cost / successful task</th></tr></thead>
              <tbody>
                {routing.routes.map((route) => (
                  <tr key={`${route.taskClass}|${route.route}|${route.model || ''}|${route.effort || ''}|${route.costUnit || ''}`}>
                    <td>{route.taskClass || '—'}</td><td>{route.route}</td><td>{route.provenanceComplete ? `${route.model} / ${route.effort}` : 'Legacy / incomplete'}</td><td>{route.costUnit || '—'}</td><td>{route.attempts}</td>
                    <td>{Math.round(route.successRate * 100)}%</td><td>{route.avgEffectiveCost == null ? '—' : route.avgEffectiveCost.toFixed(2)}</td><td>{route.costPerSuccessfulTask == null ? '—' : route.costPerSuccessfulTask.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty title="No routing evidence yet" body="Route outcomes appear here as they are recorded." />}
      </div>
    </div>
  );
}

// Low-friction capture: mark a chat reply useful, or flag a problem with an
// optional expected-behaviour note. It POSTs to the review queue only and never
// blocks the chat or changes behaviour; failures are swallowed silently.
function FeedbackControl({ message }) {
  const [mode, setMode] = useState('idle');
  const [sentiment, setSentiment] = useState('wrong');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [doneLabel, setDoneLabel] = useState('');
  const metadata = parseMessageMetadata(message.metadata);
  const submit = async (chosen) => {
    setPending(true);
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify({ sentiment: chosen, surface: 'chat:reply', runId: String(message.id), provider: metadata?.model || metadata?.runtime || null, note: note.trim() || null }) });
      setDoneLabel(chosen); setMode('done'); setNote('');
    } catch { /* feedback capture must never disrupt the conversation */ }
    setPending(false);
  };
  if (mode === 'done') return <span className="feedback-thanks" role="status">Thanks — “{doneLabel}” logged for review.</span>;
  return (
    <span className="feedback-control">
      <button type="button" className="feedback-quick" title="Mark this reply useful" aria-label="Mark reply useful" disabled={pending} onClick={() => submit('useful')}>👍</button>
      <button type="button" className="feedback-quick" title="Flag a problem with this reply" aria-label="Flag a problem with this reply" aria-expanded={mode === 'flag'} disabled={pending} onClick={() => setMode(mode === 'flag' ? 'idle' : 'flag')}>⚑</button>
      {mode === 'flag' && (
        <span className="feedback-flag">
          <select aria-label="What was off with this reply" value={sentiment} onChange={(event) => setSentiment(event.target.value)} disabled={pending}>
            <option value="wrong">Wrong</option>
            <option value="confusing">Confusing</option>
            <option value="broken">Broken</option>
            <option value="incomplete">Incomplete</option>
            <option value="unnecessary">Unnecessary</option>
          </select>
          <input placeholder="Optional: what did you expect?" value={note} onChange={(event) => setNote(event.target.value)} disabled={pending} />
          <button type="button" className="feedback-send" disabled={pending} onClick={() => submit(sentiment)}>Send</button>
        </span>
      )}
    </span>
  );
}

function FeedbackReview({ setNotice, refreshSignal, proposeFeedbackTriage, confirmFeedbackTriage }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const load = async () => { try { setData(await api('/api/feedback')); } catch (err) { setNotice(err.message); } };
  useEffect(() => { load(); }, [refreshSignal]);
  const propose = async (item, status, label) => {
    setBusy(true);
    try {
      const result = await proposeFeedbackTriage(item.id, status);
      setPending({ ...result.confirmation, itemId: item.id, status, label });
    } catch (err) { setNotice(err.message); } finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const applied = await confirmFeedbackTriage(pending);
      if (pending.status === 'routed' && applied.failureEventId) {
        setNotice(`Routed to Quality review as observed failure #${applied.failureEventId}. No behaviour changed automatically.`);
      }
      setPending(null);
      await load();
    } catch (err) { setNotice(err.message); } finally { setBusy(false); }
  };
  if (!data) return <Empty title="Loading feedback" body="Gathering the review queue." />;
  const { feedback, themes } = data;
  const proposed = (themes || []).filter((theme) => theme.proposeConsolidation);
  return (
    <div className="stacked-panels">
      <div className="panel">
        <div className="panel-heading"><div><h2>Feedback review</h2><p>Captured feedback is queued here for review only. It never changes prompts, rules, memory, or behaviour automatically.</p></div><Pill tone="info">{feedback.length}</Pill></div>
        {proposed.length > 0 && (
          <div className="source-warning info" role="status">
            <strong>Recurring themes worth a regression test or issue</strong>
            <ul>{proposed.map((theme) => <li key={theme.themeKey}>{theme.count}× {theme.sentiment} on {theme.surface || 'unspecified surface'}</li>)}</ul>
          </div>
        )}
        {feedback.length ? (
          <div className="table-list">
            {feedback.map((item) => (
              <div className="item-row" key={item.id}>
                <div className="item-main">
                  <div className="item-title">{item.sentiment}{item.surface ? ` · ${item.surface}` : ''}{item.sensitive ? ' · 🔒 local only' : ''}</div>
                  {item.note && <div className="item-meta"><span>{item.note}</span></div>}
                  <div className="item-meta"><span>{item.provider ? `${item.provider} · ` : ''}{item.run_id ? `run ${item.run_id} · ` : ''}{item.created_at}</span></div>
                </div>
                {pending?.itemId === item.id ? (
                  <div className="button-row">
                    <span>{pending.label}?</span>
                    <button className="primary" data-action-id="feedback.propose_triage" data-control-id="feedback-review.triage.confirm" disabled={busy} onClick={confirm}>{busy ? 'Applying…' : 'Confirm'}</button>
                    <button className="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
                  </div>
                ) : (
                  <div className="button-row">
                    {Boolean(item.actionable) && <button className="secondary" data-action-id="feedback.propose_triage" data-control-id="feedback-review.triage.route" disabled={busy} onClick={() => propose(item, 'routed', 'Route to Quality review')}>Route to Quality review</button>}
                    <button className="secondary" data-action-id="feedback.propose_triage" data-control-id="feedback-review.triage.dismiss" disabled={busy} onClick={() => propose(item, 'dismissed', 'Dismiss')}>Dismiss</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : <Empty title="No feedback yet" body="Use 👍 or ⚑ on a chat reply to capture feedback." />}
      </div>
    </div>
  );
}

function CompletedWorkboard({ setNotice, refreshSignal }) {
  const [records, setRecords] = useState({ items: [], projects: [], roadmap: [], runs: [] });

  useEffect(() => {
    Promise.all([api('/api/items?all=1'), api('/api/projects'), api('/api/roadmap'), api('/api/tooling/openhands/requests').catch(() => [])])
      .then(([items, projects, roadmap, runs]) => setRecords({ items, projects, roadmap, runs }))
      .catch((err) => setNotice(err.message));
  }, [refreshSignal, setNotice]);

  const items = records.items.filter((item) => ['done', 'archived', 'deprecated', 'superseded'].includes(item.status));
  const projects = records.projects.filter((project) => ['done', 'completed', 'archived'].includes(project.status));
  const roadmap = records.roadmap.filter((item) => item.status === 'done');
  const runs = records.runs.filter((run) => ['completed', 'succeeded', 'executor-ran'].includes(run.status));
  const groups = [
    ['Workboard records', items, (item) => <ItemRow item={item} compact />],
    ['Projects', projects, (project) => <ItemRow item={{ ...project, title: project.name, type: 'project' }} compact />],
    ['Development roadmap', roadmap, (item) => <ItemRow item={{ ...item, type: item.category || 'roadmap' }} compact />],
    ['Execution requests', runs, (run) => <ItemRow item={{ ...run, type: 'execution request' }} compact />]
  ];
  return (
    <div className="completed-grid">
      <div className="panel wide-panel">
        <h2>Completed</h2>
        <p>One read-only index of existing completed, archived, deprecated, and superseded records. Nothing is copied or migrated here.</p>
      </div>
      {groups.map(([title, recordsForGroup, render]) => (
        <div className="panel" key={title}>
          <div className="panel-heading"><h2>{title}</h2><Pill tone="good">{recordsForGroup.length}</Pill></div>
          {recordsForGroup.length ? <div className="table-list">{recordsForGroup.map((record) => <React.Fragment key={record.id}>{render(record)}</React.Fragment>)}</div> : <Empty title="Nothing recorded" body="Completed source records will appear here when they exist." />}
        </div>
      ))}
    </div>
  );
}

function KnowledgeSources({ memory, setNotice, refreshSignal }) {
  const records = [...memory.items, ...memory.candidates].filter((item) => item.source || item.evidence);
  return (
    <section className="panel">
      <div className="panel-heading"><div><h2>Sources & evidence</h2><p>Live provenance from existing memory and candidate records. Source details are never invented or promoted from this view.</p></div><Pill tone="info">{records.length} records</Pill></div>
      <div className="source-warning info"><strong>Source Control is here</strong><small>Git changes, history, branches, and safe publishing (commit / push / PR) are in the <b>Source Control</b> panel below. Local coding runs are under System → Runs.</small></div>
      {records.length ? <div className="table-list">{records.map((record) => <div className="memory-row" key={`${record.id}-${record.status}`}><ItemRow item={record} compact /><div className="candidate-meta"><span>Source: {record.source || 'not recorded'}</span><span>Evidence: {record.evidence || 'not recorded'}</span></div></div>)}</div> : <Empty title="No provenance records" body="Source and evidence details will appear when existing records provide them." />}
      <div className="source-management" id="source-control"><h2><GitBranch size={18} /> Source Control</h2><p>Git repository provenance, changes, history, branches, and safe publication controls live here. Local coding runs are surfaced separately in System → Runs.</p><SourceControl setNotice={setNotice} refreshSignal={refreshSignal} initialTab="changes" availableTabs={['changes', 'history', 'branches', 'sync']} /></div>
    </section>
  );
}

function KnowledgeRules({ memory }) {
  const rules = memory.items.filter((item) => item.type === 'rule');
  return (
    <section className="panel">
      <div className="panel-heading"><div><h2>Rules</h2><p>Approved rule records from the local knowledge store. Updates remain governed through the Knowledge review flow.</p></div><Pill tone="info">{rules.length}</Pill></div>
      {rules.length ? <div className="table-list">{rules.map((rule) => <ItemRow key={rule.id} item={rule} />)}</div> : <Empty title="No approved rules" body="Approved items with the rule type will be shown here." />}
    </section>
  );
}

function SystemStatus({ boot, planner, sessions, models, setNotice, refreshSignal }) {
  const runtime = boot?.runtimeDiagnostics;
  const storageAvailable = Boolean(runtime?.activeDatabasePath);
  const storage = storageAvailable ? 'Local SQLite database' : boot ? 'Database unavailable' : 'Checking local database…';
  const [live, setLive] = useState({ tooling: null, connector: null, source: null, coding: null });
  useEffect(() => {
    Promise.all([
      api('/api/tooling/status'),
      api('/api/browser/extension/install-info'),
      api('/api/source/status'),
      api('/api/source/coding/status')
    ]).then(([tooling, connector, source, coding]) => setLive({ tooling, connector, source, coding })).catch((err) => setNotice(err.message));
  }, [refreshSignal, setNotice]);
  return (
    <section className="status-grid">
      <div className="panel wide-panel"><h2>Local system status</h2><p>Reported from the current bootstrap response only; this page does not run synthetic checks.</p></div>
      <div className="panel"><h3>About / Build</h3><Pill tone={boot?.build?.dirty ? 'warn' : boot?.build?.commit && boot.build.commit !== 'unknown' ? 'good' : 'warn'}>{boot?.build ? `v${boot.build.version || '—'}` : 'Checking'}</Pill><p>Commit <code>{boot?.build?.shortCommit || 'unknown'}</code>{boot?.build?.dirty ? ' · built from a dirty tree' : ''}<br />Built {boot?.build?.buildTime ? new Date(boot.build.buildTime).toLocaleString() : 'time unknown'}<br />{boot?.build?.repository || 'Daa13x/LifePlanSystemPublic'}</p></div>
      <div className="panel"><h3>Storage</h3><Pill tone={storageAvailable ? 'good' : 'warn'}>{storageAvailable ? 'Available' : boot ? 'Unavailable' : 'Checking'}</Pill><p role="status" aria-live="polite">{storage}</p></div>
      <div className="panel wide-panel"><h3>Personal knowledge runtime</h3><Pill tone={runtime?.personalRetrievalEnabled ? 'good' : 'warn'}>{runtime?.personalRetrievalEnabled ? 'Enabled' : 'Checking'}</Pill><p>Build <code>{runtime?.build?.shortCommit || 'unknown'}</code> · database <code>{runtime?.activeDatabasePath ? 'local SQLite' : 'checking'}</code><br />{runtime ? `${runtime.coverage?.totalRetrievable || 0} eligible records: ${runtime.coverage?.counts?.activeKnowledge || 0} Knowledge, ${runtime.coverage?.counts?.activeProjects || 0} projects, ${runtime.coverage?.counts?.eligibleUserChatMessages || 0} user Chat, ${runtime.coverage?.counts?.privateRepositoryFiles || 0} private-repo files.` : 'Loading runtime diagnostics…'}<br />Last retrieval: {runtime?.lastPersonalRetrieval?.resultType || 'none'} ({runtime?.lastPersonalRetrieval?.sourceCount || 0} source(s)).</p></div>
      <div className="panel"><h3>Workboard</h3><strong>{planner?.summary?.focus ?? '—'} focus items</strong><p>{planner?.summary?.approvals ?? '—'} pending approvals · {planner?.summary?.candidates ?? '—'} memory candidates</p></div>
      <div className="panel"><h3>Chat</h3><strong>{sessions.length} active sessions</strong><p>Sessions are loaded from the local database.</p></div>
      <div className="panel"><h3>Models</h3><strong>{models.length} configured records</strong><p>Runtime readiness and installation controls are available under Tools and Settings.</p></div>
      <div className="panel"><h3>Browser connector</h3><Pill tone={live.connector?.connected ? 'good' : 'warn'}>{live.connector ? live.connector.connected ? 'Connected' : 'Needs attention' : 'Checking'}</Pill><p>{live.connector?.recommendedAction || 'Loading connector state…'}</p></div>
      <div className="panel"><h3>Repository</h3><Pill tone={live.source?.hasConflicts ? 'bad' : live.source ? 'good' : 'warn'}>{live.source ? live.source.hasConflicts ? 'Conflicts' : live.source.hasChanges ? 'Changes pending' : 'Clean' : 'Checking'}</Pill><p>{live.source?.branch ? `${live.source.branch}${live.source.upstream ? ` → ${live.source.upstream}` : ''}` : 'Loading local repository state…'}</p></div>
      <div className="panel"><h3>Tools & runs</h3><Pill tone={live.tooling?.playwright?.available ? 'good' : 'warn'}>{live.tooling ? live.tooling.playwright?.available ? 'Tooling available' : 'Setup needed' : 'Checking'}</Pill><p>{live.coding ? `${live.coding.activeTaskIds?.length || 0} active coding run(s)` : 'Loading active run state…'}</p></div>
    </section>
  );
}

function SetupRecovery({ boot, selectedSession, setNotice, refreshSignal }) {
  const [state, setState] = useState({ setup: null, recovery: null });
  const [busy, setBusy] = useState('');
  const [proposal, setProposal] = useState(null);
  const [lastResult, setLastResult] = useState('');

  const refreshRecovery = async () => {
    const [setup, recovery] = await Promise.all([api('/api/setup/status'), api('/api/recovery/status')]);
    setState({ setup, recovery });
  };
  useEffect(() => { refreshRecovery().catch((err) => setNotice(err.message)); }, [refreshSignal, setNotice]);

  async function run(label, work) {
    setBusy(label);
    try {
      const result = await work();
      await refreshRecovery();
      return result;
    } catch (err) {
      setLastResult(`Failed: ${err.message}`);
      setNotice(err.message);
      return null;
    } finally { setBusy(''); }
  }
  async function openModelSettings() {
    if (busy) return;
    setBusy('navigation-settings');
    try {
      const result = await invokeNeutralAction('navigation.settings', {}, selectedSession);
      if (result.data?.applied) setNotice('Opened Local Model settings.');
      else setNotice(`Settings navigation did not apply (${result.data?.status || 'unknown'}).`);
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy('');
    }
  }
  const environment = state.recovery?.environment || state.setup;
  const backups = state.recovery?.backups || [];
  const overall = environment?.pendingRestore ? 'Recovery pending' : environment?.ready ? 'Healthy' : environment ? 'Attention needed' : 'Checking';
  const tone = overall === 'Healthy' ? 'good' : overall === 'Checking' ? 'warn' : 'bad';

  return (
    <section className="stacked-panels">
      <div className="panel wide-panel">
        <div className="panel-heading"><div><h2><ShieldCheck size={18} /> Setup & Recovery</h2><p>Live local diagnostics, validated backups, and restart-safe recovery. Restore is staged first and only completes during the next application restart.</p></div><Pill tone={tone}>{overall}</Pill></div>
        <p>Build <code>{boot?.build?.shortCommit || 'unknown'}</code> · version {boot?.build?.version || 'unknown'} · {environment?.pendingRestore ? 'Restart Life Planner to complete the staged recovery.' : 'No restart is currently required.'}</p>
        <div className="button-row">
          <button className="secondary" disabled={Boolean(busy)} onClick={() => run('diagnostics', async () => { await api('/api/setup/repair/data-directory', { method: 'POST' }); setLastResult('Diagnostics rechecked; the data-directory repair is safe and bounded.'); })}><RefreshCcw size={15} /> {busy === 'diagnostics' ? 'Checking…' : 'Re-check diagnostics'}</button>
          <button className="primary" disabled={Boolean(busy)} onClick={() => run('backup', async () => { const backup = await api('/api/recovery/backup', { method: 'POST' }); setLastResult(`Backup created: ${backup.name}.`); })}><Archive size={15} /> {busy === 'backup' ? 'Creating backup…' : 'Create backup'}</button>
        </div>
        {lastResult && <div className="source-warning info"><strong>Latest operation</strong><small>{lastResult}</small></div>}
      </div>

      <div className="panel">
        <div className="panel-heading"><div><h2>Diagnostics</h2><p>Results are generated by the local server and omit secrets and filesystem paths.</p></div><Pill tone={environment?.ready ? 'good' : 'warn'}>{environment ? `${environment.checks?.filter((check) => check.ok).length || 0}/${environment.checks?.length || 0}` : '—'}</Pill></div>
        <div className="table-list">
          {(environment?.checks || []).map((check) => {
            const setupTarget = check.id === 'local-model' || check.id === 'local-runtime' ? 'settings' : null;
            return <div className="item-row compact-row" key={check.id}><div className="item-main"><div className="item-title">{check.id.replace(/-/g, ' ')}</div><div className="item-meta"><span>{check.detail}</span></div></div>{!check.ok && setupTarget ? <button className="pill warn diagnostic-action" data-action-id="navigation.settings" data-control-id="setup-recovery.diagnostics.open-model-settings" disabled={Boolean(busy)} onClick={openModelSettings} title="Open Local Model settings">{busy === 'navigation-settings' ? 'Opening…' : 'Not configured'}</button> : <Pill tone={check.ok ? 'good' : check.required ? 'bad' : 'warn'}>{check.ok ? 'Healthy' : check.required ? 'Attention needed' : 'Not configured'}</Pill>}</div>;
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading"><div><h2>Backups and restore</h2><p>Backups are validated SQLite snapshots. Temporary files, logs, models, and browser profiles are excluded. Settings remain in the snapshot; credential values stay protected by Windows DPAPI and work only for the same Windows user.</p></div><Pill tone="info">{backups.length}</Pill></div>
        {backups.length ? <div className="table-list">{backups.map((backup) => <div className="item-row" key={backup.name}><div className="item-main"><div className="item-title">{backup.label || 'backup'}</div><div className="item-meta"><span>{new Date(backup.createdAt).toLocaleString()}</span><span>{backup.files?.length || 0} validated file(s)</span></div></div><div className="button-row"><button className="secondary" disabled={Boolean(busy)} onClick={() => run(`validate-${backup.name}`, async () => { const result = await api('/api/recovery/backup/validate', { method: 'POST', body: JSON.stringify({ backup: backup.name }) }); setLastResult(result.valid ? 'Backup validation passed.' : 'Backup validation failed.'); })}>Validate</button><button className="secondary" disabled={Boolean(busy) || Boolean(proposal)} onClick={() => run(`propose-${backup.name}`, async () => { const next = await api('/api/recovery/restore/propose', { method: 'POST', body: JSON.stringify({ backup: backup.name }) }); setProposal(next); setLastResult('Restore is ready for confirmation. No data has changed.'); })}>Restore…</button></div></div>)}</div> : <Empty title="No validated backups" body="Create a local backup before attempting a restore." />}
        {proposal && <div className="source-warning warning"><strong>Confirm staged restore</strong><small>This will replace the live application database with the selected validated backup on the next restart. The current database is preserved for rollback until the replacement is verified.</small><div className="button-row"><button className="primary" disabled={Boolean(busy)} onClick={() => run('confirm-restore', async () => { const result = await api('/api/recovery/restore/confirm', { method: 'POST', body: JSON.stringify({ confirmationId: proposal.confirmationId, token: proposal.token }) }); setProposal(null); setLastResult(result.message || 'Restore staged for the next restart.'); })}><RotateCcw size={15} /> {busy === 'confirm-restore' ? 'Staging…' : 'Confirm and stage restore'}</button><button className="secondary" disabled={Boolean(busy)} onClick={() => { setProposal(null); setLastResult('Restore confirmation dismissed; no data changed.'); }}>Cancel</button></div></div>}
      </div>
    </section>
  );
}

function QuickAddItem({ refresh, setNotice }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ type: 'goal', title: '', body: '', due_at: '', next_action: '' });
  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function save() {
    if (!form.title.trim()) return;
    setBusy(true);
    try {
      await api('/api/items', { method: 'POST', body: JSON.stringify({ ...form, status: form.type === 'blocker' ? 'blocked' : 'active' }) });
      setForm({ type: 'goal', title: '', body: '', due_at: '', next_action: '' });
      setOpen(false);
      setNotice?.('Item added to the Workboard.');
      refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <button className="primary subtle" onClick={() => setOpen(true)}>+ Add Workboard item</button>;
  }
  return (
    <div className="quick-add">
      <div className="quick-add-row">
        <select value={form.type} onChange={set('type')} disabled={busy}>
          {['goal', 'project', 'decision', 'reminder', 'blocker', 'waiting', 'rule', 'note'].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input value={form.title} onChange={set('title')} placeholder="What needs tracking?" disabled={busy} autoFocus />
      </div>
      <textarea value={form.body} onChange={set('body')} placeholder="Detail (optional)" disabled={busy} rows={2} />
      <div className="quick-add-row">
        <input type="date" value={form.due_at} onChange={set('due_at')} disabled={busy} />
        <input value={form.next_action} onChange={set('next_action')} placeholder="Next action (optional)" disabled={busy} />
      </div>
      <div className="quick-add-row">
        <button className="primary" onClick={save} disabled={busy || !form.title.trim()}>{busy ? 'Saving...' : 'Save item'}</button>
        <button className="primary subtle" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

function PlannerItemActions({ item, refresh, proposeWorkboardItemUpdate, confirmWorkboardItemUpdate, setNotice }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  async function propose(changes, label) {
    setBusy(true);
    try {
      const result = await proposeWorkboardItemUpdate(item.id, changes);
      setPending({ ...result.confirmation, label });
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true);
    try {
      await confirmWorkboardItemUpdate(pending);
      setPending(null);
      refresh();
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  if (pending) {
    return (
      <div className="item-actions item-actions-confirm">
        <span>{pending.label}?</span>
        <button className="primary" data-action-id="workboard.propose_update" data-control-id="planner.item-actions.confirm" disabled={busy} onClick={confirm}>{busy ? 'Applying…' : 'Confirm'}</button>
        <button className="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
      </div>
    );
  }
  return (
    <div className="item-actions">
      {item.status !== 'done' && (
        <button title="Mark done" data-action-id="workboard.propose_update" data-control-id="planner.item-actions.done" disabled={busy} onClick={() => propose({ status: 'done', last_reviewed: 'today' }, 'Mark done')}>Done</button>
      )}
      <button title="Mark reviewed (clears stale)" data-action-id="workboard.propose_update" data-control-id="planner.item-actions.seen" disabled={busy} onClick={() => propose(item.status === 'stale' ? { status: 'active', last_reviewed: 'today' } : { last_reviewed: 'today' }, 'Mark reviewed')}>Seen</button>
      <button title="Archive" data-action-id="workboard.propose_update" data-control-id="planner.item-actions.drop" disabled={busy} onClick={() => propose({ status: 'archived' }, 'Archive')}>Drop</button>
    </div>
  );
}

function CodingWorkQueue({ navigate, proposeCodingTask, confirmCodingTask, setNotice }) {
  const [coding, setCoding] = useState({ tasks: [] });
  const [draft, setDraft] = useState({ title: '', objective: '', allowedPaths: 'src', maxFilesChanged: 3, validation: 'frontend' });
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const load = () => api('/api/source/coding/status').then(setCoding).catch((error) => setNotice(error.message));
  useEffect(() => { load(); }, []);
  async function propose() {
    setBusy(true);
    try {
      const result = await proposeCodingTask(draft);
      setPending({ ...result.confirmation, preview: result.data?.preview || draft });
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true);
    try {
      await confirmCodingTask(pending);
      setPending(null);
      setDraft((current) => ({ ...current, title: '', objective: '' }));
      await load();
      setNotice('Coding work queued with a sealed scope. Prepare it in System > Runs.');
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  return <div className="coding-workboard-card">
    <div className="panel-heading"><div><h3>Local coding queue</h3><p>Narrow development work for the supervised local model.</p></div><Pill tone="info">{coding.tasks?.filter((task) => !['applied', 'rejected'].includes(task.status)).length || 0}</Pill></div>
    {pending ? (
      <div className="coding-task-confirm">
        <p>Review before sealing: <strong>{pending.preview.title}</strong></p>
        <p>{pending.preview.objective}</p>
        <div className="button-row">
          <button className="primary" data-action-id="coding.propose_task" data-control-id="planner.coding-queue.confirm" disabled={busy} onClick={confirm}>{busy ? 'Sealing…' : 'Confirm seal'}</button>
          <button className="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
        </div>
      </div>
    ) : (
      <details><summary>Queue a coding task</summary>
        <label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Small code outcome" /></label>
        <label>Objective<textarea value={draft.objective} onChange={(event) => setDraft({ ...draft, objective: event.target.value })} placeholder="Defect, constraints, and acceptance result" /></label>
        <label>Allowed paths<textarea value={draft.allowedPaths} onChange={(event) => setDraft({ ...draft, allowedPaths: event.target.value })} /></label>
        <button className="primary" data-action-id="coding.propose_task" data-control-id="planner.coding-queue.seal-and-queue" onClick={propose} disabled={busy || !draft.title.trim() || !draft.objective.trim() || !draft.allowedPaths.trim()}>Seal and queue</button>
      </details>
    )}
    <div className="coding-workboard-list">{(coding.tasks || []).slice(0, 4).map((task) => <button key={task.id} onClick={() => navigate('system', 'runs')}><span>{task.title}</span><small>{CODING_STATUS_LABELS[task.status] || task.status}</small></button>)}</div>
    <button className="secondary" onClick={() => navigate('system', 'runs')}>Open coding workspace</button>
  </div>;
}

function Planner({ planner, refresh, runRefresh, proposeCodingTask, confirmCodingTask, setNotice, navigate }) {
  if (!planner) return <div className="loading">Loading Workboard context...</div>;
  const nextBestBody = planner.nextBest?.body
    || (planner.nextBest?.action_type ? 'Review and approve, deny, or defer this proposed change.' : 'Add goals, projects, or memory candidates to feed the Workboard.');
  const buckets = [
    ['Today’s Focus', planner.focus, 'good'],
    ['Blocked', planner.blockers, 'bad'],
    ['Waiting On Me', planner.waiting, 'warn'],
    ['Can Continue Automatically', planner.automatic, 'info'],
    ['Drifting Or Stale', planner.stale, 'muted']
  ];
  return (
    <section className="planner-grid">
      <div className="focus-panel">
        <div className="panel-heading">
          <div>
            <h2>Best Next Action</h2>
            <p>{planner.nextBest?.next_action || planner.nextBest?.title || 'Review the memory and approval queues.'}</p>
          </div>
          <Pill tone="good">Priority grouped</Pill>
        </div>
        <div className="next-action">
          <ChevronRight size={24} />
          <div>
            <strong>{planner.nextBest?.title || 'No current item selected'}</strong>
            <span>{nextBestBody}</span>
          </div>
        </div>
        <div className="metric-strip">
          {Object.entries(planner.summary).map(([key, value]) => (
            <div key={key}>
              <strong>{value}</strong>
              <span>{key}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="right-rail">
        <h3>Review Queue</h3>
        {planner.approvals.length === 0 && planner.candidates.length === 0 ? (
          <Empty title="Clear" body="No pending approvals or memory candidates." />
        ) : (
          <>
            {planner.approvals.map((item) => (
              <ApprovalRow key={`approval-${item.id}`} item={item} refresh={refresh} />
            ))}
            {planner.candidates.map((item) => <ItemRow key={`candidate-${item.id}`} item={item} compact />)}
          </>
        )}
        <QuickAddItem refresh={refresh} setNotice={setNotice} />
        <CodingWorkQueue navigate={navigate} proposeCodingTask={proposeCodingTask} confirmCodingTask={confirmCodingTask} setNotice={setNotice} />
        <button className="primary subtle" data-action-id="planner.refresh" data-control-id="planner.refresh-workboard" onClick={runRefresh}>Refresh Workboard</button>
      </div>

      <div className="bucket-grid">
        {buckets.map(([title, items, tone]) => (
          <div className="bucket" key={title}>
            <div className="bucket-title">
              <h3>{title}</h3>
              <Pill tone={tone}>{items.length}</Pill>
            </div>
            {items.length ? items.map((item) => (
              <ItemRow key={`${title}-${item.id}`} item={item}>
                <PlannerItemActions item={item} refresh={refresh} proposeWorkboardItemUpdate={proposeWorkboardItemUpdate} confirmWorkboardItemUpdate={confirmWorkboardItemUpdate} setNotice={setNotice} />
              </ItemRow>
            )) : <Empty title="Nothing here" body="The database has no matching active items. Use “+ Add Workboard item” to put real life in here." />}
          </div>
        ))}
      </div>
    </section>
  );
}

function ApprovalRow({ item, refresh }) {
  async function decide(decision) {
    await api(`/api/approvals/${item.id}/${decision}`, { method: 'POST' });
    refresh();
  }
  return (
    <div className="approval-row">
      <ItemRow item={item} compact />
      <div className="mini-actions">
        <button onClick={() => decide('approve')} aria-label={`Approve ${item.title}`}><Check size={14} /></button>
        <button onClick={() => decide('defer')} aria-label={`Defer ${item.title}`}><Clock3 size={14} /></button>
        <button className="danger" onClick={() => decide('deny')} aria-label={`Deny ${item.title}`}><X size={14} /></button>
      </div>
    </div>
  );
}

// Shared presentational shell for the diagnostics panel so new-message and
// legacy-message details render identically.
function DetailsPanel({ rows, mode, title }) {
  if (!rows.length) return null;
  return (
    <details className="message-details" open={mode !== 'clean'}>
      <summary>{title}</summary>
      <dl className="message-details-grid">
        {rows.map(([label, value]) => (
          <div className="message-details-row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

// Structured diagnostics for a NEW assistant reply (stored metadata), shown
// beneath the answer — never concatenated into it. Clean mode keeps it
// collapsed; Detailed/Developer open it; Developer adds full diagnostics.
function MessageDetails({ metadata, mode }) {
  if (!metadata) return null;
  return <DetailsPanel rows={buildDetailRows(metadata, mode)} mode={mode} title={mode === 'developer' ? 'Diagnostics' : 'Details'} />;
}

// Diagnostics recovered from a LEGACY reply's text (no stored metadata). Clean
// mode hides the legacy trailer entirely so it never interrupts the answer.
function LegacyMessageDetails({ legacy, mode }) {
  if (mode === 'clean') return null;
  return <DetailsPanel rows={buildLegacyDetailRows(legacy, mode)} mode={mode} title={mode === 'developer' ? 'Diagnostics (legacy)' : 'Details (legacy)'} />;
}

// Reduce Markdown to plain speakable text so a screen reader / TTS voice does
// not read "asterisk asterisk" etc. Code fences are announced generically.
function plainTextForSpeech(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[>#\-*+\s]+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Text-to-speech play control for an assistant message, using the on-device Web
// Speech API. Text generation and speech are separate states: the button only
// reports "playing" once audio has actually started (utterance onstart), never
// before. Renders nothing when the browser has no speech synthesis.
function MessageVoice({ text }) {
  const [state, setState] = useState('idle'); // idle | playing | failed
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  if (!supported) return null;

  function toggle() {
    const synth = window.speechSynthesis;
    if (state === 'playing') { synth.cancel(); setState('idle'); return; }
    const spoken = plainTextForSpeech(text);
    if (!spoken) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.onstart = () => setState('playing');
    utterance.onend = () => setState('idle');
    utterance.onerror = () => setState('failed');
    try { synth.speak(utterance); } catch { setState('failed'); }
  }

  const label = state === 'playing' ? 'Stop speaking' : state === 'failed' ? 'Voice failed — tap to retry' : 'Play as speech';
  return (
    <button type="button" className={cx('voice-button', state)} onClick={toggle} title={label} aria-label={label} aria-pressed={state === 'playing'}>
      {state === 'playing' ? <VolumeX size={14} /> : <Volume2 size={14} />}
    </button>
  );
}

// One chat bubble. Assistant replies render their answer as Markdown and their
// diagnostics in the Details panel. New replies use stored metadata; older
// replies fall back to the display-only legacy-text parser, which fails safe
// (shows the original message verbatim) when the structure is uncertain.
function MessageBubble({ message, mode }) {
  let body = message.content;
  let details = null;

  if (message.role === 'assistant') {
    const metadata = parseMessageMetadata(message.metadata);
    if (hasStructuredMetadata(metadata)) {
      details = <MessageDetails metadata={metadata} mode={mode} />;
    } else {
      const legacy = parseLegacyAssistantMessage(message.content);
      if (legacy) {
        body = legacy.answer;
        details = <LegacyMessageDetails legacy={legacy.legacy} mode={mode} />;
      }
    }
  }

  return (
    <div className={cx('message', message.role)}>
      <span>{message.role}</span>
      <div className="message-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
      {message.role === 'assistant' && Array.isArray(parseMessageMetadata(message.metadata)?.localSources) && (
        <SourceCards sources={parseMessageMetadata(message.metadata).localSources} />
      )}
      {message.role === 'assistant' && (
        <EscalationHint answerability={parseMessageMetadata(message.metadata)?.localAnswerability} />
      )}
      {message.role === 'assistant' && body.trim() && (
        <div className="message-actions"><MessageVoice text={body} /><FeedbackControl message={message} /></div>
      )}
      {details}
    </div>
  );
}

// Surfaces the transparent local-answerability decision when local knowledge was
// insufficient and policy permits a reviewed cloud check. It is informational and
// points at the EXISTING Cloud control in the composer — it never sends anything
// itself, and it appears only when the server marked escalation as suggested.
function EscalationHint({ answerability }) {
  const escalation = answerability?.escalation;
  if (!escalation?.suggested) return null;
  return (
    <div className="source-warning info" role="status">
      <strong>Local knowledge looked thin for this</strong>
      <small>{escalation.reason || 'A reviewed cloud check is available.'} Use the Cloud control below to prepare one — nothing is sent until you review the exact prompt and approve it.</small>
    </div>
  );
}

function SourceCards({ sources }) {
  if (!sources.length) return null;
  return <details className="message-sources">
    <summary>Sources used ({sources.length})</summary>
    {sources.slice(0, 5).map((source) => <div className="message-source-card" key={source.sourceId || source.title}>
      <strong>{source.title || 'Local record'}</strong>
      <small>{source.sourceType || source.category || 'local record'} · {source.updatedAt ? new Date(source.updatedAt).toLocaleDateString() : 'date unknown'}</small>
      {source.excerpt && <p>{String(source.excerpt).slice(0, 280)}</p>}
    </div>)}
  </details>;
}

function Chat({ sessions, activeSession, selectedSession, setSelectedSession, setSessions, messages, setMessages, refreshAll, setNotice, navigate, settings }) {
  const detailMode = normalizeDetailMode(settings?.assistantResponseDetail);
  const [draft, setDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [streamingText, setStreamingText] = useState(null);
  const [runtimeMode, setRuntimeMode] = useState('');
  // Truthful "model warming up" note shown while the local model loads on the
  // first message, so a normal ~1 min warm-up is not mistaken for a hang.
  const [warmupNote, setWarmupNote] = useState('');
  const [runtime, setRuntime] = useState(null);
  const [runtimeUnreachable, setRuntimeUnreachable] = useState(false);
  const [repoFiles, setRepoFiles] = useState([]);
  const [contextFiles, setContextFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [connection, setConnection] = useState(null);
  const [connectionState, setConnectionState] = useState('checking');
  const [systemStatusPreview, setSystemStatusPreview] = useState(null);
  const [systemModelsPreview, setSystemModelsPreview] = useState(null);
  const [systemRunsPreview, setSystemRunsPreview] = useState(null);
  const [plannerTodayPreview, setPlannerTodayPreview] = useState(null);
  const [systemCheckBusy, setSystemCheckBusy] = useState('');
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyResults, setHistoryResults] = useState([]);
  const [historySearchBusy, setHistorySearchBusy] = useState(false);
  const historySearchRequestRef = useRef(0);
  const [contextRecords, setContextRecords] = useState([]);
  const [picker, setPicker] = useState(null);
  const pickerSearchRequestRef = useRef(0);
  const pickerPreviewRequestRef = useRef(0);
  const [proposal, setProposal] = useState(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeForm, setProposeForm] = useState({ type: 'note', title: '', next_action: '' });
  const [plannerProposeOpen, setPlannerProposeOpen] = useState(false);
  const [plannerProposeForm, setPlannerProposeForm] = useState({ title: '', next_action: '', deadline: '', importance: 3, effort: 3 });
  const [plannerProposal, setPlannerProposal] = useState(null);
  const [projectProposeOpen, setProjectProposeOpen] = useState(false);
  const [projectProposeForm, setProjectProposeForm] = useState({ title: '', body: '', next_action: '' });
  const [projectProposal, setProjectProposal] = useState(null);
  const [projectProposalBusy, setProjectProposalBusy] = useState(false);
  const [plannerProposalBusy, setPlannerProposalBusy] = useState(false);
  const [plannerUpdateForm, setPlannerUpdateForm] = useState(null);
  const [cloudChecks, setCloudChecks] = useState([]);
  const [cloudScope, setCloudScope] = useState('latest-turn');
  const [cloudPreview, setCloudPreview] = useState(null);
  const [cloudProviders, setCloudProviders] = useState([]);
  const [cloudProvider, setCloudProvider] = useState('ChatGPT');
  const [cloudModel, setCloudModel] = useState('');
  const [cloudInstruction, setCloudInstruction] = useState('');
  const selectedSessionRef = useRef(selectedSession);
  const chatInstanceActiveRef = useRef(true);
  const connectionRequestRef = useRef(0);
  selectedSessionRef.current = selectedSession;
  useEffect(() => {
    chatInstanceActiveRef.current = true;
    return () => { chatInstanceActiveRef.current = false; };
  }, []);

  // --- ChatGPT-style auto-scroll for the message container (not the window) ---
  // autoFollow tracks whether the newest content should stick to the bottom. It
  // is derived from the user's own scroll position: near the bottom => follow;
  // scrolled up => stop following and offer a "Jump to latest" control. Scrolls
  // are instant (scrollTop assignment), never animated, so streaming tokens do
  // not cause shaking or restarting animations.
  const messagesRef = useRef(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const NEAR_BOTTOM_PX = 96;

  const isNearBottom = (el) => !el || (el.scrollHeight - el.scrollTop - el.clientHeight) <= NEAR_BOTTOM_PX;
  const scrollMessagesToBottom = () => { const el = messagesRef.current; if (el) el.scrollTop = el.scrollHeight; };

  function handleMessagesScroll() {
    const near = isNearBottom(messagesRef.current);
    setAutoFollow(near);
    setShowJump(!near);
  }
  function jumpToLatest() {
    setAutoFollow(true);
    setShowJump(false);
    scrollMessagesToBottom();
  }

  // Follow the newest content whenever messages or the streaming buffer change,
  // but only while the user is at/near the bottom. useLayoutEffect positions
  // before paint so there is no visible jump.
  useLayoutEffect(() => {
    if (autoFollow) scrollMessagesToBottom();
  }, [messages, streamingText, autoFollow]);

  // Opening or reloading a conversation starts pinned to the latest message.
  useEffect(() => {
    setAutoFollow(true);
    setShowJump(false);
    const id = requestAnimationFrame(scrollMessagesToBottom);
    return () => cancelAnimationFrame(id);
  }, [selectedSession]);

  async function loadConnection(sessionId = selectedSession) {
    if (!sessionId) {
      connectionRequestRef.current += 1;
      setConnection(null);
      setConnectionState('unavailable');
      return;
    }
    if (!isChatSendOriginActive(selectedSessionRef.current, sessionId, chatInstanceActiveRef.current)) return;
    const requestId = connectionRequestRef.current + 1;
    connectionRequestRef.current = requestId;
    const canApply = () => isLatestChatConnectionRequest(
      connectionRequestRef.current,
      requestId,
      selectedSessionRef.current,
      sessionId,
      chatInstanceActiveRef.current
    );
    if (canApply()) {
      setConnectionState('checking');
    }
    try {
      const next = await api(`/api/chat/sessions/${sessionId}/connection`);
      if (canApply()) {
        setConnection(next);
        setChatBusy(Boolean(next.generating));
        setConnectionState('ready');
      }
    } catch {
      if (canApply()) {
        setConnection(null);
        setConnectionState('unavailable');
      }
    }
  }
  async function loadCloudChecks(sessionId = selectedSession) { if (sessionId) try { setCloudChecks(await api(`/api/chat/sessions/${sessionId}/cloud-checks`)); } catch {} }
  async function previewCloudCheck() { try { setCloudPreview(await api(`/api/chat/sessions/${selectedSession}/cloud-checks/preview`, { method: 'POST', body: JSON.stringify({ scope: cloudScope, provider: cloudProvider, model: cloudModel, instruction: cloudInstruction }) })); } catch (err) { setNotice(err.message); } }
  async function chooseCloudProvider(provider) {
    setCloudProvider(provider.provider);
    setCloudModel(provider.model || '');
    // The compact provider control is deliberately useful before connection:
    // it opens the exact local-only preview, never a cloud request.  This
    // means the familiar ChatGPT-style button is always present when enabled,
    // while the later Send action remains server-gated on a signed-in tab.
    try {
      setCloudPreview(await api(`/api/chat/sessions/${selectedSession}/cloud-checks/preview`, {
        method: 'POST', body: JSON.stringify({ scope: cloudScope, provider: provider.provider, model: provider.model, instruction: cloudInstruction })
      }));
      if (!provider.configured) setNotice(`${provider.provider} prompt prepared locally. Connect its browser session with + before sending.`);
    } catch (err) { setNotice(err.message); }
  }
  async function createCloudCheck() { try { const result = await api(`/api/chat/sessions/${selectedSession}/cloud-checks`, { method: 'POST', body: JSON.stringify({ scope: cloudScope, provider: cloudProvider, model: cloudModel, instruction: cloudInstruction, idempotency_key: crypto.randomUUID().replaceAll('-', '') }) }); if (!result.blocked) await api(`/api/chat/cloud-checks/${result.check.id}/send`, { method: 'POST' }); setCloudPreview(null); await loadCloudChecks(); } catch (err) { setNotice(`${cloudProvider || 'Cloud provider'} could not send: ${err.message} Open Cloud accounts with + to connect the LPS Browser Agent and a signed-in provider tab.`); await loadCloudChecks(); } }
  async function sendCloudCheck(id) { try { await api(`/api/chat/cloud-checks/${id}/send`, { method: 'POST' }); await loadCloudChecks(); } catch (err) { setNotice(`Cloud check could not send: ${err.message} Open Cloud accounts with + to connect the provider.`); } }
  async function saveCloudCandidate(id) { try { await api(`/api/chat/cloud-checks/${id}/memory-candidate`, { method: 'POST' }); await loadCloudChecks(); refreshAll(); setNotice('Cloud response saved as a review-only memory candidate.'); } catch (err) { setNotice(err.message); } }
  async function setCloudGuidance(id, active) { try { await api(`/api/chat/cloud-checks/${id}/guidance`, { method: active ? 'POST' : 'DELETE' }); await loadCloudChecks(); } catch (err) { setNotice(err.message); } }
  async function cancelCloudCheck(id) { try { await api(`/api/chat/cloud-checks/${id}/cancel`, { method: 'POST' }); await loadCloudChecks(); } catch (err) { setNotice(err.message); } }
  async function dismissCloudCheck(id) { try { await api(`/api/chat/cloud-checks/${id}/dismiss`, { method: 'POST' }); await loadCloudChecks(); } catch (err) { setNotice(err.message); } }
  async function retryCloudCheck(id) { try { await api(`/api/chat/cloud-checks/${id}/retry`, { method: 'POST' }); await api(`/api/chat/cloud-checks/${id}/send`, { method: 'POST' }); await loadCloudChecks(); } catch (err) { setNotice(err.message); } }
  const cloudStateLabel = (status) => ({
    'checking-sharing-permissions': 'Checking sharing permissions', prepared: 'Prepared — connection required', active: 'Waiting for provider', completed: 'Completed', blocked: 'Blocked', failed: 'Failed', cancelled: 'Cancelled'
  }[status] || 'Preparing cloud prompt');

  async function loadContextRecords(sessionId = selectedSession) {
    if (!sessionId) return;
    try { setContextRecords(await api(`/api/chat/sessions/${sessionId}/context-records`)); } catch { /* non-fatal */ }
  }

  async function invokeAction(name, args) {
    return invokeNeutralAction(name, args, selectedSession);
  }

  async function openWorkboardViaAction() {
    if (systemCheckBusy) return;
    setSystemCheckBusy('navigation');
    try {
      const result = await invokeAction('navigation.workboard', {});
      if (result.data?.applied) setNotice('Opened the Workboard.');
      else setNotice(`Workboard navigation did not apply (${result.data?.status || 'unknown'}).`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSystemCheckBusy('');
    }
  }

  async function openSystemViaAction() {
    if (systemCheckBusy) return;
    setSystemCheckBusy('navigation-system');
    try {
      const result = await invokeAction('navigation.system', {});
      if (result.data?.applied) setNotice('Opened System.');
      else setNotice(`System navigation did not apply (${result.data?.status || 'unknown'}).`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSystemCheckBusy('');
    }
  }

  async function openSettingsViaAction() {
    if (systemCheckBusy) return;
    setSystemCheckBusy('navigation-settings');
    try {
      const result = await invokeAction('navigation.settings', {});
      if (result.data?.applied) setNotice('Opened Settings.');
      else setNotice(`Settings navigation did not apply (${result.data?.status || 'unknown'}).`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSystemCheckBusy('');
    }
  }

  async function openPlannerViaAction() {
    if (systemCheckBusy) return;
    setSystemCheckBusy('navigation-planner');
    try {
      const result = await invokeAction('navigation.planner', {});
      if (result.data?.applied) setNotice('Opened Today.');
      else setNotice(`Daily Planner navigation did not apply (${result.data?.status || 'unknown'}).`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSystemCheckBusy('');
    }
  }

  async function checkSystemStatus() {
    if (systemCheckBusy) return;
    setSystemCheckBusy('status');
    try {
      const result = await invokeAction('system.status', {});
      setSystemStatusPreview(result.data);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSystemCheckBusy('');
    }
  }

  async function checkSystemModels() {
    if (systemCheckBusy) return;
    setSystemCheckBusy('models');
    try {
      const result = await invokeAction('system.models', { limit: 5 });
      setSystemModelsPreview(result.data);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSystemCheckBusy('');
    }
  }

  async function checkSystemRuns() {
    if (systemCheckBusy) return;
    setSystemCheckBusy('runs');
    try {
      const result = await invokeAction('system.runs', { limit: 5 });
      setSystemRunsPreview(result.data);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSystemCheckBusy('');
    }
  }

  async function checkPlannerToday() {
    if (systemCheckBusy) return;
    setSystemCheckBusy('planner');
    try {
      const result = await invokeAction('planner.today', {});
      setPlannerTodayPreview(result.data);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSystemCheckBusy('');
    }
  }

  async function searchChatHistory(event) {
    event.preventDefault();
    const query = historyQuery.trim();
    if (!query || historySearchBusy) return;
    const requestId = ++historySearchRequestRef.current;
    setHistorySearchBusy(true);
    try {
      const result = await invokeAction('conversation.search', { query, limit: 8 });
      if (historySearchRequestRef.current === requestId) setHistoryResults(result.data.matches || []);
    } catch (error) {
      if (historySearchRequestRef.current === requestId) setNotice(error.message);
    } finally {
      if (historySearchRequestRef.current === requestId) setHistorySearchBusy(false);
    }
  }

  function openHistoryResult(match) {
    historySearchRequestRef.current += 1;
    setHistorySearchBusy(false);
    setHistoryQuery('');
    setHistoryResults([]);
    setSelectedSession(match.session_id);
    navigate('chat', null, match.session_id);
  }

  async function runPickerSearch(next = {}) {
    const requestId = ++pickerSearchRequestRef.current;
    pickerPreviewRequestRef.current += 1;
    const p = { ...picker, ...next, preview: null };
    setPicker({ ...p, loading: true });
    try {
      let results = [];
      if (p.domain === 'knowledge') {
        const r = await invokeAction('knowledge.search', { query: p.query?.trim() || 'a', scope: p.scope || 'all', limit: 15 });
        results = (r.data.items || []).map((it) => ({ kind: it.kind === 'candidate' ? 'knowledge-candidate' : 'knowledge-item', ref_id: it.id, label: `${it.type || it.kind}: ${it.title}`, sub: it.snippet }));
      } else {
        const r = await invokeAction('workboard.list', { view: p.view || 'projects', limit: 15 });
        results = (r.data.records || []).map((rec) => ({
          kind: `workboard-${rec.identity.type}`,
          entity_type: rec.identity.type,
          ref_id: rec.identity.id,
          label: `${rec.category}: ${rec.title}`,
          sub: rec.detail || rec.status || ''
        }));
      }
      if (pickerSearchRequestRef.current !== requestId) return;
      setPicker((current) => current?.domain === p.domain ? { ...p, loading: false, results } : current);
    } catch (err) {
      if (pickerSearchRequestRef.current !== requestId) return;
      setNotice(err.message);
      setPicker((current) => current?.domain === p.domain ? { ...p, loading: false, results: [] } : current);
    }
  }

  function openPicker(domain) {
    pickerSearchRequestRef.current += 1;
    pickerPreviewRequestRef.current += 1;
    const base = { domain, query: '', results: [], loading: false, scope: 'all', view: 'projects', preview: null };
    setPicker(base);
    runPickerSearch(base);
  }

  function closePicker() {
    pickerSearchRequestRef.current += 1;
    pickerPreviewRequestRef.current += 1;
    setPicker(null);
  }

  async function previewContextRecord(rec) {
    const isKnowledge = rec && ['knowledge-item', 'knowledge-candidate'].includes(rec.kind);
    const isWorkboard = rec && ['project', 'item', 'roadmap', 'approval', 'candidate'].includes(rec.entity_type);
    if (!isKnowledge && !isWorkboard) return;
    const requestId = ++pickerPreviewRequestRef.current;
    const key = `${rec.kind}-${rec.ref_id}`;
    const expectedDomain = isKnowledge ? 'knowledge' : 'workboard';
    setPicker((current) => current?.domain === expectedDomain
      ? { ...current, preview: { key, loading: true, data: null, error: '' } }
      : current);
    try {
      const result = isKnowledge
        ? await invokeAction('knowledge.read', { id: rec.ref_id, kind: rec.kind === 'knowledge-candidate' ? 'candidate' : 'item' })
        : await invokeAction('workboard.read', { id: rec.ref_id, type: rec.entity_type });
      if (pickerPreviewRequestRef.current !== requestId) return;
      setPicker((current) => current?.domain === expectedDomain
        ? { ...current, preview: { key, loading: false, data: result.data, error: '' } }
        : current);
    } catch (err) {
      if (pickerPreviewRequestRef.current !== requestId) return;
      setNotice(err.message);
      setPicker((current) => current?.domain === expectedDomain
        ? { ...current, preview: { key, loading: false, data: null, error: 'Preview unavailable.' } }
        : current);
    }
  }

  async function attachRecord(rec) {
    try {
      const records = await api(`/api/chat/sessions/${selectedSession}/context-records`, { method: 'POST', body: JSON.stringify({ kind: rec.kind, ref_id: rec.ref_id }) });
      setContextRecords(records);
      loadConnection();
      setNotice(`Attached ${rec.label} to this chat.`);
    } catch (err) { setNotice(err.message); }
  }

  async function removeContextRecord(id) {
    try {
      const records = await api(`/api/chat/sessions/${selectedSession}/context-records/${id}`, { method: 'DELETE' });
      setContextRecords(records);
      loadConnection();
    } catch (err) { setNotice(err.message); }
  }

  async function submitProposeCreate() {
    if (!proposeForm.title.trim() || proposalBusy) return;
    setProposalBusy(true);
    try {
      const r = await invokeAction('workboard.propose_create', { type: proposeForm.type, title: proposeForm.title, next_action: proposeForm.next_action });
      if (!r.confirmation?.confirmationId || !r.confirmation?.token) throw new Error('The Workboard proposal was not bound to a confirmation.');
      setProposal({ ...r.data, confirmation: r.confirmation, correlationId: r.correlationId });
      setProposeOpen(false);
      setProposeForm({ type: 'note', title: '', next_action: '' });
    } catch (err) { setNotice(err.message); }
    finally { setProposalBusy(false); }
  }

  async function submitProposeUpdate(record, changes) {
    if (!record?.identity || proposalBusy) return;
    setProposalBusy(true);
    try {
      const r = await invokeAction('workboard.propose_update', { type: record.identity.type, id: record.identity.id, changes });
      if (!r.confirmation?.confirmationId || !r.confirmation?.token) throw new Error('The Workboard update was not bound to a confirmation.');
      setProposal({ ...r.data, confirmation: r.confirmation, correlationId: r.correlationId });
      closePicker();
    } catch (err) { setNotice(err.message); }
    finally { setProposalBusy(false); }
  }

  async function confirmProposal() {
    if (!proposal || proposalBusy) return;
    const confirmationId = proposal.confirmation?.confirmationId;
    const token = proposal.confirmation?.token;
    if (!confirmationId || !token) return setNotice('This proposal has no valid confirmation receipt. Preview it again.');
    setProposalBusy(true);
    try {
      const result = await api(`/api/chat/sessions/${selectedSession}/workboard/confirm`, { method: 'POST', body: JSON.stringify({ confirmationId, token }) });
      setNotice(`Workboard ${result.operation === 'workboard.create' ? 'item created' : 'item updated'}: ${result.record?.title || ''}.`);
      setProposal(null);
      refreshAll();
    } catch (err) { setNotice(err.message); }
    finally { setProposalBusy(false); }
  }

  async function submitProposeProjectCreate() {
    if (!projectProposeForm.title.trim() || projectProposalBusy) return;
    setProjectProposalBusy(true);
    try {
      const r = await invokeAction('project.propose_create', { title: projectProposeForm.title, body: projectProposeForm.body, next_action: projectProposeForm.next_action });
      if (!r.confirmation?.confirmationId || !r.confirmation?.token) throw new Error('The Workboard card proposal was not bound to a confirmation.');
      setProjectProposal({ ...r.data, confirmation: r.confirmation, correlationId: r.correlationId });
      setProjectProposeOpen(false);
      setProjectProposeForm({ title: '', body: '', next_action: '' });
    } catch (err) { setNotice(err.message); }
    finally { setProjectProposalBusy(false); }
  }

  async function confirmProjectProposal() {
    if (!projectProposal || projectProposalBusy) return;
    const confirmationId = projectProposal.confirmation?.confirmationId;
    const token = projectProposal.confirmation?.token;
    if (!confirmationId || !token) return setNotice('This proposal has no valid confirmation receipt. Preview it again.');
    setProjectProposalBusy(true);
    try {
      const result = await api(`/api/chat/sessions/${selectedSession}/project/confirm`, { method: 'POST', body: JSON.stringify({ confirmationId, token }) });
      setNotice(`Workboard card created: ${result.record?.name || ''}.`);
      setProjectProposal(null);
      refreshAll();
    } catch (err) { setNotice(err.message); }
    finally { setProjectProposalBusy(false); }
  }

  async function submitProposePlannerCreate() {
    if (!plannerProposeForm.title.trim() || plannerProposalBusy) return;
    setPlannerProposalBusy(true);
    try {
      const args = {
        title: plannerProposeForm.title,
        next_action: plannerProposeForm.next_action,
        importance: Number(plannerProposeForm.importance) || 3,
        effort: Number(plannerProposeForm.effort) || 3
      };
      if (plannerProposeForm.deadline) args.deadline = plannerProposeForm.deadline;
      const r = await invokeAction('planner.propose_create', args);
      // A proposal only — no task exists yet until the user confirms below.
      setPlannerProposal({ ...r.data, confirmation: r.confirmation, correlationId: r.correlationId });
    } catch (error) { setNotice(error.message); }
    finally { setPlannerProposalBusy(false); }
  }

  async function confirmPlannerProposal() {
    if (!plannerProposal || plannerProposalBusy) return;
    const confirmationId = plannerProposal.confirmation?.confirmationId;
    const token = plannerProposal.confirmation?.token;
    if (!confirmationId || !token) return setNotice('This proposal has no valid confirmation receipt. Preview it again.');
    setPlannerProposalBusy(true);
    try {
      const result = await api(`/api/chat/sessions/${selectedSession}/planner/confirm`, { method: 'POST', body: JSON.stringify({ confirmationId, token }) });
      setNotice(`Daily Planner task ${result.operation === 'planner.update' ? 'updated' : 'created'}: ${result.record?.title || 'task'}.`);
      setPlannerProposal(null);
      setPlannerProposeOpen(false);
      setPlannerProposeForm({ title: '', next_action: '', deadline: '', importance: 3, effort: 3 });
      setPlannerUpdateForm(null);
      try {
        const today = await invokeAction('planner.today', {});
        setPlannerTodayPreview(today.data);
      } catch {
        // Never retain a stale pre-mutation preview if the canonical refresh fails.
        setPlannerTodayPreview(null);
      }
      refreshAll();
    } catch (err) { setNotice(err.message); }
    finally { setPlannerProposalBusy(false); }
  }

  // Open the edit form for one planner task, pre-filled from its exact current
  // values (fetched from the canonical Planner endpoint) so the before/after diff
  // is accurate and only genuinely changed fields become an update.
  async function openPlannerUpdate(task) {
    if (plannerProposalBusy) return;
    setPlannerProposal(null);
    try {
      const tasks = await api('/api/planner/tasks');
      const full = tasks.find((t) => t.id === task.id);
      if (!full) return setNotice('That planner task is no longer available.');
      setPlannerUpdateForm({
        id: full.id,
        title: full.title || '',
        next_action: full.next_action || '',
        deadline: full.deadline || '',
        importance: full.importance ?? 3,
        effort: full.effort ?? 3,
        status: full.status || 'active'
      });
    } catch (error) { setNotice(error.message); }
  }

  async function submitProposePlannerUpdate() {
    const form = plannerUpdateForm;
    if (!form || !form.title.trim() || plannerProposalBusy) return;
    setPlannerProposalBusy(true);
    try {
      const changes = {
        title: form.title,
        next_action: form.next_action,
        importance: Number(form.importance) || 3,
        effort: Number(form.effort) || 3,
        deadline: form.deadline || '',
        status: form.status
      };
      const r = await invokeAction('planner.propose_update', { id: form.id, changes });
      // A proposal only — the task is not changed until the user confirms below.
      setPlannerProposal({ ...r.data, confirmation: r.confirmation, correlationId: r.correlationId });
    } catch (error) { setNotice(error.message); }
    finally { setPlannerProposalBusy(false); }
  }

  async function proposePlannerStatus(task, status) {
    if (!task?.id || plannerProposalBusy) return;
    setPlannerProposalBusy(true);
    setPlannerProposal(null);
    try {
      const r = await invokeAction('planner.propose_update', { id: task.id, changes: { status } });
      // Status controls use the same state-bound review and confirmation path as Edit.
      setPlannerProposal({ ...r.data, confirmation: r.confirmation, correlationId: r.correlationId });
    } catch (error) { setNotice(error.message); }
    finally { setPlannerProposalBusy(false); }
  }

  async function sendViaJson(outgoing, optimisticId, requestKey, originSessionId) {
    const canRenderOrigin = () => isChatSendOriginActive(selectedSessionRef.current, originSessionId, chatInstanceActiveRef.current);
    const result = await awaitChatSendResult({
      content: outgoing,
      requestKey,
      send: ({ content, requestKey: durableKey }) => api(`/api/chat/sessions/${originSessionId}/messages`, {
        method: 'POST',
        headers: { 'X-LPS-Idempotency-Key': durableKey },
        body: JSON.stringify({ content })
      }),
      onPending: () => { if (canRenderOrigin()) setNotice('That message is still being processed. Waiting for the saved reply…'); }
    });
    if (!result) {
      const history = await api(`/api/chat/sessions/${originSessionId}/messages`);
      if (canRenderOrigin()) {
        setMessages(history);
        setNotice('The reply is still processing after the bounded wait. It remains saved and will appear when this chat is reopened.');
      }
      return;
    }
    if (canRenderOrigin()) {
      setMessages((current) => [...current.filter((m) => m.id !== optimisticId), ...result.messages]);
      setRuntimeMode(result.runtime || '');
      if (result.error) setNotice(result.error);
    }
  }

  async function prepareDirectCloudRequest(outgoing) {
    const match = String(outgoing || '').match(/\b(?:ask|use|consult|check with)\s+(chatgpt|gemini|grok|claude)\b/i);
    if (!match) return false;
    const provider = cloudProviders.find((item) => item.provider.toLowerCase() === match[1].toLowerCase());
    if (!provider) {
      setNotice(`${match[1]} is not connected. Open Cloud accounts with + to connect a signed-in browser session first.`);
      navigate('settings');
      return true;
    }
    try {
      setCloudProvider(provider.provider);
      setCloudModel(provider.model || '');
      setCloudInstruction(outgoing);
      setCloudPreview(await api(`/api/chat/sessions/${selectedSession}/cloud-checks/preview`, {
        method: 'POST', body: JSON.stringify({ scope: cloudScope, provider: provider.provider, model: provider.model, instruction: outgoing })
      }));
      setNotice(`Prepared a reviewed ${provider.provider} cloud check. Review the exact prompt before sending.`);
    } catch (err) {
      setNotice(`Could not prepare the ${provider.provider} cloud check: ${err.message}`);
    }
    return true;
  }

  async function send() {
    if (!draft.trim() || !selectedSession || chatBusy) return;
    const outgoing = draft;
    if (await prepareDirectCloudRequest(outgoing)) {
      setDraft('');
      return;
    }
    const optimisticId = `tmp-${Date.now()}`;
    const requestKey = crypto.randomUUID().replaceAll('-', '');
    const originSessionId = selectedSession;
    const canRenderOrigin = () => isChatSendOriginActive(selectedSessionRef.current, originSessionId, chatInstanceActiveRef.current);
    setChatBusy(true);
    setDraft('');
    // Sending is a deliberate action: jump to the new message and follow the reply.
    setAutoFollow(true);
    setShowJump(false);
    setMessages((current) => [...current, { id: optimisticId, role: 'user', content: outgoing }]);
    setStreamingText('');
    let streamStarted = false;
    try {
      const response = await fetch(`${API}/api/chat/sessions/${originSessionId}/messages/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LPS-CSRF': await mutationToken(), 'X-LPS-Idempotency-Key': requestKey },
        body: JSON.stringify({ content: outgoing })
      });
      if (!response.ok || !response.body) throw new Error('stream-unavailable');
      streamStarted = true;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let acc = '';
      let runtimeLabel = '';
      let streamError = null;
      let terminalEvent = false;
      readStream: for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const lines = frame.split('\n');
          const event = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim();
          const dataRaw = (lines.find((l) => l.startsWith('data:')) || '').slice(5).trim();
          if (!event || !dataRaw) continue;
          let data;
          try { data = JSON.parse(dataRaw); } catch { continue; }
          if (event === 'token') { acc += data.delta; if (canRenderOrigin()) { setStreamingText(acc); setWarmupNote(''); } }
          else if (event === 'status') { if (data.phase === 'warming' && canRenderOrigin()) setWarmupNote(data.message || 'Starting the local model…'); }
          else if (event === 'done') {
            runtimeLabel = data.runtime || '';
            if (canRenderOrigin()) setWarmupNote('');
            terminalEvent = true;
            break;
          } else if (event === 'error') {
            streamError = data.error;
            runtimeLabel = data.runtime || '';
            if (canRenderOrigin()) setWarmupNote('');
            terminalEvent = true;
            break;
          }
        }
        // Native WebViews may keep an HTTP connection alive after the server
        // has sent its terminal SSE frame. Do not leave Chat "Thinking" while
        // waiting for that transport socket to close.
        if (terminalEvent) {
          await reader.cancel();
          break readStream;
        }
      }
      if (canRenderOrigin()) {
        setRuntimeMode(runtimeLabel);
        if (streamError) setNotice(streamError);
      }
      // Reconcile with the server's persisted history so the list is always
      // exactly one user + one final assistant message (no duplicate rows).
      const history = await api(`/api/chat/sessions/${originSessionId}/messages`);
      if (canRenderOrigin()) setMessages(history);
    } catch (err) {
      if (!streamStarted) {
        // Streaming endpoint unavailable: use the non-streaming JSON endpoint.
        try { await sendViaJson(outgoing, optimisticId, requestKey, originSessionId); }
        catch (jsonErr) {
          if (canRenderOrigin()) {
            setNotice(jsonErr.message);
            setMessages((current) => current.filter((m) => m.id !== optimisticId));
          }
        }
      } else {
        if (canRenderOrigin()) setNotice('Streaming was interrupted; reconnecting to the same saved reply…');
        try { await sendViaJson(outgoing, optimisticId, requestKey, originSessionId); }
        catch (jsonErr) {
          if (canRenderOrigin()) setNotice(`Streaming was interrupted and the saved reply could not be reconciled yet: ${jsonErr.message}`);
          try {
            const history = await api(`/api/chat/sessions/${originSessionId}/messages`);
            if (canRenderOrigin()) setMessages(history);
          } catch { /* keep current view */ }
        }
      }
    } finally {
      if (canRenderOrigin()) {
        setStreamingText(null);
        setWarmupNote('');
        setChatBusy(false);
      }
      refreshAll();
      if (canRenderOrigin()) loadConnection(originSessionId);
    }
  }

  async function cancelGeneration() {
    if (!selectedSession || !chatBusy) return;
    try {
      const result = await api(`/api/chat/sessions/${selectedSession}/cancel`, { method: 'POST' });
      setNotice(result.message);
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function newSession() {
    const session = await api('/api/chat/sessions', { method: 'POST', body: JSON.stringify({ title: 'New planning chat' }) });
    setSessions((current) => [session, ...current]);
    setSelectedSession(session.id);
    navigate('chat', null, session.id);
  }

  async function patchSession(id, body) {
    const updated = await api(`/api/chat/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    setSessions((current) => current.map((session) => (session.id === id ? updated : session)).filter((session) => !session.deleted));
    if (body.deleted && selectedSession === id) {
      const nextSession = sessions.find((session) => session.id !== id);
      setSelectedSession(nextSession?.id || null);
      navigate('chat', null, nextSession?.id || null);
    }
  }

  async function syncSessionToMemory(session) {
    try {
      const result = await api(`/api/chat/sessions/${session.id}/memory-candidate`, { method: 'POST' });
      refreshAll();
      setNotice(result.reused
        ? `A review-only memory candidate already exists for “${session.title}”.`
        : `“${session.title}” was added to Knowledge as a review-only memory candidate.`);
    } catch (err) {
      setNotice(err.message);
    }
  }

  function deleteSessionFromList(session) {
    if (window.confirm(`Delete “${session.title}”? This hides the chat and its history from the app.`)) {
      patchSession(session.id, { deleted: 1 });
    }
  }

  async function loadContext(sessionId = selectedSession) {
    if (!sessionId) return;
    try {
      setContextFiles(await api(`/api/chat/sessions/${sessionId}/context`));
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function addContextFile() {
    if (!selectedSession || !selectedFile) return;
    try {
      setContextFiles(await api(`/api/chat/sessions/${selectedSession}/context`, {
        method: 'POST',
        body: JSON.stringify({ path: selectedFile })
      }));
      setSelectedFile('');
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function removeContextFile(contextId) {
    if (!selectedSession) return;
    try {
      setContextFiles(await api(`/api/chat/sessions/${selectedSession}/context/${contextId}`, { method: 'DELETE' }));
    } catch (err) {
      setNotice(err.message);
    }
  }

  const refreshCloudProviders = () => api('/api/chat/cloud-providers').then((providers) => { setCloudProviders(providers); setCloudProvider((current) => providers.some((provider) => provider.provider === current) ? current : (providers[0]?.provider || '')); setCloudModel((current) => providers.flatMap((provider) => provider.models || []).includes(current) ? current : (providers.find((provider) => provider.provider === cloudProvider)?.model || providers[0]?.model || '')); }).catch(() => {});
  function openPrivateRepositorySync() {
    navigate('system', 'repository');
    setNotice('Private repository sync is available in System → Repository. Review the target and confirm the safe fast-forward sync there.');
  }

  async function openChatGptSync() {
    if (openNativeProviderWindow('chatgpt')) {
      setNotice('Opened ChatGPT in its separate Life Planner provider window. Sign in there; it uses an isolated browser profile and does not send LPS data automatically.');
      return;
    }
    try {
      await api('/api/browser/open-external', { method: 'POST', body: JSON.stringify({ url: 'https://chatgpt.com/' }) });
      setNotice('Opened ChatGPT in your normal browser. Sign in there, then keep the LPS Browser Agent enabled to connect the session.');
    } catch (error) {
      setNotice(`Could not open ChatGPT sign-in: ${error.message}`);
    }
  }

  useEffect(() => {
    api('/api/repo/files?q=').then(setRepoFiles).catch((err) => setNotice(err.message));
    api('/api/models/runtime').then(setRuntime).catch((err) => { setRuntimeUnreachable(true); setNotice(err.message); });
    refreshCloudProviders();
  }, []);
  useEffect(() => {
    const timer = window.setInterval(refreshCloudProviders, 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    loadContext();
    loadContextRecords();
    loadConnection();
    loadCloudChecks();
    setProposal(null);
    historySearchRequestRef.current += 1;
    setHistorySearchBusy(false);
    setHistoryResults([]);
    pickerSearchRequestRef.current += 1;
    pickerPreviewRequestRef.current += 1;
    setPicker(null);
  }, [selectedSession]);
  useEffect(() => {
    const originSessionId = selectedSession;
    if (!originSessionId || !connection?.generating || String(connection.conversationId) !== String(originSessionId)) return undefined;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const [nextConnection, history] = await Promise.all([
          api(`/api/chat/sessions/${originSessionId}/connection`),
          api(`/api/chat/sessions/${originSessionId}/messages`)
        ]);
        if (!active || !isChatSendOriginActive(selectedSessionRef.current, originSessionId, chatInstanceActiveRef.current)) return;
        setConnection(nextConnection);
        setMessages(history);
        setChatBusy(Boolean(nextConnection.generating));
        if (!nextConnection.generating) setNotice('The saved local reply finished and is now visible.');
      } catch { /* the next bounded poll or manual refresh can recover */ }
    }, 750);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectedSession, connection?.conversationId, connection?.generating]);
  useEffect(() => {
    if (!cloudChecks.some((check) => check.status === 'active')) return undefined;
    const timer = window.setInterval(() => loadCloudChecks(), 1500);
    return () => window.clearInterval(timer);
  }, [cloudChecks, selectedSession]);

  const modelReady = Boolean(runtime?.endpointConfigured || runtime?.assigned || runtime?.managedServerRunning);
  const modelStatus = runtimeUnreachable
    ? (IS_NATIVE
      ? 'Cannot reach the desktop LifePlanSystem. Make sure it is running on your computer and the phone is connected (adb reverse tcp:4177 tcp:4177), then reopen the app.'
      : 'Cannot reach the LifePlanSystem server. Make sure it is running, then reload.')
    : !runtime
      ? 'Checking local Planner Assistant setup...'
      : modelReady
      ? runtime.managedServerRunning
        ? `Planner Assistant endpoint is running at ${runtime.managedEndpoint}.`
        : runtime.endpointConfigured
          ? `Planner Assistant will try local endpoint ${runtime.endpoint}.`
          : `Planner Assistant model is assigned: ${runtime.model?.name}.`
      : 'No Planner Assistant model or local endpoint is configured. Your message can still be saved and reviewed as a memory candidate, but no assistant reply will be invented until local inference is available.';

  return (
    <section className="chat-layout">
      <div className="chat-sidebar">
        <div className="session-list">
          <button className="primary" onClick={newSession}><Plus size={16} /> New chat</button>
          <form className="inline-form compact" onSubmit={searchChatHistory}>
            <input value={historyQuery} maxLength={240} onChange={(event) => setHistoryQuery(event.target.value)} aria-label="Search local chat history" placeholder="Search chats…" />
            <button type="submit" data-action-id="conversation.search" data-control-id="chat.history-search.submit" disabled={historySearchBusy || !historyQuery.trim()}>{historySearchBusy ? 'Searching…' : 'Search'}</button>
          </form>
          {historyResults.length ? (
            <div className="history-search-results" aria-label="Chat history search results">
              {historyResults.map((match, index) => (
                <button className="session-row" key={`${match.session_id}-${match.created_at || index}`} onClick={() => openHistoryResult(match)}>
                  <span>{match.role} · Chat #{match.session_id}</span>
                  <strong>{match.session_title}</strong>
                  <small>{match.snippet}</small>
                </button>
              ))}
            </div>
          ) : null}
          {sessions.map((session) => (
            <div key={session.id} className={cx('session-entry', session.id === selectedSession && 'selected')}>
              <button className="session-row" onClick={() => { setSelectedSession(session.id); navigate('chat', null, session.id); }}>
                <span>{session.pinned ? 'Pinned' : 'Chat'}</span>
                <strong>{session.title}</strong>
              </button>
              <div className="session-hover-actions" aria-label={`Actions for ${session.title}`}>
                <button className="icon-button" onClick={() => syncSessionToMemory(session)} aria-label={`Sync ${session.title} to memory`} title="Sync chat to review-only memory"><Brain size={15} /></button>
                <button className="icon-button danger" onClick={() => deleteSessionFromList(session)} aria-label={`Delete ${session.title}`} title="Delete chat"><X size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="chat-panel">
        <div className="chat-header">
          <div>
            <h2>{activeSession?.title || 'Chat'}</h2>
            <p>Messages persist. Useful statements become reviewable memory candidates.{runtimeMode ? ` Last runtime: ${runtimeMode}.` : ''}</p>
          </div>
          {activeSession && (
            <div className="row-actions">
              <button className="icon-button" onClick={() => patchSession(activeSession.id, { pinned: activeSession.pinned ? 0 : 1 })}><Archive size={16} /></button>
              <button className="icon-button" onClick={() => {
                const title = window.prompt('Rename chat', activeSession.title);
                if (title) patchSession(activeSession.id, { title });
              }}>Aa</button>
              <button className="icon-button danger" onClick={() => patchSession(activeSession.id, { deleted: 1 })}><Trash2 size={16} /></button>
            </div>
          )}
        </div>
        <div className="context-bar">
          {!IS_NATIVE && <ChatConnectionBar connection={connection} connectionState={connectionState} runtime={runtime} generating={chatBusy} statusPreview={systemStatusPreview} modelsPreview={systemModelsPreview} runsPreview={systemRunsPreview} plannerPreview={plannerTodayPreview} checkBusy={systemCheckBusy} proposalBusy={plannerProposalBusy} onCheckStatus={checkSystemStatus} onCheckModels={checkSystemModels} onCheckRuns={checkSystemRuns} onCheckPlanner={checkPlannerToday} onOpenWorkboard={openWorkboardViaAction} onOpenSystem={openSystemViaAction} onOpenSettings={openSettingsViaAction} onOpenPlanner={openPlannerViaAction} onEditPlannerTask={openPlannerUpdate} onProposePlannerStatus={proposePlannerStatus} />}
          <div className="context-actions">
            <button data-action-id="knowledge.search" data-control-id="chat.context-toolbar.open-knowledge" onClick={() => openPicker('knowledge')} title="Attach selected Knowledge records to this conversation; general reviewed-memory retrieval remains automatic for personal questions."><Brain size={15} /> Attach Knowledge</button>
            <button data-action-id="workboard.list" data-control-id="chat.context-toolbar.open-workboard" onClick={() => openPicker('workboard')}><ListChecks size={15} /> Use Workboard</button>
            <button data-action-id="workboard.propose_create" data-control-id="chat.workboard-proposal.open" onClick={() => { setProposeOpen((v) => !v); setProposal(null); }}><Plus size={15} /> Propose task</button>
            <button data-action-id="planner.propose_create" data-control-id="chat.planner-proposal.open" onClick={() => { setPlannerProposeOpen((v) => !v); setPlannerProposal(null); }}><Plus size={15} /> Add planner task</button>
            <button data-action-id="project.propose_create" data-control-id="chat.project-proposal.open" onClick={() => { setProjectProposeOpen((v) => !v); setProjectProposal(null); }}><Plus size={15} /> Propose card</button>
            {!IS_NATIVE && <div className="inline-form compact">
              <select value={selectedFile} onChange={(event) => setSelectedFile(event.target.value)}>
                <option value="">Attach repo file…</option>
                {repoFiles.map((file) => <option value={file.path} key={file.path}>{file.path}</option>)}
              </select>
              <button onClick={addContextFile} disabled={!selectedFile}><Plus size={15} /> Add file</button>
            </div>}
          </div>
          {(contextRecords.length > 0 || contextFiles.length > 0) ? (
            <div className="context-chips">
              {contextRecords.map((rec) => (
                <button key={`rec-${rec.id}`} className={rec.kind.startsWith('knowledge') ? 'chip-knowledge' : 'chip-workboard'} onClick={() => removeContextRecord(rec.id)} title={`Remove ${rec.label}`}>
                  {rec.kind.startsWith('knowledge') ? <Brain size={13} /> : <ListChecks size={13} />}
                  <span>{rec.label}</span>
                  <X size={13} />
                </button>
              ))}
              {contextFiles.map((file) => (
                <button key={`file-${file.id}`} onClick={() => removeContextFile(file.id)} title="Remove context file">
                  <FileText size={13} />
                  <span>{file.path}</span>
                  <X size={13} />
                </button>
              ))}
            </div>
          ) : (
            <div className="context-chips"><span>No records or files attached. Reviewed local Knowledge and bundled GitHub documentation remain searchable; attach records deliberately for focused context.</span></div>
          )}
          {!modelReady && (
            <div className="source-warning warn">
              <strong>Planner Assistant setup needed</strong>
              <small>{modelStatus} Use the Settings cog (top-right) to assign a local GGUF model.</small>
            </div>
          )}
          {proposeOpen && (
            <div className="propose-form">
              <div className="quick-add-row">
                <select value={proposeForm.type} onChange={(e) => setProposeForm((f) => ({ ...f, type: e.target.value }))}>
                  {['goal', 'project', 'decision', 'reminder', 'blocker', 'waiting', 'note'].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input value={proposeForm.title} onChange={(e) => setProposeForm((f) => ({ ...f, title: e.target.value }))} placeholder="Proposed task title" />
              </div>
              <input value={proposeForm.next_action} onChange={(e) => setProposeForm((f) => ({ ...f, next_action: e.target.value }))} placeholder="Next action (optional)" />
              <div className="quick-add-row">
                <button data-action-id="workboard.propose_create" data-control-id="chat.workboard-proposal.preview" className="primary" onClick={submitProposeCreate} disabled={proposalBusy || !proposeForm.title.trim()}>{proposalBusy ? 'Preparing…' : 'Preview proposal'}</button>
                <button onClick={() => setProposeOpen(false)} disabled={proposalBusy}>Cancel</button>
              </div>
            </div>
          )}
          {proposal && <ProposalCard proposal={proposal} busy={proposalBusy} onConfirm={confirmProposal} onCancel={() => setProposal(null)} />}
          {plannerProposeOpen && (
            <div className="propose-form">
              <input value={plannerProposeForm.title} onChange={(e) => setPlannerProposeForm((f) => ({ ...f, title: e.target.value }))} placeholder="Planner task title" />
              <input value={plannerProposeForm.next_action} onChange={(e) => setPlannerProposeForm((f) => ({ ...f, next_action: e.target.value }))} placeholder="Next action (optional)" />
              <div className="quick-add-row">
                <label>Deadline<input type="date" value={plannerProposeForm.deadline} onChange={(e) => setPlannerProposeForm((f) => ({ ...f, deadline: e.target.value }))} /></label>
                <label>Importance<select value={plannerProposeForm.importance} onChange={(e) => setPlannerProposeForm((f) => ({ ...f, importance: Number(e.target.value) }))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
                <label>Effort<select value={plannerProposeForm.effort} onChange={(e) => setPlannerProposeForm((f) => ({ ...f, effort: Number(e.target.value) }))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
              </div>
              <div className="quick-add-row">
                <button data-action-id="planner.propose_create" data-control-id="chat.planner-proposal.preview" className="primary" onClick={submitProposePlannerCreate} disabled={plannerProposalBusy || !plannerProposeForm.title.trim()}>{plannerProposalBusy ? 'Preparing…' : 'Preview proposal'}</button>
                <button onClick={() => { setPlannerProposeOpen(false); setPlannerProposal(null); }} disabled={plannerProposalBusy}>Cancel</button>
              </div>
            </div>
          )}
          {plannerUpdateForm && (
            <div className="propose-form">
              <small>Editing Daily Planner task #{plannerUpdateForm.id}</small>
              <input value={plannerUpdateForm.title} onChange={(e) => setPlannerUpdateForm((f) => ({ ...f, title: e.target.value }))} placeholder="Planner task title" />
              <input value={plannerUpdateForm.next_action} onChange={(e) => setPlannerUpdateForm((f) => ({ ...f, next_action: e.target.value }))} placeholder="Next action (optional)" />
              <div className="quick-add-row">
                <label>Deadline<input type="date" value={plannerUpdateForm.deadline} onChange={(e) => setPlannerUpdateForm((f) => ({ ...f, deadline: e.target.value }))} /></label>
                <label>Importance<select value={plannerUpdateForm.importance} onChange={(e) => setPlannerUpdateForm((f) => ({ ...f, importance: Number(e.target.value) }))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
                <label>Effort<select value={plannerUpdateForm.effort} onChange={(e) => setPlannerUpdateForm((f) => ({ ...f, effort: Number(e.target.value) }))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
                <label>Status<select value={plannerUpdateForm.status} onChange={(e) => setPlannerUpdateForm((f) => ({ ...f, status: e.target.value }))}>{['active', 'completed', 'deferred', 'parked'].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
              </div>
              <div className="quick-add-row">
                <button data-action-id="planner.propose_update" data-control-id="chat.planner-update.preview" className="primary" onClick={submitProposePlannerUpdate} disabled={plannerProposalBusy || !plannerUpdateForm.title.trim()}>{plannerProposalBusy ? 'Preparing…' : 'Preview update'}</button>
                <button onClick={() => { setPlannerUpdateForm(null); setPlannerProposal(null); }} disabled={plannerProposalBusy}>Cancel</button>
              </div>
            </div>
          )}
          {plannerProposal && <PlannerProposalCard proposal={plannerProposal} busy={plannerProposalBusy} onConfirm={confirmPlannerProposal} onCancel={() => setPlannerProposal(null)} />}
          {projectProposeOpen && (
            <div className="propose-form">
              <input value={projectProposeForm.title} onChange={(e) => setProjectProposeForm((f) => ({ ...f, title: e.target.value }))} placeholder="Workboard card title" />
              <input value={projectProposeForm.body} onChange={(e) => setProjectProposeForm((f) => ({ ...f, body: e.target.value }))} placeholder="Evidence / details (optional)" />
              <input value={projectProposeForm.next_action} onChange={(e) => setProjectProposeForm((f) => ({ ...f, next_action: e.target.value }))} placeholder="Next action (optional)" />
              <div className="quick-add-row">
                <button data-action-id="project.propose_create" data-control-id="chat.project-proposal.preview" className="primary" onClick={submitProposeProjectCreate} disabled={projectProposalBusy || !projectProposeForm.title.trim()}>{projectProposalBusy ? 'Preparing…' : 'Preview proposal'}</button>
                <button onClick={() => setProjectProposeOpen(false)} disabled={projectProposalBusy}>Cancel</button>
              </div>
            </div>
          )}
          {projectProposal && <ProjectProposalCard proposal={projectProposal} busy={projectProposalBusy} onConfirm={confirmProjectProposal} onCancel={() => setProjectProposal(null)} />}
        </div>
        <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
          {messages.map((message) => <React.Fragment key={message.id}><MessageBubble message={message} mode={detailMode} />{cloudChecks.filter((check) => Number(check.assistant_message_id) === Number(message.id) && !check.feedback_dismissed_at).map((check) => <CloudCheckCard key={`cloud-${check.id}`} check={check} providerConnected={Boolean(cloudProviders.find((provider) => provider.provider === check.provider)?.configured)} stateLabel={cloudStateLabel(check.status)} onSend={sendCloudCheck} onCancel={cancelCloudCheck} onRetry={retryCloudCheck} onGuidance={setCloudGuidance} onSaveCandidate={saveCloudCandidate} onDismiss={dismissCloudCheck} onHistory={() => navigate('system', 'browser')} />)}</React.Fragment>)}
          {streamingText !== null && (
            <div className="message assistant streaming" aria-live="polite">
              <span>assistant</span>
              {streamingText
                ? <div className="message-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingText) }} />
                : warmupNote
                  ? <p className="warmup-note">{warmupNote}</p>
                  : <p>Planner Assistant is responding…</p>}
            </div>
          )}
        </div>
        {showJump && (
          <button type="button" className="jump-latest" onClick={jumpToLatest} aria-label="Jump to latest message" title="Jump to latest message">
            <ChevronDown size={16} /> Jump to latest
          </button>
        )}
        <div className="composer">
          <div className="cloud-composer" aria-label="Cloud check controls"><span title="Cloud check"><Globe2 size={16} /></span>{cloudProviders.map((item) => <button key={item.provider} className={cx('cloud-provider-button', cloudProvider === item.provider && 'selected', !item.configured && 'setup-required')} onClick={() => chooseCloudProvider(item)} title={item.configured ? `Prepare a reviewed ${item.provider} cloud check` : `Prepare locally, then connect ${item.provider}`} aria-label={`Use ${item.provider}`}>{item.provider === 'ChatGPT' ? <Sparkles size={16} aria-hidden="true" /> : item.provider.slice(0, 1)}</button>)}<button className="cloud-provider-button" onClick={() => navigate('settings')} title="Manage cloud accounts" aria-label="Manage cloud accounts"><Plus size={16} /></button>{cloudProviders.length ? <><select aria-label="Cloud provider model" value={cloudModel} onChange={(event) => { setCloudModel(event.target.value); setCloudPreview(null); }}><option value={cloudProviders.find((item) => item.provider === cloudProvider)?.model || ''}>{cloudProviders.find((item) => item.provider === cloudProvider)?.model || 'Provider default'}</option></select><select aria-label="Cloud check scope" value={cloudScope} onChange={(event) => { setCloudScope(event.target.value); setCloudPreview(null); }}><option value="latest-turn">Latest turn</option><option value="full-conversation">Full conversation</option></select><button onClick={previewCloudCheck} disabled={!cloudProvider}>Review cloud prompt</button></> : <small>Enable a cloud provider in Settings with +.</small>}</div>
          {cloudPreview && <div className="cloud-preview"><strong>{cloudProvider} cloud check</strong><small>{cloudPreview.model} · {cloudPreview.classification} · {cloudPreview.messageCount} messages · {cloudPreview.characters} characters</small><label>Focus for the cloud consultant (optional)<textarea value={cloudInstruction} maxLength={1200} onChange={(event) => { setCloudInstruction(event.target.value); setCloudPreview(null); }} placeholder="For example: focus on missing risks and a clearer next reply." /></label><details open><summary>Exact authorised prompt</summary><pre>{cloudPreview.prompt}</pre></details>{cloudPreview.blocked ? <small>Blocked server-side; no provider request can be made.</small> : <button className="primary" onClick={createCloudCheck}>Ask {cloudProvider}</button>}</div>}
          {cloudChecks.some((check) => check.guidance_active) && <div className="source-warning info" role="status"><strong>Cloud guidance active</strong><small>The selected completed cloud feedback will advise this session's next successfully stored assistant reply once, then be removed.</small></div>}
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Tell Life Planner what changed, what is blocked, or what needs review..." disabled={chatBusy} />
          {chatBusy && <button onClick={cancelGeneration} title="Cancel local model generation"><X size={16} /> Cancel</button>}
          <button className="primary" onClick={send} disabled={chatBusy || !draft.trim()} title={modelReady ? 'Send to Planner Assistant' : 'Save the message; local inference must be configured before an assistant response is generated.'}><Bot size={16} /> {chatBusy ? 'Thinking...' : 'Send'}</button>
        </div>
        {picker && <ContextPicker picker={picker} onSearch={runPickerSearch} onPreview={previewContextRecord} onProposeUpdate={submitProposeUpdate} proposalBusy={proposalBusy} onAttach={attachRecord} onClose={closePicker} />}
      </div>
    </section>
  );
}

function CloudCheckCard({ check, providerConnected, stateLabel, onSend, onCancel, onRetry, onGuidance, onSaveCandidate, onDismiss, onHistory }) {
  let includedCount = 0;
  try { includedCount = JSON.parse(check.included_message_ids || '[]').length; } catch { /* malformed legacy metadata remains displayable */ }
  const sourceTurn = [check.user_message_id ? `user #${check.user_message_id}` : '', check.assistant_message_id ? `assistant #${check.assistant_message_id}` : ''].filter(Boolean).join(' → ') || 'session context';
  const completedAt = check.status === 'completed' && check.updated_at ? new Date(check.updated_at).toLocaleString() : '';
  return <article className="cloud-check-card" aria-label={`Cloud check ${check.id}: ${stateLabel}`}>
    <strong>{check.provider} / {check.model || 'configured browser model'} · {stateLabel}</strong>
    <small>{check.scope} · {includedCount} included messages · approximately {(check.prompt || '').length} characters</small>
    <small>Source: {sourceTurn} · Privacy: {check.classification || 'pending'} · created {new Date(check.created_at).toLocaleString()}{completedAt ? ` · completed ${completedAt}` : ''}</small>
    <button className="link" onClick={onHistory}>Open Cloud Consultation #{check.consultation_id}</button>
    <details><summary>Exact authorised prompt</summary><pre>{check.prompt}</pre></details>
    {check.response && <div className="message-body" aria-live="polite" dangerouslySetInnerHTML={{ __html: renderMarkdown(check.response) }} />}
    {check.error_detail && <small role="status">{check.error_detail}</small>}
    {check.status === 'prepared' && (providerConnected ? <button onClick={() => onSend(check.id)}>Send reviewed prompt</button> : <><small role="status">No signed-in provider tab is connected. No prompt has been sent.</small><button onClick={onHistory}>Open browser connection setup</button></>)}
    {check.status === 'active' && <button onClick={() => onCancel(check.id)}>Cancel cloud check</button>}
    {['failed', 'cancelled'].includes(check.status) && <button onClick={() => onRetry(check.id)}>Retry cloud check</button>}
    {check.status === 'completed' && <>{check.feedback_dismissed_at ? <small>Feedback dismissed; this historical card remains available for provenance.</small> : <><button onClick={() => onGuidance(check.id, !check.guidance_active)}>{check.guidance_active ? 'Remove guidance' : 'Use for next reply'}</button><button onClick={() => onDismiss(check.id)}>Dismiss</button></>}{check.memory_candidate_id ? <small>Memory candidate #{check.memory_candidate_id} is awaiting review.</small> : <button onClick={() => onSaveCandidate(check.id)}>Save as memory candidate</button>}</>}
  </article>;
}

function ChatConnectionBar({ connection, connectionState, runtime, generating, statusPreview, modelsPreview, runsPreview, plannerPreview, checkBusy, proposalBusy, onCheckStatus, onCheckModels, onCheckRuns, onCheckPlanner, onOpenWorkboard, onOpenSystem, onOpenSettings, onOpenPlanner, onEditPlannerTask, onProposePlannerStatus }) {
  const modelName = connection?.model?.name || runtime?.model?.name || null;
  const modelAssigned = connection?.model?.assigned ?? Boolean(runtime?.assigned);
  const running = connection?.runtime?.managedServerRunning ?? Boolean(runtime?.managedServerRunning);
  const ready = connection?.runtime?.ready ?? Boolean(runtime?.managedServerRunning || runtime?.endpointConfigured || runtime?.assigned);
  const last = connection?.runtime?.lastResult;
  const attached = connection?.attached || { knowledge: 0, workboard: 0, files: 0 };
  const available = connection?.available || { total: 0, knowledge: 0, workboard: 0, files: 0, sources: [] };
  const genStatus = generating ? 'generating…' : running ? 'ready · server running' : ready ? 'ready' : 'setup needed';
  return (
    <div className="connection-bar">
      <div className="conn-item">
        <span>Model</span>
        <strong className={modelAssigned ? 'good' : 'warn'}>{modelName || 'None assigned'}</strong>
        <button className="link" data-action-id="navigation.settings" data-control-id="chat.navigation.open-settings" onClick={onOpenSettings} disabled={Boolean(checkBusy)}>{checkBusy === 'navigation-settings' ? 'Opening…' : 'Assign / change'}</button>
      </div>
      <div className="conn-item">
        <span>Runtime</span>
        <strong className={generating ? 'good' : ''}>{genStatus}</strong>
        <button className="link" data-action-id="system.status" data-control-id="chat.connection.system-status-check" onClick={onCheckStatus} disabled={Boolean(checkBusy)}>{checkBusy === 'status' ? 'Checking…' : 'Check status'}</button>
        <button className="link" data-action-id="system.models" data-control-id="chat.connection.system-models-check" onClick={onCheckModels} disabled={Boolean(checkBusy)}>{checkBusy === 'models' ? 'Checking…' : 'Check models'}</button>
        <button className="link" data-action-id="system.runs" data-control-id="chat.connection.system-runs-check" onClick={onCheckRuns} disabled={Boolean(checkBusy)}>{checkBusy === 'runs' ? 'Checking…' : 'Recent runs'}</button>
        <button className="link" data-action-id="planner.today" data-control-id="chat.connection.planner-today-check" onClick={onCheckPlanner} disabled={Boolean(checkBusy)}>{checkBusy === 'planner' ? 'Checking…' : 'Check today'}</button>
        <button className="link" data-action-id="navigation.planner" data-control-id="chat.navigation.open-planner" onClick={onOpenPlanner} disabled={Boolean(checkBusy)}>{checkBusy === 'navigation-planner' ? 'Opening…' : 'Open Today'}</button>
        <button className="link" data-action-id="navigation.workboard" data-control-id="chat.navigation.open-workboard" onClick={onOpenWorkboard} disabled={Boolean(checkBusy)}>{checkBusy === 'navigation' ? 'Opening…' : 'Open Workboard'}</button>
        <button className="link" data-action-id="navigation.system" data-control-id="chat.navigation.open-system" onClick={onOpenSystem} disabled={Boolean(checkBusy)}>{checkBusy === 'navigation-system' ? 'Opening…' : 'Open full System'}</button>
        {statusPreview ? (
          <small role="status">
            DB {statusPreview.sqlite?.ready ? 'ready' : 'unavailable'} · model {statusPreview.model?.assigned ? 'assigned' : 'not assigned'} · repository {statusPreview.repository?.available ? statusPreview.repository.hasChanges ? 'has changes' : 'clean' : 'unavailable'} · browser connector {statusPreview.browserConnector?.connected ? 'connected' : 'disconnected'}
          </small>
        ) : null}
        {modelsPreview ? <small role="status">{modelsPreview.count} model(s): {modelsPreview.models.length ? modelsPreview.models.map((model) => model.name).join(', ') : 'none recorded'}</small> : null}
        {runsPreview ? <small role="status">{runsPreview.count} recent run(s): {runsPreview.runs.length ? runsPreview.runs.map((run) => `${run.title} (${run.status})`).join(', ') : 'none recorded'}</small> : null}
        {plannerPreview ? (
          <div className="planner-preview" role="status">
            <small>Today · {plannerPreview.mode} · {plannerPreview.visible.length} task(s)</small>
            {plannerPreview.visible.length
              ? plannerPreview.visible.map((task) => (
                <span key={task.id} className="planner-preview-task">
                  {task.title}
                  <button className="link" data-action-id="planner.propose_update" data-control-id="chat.planner-update.open" onClick={() => onEditPlannerTask(task)} disabled={Boolean(checkBusy || proposalBusy)}>Edit</button>
                  <button className="link" data-action-id="planner.propose_update" data-control-id="chat.planner-status.complete" onClick={() => onProposePlannerStatus(task, 'completed')} disabled={Boolean(checkBusy || proposalBusy)}>Done</button>
                  <button className="link" data-action-id="planner.propose_update" data-control-id="chat.planner-status.defer" onClick={() => onProposePlannerStatus(task, 'deferred')} disabled={Boolean(checkBusy || proposalBusy)}>Not today</button>
                </span>
              ))
              : <small>nothing scheduled</small>}
          </div>
        ) : null}
      </div>
      <div className="conn-item">
        <span>Always-on local sources</span>
        <strong>{available.knowledge} Knowledge · {available.workboard} Workboard · {available.files} file(s)</strong>
        <small>{available.total} safe records searchable</small>
        {available.sources.length > 0 && <details className="local-source-list"><summary>Show indexed source files</summary><ul>{available.sources.map((source) => <li key={source}>{source}</li>)}</ul></details>}
        <span>Attached context</span>
        <strong>{attached.knowledge} Knowledge · {attached.workboard} Workboard · {attached.files} file(s)</strong>
      </div>
      <div className="conn-item">
        <span>Capabilities</span>
        <strong role="status" aria-live="polite">{connectionState === 'ready' && Array.isArray(connection?.capabilities)
          ? `${connection.capabilities.length} tools`
          : connectionState === 'unavailable' ? 'Unavailable' : 'Checking…'}</strong>
      </div>
      <div className="conn-item">
        <span>Conversation</span>
        <strong>#{connection?.conversationId ?? '—'}</strong>
      </div>
      {last && (
        <div className="conn-item">
          <span>Last runtime</span>
          <strong className={last.ok ? 'good' : 'warn'}>{last.ok ? last.mode : `${last.mode} error`}</strong>
        </div>
      )}
    </div>
  );
}

function ProposalCard({ proposal, busy, onConfirm, onCancel }) {
  const isUpdate = proposal.operation === 'workboard.update';
  return (
    <div className="proposal-card">
      <div className="proposal-head"><ShieldCheck size={16} /><strong>Confirm Workboard {isUpdate ? 'update' : 'create'}</strong></div>
      <p>{proposal.affects}</p>
      <div className="proposal-diff">
        {isUpdate
          ? Object.keys(proposal.after || {}).map((k) => (
            <div key={k}><span>{k}</span><em>{String(proposal.before?.[k] ?? '—')}</em> → <strong>{String(proposal.after[k])}</strong></div>
          ))
          : (
            <>
              <div><span>type</span><strong>{proposal.preview?.type}</strong></div>
              <div><span>title</span><strong>{proposal.preview?.title}</strong></div>
              {proposal.preview?.body ? <div><span>details</span><strong>{proposal.preview.body}</strong></div> : null}
              {proposal.preview?.next_action ? <div><span>next action</span><strong>{proposal.preview.next_action}</strong></div> : null}
            </>
          )}
      </div>
      <div className="decision-row">
        {isUpdate
          ? <button data-action-id="workboard.propose_update" data-control-id="chat.workboard-update.confirm" className="primary" onClick={onConfirm} disabled={busy}><Check size={15} /> {busy ? 'Applying…' : 'Confirm and apply'}</button>
          : <button data-action-id="workboard.propose_create" data-control-id="chat.workboard-proposal.confirm" className="primary" onClick={onConfirm} disabled={busy}><Check size={15} /> {busy ? 'Applying…' : 'Confirm and apply'}</button>}
        <button onClick={onCancel} disabled={busy}><X size={15} /> Cancel</button>
      </div>
      <small>This time-limited proposal is bound to this chat and cannot be replaced by the browser. Nothing is written to the Workboard until you confirm.</small>
    </div>
  );
}

function PlannerProposalCard({ proposal, busy, onConfirm, onCancel }) {
  const isUpdate = proposal.operation === 'planner.update';
  const preview = proposal.preview || {};
  return (
    <div className="proposal-card">
      <div className="proposal-head"><ShieldCheck size={16} /><strong>Confirm Daily Planner {isUpdate ? 'update' : 'task'}</strong></div>
      <p>{proposal.affects}</p>
      <div className="proposal-diff">
        {isUpdate
          ? Object.keys(proposal.after || {}).map((k) => (
            <div key={k}><span>{k}</span><em>{String(proposal.before?.[k] ?? '—')}</em> → <strong>{String(proposal.after[k])}</strong></div>
          ))
          : (
            <>
              <div><span>title</span><strong>{preview.title}</strong></div>
              {preview.next_action ? <div><span>next action</span><strong>{preview.next_action}</strong></div> : null}
              {preview.why ? <div><span>why</span><strong>{preview.why}</strong></div> : null}
              <div><span>importance</span><strong>{String(preview.importance)}</strong></div>
              <div><span>effort</span><strong>{String(preview.effort)}</strong></div>
              {preview.estimated_minutes != null ? <div><span>estimate</span><strong>{preview.estimated_minutes} min</strong></div> : null}
              {preview.deadline ? <div><span>deadline</span><strong>{preview.deadline}</strong></div> : null}
            </>
          )}
      </div>
      <div className="decision-row">
        {isUpdate
          ? <button data-action-id="planner.propose_update" data-control-id="chat.planner-update.confirm" className="primary" onClick={onConfirm} disabled={busy}><Check size={15} /> {busy ? 'Applying…' : 'Confirm and update task'}</button>
          : <button data-action-id="planner.propose_create" data-control-id="chat.planner-proposal.confirm" className="primary" onClick={onConfirm} disabled={busy}><Check size={15} /> {busy ? 'Creating…' : 'Confirm and create task'}</button>}
        <button onClick={onCancel} disabled={busy}><X size={15} /> Cancel</button>
      </div>
      <small>This time-limited proposal is bound to this chat and cannot be replaced by the browser. {isUpdate ? 'No task is changed' : 'No Daily Planner task exists'} until you confirm.</small>
    </div>
  );
}

function ProjectProposalCard({ proposal, busy, onConfirm, onCancel }) {
  const preview = proposal.preview || {};
  return (
    <div className="proposal-card">
      <div className="proposal-head"><ShieldCheck size={16} /><strong>Confirm Workboard card</strong></div>
      <p>{proposal.affects}</p>
      <div className="proposal-diff">
        <div><span>title</span><strong>{preview.title}</strong></div>
        {preview.body ? <div><span>evidence</span><strong>{preview.body}</strong></div> : null}
        {preview.next_action ? <div><span>next action</span><strong>{preview.next_action}</strong></div> : null}
      </div>
      <div className="decision-row">
        <button data-action-id="project.propose_create" data-control-id="chat.project-proposal.confirm" className="primary" onClick={onConfirm} disabled={busy}><Check size={15} /> {busy ? 'Creating…' : 'Confirm and create card'}</button>
        <button onClick={onCancel} disabled={busy}><X size={15} /> Cancel</button>
      </div>
      <small>This time-limited proposal is bound to this chat and cannot be replaced by the browser. No Workboard card exists until you confirm.</small>
    </div>
  );
}

function ContextPicker({ picker, onSearch, onPreview, onProposeUpdate, proposalBusy, onAttach, onClose }) {
  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <strong>{picker.domain === 'knowledge' ? 'Attach Knowledge context' : 'Attach Workboard context'}</strong>
          <button className="icon-button" onClick={onClose} aria-label="Close context picker"><X size={16} /></button>
        </div>
        <div className="picker-controls">
          {picker.domain === 'knowledge' ? (
            <>
              <input data-action-id="knowledge.search" data-control-id="chat.context-picker.knowledge-query" value={picker.query} placeholder="Search approved memory, candidates, rules…" onChange={(e) => onSearch({ query: e.target.value })} autoFocus />
              <select data-action-id="knowledge.search" data-control-id="chat.context-picker.knowledge-scope" value={picker.scope} onChange={(e) => onSearch({ scope: e.target.value })}>
                {['all', 'approved', 'candidates', 'rules'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </>
          ) : (
            <select data-action-id="workboard.list" data-control-id="chat.context-picker.workboard-view" value={picker.view} onChange={(e) => onSearch({ view: e.target.value })}>
              {['projects', 'overview', 'roadmap', 'review', 'blocked', 'completed'].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          )}
        </div>
        <div className="picker-results">
          {picker.loading
            ? <div className="loading">Searching…</div>
            : (picker.results || []).length === 0
              ? <Empty title="No records" body="Nothing matched. Adjust the search or scope." />
              : picker.results.map((rec) => (
                <div key={`${rec.kind}-${rec.ref_id}`} className="picker-result">
                  <div className="picker-result-actions">
                    <button className="picker-row" onClick={() => onAttach(rec)} aria-label={`Attach ${rec.label}`}>
                      <div><strong>{rec.label}</strong><span>{rec.sub}</span></div>
                      <Plus size={16} />
                    </button>
                    {picker.domain === 'knowledge' ? (
                      <button
                        type="button"
                        className="secondary picker-preview-button"
                        data-action-id="knowledge.read"
                        data-control-id="chat.context-picker.knowledge-preview"
                        onClick={() => onPreview(rec)}
                        disabled={picker.preview?.loading && picker.preview?.key === `${rec.kind}-${rec.ref_id}`}
                      >
                        {picker.preview?.loading && picker.preview?.key === `${rec.kind}-${rec.ref_id}` ? 'Loading…' : 'Preview'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="secondary picker-preview-button"
                        data-action-id="workboard.read"
                        data-control-id="chat.context-picker.workboard-preview"
                        onClick={() => onPreview(rec)}
                        disabled={picker.preview?.loading && picker.preview?.key === `${rec.kind}-${rec.ref_id}`}
                      >
                        {picker.preview?.loading && picker.preview?.key === `${rec.kind}-${rec.ref_id}` ? 'Loading…' : 'Preview'}
                      </button>
                    )}
                  </div>
                  {picker.preview?.key === `${rec.kind}-${rec.ref_id}`
                    ? picker.domain === 'knowledge'
                      ? <KnowledgeRecordPreview preview={picker.preview} />
                      : <WorkboardRecordPreview preview={picker.preview} onProposeUpdate={onProposeUpdate} busy={proposalBusy} />
                    : null}
                </div>
              ))}
        </div>
        <small>Previewing never attaches a record. Only Attach adds the selected record — never the whole database. IDs and provenance are retained.</small>
      </div>
    </div>
  );
}

function KnowledgeRecordPreview({ preview }) {
  if (preview.loading) return <div className="picker-preview" role="status">Loading preview…</div>;
  if (preview.error) return <div className="picker-preview" role="status">{preview.error}</div>;
  const record = preview.data;
  if (!record) return null;
  const provenance = record.provenance || {};
  return (
    <div className="picker-preview">
      <div className="picker-preview-head"><strong>{record.title}</strong><span>{record.type || record.kind}</span></div>
      <div className="picker-preview-body">{record.body || 'No body recorded.'}</div>
      <div className="picker-preview-meta">
        <span>source: {provenance.source || 'not recorded'}</span>
        <span>evidence: {provenance.evidence || 'not recorded'}</span>
        <span>status: {provenance.status || 'not recorded'}</span>
        {provenance.confidence === null || provenance.confidence === undefined ? null : <span>confidence: {provenance.confidence}</span>}
        {provenance.updated_at ? <span>updated: {provenance.updated_at}</span> : null}
      </div>
      <small>This is a bounded plain-text preview with provenance. Attach remains a separate action.</small>
    </div>
  );
}

function WorkboardRecordPreview({ preview, onProposeUpdate, busy }) {
  if (preview.loading) return <div className="picker-preview" role="status">Loading preview…</div>;
  if (preview.error) return <div className="picker-preview" role="status">{preview.error}</div>;
  const record = preview.data;
  if (!record) return null;
  return (
    <div className="picker-preview" aria-label={`Workboard preview: ${record.title}`}>
      <div className="picker-preview-head">
        <strong>{record.title}</strong>
        <span>{record.identity?.type}{record.status ? ` · ${record.status}` : ''}</span>
      </div>
      {record.detail ? <div className="picker-preview-body">{record.detail}</div> : null}
      {record.next_action ? <p><strong>Next:</strong> {record.next_action}</p> : null}
      {record.project ? <small>Project: {record.project.title}</small> : null}
      {record.children?.length ? (
        <div className="picker-preview-meta">
          <strong>Linked items</strong>
          {record.children.map((child) => <span key={`${child.identity.type}-${child.identity.id}`}>{child.title}{child.status ? ` · ${child.status}` : ''}</span>)}
          {record.truncated ? <span>Additional linked items omitted.</span> : null}
        </div>
      ) : null}
      <div className="picker-preview-meta">
        <strong>Provenance</strong>
        <span>source: {record.provenance?.source || 'not recorded'}</span>
        <span>evidence: {record.provenance?.evidence || 'not recorded'}</span>
      </div>
      <small>This is a bounded plain-text preview. Attach remains a separate action.</small>
      {record.identity?.type === 'item' ? <WorkboardUpdateControls record={record} onProposeUpdate={onProposeUpdate} busy={busy} /> : null}
    </div>
  );
}

function WorkboardUpdateControls({ record, onProposeUpdate, busy }) {
  const [form, setForm] = useState({ title: record.title || '', status: record.status || 'active', next_action: record.next_action || '' });
  useEffect(() => {
    setForm({ title: record.title || '', status: record.status || 'active', next_action: record.next_action || '' });
  }, [record.identity?.id, record.title, record.status, record.next_action]);
  const changes = {};
  if (form.title.trim() !== record.title) changes.title = form.title.trim();
  if (form.status !== record.status) changes.status = form.status;
  if ((form.next_action.trim() || null) !== (record.next_action || null)) changes.next_action = form.next_action.trim() || null;
  const hasChanges = Object.keys(changes).length > 0;
  return (
    <div className="propose-form picker-update-form">
      <strong>Propose an update</strong>
      <input value={form.title} maxLength={160} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} aria-label="Updated Workboard title" />
      <select value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))} aria-label="Updated Workboard status">
        {['active', 'stable', 'blocked', 'stale', 'pending review', 'done', 'archived', 'deprecated', 'superseded'].map((status) => <option key={status} value={status}>{status}</option>)}
      </select>
      <input value={form.next_action} maxLength={400} onChange={(event) => setForm((current) => ({ ...current, next_action: event.target.value }))} aria-label="Updated Workboard next action" placeholder="Next action" />
      <button
        type="button"
        className="primary"
        data-action-id="workboard.propose_update"
        data-control-id="chat.context-picker.workboard-update"
        onClick={() => onProposeUpdate(record, changes)}
        disabled={busy || !form.title.trim() || !hasChanges}
      >
        {busy ? 'Preparing…' : 'Preview update'}
      </button>
      <small>No Workboard field changes until you review and confirm the exact diff.</small>
    </div>
  );
}

function candidateDetails(candidate) {
  const rawTitle = candidate.title || 'Untitled candidate';
  const fromConsultation = candidate.source === 'cloud consultation' || rawTitle.startsWith('Consultation suggestion:');
  const title = fromConsultation ? rawTitle.replace(/^Consultation suggestion:\s*/, '').trim() || 'Cloud consultation response' : rawTitle;
  return {
    title,
    type: fromConsultation ? 'consultation' : candidate.type || 'candidate',
    bodyLabel: fromConsultation ? 'Captured external response' : 'Candidate memory',
    source: candidate.source || 'unknown',
    evidence: candidate.evidence || 'No evidence recorded.',
    confidence: Number(candidate.confidence || 0).toFixed(2),
    status: candidate.status || 'candidate'
  };
}

function CandidateReviewCard({ candidate, edits = {}, setEdits, onSave, onDecision }) {
  const details = candidateDetails(candidate);
  const edit = edits[candidate.id] || {};
  const canEdit = Boolean(setEdits && onSave);
  const update = (key, value) => {
    if (!setEdits) return;
    setEdits((current) => ({ ...current, [candidate.id]: { ...(current[candidate.id] || {}), [key]: value } }));
  };

  return (
    <div className="review-card" key={candidate.id}>
      <div className="review-card-heading">
        <Pill tone={details.type === 'consultation' ? 'info' : 'warn'}>{details.type}</Pill>
        <Pill tone="warn">{details.status}</Pill>
      </div>
      <h3>{details.title}</h3>
      <div className="candidate-response">
        <span>{details.bodyLabel}</span>
        <p>{candidate.body}</p>
      </div>
      <div className="candidate-meta">
        <span>Source: {details.source}</span>
        <span>Evidence: {details.evidence}</span>
        <span>Confidence: {details.confidence}</span>
      </div>
      {canEdit && (
        <details className="candidate-edit">
          <summary>Edit metadata</summary>
          <div className="memory-edit-grid">
            <label>
              Title
              <input value={edit.title ?? details.title} onChange={(event) => update('title', event.target.value)} />
            </label>
            <label>
              Type
              <input value={edit.type ?? details.type} onChange={(event) => update('type', event.target.value)} />
            </label>
            <label>
              Confidence
              <input type="number" min="0" max="1" step="0.05" value={edit.confidence ?? candidate.confidence} onChange={(event) => update('confidence', event.target.value)} />
            </label>
            <label>
              Evidence
              <input value={edit.evidence ?? candidate.evidence ?? ''} onChange={(event) => update('evidence', event.target.value)} />
            </label>
          </div>
        </details>
      )}
      {candidate.status === 'temporary' ? <p>Temporary information is shown separately from approved memory and is not treated as a canonical fact.</p> : <div className="decision-row">
        {canEdit && <button onClick={() => onSave(candidate)}><Check size={16} /> Save metadata</button>}
        <button className="primary" onClick={() => onDecision(candidate.id, 'approve')}><Check size={16} /> Approve</button>
        <button onClick={() => onDecision(candidate.id, 'defer')}><Clock3 size={16} /> Defer</button>
        <button onClick={() => onDecision(candidate.id, 'temporary')}><Clock3 size={16} /> Temporary</button>
        <button className="danger" onClick={() => onDecision(candidate.id, 'deny')}><X size={16} /> Deny</button>
      </div>}
    </div>
  );
}

function Memory({ memory, refresh, mode = 'memory' }) {
  const [candidateEdits, setCandidateEdits] = useState({});

  async function decide(id, decision) {
    await api(`/api/memory/candidates/${id}/${decision}`, { method: 'POST' });
    refresh();
  }

  async function saveCandidate(candidate) {
    const patch = candidateEdits[candidate.id] || {};
    await api(`/api/memory/candidates/${candidate.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    refresh();
  }

  async function proposeMemoryUpdate(item, updates, summary) {
    await api('/api/approvals', {
      method: 'POST',
      body: JSON.stringify({
        action_type: 'update_memory',
        title: summary,
        priority: updates.status === 'superseded' ? 'P1' : 'P2',
        payload: {
          id: item.id,
          previous: { status: item.status, confidence: item.confidence, updated_at: item.updated_at },
          updates,
          summary,
          risk: updates.status === 'superseded' ? 'medium' : 'low',
          source: 'Memory review'
        }
      })
    });
    refresh();
  }
  async function deleteMemory(item) {
    if (!window.confirm(`Remove “${item.title}” from active retrieval? Its minimal revision record remains for audit.`)) return;
    await api(`/api/memory/items/${item.id}`, { method: 'DELETE' });
    refresh();
  }

  const candidates = memory.candidates.filter((candidate) => ['candidate', 'deferred', 'temporary'].includes(candidate.status));
  const approvedItems = memory.items.filter((item) => item.type !== 'rule');

  return (
    <section className={mode === 'all' ? 'two-column' : 'stacked-panels'}>
      {mode !== 'memory' && (
      <div className="panel">
        <h2>Candidate Review</h2>
        <p>Chat and cloud consultation outputs wait here before becoming active memory.</p>
        {candidates.length === 0 && <Empty title="No pending candidates" body="Chat and consultation outputs will appear here for explicit review." />}
        {candidates.map((candidate) => (
          <CandidateReviewCard
            key={candidate.id}
            candidate={candidate}
            edits={candidateEdits}
            setEdits={setCandidateEdits}
            onSave={saveCandidate}
            onDecision={decide}
          />
        ))}
      </div>
      )}
      {mode !== 'candidates' && (
      <div className="panel">
        <h2>Approved Knowledge</h2>
        <p>Canonical database items with status, confidence, evidence, owner, and next action.</p>
        <div className="table-list">
          {approvedItems.map((item) => (
            <div className="memory-row" key={item.id}>
              <ItemRow item={item} />
              <div className="mini-actions text-actions">
                <button onClick={() => proposeMemoryUpdate(item, { status: item.status, confidence: item.confidence, evidence: 'Reviewed from Memory tab.', next_action: item.next_action }, `Review memory: ${item.title}`)}>Review</button>
                <button onClick={() => proposeMemoryUpdate(item, { status: 'stale', confidence: Math.min(Number(item.confidence || 0), 0.45), evidence: 'Marked stale from Memory tab.', next_action: 'Verify before relying on this memory.' }, `Mark stale: ${item.title}`)}>Stale</button>
                <button className="danger" onClick={() => proposeMemoryUpdate(item, { status: 'superseded', confidence: 0.3, evidence: 'Superseded from Memory tab.', next_action: 'Use newer approved memory instead.' }, `Supersede memory: ${item.title}`)}>Supersede</button>
                <button className="danger" onClick={() => deleteMemory(item)}>Delete</button>
              </div>
            </div>
          ))}
          {approvedItems.length === 0 && <Empty title="No approved knowledge" body="Approved non-rule memory will appear here." />}
        </div>
      </div>
      )}
    </section>
  );
}

function ApprovalQueue({ setNotice, refreshPlanner, scope = 'all' }) {
  const [items, setItems] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [checks, setChecks] = useState({});

  async function load(announce = false) {
    const data = await api('/api/planner');
    const approvalItems = data.approvals || [];
    setItems(scope === 'memory' ? approvalItems.filter((item) => item.action_type === 'update_memory') : scope === 'operational' ? approvalItems.filter((item) => item.action_type !== 'update_memory') : approvalItems);
    setCandidates(scope === 'all' ? data.candidates || [] : []);
    if (announce) setNotice('Approval queue refreshed.');
  }

  useEffect(() => { load().catch((err) => setNotice(err.message)); }, []);

  async function decide(id, decision) {
    try {
      await api(`/api/approvals/${id}/${decision}`, { method: 'POST' });
      setNotice(`Approval ${decision} recorded.`);
      await load();
      await refreshPlanner();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function decideCandidate(id, decision) {
    try {
      await api(`/api/memory/candidates/${id}/${decision}`, { method: 'POST' });
      setNotice(`Memory candidate ${decision} recorded.`);
      await load();
      await refreshPlanner();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function revalidate(id) {
    try {
      const result = await api(`/api/approvals/${id}/revalidate`, { method: 'POST' });
      setChecks((current) => ({ ...current, [id]: result }));
      setNotice(result.message);
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{scope === 'memory' ? 'Memory change proposals' : scope === 'operational' ? 'Operational review' : 'Approval Queue'}</h2>
          <p>{scope === 'memory' ? 'Existing-memory changes stay governed here; candidate promotion is reviewed above.' : scope === 'operational' ? 'Tasks, projects, workflows, agents, code, and execution proposals require an explicit decision.' : 'Meaningful changes wait here before memory, plans, repo files, or priorities change.'}</p>
        </div>
        <button onClick={() => load(true)}><RefreshCcw size={16} /> Refresh</button>
      </div>
      {items.length === 0 && candidates.length === 0 ? (
        <Empty title="No pending approvals" body={scope === 'operational' ? 'Operational proposals will appear here for explicit review.' : scope === 'memory' ? 'Governed changes to existing memory will appear here.' : 'Staged changes and memory candidates will appear here for explicit review.'} />
      ) : (
        <div className="approval-list">
          {items.length > 0 && <h3>{scope === 'operational' ? 'Operational proposals' : 'Governed changes'}</h3>}
          {items.map((item) => {
            const payload = JSON.parse(item.payload || '{}');
            const check = checks[item.id];
            return (
              <div className="approval-card" key={item.id}>
                <div className="panel-heading">
                  <div>
                    <Pill tone={payload.risk === 'high' ? 'bad' : payload.risk === 'low' ? 'good' : 'warn'}>{payload.risk || item.priority}</Pill>
                    <h3>{item.title}</h3>
                    <p>{payload.summary || item.action_type}</p>
                  </div>
                  <Pill tone="info">{item.action_type}</Pill>
                </div>
                {(payload.targetFile || payload.id) && (
                  <pre className="code-block compact-code">
{[
  payload.operation && `Operation: ${payload.operation}`,
  payload.fromFile && `From: ${payload.fromFile}`,
  payload.targetFile && `Target: ${payload.targetFile}`,
  payload.id && `Record id: ${payload.id}`,
  `Source: ${payload.source || 'unknown'}`
].filter(Boolean).join('\n')}
                  </pre>
                )}
                {check && <div className={cx('source-warning', check.valid ? 'info' : 'bad')}>{check.message}</div>}
                {payload.previousContent !== undefined && (
                  <div className="diff-columns">
                    <pre className="code-block compact-code">{payload.previousContent || '(new file)'}</pre>
                    <pre className="code-block compact-code">{payload.content || '(empty)'}</pre>
                  </div>
                )}
                <div className="decision-row">
                  <button onClick={() => revalidate(item.id)}><RefreshCcw size={16} /> Revalidate</button>
                  <button className="primary" onClick={() => decide(item.id, 'approve')}><Check size={16} /> Approve</button>
                  <button onClick={() => decide(item.id, 'defer')}><Clock3 size={16} /> Defer</button>
                  <button className="danger" onClick={() => decide(item.id, 'deny')}><X size={16} /> Deny</button>
                </div>
              </div>
            );
          })}
          {candidates.length > 0 && <h3>Memory Candidates</h3>}
          {candidates.map((candidate) => (
            <CandidateReviewCard key={candidate.id} candidate={candidate} onDecision={decideCandidate} />
          ))}
        </div>
      )}
    </section>
  );
}

function Projects({ projects, setProjects, setNotice, refreshAll }) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const [projectDraft, setProjectDraft] = useState({ name: '', status: 'active', owner: 'user', confidence: 0.75, next_action: '', shareability: 'unknown' });

  function startEdit(project) {
    setEditing(project);
    setProjectDraft({
      name: project.name || '',
      status: project.status || 'active',
      owner: project.owner || 'user',
      confidence: Number(project.confidence || 0.75),
      next_action: project.next_action || '',
      shareability: project.shareability || 'unknown'
    });
  }

  async function createProject() {
    if (!name.trim()) return;
    try {
      await api('/api/approvals', {
        method: 'POST',
        body: JSON.stringify({
          action_type: 'create_project',
          title: `Create project: ${name}`,
          priority: 'P2',
          payload: { name, next_action: 'Define next action.', evidence: 'Project proposed from Projects view.' }
        })
      });
      setName('');
      setNotice('Project proposal added to approval queue.');
      await refreshAll();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function proposeProjectUpdate() {
    if (!editing || !projectDraft.name.trim()) return;
    try {
      await api('/api/approvals', {
        method: 'POST',
        body: JSON.stringify({
          action_type: 'update_project',
          title: `Update project: ${editing.name}`,
          priority: 'P2',
          payload: {
            id: editing.id,
            previous: {
              name: editing.name,
              status: editing.status,
              owner: editing.owner,
              confidence: editing.confidence,
              next_action: editing.next_action || '',
              shareability: editing.shareability || 'unknown'
            },
            updates: {
              ...projectDraft,
              confidence: Number(projectDraft.confidence),
              evidence: 'Project update proposed from Projects view.'
            },
            summary: `Update ${editing.name}`,
            risk: 'medium',
            source: 'Projects view'
          }
        })
      });
      setEditing(null);
      setNotice('Project update proposal added to approval queue.');
      await refreshAll();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <section className="projects-layout">
      <div className="panel">
      <div className="inline-form">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="New project name" />
        <button className="primary" onClick={createProject}><Plus size={16} /> Propose project</button>
      </div>
      <div className="table-list">
        {projects.map((project) => (
          <div className="project-row" key={project.id}>
            <ItemRow item={{ ...project, type: 'project', title: project.name }} />
            <button onClick={() => startEdit(project)}>Edit</button>
          </div>
        ))}
      </div>
      </div>
      {editing && (
        <div className="panel">
          <h2>Edit Project Proposal</h2>
          <p>Project changes go through approval before updating the database.</p>
          <label>Name</label>
          <input value={projectDraft.name} onChange={(event) => setProjectDraft((draft) => ({ ...draft, name: event.target.value }))} />
          <label>Status</label>
          <select value={projectDraft.status} onChange={(event) => setProjectDraft((draft) => ({ ...draft, status: event.target.value }))}>
            <option>active</option>
            <option>blocked</option>
            <option>waiting</option>
            <option>stable</option>
            <option>archived</option>
          </select>
          <label>Owner</label>
          <input value={projectDraft.owner} onChange={(event) => setProjectDraft((draft) => ({ ...draft, owner: event.target.value }))} />
          <label>Confidence</label>
          <input type="number" min="0" max="1" step="0.05" value={projectDraft.confidence} onChange={(event) => setProjectDraft((draft) => ({ ...draft, confidence: event.target.value }))} />
          <label>Next action</label>
          <textarea value={projectDraft.next_action} onChange={(event) => setProjectDraft((draft) => ({ ...draft, next_action: event.target.value }))} />
          <label>Shareability</label>
          <select value={projectDraft.shareability} onChange={(event) => setProjectDraft((draft) => ({ ...draft, shareability: event.target.value }))}>
            <option value="unknown">Unknown — never public</option>
            <option value="private">Private — never public</option>
            <option value="local-shareable">Local-shareable — not public</option>
            <option value="public-shareable">Public-shareable — eligible only after export review</option>
          </select>
          <div className="decision-row">
            <button className="primary" onClick={proposeProjectUpdate}><Check size={16} /> Propose update</button>
            <button onClick={() => setEditing(null)}><X size={16} /> Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

function BrowserConsult({ setNotice, refresh, refreshSignal = 0 }) {
  const [cap, setCap] = useState(null);
  const [title, setTitle] = useState('Cloud critique request');
  const [draft, setDraft] = useState('');
  const [external, setExternal] = useState('');
  const [consultations, setConsultations] = useState([]);
  const [agentTabs, setAgentTabs] = useState({ cdpAvailable: false, agents: {} });
  const [repoFiles, setRepoFiles] = useState([]);
  const [selectedContextFile, setSelectedContextFile] = useState('');
  const [contextPaths, setContextPaths] = useState([]);
  const [targetAgent, setTargetAgent] = useState('ChatGPT');
  const [browserUrl, setBrowserUrl] = useState('https://chatgpt.com/');
  const [browserResult, setBrowserResult] = useState(null);
  const [consultBusy, setConsultBusy] = useState(false);
  const [assistBusy, setAssistBusy] = useState(false);
  const [consultStatus, setConsultStatus] = useState('');
  const [browserBusy, setBrowserBusy] = useState(false);
  const [externalBusy, setExternalBusy] = useState(false);
  const [chromeBusy, setChromeBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [consultPrompt, setConsultPrompt] = useState('');
  const [activeConsultationId, setActiveConsultationId] = useState(null);
  const [temporaryChatRequired, setTemporaryChatRequired] = useState(true);
  const [temporaryChatConfirmed, setTemporaryChatConfirmed] = useState(false);
  const [egressPreview, setEgressPreview] = useState(null);
  const [egressConfirmed, setEgressConfirmed] = useState(false);
  const browserReady = Boolean(cap?.playwright && cap?.chromium);
  const connectorReady = Boolean(agentTabs.connectorAvailable);
  const controlledBrowserWarning = controlledBrowserWarningForUrl(browserUrl);
  const chatGptTarget = targetAgent === 'ChatGPT' || isChatGptUrl(browserUrl);
  const temporaryChatGateActive = temporaryChatRequired && chatGptTarget;
  const temporaryChatNeedsConfirmation = temporaryChatGateActive && !temporaryChatConfirmed;
  const temporaryChatFullPromptReason = temporaryChatNeedsConfirmation
    ? 'Turn on Temporary Chat in ChatGPT, then tick the confirmation box before copying or opening the full prompt.'
    : '';
  const browserDisabledReason = browserBusy
    ? 'Browser automation is already opening a page.'
    : !cap
      ? 'Checking browser automation status.'
      : !cap.playwright
        ? 'Playwright package is not available. Install Playwright from Tooling.'
        : !cap.chromium
          ? 'Playwright Chromium is not installed. Use Tooling > Install Playwright Chromium or run npx playwright install chromium.'
          : !browserUrl.trim()
            ? 'Enter a URL before opening the controlled browser.'
            : '';
  const connectorDisabledReason = connectorReady
    ? ''
    : 'Chrome connector is not connected. Load browser-extension/lps-browser-agent in the signed-in Chrome profile and keep this app open.';
  const normalBrowserDisabledReason = !browserUrl.trim()
    ? 'Enter a URL before opening a normal browser tab.'
    : '';
  const appTabDisabledReason = !browserUrl.trim()
    ? 'Enter a URL before opening an app tab.'
    : '';
  const externalBrowserDisabledReason = externalBusy
    ? 'External browser is already opening a page.'
    : !browserUrl.trim()
      ? 'Enter a URL before opening your external browser.'
      : '';
  const chromeDisabledReason = chromeBusy
    ? 'Chrome is already opening a page.'
    : !browserUrl.trim()
      ? 'Enter a URL before opening Chrome.'
      : '';
  const copyOpenDisabledReason = !draft.trim()
    ? 'Enter a local draft before using Copy + Open.'
    : temporaryChatFullPromptReason || browserDisabledReason;
  const copyNormalDisabledReason = !draft.trim()
    ? 'Enter a local draft before using Copy + Normal.'
    : temporaryChatFullPromptReason || normalBrowserDisabledReason;
  const copyAppTabDisabledReason = !draft.trim()
    ? 'Enter a local draft before using Copy + App tab.'
    : temporaryChatFullPromptReason || appTabDisabledReason;
  const copyExternalDisabledReason = !draft.trim()
    ? 'Enter a local draft before using Copy + External.'
    : externalBrowserDisabledReason;
  const copyChromeDisabledReason = !draft.trim()
    ? 'Enter a local draft before using Copy + Chrome.'
    : chromeDisabledReason;
  const copyDisabledReason = !draft.trim() && !consultPrompt
    ? 'Enter a local draft or build a consultation prompt before copying.'
    : '';
  const assistDisabledReason = assistBusy
    ? 'Local model assistance is already running.'
    : !draft.trim()
      ? 'Enter a browser-agent question before asking the local model to assist.'
      : '';
  const automaticDisabledReason = consultBusy
    ? 'Cloud consultant is already running.'
    : !draft.trim()
      ? 'Enter a message before running cloud consultation.'
      : temporaryChatNeedsConfirmation
          ? 'Turn on Temporary Chat in ChatGPT, then tick the confirmation box before sending the full prompt.'
          : egressPreview?.blocked
            ? 'Automatic cloud sending is blocked because this prompt contains sensitive personal material. Remove or generalise it locally, then preview again.'
          : connectorDisabledReason || browserDisabledReason;
  const waitingForExternalResponse = Boolean(activeConsultationId || browserResult || consultPrompt);
  const responseCaptureHint = external.trim()
    ? 'Automatic answer captured. Choose what to save below; nothing is saved or synced until you click a save option.'
    : browserResult?.blocked
      ? browserResult?.mode === 'my Chrome connector'
        ? 'Automatic capture was blocked. Check the cloud-agent tab in your normal Chrome (finish any login or verification there), then run it again. Manual paste is available as a fallback.'
        : 'Automatic capture was blocked. Finish login or verification in the persistent browser profile, then run it again. Manual paste is available as a fallback.'
      : ['chrome', 'external', 'normal-tab', 'app-tab'].includes(browserResult?.mode)
        ? 'Manual fallback is active. Copy the answer from that browser only if automatic capture is blocked.'
        : waitingForExternalResponse
          ? 'Waiting for the automatic cloud response. If the site blocks automation, use the manual fallback controls.'
          : connectorDisabledReason || 'Run automatic consultation to send the prompt, wait for ChatGPT, and fill this box automatically. Manual paste is only a fallback.';

  async function load() {
    setCap(await api('/api/browser/capabilities'));
    setAgentTabs(await api('/api/browser/agent-tabs').catch(() => ({ cdpAvailable: false, agents: {} })));
    setConsultations(await api('/api/consultations'));
  }
  useEffect(() => { load().catch((err) => setNotice(err.message)); }, [refreshSignal]);
  useEffect(() => {
    api('/api/repo/files?q=').then(setRepoFiles).catch((err) => setNotice(err.message));
  }, []);
  useEffect(() => {
    setEgressPreview(null);
    setEgressConfirmed(false);
  }, [draft, contextPaths, targetAgent]);

  function addContextFile() {
    if (!selectedContextFile || contextPaths.includes(selectedContextFile)) return;
    setContextPaths((current) => [...current, selectedContextFile]);
    setSelectedContextFile('');
  }

  function removeContextFile(path) {
    setContextPaths((current) => current.filter((item) => item !== path));
  }

  async function ensureConsultation(promptOverride = '') {
    if (activeConsultationId) return activeConsultationId;
    const prompt = promptOverride || consultPrompt || buildConsultPrompt();
    const created = await api('/api/consultations', {
      method: 'POST',
      body: JSON.stringify({
        title,
        local_draft: draft,
        target_agent: targetAgent,
        prompt,
        opened_url: browserResult?.url,
        opened_title: browserResult?.title,
        sent_at: browserResult ? new Date().toISOString() : null
      })
    });
    setActiveConsultationId(created.id);
    return created.id;
  }

  async function saveConsultation() {
    const prompt = consultPrompt || buildConsultPrompt();
    const consultationId = await ensureConsultation(prompt);
    const hadExternalResponse = Boolean(external.trim());
    if (external.trim()) {
      await api(`/api/consultations/${consultationId}`, { method: 'PATCH', body: JSON.stringify({ external_response: external, status: 'captured' }) });
    }
    setDraft('');
    setExternal('');
    setConsultPrompt('');
    setActiveConsultationId(null);
    setBrowserResult(null);
    await load();
    await refresh();
    setNotice(hadExternalResponse
      ? 'Consultation saved. External response became a memory candidate for review; nothing was promoted automatically.'
      : 'Consultation draft saved. Add an external response to create a memory candidate.');
  }

  function buildConsultPrompt() {
    const contextLines = contextPaths.length
      ? [
        `Selected LifePlanSystem context files:`,
        ...contextPaths.map((path, index) => `${index + 1}. ${path}`),
        ``,
        `The automatic backend request will read and include the selected file contents.`
      ]
      : ['Selected LifePlanSystem context files: none.'];
    const prompt = [
      `You are acting as an external consultant for Life Planner, a local-first personal executive assistant.`,
      `Target: ${targetAgent}.`,
      ``,
      `Review the local draft below. Critique it, call out missing context or risky assumptions, and suggest concrete improvements.`,
      `Do not claim authority over memory, priorities, or plans. Your response will be pasted back into Life Planner as a reviewable suggestion only.`,
      ``,
      ...contextLines,
      ``,
      `Local draft:`,
      draft.trim() || '(No local draft supplied yet.)'
    ].join('\n');
    setConsultPrompt(prompt);
    return prompt;
  }

  async function assistConsultPrompt() {
    if (assistDisabledReason) return;
    setAssistBusy(true);
    setConsultStatus('Asking the local model to shape the browser-agent question...');
    try {
      const result = await api('/api/browser/assist-prompt', {
        method: 'POST',
        body: JSON.stringify({
          local_draft: draft,
          target_agent: targetAgent,
          context_paths: contextPaths
        })
      });
      if (result.available && result.prompt) {
        setConsultPrompt(result.prompt);
        setConsultStatus(`Local model prepared the browser-agent question. Runtime: ${result.mode}.`);
        setNotice('Local model prepared the browser-agent question. Review it, then send it to the browser agent.');
      } else {
        const fallback = buildConsultPrompt();
        setConsultPrompt(fallback);
        setConsultStatus(result.message || 'Local model assistance is unavailable; generated the standard browser-agent prompt instead.');
        setNotice(result.message || 'Local model assistance is unavailable; generated the standard browser-agent prompt instead.');
      }
    } catch (err) {
      setConsultStatus(err.message);
      setNotice(err.message);
    } finally {
      setAssistBusy(false);
    }
  }

  async function runAutomaticConsultation() {
    if (automaticDisabledReason) return;
    setConsultBusy(true);
    setExternal('');
    setBrowserResult(null);
    setActiveConsultationId(null);
    setConsultStatus('Preparing prompt and selected LifePlanSystem context...');
    try {
      const prompt = consultPrompt || buildConsultPrompt();
      if (!egressPreview || !egressConfirmed) {
        const preview = await api('/api/browser/consult/preview', {
          method: 'POST',
          body: JSON.stringify({ local_draft: draft, target_agent: targetAgent, prompt, context_paths: contextPaths })
        });
        setEgressPreview(preview);
        setConsultPrompt(preview.prompt);
        setConsultStatus('Final cloud prompt prepared. Review redactions and confirm this exact provider-bound prompt before sending.');
        setNotice('Cloud prompt is ready for review. Nothing was sent.');
        return;
      }
      const result = await api('/api/browser/consult', {
        method: 'POST',
        body: JSON.stringify({
          title,
          local_draft: draft,
          target_agent: targetAgent,
          url: browserUrl,
          prompt,
          context_paths: contextPaths,
          temporary_chat_required: temporaryChatRequired,
          temporary_chat_confirmed: temporaryChatConfirmed,
          egress_confirmation: { promptHash: egressPreview.promptHash, targetAgent: egressPreview.targetAgent }
        })
      });
      setConsultPrompt(result.prompt || '');
      setBrowserResult({
        ...result,
        mode: result.mode || 'automatic',
        blocked: Boolean(result.blocked),
        blockReason: result.blockReason || result.message
      });
      if (result.answer) {
        setExternal(result.answer);
        setConsultStatus('Response captured automatically. Review it below, then choose what to save.');
        setNotice('Cloud consultant response captured automatically. Nothing was saved or synced.');
      } else {
        setConsultStatus(result.message || result.blockReason || 'Automatic consultation could not complete.');
        setNotice(result.message || result.blockReason || 'Automatic consultation could not complete.');
      }
      setAgentTabs(await api('/api/browser/agent-tabs').catch(() => agentTabs));
    } catch (err) {
      setConsultStatus(err.message);
      setNotice(err.message);
    } finally {
      setConsultBusy(false);
    }
  }

  async function copyConsultPrompt(promptOverride = '') {
    const prompt = promptOverride || consultPrompt || buildConsultPrompt();
    if (temporaryChatNeedsConfirmation) {
      await api('/api/browser/copy-prompt', {
        method: 'POST',
        body: JSON.stringify({ prompt: temporaryChatSetupNote() })
      });
      setNotice('Temporary Chat setup note copied. Turn on Temporary Chat in ChatGPT, tick "Temporary Chat is on", then copy the full prompt.');
      return false;
    }
    await api('/api/browser/copy-prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt })
    });
    setNotice('Consultation prompt copied. Paste it into the cloud agent after login.');
    return true;
  }

  function manualPromptText(prompt) {
    return temporaryChatNeedsConfirmation ? temporaryChatSetupNote() : prompt;
  }

  async function openWithPrompt() {
    const prompt = buildConsultPrompt();
    const consultationId = await ensureConsultation(prompt);
    await copyConsultPrompt(prompt);
    await openControlledBrowser(consultationId);
  }

  async function openExternalBrowser(consultationId = activeConsultationId) {
    setExternalBusy(true);
    try {
      const result = await api('/api/browser/open-external', {
        method: 'POST',
        body: JSON.stringify({ url: browserUrl, consultation_id: consultationId })
      });
      setBrowserResult(result);
      setNotice('Opened your external browser outside the Codex app. It may appear behind this window; use this for Google sign-in or human checks that reject controlled browsers.');
      return true;
    } catch (err) {
      setNotice(err.message);
      return false;
    } finally {
      setExternalBusy(false);
    }
  }

  async function openChromeBrowser(consultationId = activeConsultationId) {
    setChromeBusy(true);
    try {
      const result = await api('/api/browser/open-chrome', {
        method: 'POST',
        body: JSON.stringify({ url: browserUrl, consultation_id: consultationId })
      });
      setBrowserResult(result);
      setNotice('Opened your installed Chrome profile. The app did not read or copy Chrome cookies.');
      return true;
    } catch (err) {
      setNotice(err.message);
      return false;
    } finally {
      setChromeBusy(false);
    }
  }

  async function openControlledBrowser(consultationId = activeConsultationId) {
    setBrowserBusy(true);
    try {
      const result = await api('/api/browser/open', {
        method: 'POST',
        body: JSON.stringify({ url: browserUrl, consultation_id: consultationId })
      });
      setBrowserResult(result);
      setNotice(result.blocked
        ? result.blockReason
        : `Opened controlled browser window: ${result.title || result.url}. It may appear outside the Codex in-app browser or behind this window.`);
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBrowserBusy(false);
    }
  }

  async function resetControlledBrowserData() {
    setResetBusy(true);
    try {
      const result = await api('/api/browser/reset-profile', { method: 'POST', body: JSON.stringify({}) });
      setBrowserResult(null);
      setNotice(result.message || 'Controlled browser data reset.');
    } catch (err) {
      setNotice(err.message);
    } finally {
      setResetBusy(false);
    }
  }

  function openWindowTab(mode = 'normal-tab') {
    const url = browserUrl.trim();
    if (!url) {
      setNotice(mode === 'app-tab' ? 'Enter a URL before opening an app tab.' : 'Enter a URL before opening a normal browser tab.');
      return false;
    }
    const opened = window.open(url, '_blank');
    if (!opened) {
      setNotice(`${mode === 'app-tab' ? 'App tab' : 'Normal browser tab'} was blocked. Allow popups or copy the URL manually.`);
      return false;
    }
    try {
      opened.opener = null;
    } catch {
      // Some browser surfaces prevent changing opener; the fallback still opened.
    }
    setBrowserResult({
      url,
      title: mode === 'app-tab' ? 'App tab' : 'Normal browser tab',
      mode,
      blocked: false
    });
    setNotice(`${mode === 'app-tab' ? 'Opened an app tab' : 'Opened a normal browser tab'}. Paste the copied prompt if this is a manual consultation.`);
    return true;
  }

  function openNormalBrowser() {
    return openWindowTab('normal-tab');
  }

  function openAppTab() {
    return openWindowTab('app-tab');
  }

  async function copyAndOpenNormal() {
    const prompt = buildConsultPrompt();
    const consultationId = await ensureConsultation(prompt);
    let copiedPrompt = false;
    try {
      copiedPrompt = await copyConsultPrompt(prompt);
    } catch (err) {
      setNotice(err.message);
      return;
    }
    const opened = openNormalBrowser();
    const copyLabel = copiedPrompt ? 'Copied prompt' : 'Copied Temporary Chat setup note';
    setNotice(opened
      ? `${copyLabel} and opened a normal browser tab. Consultation #${consultationId} is ready for pasted response.`
      : `${copyLabel}. Normal browser tab was blocked; open ${browserUrl.trim()} manually.`);
  }

  async function copyAndOpenAppTab() {
    const prompt = buildConsultPrompt();
    const consultationId = await ensureConsultation(prompt);
    let copiedPrompt = false;
    try {
      copiedPrompt = await copyConsultPrompt(prompt);
    } catch (err) {
      setNotice(err.message);
      return;
    }
    const opened = openAppTab();
    const copyLabel = copiedPrompt ? 'Copied prompt' : 'Copied Temporary Chat setup note';
    setNotice(opened
      ? `${copyLabel} and opened an app tab. Consultation #${consultationId} is ready for pasted response.`
      : `${copyLabel}. App tab was blocked; open ${browserUrl.trim()} manually.`);
  }

  async function copyAndOpenExternal() {
    const prompt = buildConsultPrompt();
    const consultationId = await ensureConsultation(prompt);
    setExternalBusy(true);
    let opened = false;
    let copiedPrompt = !temporaryChatNeedsConfirmation;
    try {
      const result = await api('/api/browser/open-external', {
        method: 'POST',
        body: JSON.stringify({
          url: browserUrl,
          consultation_id: consultationId,
          prompt: manualPromptText(prompt)
        })
      });
      setBrowserResult(result);
      opened = true;
      copiedPrompt = !temporaryChatNeedsConfirmation;
    } catch (err) {
      setNotice(err.message);
      return;
    } finally {
      setExternalBusy(false);
    }
    setNotice(opened
      ? `${copiedPrompt ? 'Copied prompt' : 'Copied Temporary Chat setup note'} and opened your external browser. Consultation #${consultationId} is ready for pasted response.`
      : `${copiedPrompt ? 'Copied prompt' : 'Copied Temporary Chat setup note'}. External browser did not open; open ${browserUrl.trim()} manually.`);
  }

  async function copyAndOpenChrome() {
    const prompt = buildConsultPrompt();
    const consultationId = await ensureConsultation(prompt);
    setChromeBusy(true);
    let opened = false;
    let copiedPrompt = !temporaryChatNeedsConfirmation;
    try {
      const result = await api('/api/browser/open-chrome', {
        method: 'POST',
        body: JSON.stringify({
          url: browserUrl,
          consultation_id: consultationId,
          prompt: manualPromptText(prompt)
        })
      });
      setBrowserResult(result);
      opened = true;
      copiedPrompt = !temporaryChatNeedsConfirmation;
    } catch (err) {
      setNotice(err.message);
      return;
    } finally {
      setChromeBusy(false);
    }
    setNotice(opened
      ? `${copiedPrompt ? 'Copied prompt' : 'Copied Temporary Chat setup note'} and opened Chrome. ${copiedPrompt ? `Consultation #${consultationId} is ready for pasted response.` : 'Turn on Temporary Chat in ChatGPT, tick "Temporary Chat is on", then click Copy.'}`
      : `${copiedPrompt ? 'Copied prompt' : 'Copied Temporary Chat setup note'}. Chrome did not open; use External or open ${browserUrl.trim()} manually.`);
  }

  async function pasteExternalResponse() {
    const text = await navigator.clipboard.readText();
    setExternal(text);
    setNotice(text ? 'AI response pasted into the review box. Save it to create a memory candidate for review.' : 'Clipboard is empty. Copy the AI response in ChatGPT first, then paste it here.');
  }

  return (
    <section className="two-column browser-flow">
      <div className="panel">
        <h2>Browser Agent Question</h2>
        <p>Automatic browser-agent sending uses the Chrome connector in the user's normal Chrome profile.</p>
        <div className="source-warning info">
          Primary flow: select context, type the browser-agent question, use local assist if helpful, then send to the browser agent in the user's Chrome tab. It will not save, sync, or promote anything until you choose a save option.
        </div>
        <div className="connection-grid">
          <div>
            <span>Playwright</span>
            <Pill tone={cap?.playwright ? 'good' : 'warn'}>{cap ? (cap.playwright ? 'Installed' : 'Missing') : 'Checking'}</Pill>
            <small>{cap?.playwright ? 'Available for controlled-browser fallback.' : 'Required only for controlled-browser fallback.'}</small>
          </div>
          <div>
            <span>Chromium</span>
            <Pill tone={cap?.chromium ? 'good' : 'warn'}>{cap ? (cap.chromium ? 'Installed' : 'Missing') : 'Checking'}</Pill>
            <small>{cap?.chromium ? 'Local Playwright browser is present.' : 'Use Tooling only if controlled-browser fallback is needed.'}</small>
          </div>
          <div>
            <span>Chrome connector</span>
            <Pill tone={connectorReady ? 'good' : 'warn'}>{connectorReady ? 'Connected' : 'Disconnected'}</Pill>
            <small>{connectorReady ? 'Normal Chrome can receive browser-agent jobs.' : 'Cloud Consultant send is setup-gated until the extension is loaded.'}</small>
          </div>
        </div>
        {!browserReady && (
          <div className="source-warning warn">
            Browser automation disabled: {browserDisabledReason || cap?.note || 'Browser automation is not ready.'}
          </div>
        )}
        {browserReady && connectorDisabledReason && (
          <div className="source-warning warn">
            Cloud Consultant setup-gated: {connectorDisabledReason} Do not bypass sign-in, verification, or Cloudflare checks; finish those only in your own browser profile.
          </div>
        )}
        {browserReady && controlledBrowserWarning && (
          <div className="source-warning warn">
            Controlled browser blocked for this URL: {controlledBrowserWarning}
          </div>
        )}
        {chatGptTarget && (
          <div className={cx('source-warning', temporaryChatNeedsConfirmation ? 'warn' : 'info')}>
            <label className="temporary-chat-option">
              <input
                type="checkbox"
                checked={temporaryChatRequired}
                onChange={(event) => {
                  setTemporaryChatRequired(event.target.checked);
                  if (!event.target.checked) setTemporaryChatConfirmed(false);
                }}
              />
              Require ChatGPT Temporary Chat before copying the full prompt
            </label>
            {temporaryChatRequired && (
              <label className="temporary-chat-option">
                <input
                  type="checkbox"
                  checked={temporaryChatConfirmed}
                  onChange={(event) => setTemporaryChatConfirmed(event.target.checked)}
                />
                I manually confirm Temporary Chat is on in ChatGPT; Life Planner cannot verify this.
              </label>
            )}
            <small>
              This checkbox is a manual confirmation only — the app has no way to check ChatGPT Temporary Chat mode. Until you tick it, automatic consultation and full prompt copy stay blocked.
            </small>
          </div>
        )}
        <label>Cloud consultant</label>
        <div className="inline-form">
          <select value={targetAgent} onChange={(event) => {
            const nextAgent = event.target.value;
            const nextConfig = CLOUD_AGENTS.find((agent) => agent.name === nextAgent);
            setTargetAgent(nextAgent);
            if (nextConfig?.url) setBrowserUrl(nextConfig.url);
            setTemporaryChatConfirmed(false);
          }}>
            {CLOUD_AGENTS.map((agent) => (
              <option value={agent.name} key={agent.name}>{agent.name}{agentTabs.agents?.[agent.name]?.open ? ' (open tab)' : ''}</option>
            ))}
          </select>
          <button onClick={buildConsultPrompt}><Sparkles size={16} /> Build prompt</button>
          <button onClick={assistConsultPrompt} disabled={Boolean(assistDisabledReason)} title={assistDisabledReason || 'Ask the local model to shape the browser-agent question'}>
            <Bot size={16} /> {assistBusy ? 'Assisting...' : 'Local assist'}
          </button>
          <button
            onClick={() => copyConsultPrompt()}
            disabled={Boolean(copyDisabledReason)}
            title={copyDisabledReason || (temporaryChatNeedsConfirmation ? 'Copy Temporary Chat setup note before copying the full prompt' : 'Copy the generated consultation prompt')}
          >
            <Clipboard size={16} /> {temporaryChatNeedsConfirmation ? 'Copy temp setup' : 'Copy'}
          </button>
        </div>
        <div className="context-chips cloud-context">
          {CLOUD_AGENTS.filter((agent) => agent.name !== 'Other web agent').map((agent) => (
            <span className="pill pill-muted" key={agent.name}>
              {agent.name}: {agentTabs.agents?.[agent.name]?.open ? `${agentTabs.agents[agent.name].count} open` : agentTabs.cdpAvailable ? 'not open' : 'tabs unread'}
            </span>
          ))}
        </div>
        <label>LifePlanSystem context to include</label>
        <div className="inline-form">
          <select value={selectedContextFile} onChange={(event) => setSelectedContextFile(event.target.value)}>
            <option value="">Select repo context file</option>
            {repoFiles.map((file) => <option value={file.path} key={file.path}>{file.path}</option>)}
          </select>
          <button onClick={addContextFile} disabled={!selectedContextFile || contextPaths.includes(selectedContextFile)}><Plus size={16} /> Include</button>
        </div>
        <div className="context-chips cloud-context">
          {contextPaths.length === 0 ? <span>No context selected. Only the typed message will be sent.</span> : contextPaths.map((path) => (
            <button key={path} onClick={() => removeContextFile(path)} title="Remove context file">
              <FileText size={13} />
              <span>{path}</span>
              <X size={13} />
            </button>
          ))}
        </div>
        {egressPreview && (
          <div className={cx('source-warning', egressPreview.blocked || egressPreview.changed ? 'warn' : 'info')}>
            <strong>Final cloud egress preview</strong>
            <small>{egressPreview.note}</small>
            <small>{egressPreview.findings.length ? egressPreview.findings.map((item) => `${item.count} ${item.type}`).join(', ') : 'No automatic sensitive-pattern redactions were required.'}</small>
            <textarea value={egressPreview.prompt} readOnly rows={8} />
            <label className="temporary-chat-option">
              <input type="checkbox" checked={egressConfirmed} onChange={(event) => setEgressConfirmed(event.target.checked)} />
              I reviewed this exact prompt and confirm sending it to {egressPreview.targetAgent}.
            </label>
          </div>
        )}
        <div className="decision-row">
          <button className="primary" onClick={runAutomaticConsultation} disabled={Boolean(automaticDisabledReason)} title={automaticDisabledReason || 'Open ChatGPT, send the browser-agent question, wait for the response, and fill the answer box'}>
            <Sparkles size={16} /> {consultBusy ? 'Working...' : egressPreview && egressConfirmed ? 'Send confirmed prompt' : 'Preview before sending'}
          </button>
          {automaticDisabledReason && <span className="inline-hint">{automaticDisabledReason}</span>}
        </div>
        {consultStatus && (
          <div className={cx('source-warning', external.trim() ? 'info' : browserResult?.blocked ? 'warn' : 'info')}>
            <strong>Automation status</strong>
            <small>{consultStatus}</small>
          </div>
        )}
        <label>Controlled browser URL</label>
        <div className="inline-form">
          <input value={browserUrl} onChange={(event) => {
            setBrowserUrl(event.target.value);
            setTemporaryChatConfirmed(false);
          }} placeholder="https://chatgpt.com/" />
          <button onClick={() => openControlledBrowser()} disabled={Boolean(browserDisabledReason)} title={browserDisabledReason || 'Open the URL in a Playwright-controlled browser'}>
            <Globe2 size={16} /> {browserBusy ? 'Opening...' : 'Open'}
          </button>
          <button className="primary" onClick={openWithPrompt} disabled={Boolean(copyOpenDisabledReason)} title={copyOpenDisabledReason || 'Copy the prompt and open the controlled browser'}>
            <Globe2 size={16} /> Copy + Open
          </button>
          <button onClick={openNormalBrowser} disabled={Boolean(normalBrowserDisabledReason)} title={normalBrowserDisabledReason || 'Open the URL in a normal browser tab'}>
            <Globe2 size={16} /> Normal tab
          </button>
          <button onClick={copyAndOpenNormal} disabled={Boolean(copyNormalDisabledReason)} title={copyNormalDisabledReason || 'Copy the prompt and open a normal browser tab'}>
            <Clipboard size={16} /> Copy + Normal
          </button>
          <button onClick={openAppTab} disabled={Boolean(appTabDisabledReason)} title={appTabDisabledReason || 'Open the URL as a visible app browser tab'}>
            <Globe2 size={16} /> App tab
          </button>
          <button onClick={copyAndOpenAppTab} disabled={Boolean(copyAppTabDisabledReason)} title={copyAppTabDisabledReason || 'Copy the prompt and open a visible app browser tab'}>
            <Clipboard size={16} /> Copy + App tab
          </button>
          <button onClick={() => openExternalBrowser()} disabled={Boolean(externalBrowserDisabledReason)} title={externalBrowserDisabledReason || 'Open the URL in your default external browser'}>
            <Globe2 size={16} /> {externalBusy ? 'Opening...' : 'External'}
          </button>
          <button
            onClick={copyAndOpenExternal}
            disabled={Boolean(copyExternalDisabledReason)}
            title={copyExternalDisabledReason || (temporaryChatNeedsConfirmation ? 'Copy Temporary Chat setup note and open your default external browser' : 'Copy the prompt and open your default external browser')}
          >
            <Clipboard size={16} /> {temporaryChatNeedsConfirmation ? 'Temp + External' : 'Copy + External'}
          </button>
          <button onClick={() => openChromeBrowser()} disabled={Boolean(chromeDisabledReason)} title={chromeDisabledReason || 'Open the URL in your installed Chrome profile'}>
            <Globe2 size={16} /> {chromeBusy ? 'Opening...' : 'Chrome'}
          </button>
          <button
            onClick={copyAndOpenChrome}
            disabled={Boolean(copyChromeDisabledReason)}
            title={copyChromeDisabledReason || (temporaryChatNeedsConfirmation ? 'Copy Temporary Chat setup note and open your installed Chrome profile' : 'Copy the prompt and open your installed Chrome profile')}
          >
            <Clipboard size={16} /> {temporaryChatNeedsConfirmation ? 'Temp + Chrome' : 'Copy + Chrome'}
          </button>
          <button onClick={resetControlledBrowserData} disabled={resetBusy || browserBusy} title="Close the Playwright browser and clear this app's controlled browser profile">
            <RefreshCcw size={16} /> {resetBusy ? 'Resetting...' : 'Reset data'}
          </button>
        </div>
        {(browserDisabledReason || copyOpenDisabledReason) && (
          <p>
            {browserDisabledReason && `Open disabled: ${browserDisabledReason}`}
            {browserDisabledReason && copyOpenDisabledReason && copyOpenDisabledReason !== browserDisabledReason ? ' ' : ''}
            {copyOpenDisabledReason && copyOpenDisabledReason !== browserDisabledReason ? `Copy + Open disabled: ${copyOpenDisabledReason}` : ''}
          </p>
        )}
        {browserResult && (
          <div className="browser-result">
            <Pill tone={browserResult.blocked ? 'warn' : 'good'}>{browserResult.blocked ? 'Blocked' : 'Opened'}</Pill>
            <strong>{browserResult.title || browserResult.url}</strong>
            <span>{browserResult.url}</span>
            {browserResult.excerpt && <small>{browserResult.excerpt}</small>}
            {browserResult.blocked && <small>{browserResult.blockReason}</small>}
            <small>
              {browserResult.mode === 'my Chrome connector'
                ? 'Sent through the Life Planner extension in your normal Chrome. No separate automation window was opened.'
                : browserResult.mode === 'chrome'
                  ? 'Opened in your installed Chrome profile. The app did not read or copy cookies.'
                  : browserResult.mode === 'external'
                    ? 'Opened outside the Codex app in your default browser.'
                    : browserResult.mode === 'app-tab'
                      ? 'Opened as a browser tab from the app. The prompt was copied separately for manual paste.'
                      : browserResult.mode === 'normal-tab'
                        ? 'Opened as a normal browser tab. The prompt was copied separately for manual paste.'
                    : browserResult.mode?.includes?.('app-controlled')
                      ? `${browserResult.mode}. ${browserResult.launchNote || 'Using the app controlled browser profile.'}`
                      : 'Opened in a separate Playwright-controlled browser window.'}
            </small>
          </div>
        )}
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Browser-agent question or draft..." />
        {consultPrompt && <textarea value={consultPrompt} onChange={(event) => setConsultPrompt(event.target.value)} placeholder="Prepared browser-agent prompt..." />}
        <div className={cx('source-warning', external.trim() ? 'info' : 'warn')}>
          <strong>{external.trim() ? 'AI response ready to save' : waitingForExternalResponse ? 'Waiting for AI response' : 'No AI response captured yet'}</strong>
          <small>{external.trim() ? 'Saving will create a reviewable memory candidate; nothing is promoted automatically.' : responseCaptureHint}</small>
        </div>
        <div className="inline-form">
          <button onClick={pasteExternalResponse}><Clipboard size={16} /> Manual paste fallback</button>
          {activeConsultationId && <Pill tone="info">Consultation #{activeConsultationId}</Pill>}
        </div>
        <textarea value={external} onChange={(event) => setExternal(event.target.value)} placeholder="Captured browser-agent response appears here. Manual paste is available if capture is blocked." />
        {external.trim() && (
          <div className="save-choice">
            <strong>What do you want to keep?</strong>
            <small>Nothing has been saved yet. Choose one explicit action after reviewing the answer.</small>
            <div className="decision-row">
              <button className="primary" onClick={saveConsultation} title="Save this response as a reviewable memory candidate"><Globe2 size={16} /> Save response candidate</button>
              <button onClick={() => {
                setExternal('');
                setConsultStatus('Captured response cleared. Nothing was saved.');
              }}><X size={16} /> Save nothing</button>
            </div>
          </div>
        )}
        {!external.trim() && (
          <button className="primary" onClick={saveConsultation} disabled title="Run automatic consultation or use manual fallback before saving"><Globe2 size={16} /> Save response as reviewable suggestion</button>
        )}
      </div>
      <div className="panel">
        <h2>Consultation History</h2>
        {consultations.map((item) => (
          <div className="review-card" key={item.id}>
            <Pill tone={item.status === 'captured' ? 'warn' : 'muted'}>{item.status}</Pill>
            <h3>{item.title}</h3>
            <span>{item.target_agent}</span>
            {item.opened_url && <small>{item.opened_url}</small>}
            <p>{item.local_draft}</p>
            {item.external_response && <small>{item.external_response.slice(0, 300)}</small>}
          </div>
        ))}
      </div>
    </section>
  );
}

function OpenHandsPanel({ setNotice, refreshSignal = 0 }) {
  const [status, setStatus] = useState(null);
  const [model, setModel] = useState(null);
  const [requests, setRequests] = useState([]);
  const [busy, setBusy] = useState('');
  const [report, setReport] = useState(null);
  const [form, setForm] = useState({
    title: '',
    objective: '',
    targetRepoPath: '',
    baseBranch: 'main',
    allowedPaths: '',
    forbiddenPaths: '',
    testCommand: 'npm run build',
    maxFilesChanged: 3,
    requestedBy: 'Alex'
  });
  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function run(label, fn) {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy('');
    }
  }

  const checkOpenHands = () => run('oh-status', async () => setStatus(await api('/api/tooling/openhands/status')));
  const checkModel = () => run('model', async () => setModel(await api('/api/tooling/openhands/model-status')));
  const loadRequests = () => run('requests', async () => setRequests(await api('/api/tooling/openhands/requests')));

  const approveRequest = (id) => run(`approve-${id}`, async () => {
    const result = await api(`/api/tooling/openhands/requests/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({ approvedBy: form.requestedBy || 'user' }) });
    setNotice(result.note);
    setRequests(await api('/api/tooling/openhands/requests'));
  });

  const runRequest = (id) => run(`run-${id}`, async () => {
    const result = await api(`/api/tooling/openhands/requests/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify({ runBy: form.requestedBy || 'user' }) });
    setNotice(result.message);
    setRequests(await api('/api/tooling/openhands/requests'));
  });

  const viewReport = (id) => run(`report-${id}`, async () => {
    setReport(await api(`/api/tooling/openhands/requests/${encodeURIComponent(id)}/report`));
  });

  const confirmExecution = (id) => run(`confirm-${id}`, async () => {
    const result = await api(`/api/tooling/openhands/requests/${encodeURIComponent(id)}/confirm-execution`, { method: 'POST', body: JSON.stringify({ confirmedBy: form.requestedBy || 'user' }) });
    setNotice(result.note);
    setRequests(await api('/api/tooling/openhands/requests'));
  });

  const runExecutionPlan = (id) => run(`plan-${id}`, async () => {
    const result = await api(`/api/tooling/openhands/requests/${encodeURIComponent(id)}/execution-plan`, { method: 'POST', body: JSON.stringify({}) });
    setNotice(result.message);
    setRequests(await api('/api/tooling/openhands/requests'));
  });

  const runExecutor = (id) => run(`exec-${id}`, async () => {
    const result = await api(`/api/tooling/openhands/requests/${encodeURIComponent(id)}/execute`, { method: 'POST', body: JSON.stringify({}) });
    setNotice(result.message);
    setRequests(await api('/api/tooling/openhands/requests'));
  });

  useEffect(() => {
    checkOpenHands();
    loadRequests();
  }, [refreshSignal]);

  async function setOpenHandsEnabled(enabled) {
    await run('configure', async () => {
      const result = await api('/api/tooling/openhands/config', { method: 'POST', body: JSON.stringify({ enabled }) });
      setNotice(result.note);
      setModel(null);
      setStatus(await api('/api/tooling/openhands/status'));
    });
  }

  async function startOpenHands() {
    await run('start', async () => {
      const result = await api('/api/tooling/openhands/start', { method: 'POST', body: JSON.stringify({}) });
      setNotice(result.message);
      setStatus(await api('/api/tooling/openhands/status'));
    });
  }

  async function stopOpenHands() {
    await run('stop', async () => {
      const result = await api('/api/tooling/openhands/stop', { method: 'POST', body: JSON.stringify({}) });
      setNotice(result.message);
      setStatus(await api('/api/tooling/openhands/status'));
    });
  }

  async function openUi() {
    await run('open', async () => {
      await api('/api/browser/open-external', { method: 'POST', body: JSON.stringify({ url: status?.url || 'http://localhost:3000' }) });
      setNotice('Opened the OpenHands UI in your external browser.');
    });
  }

  async function submitRequest() {
    if (!form.title.trim() || !form.objective.trim()) return;
    await run('submit', async () => {
      const result = await api('/api/tooling/openhands/requests', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          maxFilesChanged: Number(form.maxFilesChanged)
        })
      });
      setNotice(`Request stored at ${result.storedAt}. Nothing runs until approved.`);
      setForm((prev) => ({ ...prev, title: '', objective: '' }));
      setRequests(await api('/api/tooling/openhands/requests'));
    });
  }

  const installedTone = status?.installed === 'installed' ? 'good' : status?.installed === 'missing' ? 'bad' : 'warn';

  return (
    <div className="panel wide-panel">
      <div className="panel-heading">
        <div>
          <h2>OpenHands Worker</h2>
          <p>Local coding worker for minor tasks. LPS is the brain and approval gate: requests are stored for review; nothing executes automatically.</p>
        </div>
        <Pill tone={status?.enabled ? 'info' : 'warn'}>{status?.enabled ? 'optional - enabled' : 'optional - inactive'}</Pill>
      </div>

      <div className="connection-grid">
        <div>
          <span>OpenHands</span>
          <Pill tone={installedTone}>{status?.installed || 'unknown'}</Pill>
          <small>{status?.container?.exists ? `${status.container.image}` : 'container not found'}</small>
        </div>
        <div>
          <span>Container</span>
          <Pill tone={status?.container?.running ? 'good' : 'warn'}>{status?.container?.running ? 'running' : status?.container?.exists ? 'stopped' : 'absent'}</Pill>
          <small>{status?.container?.status || 'no status'}</small>
        </div>
        <div>
          <span>UI</span>
          <Pill tone={status?.http?.reachable ? 'good' : 'warn'}>{status?.http?.reachable ? `HTTP ${status.http.code}` : 'unreachable'}</Pill>
          <small>{status?.url || 'http://localhost:3000'}</small>
        </div>
        <div>
          <span>LPS model endpoint</span>
          <Pill tone={(model?.configured || status?.model?.baseUrl) ? 'good' : 'warn'}>{(model?.configured || status?.model?.baseUrl) ? 'configured' : 'not ready'}</Pill>
          <small>{model?.config ? `${model.config.model} via ${model.config.source}` : status?.model?.model || 'Uses LPS local model settings'}</small>
        </div>
      </div>
      {status?.note && <div className="source-warning warn"><small>{status.note}</small></div>}
      {model?.note && <div className="source-warning info"><small>{model.note}</small></div>}

      <div className="decision-row">
        <button onClick={checkOpenHands} disabled={Boolean(busy)}><RefreshCcw size={16} /> {busy === 'oh-status' ? 'Checking...' : 'Check OpenHands'}</button>
        <button onClick={() => setOpenHandsEnabled(!status?.enabled)} disabled={Boolean(busy)}>{status?.enabled ? 'Disable OpenHands' : 'Enable OpenHands'}</button>
        <button onClick={startOpenHands} disabled={Boolean(busy) || !status?.enabled || !status?.container?.exists || status?.container?.running}><Bot size={16} /> {busy === 'start' ? 'Starting...' : 'Start OpenHands'}</button>
        <button onClick={stopOpenHands} disabled={Boolean(busy) || !status?.container?.running}><X size={16} /> {busy === 'stop' ? 'Stopping...' : 'Stop OpenHands'}</button>
        <button onClick={openUi} disabled={Boolean(busy) || !status?.enabled}><Globe2 size={16} /> Open OpenHands UI</button>
        <button onClick={checkModel} disabled={Boolean(busy) || !status?.enabled}><SearchCheck size={16} /> Check worker endpoint</button>
      </div>

      <h3>Request minor work</h3>
      <p>One focused objective, max 5 files. Requests are stored under .lps/tooling/openhands/requests for review — never committed, never auto-run.</p>
      <div className="inline-form">
        <input value={form.title} onChange={set('title')} placeholder="Task title (required)" />
        <input value={form.requestedBy} onChange={set('requestedBy')} placeholder="Requested by" />
      </div>
      <textarea value={form.objective} onChange={set('objective')} placeholder="Objective — one focused change (required)" rows={3} />
      <div className="inline-form">
        <input value={form.targetRepoPath} onChange={set('targetRepoPath')} placeholder="Target repo path (blank = this workspace)" />
        <input value={form.baseBranch} onChange={set('baseBranch')} placeholder="Base branch" />
        <input type="number" min="1" max="5" value={form.maxFilesChanged} onChange={set('maxFilesChanged')} title="Max files changed (1-5)" />
      </div>
      <div className="inline-form">
        <textarea value={form.allowedPaths} onChange={set('allowedPaths')} placeholder="Allowed paths (one per line, optional)" rows={2} />
        <textarea value={form.forbiddenPaths} onChange={set('forbiddenPaths')} placeholder="Extra forbidden paths (one per line)" rows={2} />
      </div>
      <input value={form.testCommand} onChange={set('testCommand')} placeholder="Test command (stored, never auto-run)" />
      <label className="toggle-row" title="Always on in this version">
        <input type="checkbox" checked readOnly disabled />
        Approval required before run, commit, and push (always on)
      </label>
      <div className="decision-row">
        <button className="primary" onClick={submitRequest} disabled={Boolean(busy) || !form.title.trim() || !form.objective.trim()}>
          <Check size={16} /> {busy === 'submit' ? 'Storing...' : 'Store request for review'}
        </button>
        <button onClick={loadRequests} disabled={Boolean(busy)}><RefreshCcw size={16} /> Refresh list</button>
      </div>

      <h3>Approved Request Runner</h3>
      <div className="source-warning info">
        <small>
          <strong>Gated runner, not an autonomous agent.</strong> A request must be explicitly Approved by a human, then Run.
          The runner executes only an allowlisted validation command (<code>node --check server/index.js</code> or <code>npm run build</code>),
          writes a report under <code>.lps/tooling/openhands/reports/</code>, and never edits code, runs arbitrary commands, commits, pushes, merges, resets, deletes, or force-pushes.
        </small>
      </div>

      <h3>Execution Worker (dry-run / plan only)</h3>
      <div className="source-warning warn">
        <small>
          <strong>Gated local coding worker — not an autonomous agent.</strong> This first version is <strong>dry-run / plan only</strong>:
          it does not edit code or invoke OpenHands. It needs a <strong>second explicit confirmation</strong> beyond approval, then produces
          an execution plan (proposed dedicated branch, protected-path scan, max-files budget) and a report. It never runs on main/master,
          never commits/pushes/merges/resets/deletes/force-pushes, and never runs arbitrary commands. <strong>Human review is required before any commit, push, or PR.</strong>
        </small>
      </div>

      <h3>Worktree Executor (high risk — real invocation OFF)</h3>
      <div className="source-warning bad">
        <small>
          <strong>Gated local coding worker — high risk.</strong> The executor runs all work inside an <strong>isolated git worktree</strong> on a
          dedicated <code>openhands/exec-&lt;id&gt;</code> branch — never on main/master and never in your working tree. It requires approval
          <strong>and</strong> the second execution confirmation. <strong>Real OpenHands invocation is currently DISABLED</strong> by a server-side flag, so
          this proves the worktree/gate/report flow without editing any code. It enforces allowed/forbidden/protected paths and max-files against the
          <em>actual</em> diff, runs only allowlisted validation, and writes a report. It never commits, pushes, merges, resets, deletes branches, or
          force-pushes. <strong>A human must review the diff and use the Source Control panel for any commit/push/PR.</strong>
        </small>
      </div>

      <h3>Requests</h3>
      {requests.length === 0 ? (
        <Empty title="No requests yet" body="Stored OpenHands task requests will appear here for review." />
      ) : (
        <div className="table-list">
          {requests.map((request) => (
            <div className="review-card" key={request.id}>
              <div className="review-card-heading">
                <Pill tone={['approved', 'validated', 'execution-planned'].includes(request.status) ? 'good' : request.status === 'validation-failed' ? 'bad' : request.status === 'pending' ? 'warn' : 'muted'}>{request.status}</Pill>
                <Pill tone={request.riskLevel === 'low' ? 'good' : 'warn'}>{request.riskLevel || 'unrated'} risk</Pill>
                {request.executionConfirmed && <Pill tone="info">execution confirmed</Pill>}
              </div>
              <h3>{request.title}</h3>
              <div className="candidate-meta">
                <span>By: {request.requestedBy}</span>
                <span>Created: {request.createdAt ? new Date(request.createdAt).toLocaleString() : 'unknown'}</span>
                <span>Repo: {request.targetRepoPath}</span>
                <span>Max files: {request.maxFilesChanged}</span>
                {request.approvedBy && <span>Approved by: {request.approvedBy}</span>}
                {request.validationCommand && <span>Validated: {request.validationCommand} ({request.validationOk ? 'ok' : 'failed'})</span>}
                {request.executionConfirmedBy && <span>Exec confirmed by: {request.executionConfirmedBy}</span>}
                {request.status === 'execution-planned' && <span>Plan eligible: {request.executionEligible ? 'yes' : 'no (blocked)'}</span>}
                {request.reportPath && <span>Report: {request.reportPath}</span>}
              </div>
              <div className="decision-row">
                {request.status === 'pending' && (
                  <button className="primary" disabled={Boolean(busy)} onClick={() => approveRequest(request.id)}>
                    <Check size={16} /> {busy === `approve-${request.id}` ? 'Approving...' : 'Approve for runner'}
                  </button>
                )}
                <button
                  disabled={Boolean(busy) || request.status !== 'approved'}
                  title={request.status !== 'approved' ? 'A human must approve this request before it can run' : 'Run the allowlisted validation only'}
                  onClick={() => runRequest(request.id)}
                >
                  <Bot size={16} /> {busy === `run-${request.id}` ? 'Running...' : 'Run validation'}
                </button>
                {['approved', 'execution-planned'].includes(request.status) && !request.executionConfirmed && (
                  <button
                    disabled={Boolean(busy)}
                    title="Second explicit human confirmation required before an execution plan can run"
                    onClick={() => confirmExecution(request.id)}
                  >
                    <ShieldCheck size={16} /> {busy === `confirm-${request.id}` ? 'Confirming...' : 'Confirm execution (2nd)'}
                  </button>
                )}
                <button
                  disabled={Boolean(busy) || !request.executionConfirmed || !['approved', 'execution-planned'].includes(request.status)}
                  title={!request.executionConfirmed ? 'Requires a second execution confirmation first' : 'Dry-run: evaluate safety gates and write a plan. No code is edited.'}
                  onClick={() => runExecutionPlan(request.id)}
                >
                  <SearchCheck size={16} /> {busy === `plan-${request.id}` ? 'Planning...' : 'Run execution plan (dry run)'}
                </button>
                <button
                  className="danger"
                  disabled={Boolean(busy) || !request.executionConfirmed || !['approved', 'execution-planned', 'executor-ran'].includes(request.status)}
                  title={!request.executionConfirmed ? 'Requires a second execution confirmation first' : 'Runs the harness in an isolated worktree. Real OpenHands invocation is OFF; no code is edited.'}
                  onClick={() => runExecutor(request.id)}
                >
                  <Bot size={16} /> {busy === `exec-${request.id}` ? 'Running harness...' : 'Run worktree executor (invocation OFF)'}
                </button>
                {request.reportPath && (
                  <button disabled={Boolean(busy)} onClick={() => viewReport(request.id)}>
                    <FileText size={16} /> View report
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {report && (
        <div className="panel">
          <div className="panel-heading">
            <h3>Runner report: {report.reportPath}</h3>
            <button onClick={() => setReport(null)}><X size={14} /> Close</button>
          </div>
          <pre className="code-block diff-detail">{report.content}</pre>
        </div>
      )}
    </div>
  );
}

function Tooling({ setNotice, refreshSignal = 0 }) {
  const [status, setStatus] = useState(null);
  const [connector, setConnector] = useState(null);
  const [busy, setBusy] = useState('');

  async function refresh(announce = false) {
    try {
      const [nextStatus, nextConnector] = await Promise.all([
        api('/api/tooling/status'),
        api('/api/browser/extension/install-info')
      ]);
      setStatus(nextStatus);
      setConnector(nextConnector);
      if (announce) setNotice('Tooling status refreshed.');
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function install(tool) {
    setBusy(tool);
    try {
      const result = await api('/api/tooling/install', { method: 'POST', body: JSON.stringify({ tool }) });
      setNotice(`${result.tool} install finished.`);
      await refresh();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy('');
    }
  }

  async function openExternal(url, label) {
    setBusy(label);
    try {
      await api('/api/browser/open-external', { method: 'POST', body: JSON.stringify({ url }) });
      setNotice(`Opened ${label} in your external browser.`);
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy('');
    }
  }

  async function installBrowserAgent() {
    setBusy('browserAgent');
    try {
      const result = await api('/api/browser/extension/install-helper', { method: 'POST', body: JSON.stringify({}) });
      setNotice(result.message);
      await refresh();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy('');
    }
  }

  useEffect(() => { refresh(); }, [refreshSignal]);

  const rows = [
    {
      id: 'playwright',
      name: 'Playwright package',
      state: status?.playwright?.available,
      detail: status?.playwright?.available ? 'Installed in local node_modules.' : 'Needed for external browser and tab control.',
      action: () => install('playwright')
    },
    {
      id: 'playwrightChromium',
      name: 'Playwright Chromium',
      state: status?.playwright?.chromiumCheck,
      detail: status?.playwright?.chromiumCheck ? 'Installed in the local Playwright browser cache.' : 'Downloads the browser runtime Playwright controls.',
      action: () => install('playwrightChromium'),
      disabled: !status?.playwright?.available
    }
  ];

  const connectorLabel = connector?.connected
    ? 'Connected'
    : connector?.requiresEnable
      ? 'Disabled'
      : connector?.requiresReload
        ? 'Reload required'
        : connector?.waitingForHeartbeat
          ? 'Waiting for heartbeat'
          : connector?.installedInChrome
            ? 'Registered'
            : 'Not installed';
  const connectorDetail = connector?.connected
    ? 'Connected to this LPS session from the detected Chrome profile.'
    : connector?.recommendedAction || 'Load the unpacked extension in the Chrome profile that runs LPS.';

  return (
    <section className="tooling-grid">
      <div className="panel source-hero">
        <div>
          <h2>Local Tooling</h2>
          <p>Bootstrap Playwright for external browser and tab control. Installs use this app folder, not global project state unless the tool requires it.</p>
        </div>
        <button onClick={() => refresh(true)}><RefreshCcw size={16} /> Refresh</button>
      </div>

      <div className="panel">
        <h2>Runtime</h2>
        <div className="connection-grid">
          <div><span>Node</span><strong>{status?.node?.version || 'Checking...'}</strong></div>
          <div><span>npm</span><strong>{status?.npm?.version || 'Checking...'}</strong></div>
          <div><span>GitHub CLI</span><Pill tone={status?.githubCli?.authenticated ? 'good' : 'warn'}>{status?.githubCli?.available ? status?.githubCli?.authenticated ? 'Logged in' : 'Available' : 'Missing'}</Pill><small>{status?.installHints?.githubCli}</small></div>
          <div><span>HF CLI</span><Pill tone={status?.huggingFaceCli?.authenticated ? 'good' : 'warn'}>{status?.huggingFaceCli?.available ? status?.huggingFaceCli?.authenticated ? 'Logged in' : 'Available' : 'Missing'}</Pill><small>{status?.installHints?.huggingFaceCli}</small></div>
        </div>
        {status && !status.winget?.available && (
          <div className="source-warning warn">winget is not on PATH, so this app cannot run the GitHub CLI winget install command for you.</div>
        )}
        {status && (!status.githubCli?.available || !status.huggingFaceCli?.available) && (
          <div className="decision-row">
            {!status.githubCli?.available && (
              <button onClick={() => openExternal(status.installUrls?.githubCli || 'https://cli.github.com/', 'GitHub CLI download')} disabled={Boolean(busy)}>
                <Github size={16} /> Open GitHub CLI download
              </button>
            )}
            {!status.huggingFaceCli?.available && (
              <button onClick={() => openExternal(status.installUrls?.huggingFaceCli || 'https://huggingface.co/docs/huggingface_hub/guides/cli', 'Hugging Face CLI docs')} disabled={Boolean(busy)}>
                <Globe2 size={16} /> Open HF CLI docs
              </button>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Browser Automation</h2>
        <p>Browser-agent sending uses the Chrome connector in the user's normal Chrome. Playwright remains available for fallback tooling.</p>
        <div className="tool-row">
          <div>
            <strong>Chrome connector</strong>
            <span>{connectorDetail}</span>
            <small>{connector?.extensionPath || 'browser-extension/lps-browser-agent'}</small>
            {connector?.detectedProfilePath && <small>Detected profile: {connector.detectedProfilePath}</small>}
            {connector?.installedPath && connector.installedPath !== connector.extensionPath && <small>Chrome loaded: {connector.installedPath}</small>}
          </div>
          <div className="tool-actions">
            <Pill tone={connector?.connected ? 'good' : 'warn'}>{connectorLabel}</Pill>
            <button disabled={Boolean(busy)} onClick={installBrowserAgent}>
              {busy === 'browserAgent' ? 'Opening...' : connector?.installedInChrome ? 'Repair connector' : 'Install connector'}
            </button>
          </div>
        </div>
        {connector?.manualChromeStepRequired && (
          <div className="source-warning warn">{connector.manualChromeBoundary}</div>
        )}
        <div className="tool-list">
          {rows.map((row) => (
            <div className="tool-row" key={row.id}>
              <div>
                <strong>{row.name}</strong>
                <span>{row.detail}</span>
              </div>
              <div className="tool-actions">
                <Pill tone={row.state ? 'good' : 'warn'}>{row.state ? 'Ready' : 'Missing'}</Pill>
                <button disabled={busy || row.disabled || row.state} onClick={row.action}>
                  {busy === row.id ? 'Installing...' : 'Install'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <OpenHandsPanel setNotice={setNotice} refreshSignal={refreshSignal} />

      <div className="panel wide-panel">
        <h2>Notes</h2>
        <pre className="code-block">
{`What the app can install locally:
- npm install playwright
- npx playwright install chromium

Browser agent connector:
- Tooling > Install connector opens chrome://extensions and copies the unpacked extension folder.
- Extension folder: ${connector?.extensionPath || 'browser-extension/lps-browser-agent'}
- It talks to 127.0.0.1:4177 only; no public firewall rule is needed for local use.

What needs an OS/user install:
- GitHub CLI: ${status?.installHints?.githubCli || 'winget install --id GitHub.cli'}
- Hugging Face CLI: ${status?.installHints?.huggingFaceCli || 'pip install -U huggingface_hub[cli]'}

After installing CLI tools, use the Source tab login buttons and refresh status.`}
        </pre>
      </div>
    </section>
  );
}

const ROADMAP_COLUMNS = [
  { status: 'planned', label: 'Planned', hint: 'Not started yet' },
  { status: 'active', label: 'In Progress', hint: 'Being built now — keep this short' },
  { status: 'paused', label: 'Paused', hint: 'Stopped mid-build; resume notes kept' },
  { status: 'parked', label: 'Parked', hint: 'Intentionally shelved; roadmapped, resumable' },
  { status: 'done', label: 'Done', hint: 'Shipped' }
];
const ROADMAP_CATEGORY_TONES = { feature: 'good', fix: 'warn', infra: 'default', chore: 'default', idea: 'warn' };
const ROADMAP_BLANK = { title: '', detail: '', resume_notes: '', category: 'feature', status: 'planned' };

function DevRoadmap({ setNotice, refreshSignal = 0 }) {
  const [items, setItems] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(ROADMAP_BLANK);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(ROADMAP_BLANK);

  async function load(announce = false) {
    try {
      setItems(await api('/api/roadmap'));
      setCandidates(await api('/api/roadmap/candidates').catch(() => []));
      if (announce) setNotice('Dev roadmap refreshed.');
    } catch (err) {
      setNotice(err.message);
    }
  }

  const scanNow = () => act(async () => {
    const result = await api('/api/roadmap/scan', { method: 'POST' });
    setCandidates(result.candidates || []);
  }, 'Scanned chat history and files for dev tasks.');

  const acceptCandidate = (candidate) => act(
    () => api(`/api/roadmap/candidates/${candidate.id}/accept`, { method: 'POST' }),
    `Added "${candidate.title}" to Planned.`
  );

  const dismissCandidate = (candidate) => act(
    () => api(`/api/roadmap/candidates/${candidate.id}/dismiss`, { method: 'POST' })
  );

  useEffect(() => { load(); }, [refreshSignal]);

  async function act(fn, success) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await load();
      if (success) setNotice(success);
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  }

  const addItem = () => {
    if (!draft.title.trim()) return;
    act(async () => {
      await api('/api/roadmap', { method: 'POST', body: JSON.stringify(draft) });
      setDraft(ROADMAP_BLANK);
    }, 'Added roadmap item.');
  };

  const setStatus = (item, status) => act(
    () => api(`/api/roadmap/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    `"${item.title}" → ${status}.`
  );

  const move = (item, direction) => act(
    () => api(`/api/roadmap/${item.id}/move`, { method: 'POST', body: JSON.stringify({ direction }) })
  );

  const remove = (item) => act(
    () => api(`/api/roadmap/${item.id}`, { method: 'DELETE' }),
    `Deleted "${item.title}".`
  );

  const startEdit = (item) => {
    setEditingId(item.id);
    setEditDraft({ title: item.title, detail: item.detail || '', resume_notes: item.resume_notes || '', category: item.category, status: item.status });
  };

  const saveEdit = (item) => act(async () => {
    await api(`/api/roadmap/${item.id}`, { method: 'PATCH', body: JSON.stringify(editDraft) });
    setEditingId(null);
  }, 'Roadmap item updated.');

  const counts = ROADMAP_COLUMNS.reduce((acc, col) => {
    acc[col.status] = items.filter((item) => item.status === col.status).length;
    return acc;
  }, {});

  return (
    <section className="roadmap-panel">
      <div className="source-warning info">
        <strong>Development roadmap — build work only</strong>
                <small>Features not built or partly built, dev todos, and parked work. This is separate from your life-assistant Workboard, Projects, and Memory. Nothing here is a life goal.</small>
      </div>

      <div className="panel roadmap-add">
        <div className="panel-heading">
          <h2>Add build item</h2>
          <button onClick={() => load(true)} disabled={busy}><RefreshCcw size={15} /> Refresh</button>
        </div>
        <div className="inline-form">
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Feature or todo (e.g. Model manager list)" disabled={busy} />
          <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} disabled={busy}>
            <option value="feature">feature</option>
            <option value="fix">fix</option>
            <option value="infra">infra</option>
            <option value="chore">chore</option>
            <option value="idea">idea</option>
          </select>
          <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })} disabled={busy}>
            {ROADMAP_COLUMNS.map((col) => <option value={col.status} key={col.status}>{col.label}</option>)}
          </select>
          <button className="primary" onClick={addItem} disabled={busy || !draft.title.trim()}><Plus size={16} /> Add</button>
        </div>
        <textarea value={draft.detail} onChange={(event) => setDraft({ ...draft, detail: event.target.value })} placeholder="What it is / what's left to do (optional)" disabled={busy} />
      </div>

      <div className="panel roadmap-suggested">
        <div className="panel-heading">
          <h2>Suggested from history &amp; files {candidates.length ? `(${candidates.length})` : ''}</h2>
          <button onClick={scanNow} disabled={busy} title="Scan chat history and repo files for dev tasks"><SearchCheck size={15} /> Scan now</button>
        </div>
        <small>Auto-detected dev tasks from chat and code (TODO/FIXME, unchecked checklist items, build language). Accept to add to Planned, or dismiss.</small>
        {candidates.length === 0 ? (
          <div className="roadmap-empty">Nothing pending. Scan finds new dev-only tasks; life-assistant content is never included.</div>
        ) : (
          <div className="roadmap-suggested-list">
            {candidates.map((candidate) => (
              <div className="roadmap-suggested-row" key={candidate.id}>
                <div className="roadmap-suggested-main">
                  <Pill tone={ROADMAP_CATEGORY_TONES[candidate.category] || 'default'}>{candidate.category}</Pill>
                  <span className="roadmap-suggested-title">{candidate.title}</span>
                  <span className="roadmap-suggested-src">{candidate.source_kind}{candidate.source_ref ? ` · ${candidate.source_ref}` : ''}</span>
                </div>
                <div className="mini-actions">
                  <button onClick={() => acceptCandidate(candidate)} disabled={busy}><Plus size={14} /> Accept</button>
                  <button onClick={() => dismissCandidate(candidate)} disabled={busy}><X size={14} /> Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="roadmap-board">
        {ROADMAP_COLUMNS.map((col) => (
          <div className={cx('roadmap-column', `rm-${col.status}`)} key={col.status}>
            <div className="roadmap-col-head">
              <strong>{col.label}</strong>
              <span className="sc-badge">{counts[col.status]}</span>
            </div>
            <small className="roadmap-col-hint">{col.hint}</small>
            <div className="roadmap-cards">
              {items.filter((item) => item.status === col.status).length === 0 ? (
                <div className="roadmap-empty">—</div>
              ) : items.filter((item) => item.status === col.status).map((item) => (
                <div className="roadmap-card" key={item.id}>
                  {editingId === item.id ? (
                    <div className="roadmap-edit">
                      <input value={editDraft.title} onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })} disabled={busy} />
                      <textarea value={editDraft.detail} onChange={(event) => setEditDraft({ ...editDraft, detail: event.target.value })} placeholder="Detail" disabled={busy} />
                      <textarea value={editDraft.resume_notes} onChange={(event) => setEditDraft({ ...editDraft, resume_notes: event.target.value })} placeholder="Resume notes (how to pick this back up)" disabled={busy} />
                      <div className="roadmap-card-actions">
                        <select value={editDraft.category} onChange={(event) => setEditDraft({ ...editDraft, category: event.target.value })} disabled={busy}>
                          <option value="feature">feature</option>
                          <option value="fix">fix</option>
                          <option value="infra">infra</option>
                          <option value="chore">chore</option>
                          <option value="idea">idea</option>
                        </select>
                        <button className="primary" onClick={() => saveEdit(item)} disabled={busy}><Check size={14} /> Save</button>
                        <button onClick={() => setEditingId(null)} disabled={busy}><X size={14} /> Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="roadmap-card-top">
                        <strong>{item.title}</strong>
                        <Pill tone={ROADMAP_CATEGORY_TONES[item.category] || 'default'}>{item.category}</Pill>
                      </div>
                      {item.detail && <p className="roadmap-detail">{item.detail}</p>}
                      {item.resume_notes && (item.status === 'parked' || item.status === 'paused') && (
                        <div className="roadmap-resume"><strong>Resume:</strong> {item.resume_notes}</div>
                      )}
                      <div className="roadmap-card-actions">
                        {item.status !== 'active' && <button onClick={() => setStatus(item, 'active')} disabled={busy} title="Start / resume"><Play size={13} /></button>}
                        {item.status !== 'paused' && item.status !== 'done' && <button onClick={() => setStatus(item, 'paused')} disabled={busy} title="Pause"><Pause size={13} /></button>}
                        {item.status !== 'parked' && item.status !== 'done' && <button onClick={() => setStatus(item, 'parked')} disabled={busy} title="Park (shelve, resumable)"><Archive size={13} /></button>}
                        {item.status !== 'done' && <button onClick={() => setStatus(item, 'done')} disabled={busy} title="Mark done"><Check size={13} /></button>}
                        <button onClick={() => move(item, 'up')} disabled={busy} title="Move up">↑</button>
                        <button onClick={() => move(item, 'down')} disabled={busy} title="Move down">↓</button>
                        <button onClick={() => startEdit(item)} disabled={busy} title="Edit">Aa</button>
                        <button className="danger" onClick={() => remove(item)} disabled={busy} title="Delete"><Trash2 size={13} /></button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RepositoryExplorer({ setNotice, refreshSignal = 0 }) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState('');
  const [summary, setSummary] = useState('');
  const [newPath, setNewPath] = useState('');
  const [renamePath, setRenamePath] = useState('');

  async function loadFiles(nextQuery = query, announce = false) {
    try {
      const nextFiles = await api(`/api/repo/files?q=${encodeURIComponent(nextQuery)}`);
      setFiles(nextFiles);
      if (announce) setNotice(`Repository file list refreshed: ${nextFiles.length} file(s).`);
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function openFile(filePath) {
    try {
      const file = await api(`/api/repo/file?path=${encodeURIComponent(filePath)}`);
      setSelected(file);
      setDraft(file.content);
      setSummary(`Update ${file.path}`);
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function stageRepoProposal(operation = 'update', overrides = {}) {
    const targetFile = overrides.targetFile || selected?.path;
    if (!targetFile) return;
    try {
      await api('/api/repo/proposals', {
        method: 'POST',
        body: JSON.stringify({
          operation,
          targetFile,
          fromFile: overrides.fromFile,
          content: operation === 'delete' || operation === 'rename' ? '' : draft,
          previousContent: selected?.content,
          summary: overrides.summary || summary,
          risk: operation === 'update' && !(targetFile.includes('source_of_truth') || targetFile.includes('rules/')) ? 'medium' : 'high',
          source: 'Repository Explorer'
        })
      });
      if (operation === 'create') setNewPath('');
      if (operation === 'rename') setRenamePath('');
      setNotice(`Repository ${operation} proposal staged for approval.`);
    } catch (err) {
      setNotice(err.message);
    }
  }

  useEffect(() => { loadFiles(); }, [refreshSignal]);

  return (
    <section className="repo-layout">
      <div className="panel repo-list">
        <div className="inline-form">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search repo files" />
          <button onClick={() => loadFiles(query, true)} title="Refresh repository file list"><RefreshCcw size={16} /></button>
        </div>
        <label>New file proposal</label>
        <div className="inline-form">
          <input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="docs/new-note.md" />
          <button onClick={() => stageRepoProposal('create', { targetFile: newPath, summary: `Create ${newPath}` })} disabled={!newPath.trim()}><Plus size={16} /> Create</button>
        </div>
        <div className="file-list">
          {files.map((file) => (
            <button key={file.path} className={cx('file-row', selected?.path === file.path && 'selected')} onClick={() => openFile(file.path)}>
              <FileText size={15} />
              <span>{file.path}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="panel repo-preview">
        {selected ? (
          <>
            <div className="panel-heading">
              <div>
                <h2>{selected.path}</h2>
                <p>Read locally. Writes become approval proposals before touching files.</p>
              </div>
              <Pill tone={selected.path.includes('source_of_truth') ? 'bad' : 'info'}>{selected.path.includes('source_of_truth') ? 'canonical' : 'repo file'}</Pill>
            </div>
            <label>Proposal summary</label>
            <input value={summary} onChange={(event) => setSummary(event.target.value)} />
            <label>Rename target</label>
            <div className="inline-form">
              <input value={renamePath} onChange={(event) => setRenamePath(event.target.value)} placeholder={selected.path} />
              <button onClick={() => stageRepoProposal('rename', { targetFile: renamePath, fromFile: selected.path, summary: `Rename ${selected.path} to ${renamePath}` })} disabled={!renamePath.trim()}><ShieldCheck size={16} /> Rename</button>
            </div>
            <label>File content</label>
            <textarea className="repo-editor" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <div className="decision-row">
              <button className="primary" onClick={() => stageRepoProposal('update')}><ShieldCheck size={16} /> Stage update</button>
              <button onClick={() => setDraft(selected.content)}><RefreshCcw size={16} /> Reset draft</button>
              <button className="danger" onClick={() => stageRepoProposal('delete', { targetFile: selected.path, summary: `Delete ${selected.path}` })}><Trash2 size={16} /> Delete proposal</button>
            </div>
          </>
        ) : (
          <Empty title="Select a file" body="Markdown, JSON, YAML, and text files are available for local preview." />
        )}
      </div>
    </section>
  );
}

function Calibration({ setNotice, refreshSignal = 0 }) {
  const [docs, setDocs] = useState([]);
  const calibrationFiles = [
    'LifePlanSystem_Sanitised_UI_Scaffold_2026-06-29/source_of_truth/open_questions.md',
    'LifePlanSystem_Sanitised_UI_Scaffold_2026-06-29/source_of_truth/predictions.md',
    'LifePlanSystem_Sanitised_UI_Scaffold_2026-06-29/docs/architecture/MUTUAL_CALIBRATION_LAYER.md'
  ];

  useEffect(() => {
    Promise.all(calibrationFiles.map((file) => api(`/api/repo/file?path=${encodeURIComponent(file)}`).catch((err) => ({ path: file, content: `Unavailable: ${err.message}` }))))
      .then(setDocs)
      .catch((err) => setNotice(err.message));
  }, [refreshSignal]);

  return (
    <section className="calibration-grid">
      <div className="panel">
        <h2>Reasoning / Calibration</h2>
        <p>Repo-backed calibration context. This area should track hypotheses, confidence, known blindspots, and user corrections.</p>
        <div className="connection-grid">
          <div><span>Confidence source</span><strong>Repo records</strong><small>No fake model telemetry.</small></div>
          <div><span>Write mode</span><strong>Staged proposal</strong><small>Approval required before file writes.</small></div>
          <div><span>Blindspots</span><strong>Explicit only</strong><small>Shown from repo/source docs.</small></div>
          <div><span>Corrections</span><strong>Preserved</strong><small>Future records should supersede, not erase.</small></div>
        </div>
      </div>
      {docs.map((doc) => (
        <div className="panel" key={doc.path}>
          <h2>{doc.path.split('/').pop()}</h2>
          <pre className="code-block diff-detail">{doc.content}</pre>
        </div>
      ))}
    </section>
  );
}

// LPS-native line diff. LCS alignment for normal files; a positional fallback
// above a line cap keeps very large files responsive (avoids O(n*m) work).
function computeLineDiff(oldText, newText) {
  // Normalize line endings so CRLF-vs-LF (e.g. git's LF blob vs a CRLF working
  // file on Windows) does not render every line as a change.
  const normalize = (text) => (text ? text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n') : []);
  const a = normalize(oldText);
  const b = normalize(newText);
  const rows = [];
  const CAP = 1500;
  if (a.length > CAP || b.length > CAP) {
    const max = Math.max(a.length, b.length);
    for (let k = 0; k < max; k++) {
      const left = k < a.length ? a[k] : null;
      const right = k < b.length ? b[k] : null;
      rows.push({ type: left === right ? 'context' : 'change', left, right, ln: left === null ? null : k + 1, rn: right === null ? null : k + 1 });
    }
    return { rows, approximate: true };
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ type: 'context', left: a[i], right: b[j], ln: i + 1, rn: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: 'del', left: a[i], right: null, ln: i + 1, rn: null }); i++; }
    else { rows.push({ type: 'add', left: null, right: b[j], ln: null, rn: j + 1 }); j++; }
  }
  while (i < n) { rows.push({ type: 'del', left: a[i], right: null, ln: i + 1, rn: null }); i++; }
  while (j < m) { rows.push({ type: 'add', left: null, right: b[j], ln: null, rn: j + 1 }); j++; }
  return { rows, approximate: false };
}

function SideBySideDiff({ data }) {
  const { rows, approximate } = useMemo(
    () => computeLineDiff(data.oldContent || '', data.newContent || ''),
    [data.oldContent, data.newContent]
  );
  if (data.binary || data.tooLarge) return <div className="sbs-note">{data.note}</div>;
  const changed = rows.some((row) => row.type !== 'context');
  return (
    <div className="sbs-diff">
      <div className="sbs-head">
        <span>{data.path}</span>
        <span>{data.changeType}{approximate ? ' · approx (large file)' : ''}</span>
      </div>
      {!changed && <div className="sbs-note">No differences versus the last commit.</div>}
      <div className="sbs-grid">
        {rows.map((row, idx) => {
          const leftDel = row.type === 'del' || row.type === 'change';
          const rightAdd = row.type === 'add' || row.type === 'change';
          return (
            <React.Fragment key={idx}>
              <div className="sbs-lnum">{row.ln ?? ''}</div>
              <div className={cx('sbs-cell', leftDel && 'sbs-del')}>{row.left ?? ' '}</div>
              <div className="sbs-lnum">{row.rn ?? ''}</div>
              <div className={cx('sbs-cell', rightAdd && 'sbs-add')}>{row.right ?? ' '}</div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

const CODING_STATUS_LABELS = {
  pending: 'Pending', prepared: 'Preparing complete', 'needs-scope': 'Needs Scope',
  'awaiting-advice': 'Awaiting Browser Advice', running: 'Local Run', review: 'Review Ready',
  applied: 'Applied', failed: 'Failed', interrupted: 'Interrupted',
  'apply-interrupted': 'Apply Interrupted', cancelled: 'Cancelled', rejected: 'Rejected',
  evidence_only: 'Evidence Only — No Change'
};

function codingTone(status) {
  if (status === 'applied') return 'good';
  if (['review', 'awaiting-advice', 'prepared', 'evidence_only'].includes(status)) return 'warn';
  if (['failed', 'cancelled', 'interrupted', 'apply-interrupted', 'needs-scope'].includes(status)) return 'bad';
  return 'default';
}

function HighlightedCode({ content = '', mode = 'source' }) {
  const lines = String(content || '').split('\n');
  return <div className="coding-code" role="region" aria-label={mode === 'diff' ? 'Reviewed patch' : 'Scoped source excerpt'} tabIndex={0}>
    {lines.map((line, index) => {
      const kind = mode === 'diff' ? (line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : line.startsWith('diff ') ? 'head' : '') : '';
      const parts = mode === 'source'
        ? line.split(/(\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:const|let|var|function|class|return|if|else|for|while|import|export|from|async|await|new|throw|try|catch)\b)/g)
        : [line];
      return <div className={cx('coding-line', kind && `coding-line-${kind}`)} key={`${index}-${line.slice(0, 24)}`}>
        <span className="coding-lnum">{index + 1}</span>
        <code>{parts.map((part, partIndex) => {
          const token = /^\/\//.test(part) ? 'comment' : /^(?:"|'|`)/.test(part) ? 'string' : /^(?:const|let|var|function|class|return|if|else|for|while|import|export|from|async|await|new|throw|try|catch)$/.test(part) ? 'keyword' : '';
          return token ? <span className={`coding-token-${token}`} key={partIndex}>{part}</span> : part;
        })}</code>
      </div>;
    })}
  </div>;
}

function SourceControl({ setNotice, refreshSignal = 0, initialTab = 'changes', availableTabs = null }) {
  const [source, setSource] = useState(null);
  const [diff, setDiff] = useState(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('codex/life-planner-ui');
  const [branches, setBranches] = useState({ current: '', branches: [] });
  const [branchToSwitch, setBranchToSwitch] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [hfRepo, setHfRepo] = useState('');
  const [hfRepoType, setHfRepoType] = useState('model');
  const [sourceBusy, setSourceBusy] = useState(false);
  const [operationOutput, setOperationOutput] = useState('');
  const [diffPath, setDiffPath] = useState('');
  const [fileDiff, setFileDiff] = useState(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [pushArmed, setPushArmed] = useState(false);
  const [tab, setTab] = useState(initialTab);
  const [history, setHistory] = useState([]);
  const [mergeBranch, setMergeBranch] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [stashes, setStashes] = useState([]);
  const [stashMessage, setStashMessage] = useState('');
  const [discardArmed, setDiscardArmed] = useState(false);
  const [tags, setTags] = useState([]);
  const [tagDraft, setTagDraft] = useState({ name: '', message: '' });
  const [installerBuild, setInstallerBuild] = useState(null);
  const [installerBusy, setInstallerBusy] = useState(false);
  const [sourceConfirmation, setSourceConfirmation] = useState(null);
  const [publicationCheck, setPublicationCheck] = useState(null);
  const [publicationCheckBusy, setPublicationCheckBusy] = useState(false);
  const [coding, setCoding] = useState({ tasks: [], validations: {}, model: {}, activeTaskIds: [] });
  const [codingDraft, setCodingDraft] = useState({ title: '', objective: '', allowedPaths: 'src', maxFilesChanged: 3, validation: 'frontend' });
  const [selectedCodingTaskId, setSelectedCodingTaskId] = useState('');
  const [codingAdviceDraft, setCodingAdviceDraft] = useState({ provider: 'ChatGPT', question: '', temporaryChatConfirmed: false });
  const [codingConfirmation, setCodingConfirmation] = useState(null);

  useEffect(() => { setTab(initialTab); }, [initialTab]);

  async function refreshInstallerBuild(announce = false) {
    try {
      const data = await api('/api/source/build-installer');
      setInstallerBuild(data);
      if (announce) setNotice('Installer build status refreshed.');
    } catch (err) {
      if (announce) setNotice(err.message);
    }
  }

  async function refreshCoding() {
    const next = await api('/api/source/coding/status');
    setCoding(next);
    setSelectedCodingTaskId((current) => current && next.tasks.some((task) => task.id === current) ? current : next.tasks[0]?.id || '');
    return next;
  }

  async function runPublicationCheck() {
    if (publicationCheckBusy) return;
    setPublicationCheckBusy(true);
    try {
      const result = await api('/api/source/publication-check');
      setPublicationCheck(result);
      setNotice(result.allowed ? 'Publication preflight passed.' : result.reason);
    } catch (err) {
      setPublicationCheck({ allowed: false, reason: err.message });
      setNotice(err.message);
    } finally {
      setPublicationCheckBusy(false);
    }
  }

  async function refresh(announce = false) {
    try {
      const sourceData = await api('/api/source/status');
      setSource(sourceData);
      setDiff(await api('/api/source/diff'));
      const branchData = await api('/api/source/branches');
      setBranches(branchData);
      setBranchToSwitch((current) => current || branchData.current || '');
      const originRemote = sourceData.remoteList?.find((remote) => remote.name === 'origin') || sourceData.remoteList?.[0];
      if (originRemote?.url) setRemoteUrl(originRemote.url);
      const originRepo = githubRepoFromRemote(originRemote?.url || '');
      if (originRepo) setGithubRepo((current) => current || originRepo);
      try { setHistory((await api('/api/source/history')).commits || []); } catch { /* history is best-effort */ }
      try { setStashes((await api('/api/source/stash')).entries || []); } catch { /* stash list is best-effort */ }
      try { setTags((await api('/api/source/tags')).tags || []); } catch { /* tags are best-effort */ }
      try { setInstallerBuild(await api('/api/source/build-installer')); } catch { /* installer status is best-effort */ }
      try { await refreshCoding(); } catch { /* coding worker status is best-effort */ }
      if (announce) setNotice('Source status refreshed.');
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function openFileDiff(path) {
    setDiffPath(path);
    setDiffBusy(true);
    try {
      setFileDiff(await api(`/api/source/file-diff?path=${encodeURIComponent(path)}`));
    } catch (err) {
      setFileDiff(null);
      setNotice(err.message);
    } finally {
      setDiffBusy(false);
    }
  }

  useEffect(() => { refresh(); }, [refreshSignal]);
  useEffect(() => {
    if (!(coding.tasks || []).some((task) => ['running', 'awaiting-advice', 'applying'].includes(task.status))) return undefined;
    const timer = setInterval(() => { refreshCoding().catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, [coding.tasks]);
  useEffect(() => {
    if (!installerBuild?.running) return undefined;
    const timer = setInterval(() => { refreshInstallerBuild(false); }, 2500);
    return () => clearInterval(timer);
  }, [installerBuild?.running]);

  async function action(path, body, success) {
    if (sourceBusy) return;
    setSourceBusy(true);
    try {
      const result = await api(path, { method: 'POST', body: JSON.stringify(body || {}) });
      const output = result.output || result.status || result.log || result.message || '';
      setOperationOutput(output);
      setNotice(success || result.message || result.output || 'Source control action complete.');
      await refresh();
      if (diffPath) await openFileDiff(diffPath);
    } catch (err) {
      setNotice(err.message);
      setOperationOutput(err.message);
      try { await refresh(); } catch { /* preserve the original action error */ }
    } finally {
      setSourceBusy(false);
    }
  }

  async function openExternal(url, label) {
    if (sourceBusy) return;
    setSourceBusy(true);
    try {
      await api('/api/browser/open-external', { method: 'POST', body: JSON.stringify({ url }) });
      setNotice(`Opened ${label} in your external browser.`);
    } catch (err) {
      setNotice(err.message);
      setOperationOutput(err.message);
    } finally {
      setSourceBusy(false);
    }
  }

  function requestSourceConfirmation({ title, detail, path, body, success }) {
    setSourceConfirmation({ title, detail, path, body, success });
  }

  async function runConfirmedSourceAction() {
    if (!sourceConfirmation) return;
    const pending = sourceConfirmation;
    setSourceConfirmation(null);
    await action(pending.path, { ...pending.body, confirm: true }, pending.success);
  }

  async function startInstallerBuild() {
    if (installerBusy) return;
    setInstallerBusy(true);
    try {
      const result = await api('/api/source/build-installer', { method: 'POST', body: JSON.stringify({}) });
      setInstallerBuild(result);
      setNotice(result.running ? 'Installer build started from the Source tab.' : 'Installer build status refreshed.');
    } catch (err) {
      setNotice(err.message);
    } finally {
      setInstallerBusy(false);
    }
  }

  async function createCodingTask() {
    if (sourceBusy) return;
    setSourceBusy(true);
    try {
      const result = await api('/api/source/coding/tasks', { method: 'POST', body: JSON.stringify(codingDraft) });
      setNotice(result.note);
      setCodingDraft((current) => ({ ...current, title: '', objective: '' }));
      await refresh();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSourceBusy(false);
    }
  }

  async function prepareCodingTask(task) {
    await action(`/api/source/coding/tasks/${task.id}/prepare`, {}, 'Scoped workspace evidence prepared without calling a model or browser.');
    setSelectedCodingTaskId(task.id);
  }

  async function proposeCodingConfirmation(kind, task) {
    if (sourceBusy) return;
    setSourceBusy(true);
    try {
      // Mirror the server's receipt-freshness gate: validated advice only binds
      // to a run while its receipt is still tied to the current task seal and
      // prepared evidence. Stale advice (re-prepared evidence) is dropped, not
      // silently carried, so the run proceeds without it rather than 409-ing.
      const advice = task.browserAdvice;
      const freshAdvice = advice?.status === 'validated'
        && (!advice.receipt || (advice.receipt.taskHash === task.taskHash && advice.receipt.evidenceHash === (task.preparation?.evidenceHash || '')));
      const body = kind === 'run'
        ? { taskHash: task.taskHash, evidenceHash: task.preparation?.evidenceHash, adviceHash: freshAdvice ? advice.answerHash : '' }
        : { patchHash: task.patchHash };
      const proposal = await api(`/api/source/coding/tasks/${task.id}/${kind}/propose`, { method: 'POST', body: JSON.stringify(body) });
      setCodingConfirmation({ kind, taskId: task.id, title: task.title, ...proposal });
      setNotice(`${kind === 'run' ? 'Run' : 'Apply'} confirmation is ready. Review the bound snapshot, then confirm once.`);
      await refreshCoding();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSourceBusy(false);
    }
  }

  async function confirmCodingAction() {
    if (!codingConfirmation || sourceBusy) return;
    const pending = codingConfirmation;
    setSourceBusy(true);
    try {
      const result = await api(`/api/source/coding/tasks/${pending.taskId}/${pending.kind}/confirm`, { method: 'POST', body: JSON.stringify({ confirmationId: pending.confirmationId, token: pending.token }) });
      setCodingConfirmation(null);
      setNotice(result.note || `${pending.kind === 'run' ? 'Run' : 'Apply'} confirmation completed.`);
      await refresh();
    } catch (err) {
      setNotice(err.message);
      await refreshCoding().catch(() => {});
    } finally {
      setSourceBusy(false);
    }
  }

  async function previewCodingAdvice(task) {
    if (!codingAdviceDraft.question.trim()) return;
    await action(`/api/source/coding/tasks/${task.id}/advice/preview`, {
      provider: codingAdviceDraft.provider,
      question: codingAdviceDraft.question.trim()
    }, 'Browser advice prompt prepared for review. Nothing was sent.');
  }

  function sendCodingAdvice(task) {
    requestSourceConfirmation({
      title: `Send one advisory question to ${task.browserAdvice.provider}?`,
      detail: `This sends the exact redacted prompt bound to ${task.browserAdvice.promptHash}. The response is untrusted advice and cannot alter scope or apply code.`,
      path: `/api/source/coding/tasks/${task.id}/advice/send`,
      body: {
        provider: task.browserAdvice.provider,
        promptHash: task.browserAdvice.promptHash,
        temporaryChatConfirmed: codingAdviceDraft.temporaryChatConfirmed
      },
      success: 'One browser advisory request was dispatched.'
    });
  }

  async function saveToken() {
    const token = tokenInput.trim();
    if (!token) return;
    await action('/api/source/token', { token }, 'GitHub token saved.');
    setTokenInput('');
    setShowTokenForm(false);
  }

  const stashSave = (includeUntracked) => action(
    '/api/source/stash',
    { message: stashMessage.trim(), includeUntracked },
    'Changes stashed.'
  ).then(() => setStashMessage(''));
  const stashApply = (index, pop) => pop
    ? requestSourceConfirmation({
      title: `Pop stash@{${index}}?`,
      detail: 'The stash is removed after its changes are applied. Conflicts may require manual resolution.',
      path: '/api/source/stash/apply',
      body: { index, pop: true },
      success: 'Stash popped.'
    })
    : action('/api/source/stash/apply', { index, pop: false }, 'Stash applied.');
  const stashDrop = (index) => requestSourceConfirmation({
    title: `Drop stash@{${index}}?`,
    detail: 'This permanently deletes the selected stash.',
    path: '/api/source/stash/drop',
    body: { index },
    success: 'Stash dropped.'
  });
  const resolveConflict = (path, side) => action('/api/source/resolve', { path, side }, `Resolved ${path} (${side}).`);
  const createTag = () => {
    if (!tagDraft.name.trim()) return;
    action('/api/source/tags', { name: tagDraft.name.trim(), message: tagDraft.message.trim() }, `Created tag ${tagDraft.name.trim()}.`)
      .then(() => setTagDraft({ name: '', message: '' }));
  };
  const deleteTag = (name) => action('/api/source/tags/delete', { name }, `Deleted tag ${name}.`);
  const pushTag = (name) => action('/api/source/tags/push', { name, confirm: true }, `Pushed tag ${name} to origin.`);

  const changedFiles = source?.changedFiles || [];
  const stagedFiles = changedFiles.filter((file) => file.staged);
  const localBranches = (branches.branches || []).filter((branch) => !branch.remote);
  const currentBranch = source?.branch || '';
  const originRemote = source?.remoteList?.find((remote) => remote.name === 'origin') || source?.remoteList?.[0];
  const currentRemoteUrl = originRemote?.url || '';
  const currentRepoName = githubRepoFromRemote(currentRemoteUrl);
  const currentRepoWebUrl = githubWebUrlFromRemote(currentRemoteUrl);
  const boundaryLabel = repoBoundaryLabel(source?.repoPath || '', currentRepoName);
  const isPublicCheckout = boundaryLabel === 'Public app checkout';
  const publicationAllowed = Boolean(source?.publication?.allowed);
  const pushProtectedBranch = ['main', 'master'].includes(currentBranch.toLowerCase());
  const pushDisabledReason = sourceBusy
    ? 'A source control operation is already running.'
    : source?.hasConflicts
      ? 'Resolve conflicts before pushing.'
      : source && !publicationAllowed
        ? source.publication?.reason || 'Publishing is blocked until this checkout is verified as the public app repository.'
      : '';
  const hasChanges = changedFiles.length > 0;
  const selectedCodingTask = (coding.tasks || []).find((task) => task.id === selectedCodingTaskId) || coding.tasks?.[0] || null;
  const protectedFiles = changedFiles.filter((file) => file.protected);
  const canStageAll = hasChanges && !sourceBusy && !source?.hasConflicts && protectedFiles.length === 0;
  const canCommit = !sourceBusy && Boolean(commitMessage.trim()) && changedFiles.some((file) => file.staged) && !source?.hasConflicts;
  const githubLoginDisabledReason = sourceBusy
    ? 'A source control operation is already running.'
    : !source
      ? 'Checking source status.'
      : !source.github?.cliAvailable
        ? `GitHub CLI is missing. ${source.installHints?.githubCli || 'Install GitHub CLI first.'}`
        : '';
  const hfLoginDisabledReason = sourceBusy
    ? 'A source control operation is already running.'
    : !source
      ? 'Checking source status.'
      : !source.huggingface?.cliAvailable
        ? `Hugging Face CLI is missing. ${source.installHints?.huggingFaceCli || 'Install Hugging Face CLI first or use Settings.'}`
        : '';

  const tokenConfigured = Boolean(source?.github?.tokenConfigured);
  const installerStatusTone = installerBuild?.status === 'completed'
    ? 'good'
    : installerBuild?.status === 'failed'
      ? 'bad'
      : installerBuild?.status === 'running'
        ? 'warn'
        : 'default';
  const tabs = [
    { id: 'changes', label: 'Changes', icon: FileText, badge: changedFiles.length || null },
    { id: 'history', label: 'History', icon: History, badge: null },
    { id: 'branches', label: 'Branches', icon: GitBranch, badge: null },
    { id: 'coding', label: 'Local Coding', icon: Bot, badge: coding.tasks.filter((task) => task.status === 'review').length || null },
    { id: 'sync', label: 'Sync & Setup', icon: Upload, badge: null }
  ].filter((entry) => !availableTabs || availableTabs.includes(entry.id));

  return (
    <section className="source-panel">
      <div className="sc-topbar">
        <div className="sc-topbar-main">
          <h2><GitBranch size={18} /> Source Control</h2>
          <span className="sc-repo-path" title={source?.repoPath}>{source?.repoPath || 'Reading repository state...'}</span>
        </div>
        <div className="sc-status-badges">
          <span className="sc-branch-badge">{source?.branch || 'unknown'}</span>
          {source?.upstream && source.ahead > 0 && <span className="sc-badge good">ahead {source.ahead}</span>}
          {source?.upstream && source.behind > 0 && <span className="sc-badge warn">behind {source.behind}</span>}
          <span className="sc-badge">staged {stagedFiles.length}</span>
          <span className="sc-badge">unstaged {changedFiles.length - stagedFiles.length}</span>
          {source?.hasConflicts
            ? <span className="sc-badge bad">{source.conflictFiles.length} conflict(s)</span>
            : hasChanges
              ? <span className="sc-badge warn">{changedFiles.length} changed</span>
              : <span className="sc-badge good">Clean</span>}
          <button onClick={() => refresh(true)} disabled={sourceBusy} title="Refresh status, branches and history"><RefreshCcw size={15} /></button>
        </div>
      </div>

      <div className={cx('source-warning', isPublicCheckout ? 'warn' : 'info')}>
        <strong>{boundaryLabel}</strong>
        <small>
          This Source panel controls only the local checkout at <code>{source?.repoPath || 'unknown path'}</code>.
          {currentRepoName ? <> Current origin is <code>{currentRepoName}</code>.</> : ' No GitHub origin repository was detected.'}
          {isPublicCheckout ? ' Do not use this panel to move private LifePlanSystem content into the public app checkout.' : ''}
        </small>
      </div>

      {source && !publicationAllowed && (
        <div className="source-warning bad">
          <strong>Remote publishing blocked</strong>
          <small>{source.publication?.reason || 'This checkout did not pass the server repository-boundary check.'}</small>
        </div>
      )}

      {sourceBusy && <div className="source-warning info">Running source control operation...</div>}
      {sourceConfirmation && (
        <div className="source-warning warn">
          <strong>{sourceConfirmation.title}</strong>
          <small>{sourceConfirmation.detail}</small>
          <div className="decision-row">
            <button className="primary" onClick={runConfirmedSourceAction} disabled={sourceBusy}>Confirm</button>
            <button onClick={() => setSourceConfirmation(null)} disabled={sourceBusy}>Cancel</button>
          </div>
        </div>
      )}
      {source?.hasConflicts && (
        <div className="source-warning bad sc-conflict-banner">
          <strong>{source.conflictFiles.length} conflict(s) need resolution before you can stage, commit, or switch.</strong>
          <div className="sc-conflict-resolve">
            {source.conflictFiles.map((file) => (
              <div className="sc-conflict-row" key={file}>
                <button className="sc-conflict-name" onClick={() => openFileDiff(file)} title="Open side-by-side diff">{file}</button>
                <div className="mini-actions">
                  <button onClick={() => resolveConflict(file, 'ours')} disabled={sourceBusy} title="Keep our version">Take ours</button>
                  <button onClick={() => resolveConflict(file, 'theirs')} disabled={sourceBusy} title="Keep their version">Take theirs</button>
                  <button onClick={() => resolveConflict(file, 'mark')} disabled={sourceBusy} title="Stage current file contents as resolved (after editing)"><Check size={13} /> Mark resolved</button>
                </div>
              </div>
            ))}
          </div>
          <div className="decision-row">
            <button className="danger" onClick={() => action('/api/source/abort-merge', {}, 'Aborted in-progress merge/rebase.')} disabled={sourceBusy}><RotateCcw size={15} /> Abort merge/rebase</button>
          </div>
        </div>
      )}

      <div className="sc-tabbar">
        {tabs.map((entry) => {
          const Icon = entry.icon;
          return (
            <button key={entry.id} className={cx('sc-tab', tab === entry.id && 'active')} onClick={() => setTab(entry.id)}>
              <Icon size={15} /> {entry.label}
              {entry.badge ? <span className="sc-tab-badge">{entry.badge}</span> : null}
            </button>
          );
        })}
      </div>

      {tab === 'changes' && (
        <div className="sc-tab-body sc-changes-grid">
          <div className="panel">
            <div className="panel-heading">
              <h2>Changed Files</h2>
              <div className="mini-actions">
                <button onClick={() => action('/api/source/stage-all', {}, 'Staged all changes.')} disabled={!canStageAll}><Check size={14} /> Stage all</button>
                <button onClick={() => action('/api/source/unstage-all', {}, 'Unstaged all files.')} disabled={sourceBusy || !stagedFiles.length}><X size={14} /> Unstage all</button>
                <button className="danger" onClick={() => setDiscardArmed(true)} disabled={sourceBusy || !hasChanges || discardArmed} title="Discard ALL tracked working-tree changes"><RotateCcw size={14} /> Discard all…</button>
              </div>
            </div>
            {discardArmed && (
              <div className="source-warning bad">
                <strong>Discard all tracked changes?</strong>
                <small>Runs <code>git restore --worktree -- .</code> — every tracked file reverts to the last commit/index. Untracked files are left alone. This cannot be undone.</small>
                <div className="decision-row">
                  <button className="danger" disabled={sourceBusy} onClick={async () => { await action('/api/source/discard-all', { confirm: true }, 'Discarded all tracked working-tree changes.'); setDiscardArmed(false); }}><RotateCcw size={14} /> Yes, discard all</button>
                  <button disabled={sourceBusy} onClick={() => setDiscardArmed(false)}><X size={14} /> Cancel</button>
                </div>
              </div>
            )}
            <div className="source-file-list">
              {diff?.note && <div className="source-warning warn">{diff.note}</div>}
              {changedFiles.length === 0 ? (
                <Empty title="Clean" body="No changed files." />
              ) : changedFiles.map((file) => (
                <div className={cx('source-file-row', diffPath === file.path && 'selected')} key={`${file.status}-${file.path}`}>
                  <div>
                    <strong>{file.originalPath ? `${file.originalPath} -> ${file.path}` : file.path}</strong>
                    <span>{file.status}{file.staged ? ' · staged' : ' · worktree'}</span>
                  </div>
                  <div className="mini-actions">
                    {!file.protected && (
                      <button onClick={() => openFileDiff(file.path)} disabled={diffBusy} title="Side-by-side diff"><FileText size={14} /></button>
                    )}
                    {file.protected ? (
                      <Pill tone="bad">Protected</Pill>
                    ) : file.staged ? (
                      <button onClick={() => action('/api/source/unstage-file', { path: file.path }, `Unstaged ${file.path}`)} disabled={sourceBusy}><X size={14} /> Unstage</button>
                    ) : (
                      <>
                        <button onClick={() => action('/api/source/stage-file', { path: file.path }, `Staged ${file.path}`)} disabled={sourceBusy}><Check size={14} /> Stage</button>
                        <button className="danger" onClick={() => action('/api/source/discard-file', { path: file.path }, `Discarded changes in ${file.path}`)} disabled={sourceBusy} title="Discard working-tree changes"><RotateCcw size={14} /></button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <label>Files to be committed ({stagedFiles.length})</label>
            {stagedFiles.length ? (
              <div className="commit-file-list">
                {stagedFiles.map((file) => (
                  <div className="commit-file-row" key={file.path}>
                    <span>{file.status}</span>
                    <strong>{file.path}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="source-warning info">Nothing staged. Stage at least one file to commit.</div>
            )}
            <label>Commit message</label>
            <textarea value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe the source change... (required)" disabled={sourceBusy} />
            <div className="decision-row">
              <button className="primary" onClick={() => action('/api/source/commit', { message: commitMessage }, 'Commit created.')} disabled={!canCommit}><Check size={16} /> Commit</button>
            </div>

            <label>Stash</label>
            <div className="inline-form">
              <input value={stashMessage} onChange={(event) => setStashMessage(event.target.value)} placeholder="Optional stash message" disabled={sourceBusy} />
              <button onClick={() => stashSave(false)} disabled={sourceBusy || !hasChanges} title="Stash tracked changes"><Archive size={14} /> Stash</button>
              <button onClick={() => stashSave(true)} disabled={sourceBusy || !hasChanges} title="Stash including untracked files"><Archive size={14} /> +untracked</button>
            </div>
            {stashes.length > 0 && (
              <div className="sc-stash-list">
                {stashes.map((entry) => (
                  <div className="sc-stash-row" key={entry.ref}>
                    <span className="sc-stash-ref">{entry.ref}</span>
                    <span className="sc-stash-msg">{entry.subject}</span>
                    <div className="mini-actions">
                      <button onClick={() => stashApply(entry.index, false)} disabled={sourceBusy} title="Apply (keep stash)">Apply</button>
                      <button onClick={() => stashApply(entry.index, true)} disabled={sourceBusy} title="Pop (apply and remove)">Pop</button>
                      <button className="danger" onClick={() => stashDrop(entry.index)} disabled={sourceBusy} title="Drop"><Trash2 size={13} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {operationOutput && <pre className="code-block compact-code">{operationOutput}</pre>}
          </div>

          <div className="panel wide-panel">
            <div className="panel-heading">
              <h2>Diff{diffPath ? `: ${diffPath}` : ''}</h2>
              {diffPath && <button onClick={() => { setDiffPath(''); setFileDiff(null); }} disabled={diffBusy}><X size={14} /> Close</button>}
            </div>
            {diffPath ? (
              diffBusy ? (
                <div className="loading">Loading diff...</div>
              ) : fileDiff ? (
                <SideBySideDiff data={fileDiff} />
              ) : (
                <Empty title="No diff" body="Could not load a diff for this file." />
              )
            ) : (
              <Empty title="No file selected" body="Click a file's diff icon to compare committed vs current side by side." />
            )}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="sc-tab-body">
          <div className="panel">
            <h2>Commit History</h2>
            <div className="sc-history-list">
              {history.length === 0 ? (
                <Empty title="No history" body="No commits found or history not loaded." />
              ) : history.map((commit) => (
                <div className="sc-commit-row" key={commit.shortHash}>
                  <div className="sc-commit-node" />
                  <div className="sc-commit-body">
                    <div className="sc-commit-subject" title={commit.subject}>{commit.subject}</div>
                    <div className="sc-commit-meta">
                      <span className="sc-commit-hash">{commit.shortHash}</span>
                      <span>{commit.author}</span>
                      <span>{commit.relative}</span>
                      {commit.refs.map((ref) => (
                        <span key={ref} className={cx('sc-ref-badge', ref.includes('HEAD') && 'head', ref.includes('origin') && 'remote')}>{ref}</span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'branches' && (
        <div className="sc-tab-body sc-branch-grid">
          <div className="panel">
            <h2>Current & Switch</h2>
            <p>On <strong>{source?.branch || 'unknown'}</strong>{source?.upstream ? ` tracking ${source.upstream}` : ' (no upstream)'}.</p>
            <label>Switch branch</label>
            <div className="inline-form">
              <select value={branchToSwitch} onChange={(event) => setBranchToSwitch(event.target.value)} disabled={sourceBusy}>
                {localBranches.map((branch) => (
                  <option value={branch.name} key={branch.name}>{branch.name}</option>
                ))}
              </select>
              <button onClick={() => action('/api/source/checkout', { branch: branchToSwitch }, `Switched to ${branchToSwitch}`)} disabled={sourceBusy || !branchToSwitch || branchToSwitch === source?.branch}><GitBranch size={16} /> Switch</button>
            </div>
            <label>Merge a branch into {source?.branch || 'current'}</label>
            <div className="inline-form">
              <select value={mergeBranch} onChange={(event) => setMergeBranch(event.target.value)} disabled={sourceBusy}>
                <option value="">Select branch to merge...</option>
                {(branches.branches || []).filter((branch) => branch.name !== source?.branch).map((branch) => (
                  <option value={branch.name} key={branch.name}>{branch.name}</option>
                ))}
              </select>
              <button onClick={() => requestSourceConfirmation({ title: `Merge ${mergeBranch}?`, detail: `Merge ${mergeBranch} into ${currentBranch}. Conflicts may require manual resolution.`, path: '/api/source/merge', body: { branch: mergeBranch }, success: `Merged ${mergeBranch}.` })} disabled={sourceBusy || !mergeBranch}><GitMerge size={16} /> Merge</button>
            </div>
            <label>Delete a local branch</label>
            <div className="inline-form">
              <select value={branchToSwitch} onChange={(event) => setBranchToSwitch(event.target.value)} disabled={sourceBusy}>
                {localBranches.map((branch) => (
                  <option value={branch.name} key={branch.name}>{branch.name}</option>
                ))}
              </select>
              <button className="danger" onClick={() => action('/api/source/delete-branch', { branch: branchToSwitch }, `Deleted ${branchToSwitch}.`)} disabled={sourceBusy || !branchToSwitch || branchToSwitch === source?.branch}><Trash2 size={16} /> Delete</button>
              <button className="danger" onClick={() => requestSourceConfirmation({ title: `Force-delete ${branchToSwitch}?`, detail: 'This deletes the local branch even when it contains commits that are not merged.', path: '/api/source/delete-branch', body: { branch: branchToSwitch, force: true }, success: `Force-deleted ${branchToSwitch}.` })} disabled={sourceBusy || !branchToSwitch || branchToSwitch === source?.branch}><Trash2 size={16} /> Force delete...</button>
            </div>
          </div>

          <div className="panel">
            <h2>Create branch</h2>
            <div className="inline-form">
              <input value={branchName} onChange={(event) => setBranchName(event.target.value)} disabled={sourceBusy} placeholder="feature/my-branch" />
              <button onClick={() => action('/api/source/branch', { branch: branchName }, `Created branch ${branchName}`)} disabled={sourceBusy || !branchName.trim()}><Plus size={16} /> Create + switch</button>
            </div>
            <h2>All branches</h2>
            <div className="sc-branch-list">
              {(branches.branches || []).map((branch) => (
                <div className={cx('sc-branch-item', branch.current && 'current')} key={`${branch.remote ? 'r' : 'l'}-${branch.name}`}>
                  <GitBranch size={13} />
                  <span>{branch.name}</span>
                  {branch.current && <Pill tone="good">current</Pill>}
                  {branch.remote && <Pill tone="warn">remote</Pill>}
                  {branch.remote && (
                    <button onClick={() => action('/api/source/checkout-remote', { branch: branch.name }, `Now tracking ${branch.name}.`)} disabled={sourceBusy || hasChanges} title={hasChanges ? 'Commit or stash changes before tracking a remote branch.' : `Create/switch the matching local branch and track ${branch.name}`}>
                      Track
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'coding' && (
        <div className="sc-tab-body coding-workspace-shell">
          <div className="coding-runtime-bar">
            <div><span>Local worker</span><strong className={coding.model?.configured ? 'good' : 'warn'}>{coding.model?.configured ? coding.model.source : 'Unavailable'}</strong><small>{coding.model?.name || 'Select a local code model'}{coding.model?.source === 'bundled llama.cpp' ? ` · ${coding.model.managedContextSize || 0}/${coding.model.requiredCodingContextSize} context${coding.model.codingContextReady ? '' : ' · restarts on run'}` : ''}</small></div>
            <div><span>Browser advice</span><strong className={coding.browser?.connected ? 'good' : 'warn'}>{coding.browser?.connected ? 'Connector ready' : 'Optional / disconnected'}</strong><small>Advisory only, never a fallback worker</small></div>
            <div><span>Mutation boundary</span><strong>{coding.activeTaskIds?.length || 0} active</strong><small>Live checkout stays untouched until Apply</small></div>
          </div>

          <details className="panel coding-create-panel">
            <summary><Plus size={15} /> Create a narrow coding task</summary>
            <div className="coding-create-grid">
              <label>Title<input value={codingDraft.title} onChange={(event) => setCodingDraft({ ...codingDraft, title: event.target.value })} placeholder="Small, specific outcome" disabled={sourceBusy} /></label>
              <label className="coding-create-objective">Objective and acceptance criteria<textarea value={codingDraft.objective} onChange={(event) => setCodingDraft({ ...codingDraft, objective: event.target.value })} placeholder="Describe the defect and the observable result." disabled={sourceBusy} /></label>
              <label>Allowed paths, one per line<textarea value={codingDraft.allowedPaths} onChange={(event) => setCodingDraft({ ...codingDraft, allowedPaths: event.target.value })} placeholder={'src/component.jsx\nserver/helper.js'} disabled={sourceBusy} /></label>
              <label>Independent validation<select value={codingDraft.validation} onChange={(event) => setCodingDraft({ ...codingDraft, validation: event.target.value })} disabled={sourceBusy}>{Object.entries(coding.validations || {}).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
              <label>Maximum changed files<select value={codingDraft.maxFilesChanged} onChange={(event) => setCodingDraft({ ...codingDraft, maxFilesChanged: Number(event.target.value) })} disabled={sourceBusy}>{[1, 2, 3, 4, 5].map((count) => <option value={count} key={count}>{count}</option>)}</select></label>
              <button className="primary" onClick={createCodingTask} disabled={sourceBusy || !codingDraft.title.trim() || !codingDraft.objective.trim() || !codingDraft.allowedPaths.trim()}><Plus size={15} /> Seal task scope</button>
            </div>
          </details>

          {!selectedCodingTask ? <Empty title="No local coding tasks" body="Create a bounded task. Preparation reads only approved source and makes no model or browser call." /> : (
            <div className="coding-ide">
              <aside className="coding-task-rail" aria-label="Coding tasks">
                <div className="coding-rail-title"><strong>Task queue</strong><span>{coding.tasks.length}</span></div>
                {coding.tasks.map((task) => <button key={task.id} className={cx('coding-task-button', selectedCodingTask.id === task.id && 'selected')} onClick={() => setSelectedCodingTaskId(task.id)}>
                  <span>{task.title}</span><small>{CODING_STATUS_LABELS[task.status] || task.status}</small>
                </button>)}
              </aside>

              <main className="coding-review-area">
                <div className="coding-review-head">
                  <div><small>{selectedCodingTask.id}</small><h2>{selectedCodingTask.title}</h2><p>{selectedCodingTask.objective}</p></div>
                  <Pill tone={codingTone(selectedCodingTask.status)}>{CODING_STATUS_LABELS[selectedCodingTask.status] || selectedCodingTask.status}</Pill>
                </div>
                <div className="source-warning info"><strong>Live checkout boundary</strong><small>{selectedCodingTask.status === 'applied' ? 'This reviewed patch was explicitly applied unstaged. Source Control now owns any commit or push.' : 'The live checkout is untouched. Preparation, browser advice, local inference, and validation occur before a separate patch-hash Apply approval.'}</small></div>
                {selectedCodingTask.error && <div className="source-warning bad"><strong>Stopped honestly</strong><small>{selectedCodingTask.error}</small></div>}

                <details className="coding-evidence-section" open={!selectedCodingTask.diff}>
                  <summary>Scoped evidence <span>{selectedCodingTask.preparation?.evidence?.anchors?.length || 0} ranked files</span></summary>
                  {!selectedCodingTask.preparation ? <Empty title="Evidence not prepared" body="Prepare reads bounded text from the sealed allowed paths only. It does not call a model." /> : <>
                    <div className="coding-evidence-stats"><span>Hash <code>{selectedCodingTask.preparation.evidenceHash?.slice(0, 16)}</code></span><span>{selectedCodingTask.preparation.evidence.fileCount} eligible files</span><span>{selectedCodingTask.preparation.evidence.redactionCount || 0} redactions</span></div>
                    {(selectedCodingTask.preparation.evidence.excerpts || []).map((excerpt) => {
                      const anchor = selectedCodingTask.preparation.evidence.anchors.find((item) => item.path === excerpt.path);
                      return <details className="coding-file-preview" key={excerpt.path}><summary><code>{excerpt.path}</code><span>{anchor?.reason || 'Selected from approved scope.'}</span></summary><HighlightedCode content={excerpt.excerpt} /></details>;
                    })}
                  </>}
                </details>

                <details className="coding-evidence-section" open={Boolean(selectedCodingTask.toolTrace?.length)}>
                  <summary>Local tool trace <span>{selectedCodingTask.toolTrace?.length || 0} read-only calls</span></summary>
                  {(selectedCodingTask.toolTrace || []).length ? selectedCodingTask.toolTrace.map((entry) => <div className="coding-tool-evidence" key={`${entry.round}-${entry.resultHash}`}><div className="coding-evidence-stats"><strong>{entry.round}. {entry.name}</strong><code>{entry.path}</code>{entry.query && <span>query: {entry.query}</span>}<span>{entry.resultBytes} bytes</span><code>{entry.resultHash?.slice(0, 16)}</code></div>{entry.resultPreview && <details className="coding-file-preview"><summary><code>Controller evidence excerpt</code><span>Stored bounded result, not model paraphrase</span></summary><pre className="code-block compact-code">{entry.resultPreview}</pre></details>}</div>) : <Empty title="No tools used" body={`The local model can make up to ${coding.limits?.maxToolRounds ?? 16} scoped list, literal search, or ranged file-read calls. It cannot run commands, use the network, or perform Git operations.`} />}
                </details>

                <details className="coding-evidence-section" open={Boolean(selectedCodingTask.diff)}>
                  <summary>Reviewed patch <span>{selectedCodingTask.changedFiles?.length || 0} changed files</span></summary>
                  {selectedCodingTask.diff ? <HighlightedCode content={selectedCodingTask.diff} mode="diff" /> : <Empty title="No patch yet" body="A patch appears only after the local worker returns bounded JSON and independent validation passes." />}
                </details>

                {selectedCodingTask.validationResult && <details className="coding-evidence-section" open><summary>Independent validation <span>{selectedCodingTask.validationResult.ok ? 'Passed' : 'Failed'}</span></summary><pre className="code-block compact-code">{selectedCodingTask.validationResult.output}</pre></details>}
                {selectedCodingTask.status === 'evidence_only' && <div className="source-warning info"><strong>Evidence-only outcome — no source change</strong><small>The local coder reported that the sealed evidence warrants no source mutation ({selectedCodingTask.assessment?.evidenceBasis || 'grounded in prepared evidence'}). No patch was created and nothing was validated as a change. Close this task with Reject, or seal a new task if you disagree.</small></div>}
                {selectedCodingTask.browserAdvice?.disposition && selectedCodingTask.browserAdvice.disposition.state !== 'validated' && (() => {
                  const d = selectedCodingTask.browserAdvice.disposition;
                  const tone = d.category === 'rejected' || d.category === 'blocked' ? 'bad' : d.category === 'in-progress' ? 'info' : 'warn';
                  return (
                    <div className={cx('source-warning', tone)}>
                      <strong>Browser consultation: {d.label}</strong>
                      {d.missing && <small>Missing: {d.missing}</small>}
                      <small>Next: {d.nextAction}</small>
                    </div>
                  );
                })()}
                {selectedCodingTask.browserAdvice?.receipt && (() => {
                  const receipt = selectedCodingTask.browserAdvice.receipt;
                  const stale = receipt.evidenceHash !== (selectedCodingTask.preparation?.evidenceHash || '') || receipt.taskHash !== selectedCodingTask.taskHash;
                  return (
                    <details className="coding-evidence-section" open>
                      <summary>Browser consultation receipt <span>{stale ? 'Stale — re-consult' : (receipt.terminalState || 'recorded')}</span></summary>
                      <div className="coding-evidence-stats">
                        <span>Provider <strong>{receipt.provider || 'unknown'}</strong></span>
                        {receipt.conversationId && <span>Turn <code>{receipt.conversationId}</code></span>}
                        {receipt.capturedAt && <span>Captured {receipt.capturedAt}</span>}
                        <span>Answer <code>{(receipt.answerHash || '').slice(0, 16) || 'none'}</code></span>
                        <span>Bound evidence <code>{(receipt.evidenceHash || '').slice(0, 16) || 'none'}</code></span>
                      </div>
                      <small>{stale
                        ? 'The task scope or prepared evidence changed after this advice was captured, so it is no longer bound to a run. Re-consult to use fresh advice.'
                        : 'Untrusted advisory provenance only. It cannot widen scope, apply code, or count as validation.'}</small>
                    </details>
                  );
                })()}
                {selectedCodingTask.summary && <div className="source-warning info"><strong>Local coder summary</strong><small>{selectedCodingTask.summary}</small></div>}
              </main>

              <aside className="coding-inspector">
                <h3>Inspection</h3>
                <dl>
                  <dt>Scope seal</dt><dd><code>{selectedCodingTask.taskHash?.slice(0, 20)}</code></dd>
                  <dt>Base commit</dt><dd><code>{selectedCodingTask.baseCommit?.slice(0, 12) || 'not pinned'}</code></dd>
                  <dt>Allowed paths</dt><dd>{selectedCodingTask.allowedPaths.map((item) => <code key={item}>{item}</code>)}</dd>
                  <dt>Validation</dt><dd>{coding.validations?.[selectedCodingTask.validation] || selectedCodingTask.validation}</dd>
                  <dt>File limit</dt><dd>{selectedCodingTask.maxFilesChanged}</dd>
                  <dt>Evidence hash</dt><dd><code>{selectedCodingTask.preparation?.evidenceHash?.slice(0, 20) || 'not prepared'}</code></dd>
                  <dt>Patch hash</dt><dd><code>{selectedCodingTask.patchHash?.slice(0, 20) || 'not generated'}</code></dd>
                  {selectedCodingTask.leaseStatus?.acquiredAt && <>
                    <dt>Run lease</dt><dd>{selectedCodingTask.leaseStatus.held ? `Held by ${selectedCodingTask.leaseStatus.owner}` : 'Expired — reclaimable'}{selectedCodingTask.leaseStatus.held && Number.isFinite(selectedCodingTask.leaseStatus.remainingMs) ? ` · ${Math.round(selectedCodingTask.leaseStatus.remainingMs / 60000)} min left` : ''}</dd>
                    <dt>Lease phase</dt><dd>{selectedCodingTask.leaseStatus.phase || '—'}{selectedCodingTask.leaseStatus.lastEvent?.at ? ` · last event ${selectedCodingTask.leaseStatus.lastEvent.at}` : ''}</dd>
                  </>}
                  <dt>Checker repairs</dt><dd>{Number(selectedCodingTask.validationRepairs || 0)} / {coding.limits?.maxValidationRepairAttempts ?? 1} bounded repair pass</dd>
                  <dt>Evidence recovery</dt><dd>{Number(selectedCodingTask.evidenceRecoveries || 0)} / {coding.limits?.maxEvidenceRecoveryAttempts ?? 5} bounded gap-resolution passes</dd>
                  <dt>Last action confidence</dt><dd>{selectedCodingTask.assessment ? `${Math.round(Number(selectedCodingTask.assessment.confidence) * 100)}% — ${selectedCodingTask.assessment.action}` : 'not assessed'}</dd>
                  {selectedCodingTask.assessment?.evidenceBasis && <><dt>Confidence basis</dt><dd>{selectedCodingTask.assessment.evidenceBasis}</dd></>}
                  {selectedCodingTask.recovery?.blockedReason && <><dt>Blocked by</dt><dd>{selectedCodingTask.recovery.blockedReason}</dd><dt>Next safe action</dt><dd>{selectedCodingTask.recovery.nextPermittedAction}</dd></>}
                  {selectedCodingTask.recovery?.evidenceGaps?.length > 0 && <><dt>Evidence gaps</dt><dd>{selectedCodingTask.recovery.evidenceGaps.map((gap) => <div key={gap}>{gap}</div>)}</dd></>}
                  <dt>Browser advice</dt><dd>{selectedCodingTask.browserAdvice?.status || 'skipped'}</dd>
                </dl>

                <div className="coding-actions">
                  {['pending', 'needs-scope'].includes(selectedCodingTask.status) && <button className="primary" onClick={() => prepareCodingTask(selectedCodingTask)} disabled={sourceBusy}><SearchCheck size={15} /> Prepare evidence</button>}
                  {['prepared', 'failed', 'interrupted', 'cancelled'].includes(selectedCodingTask.status) && <button className="primary" onClick={() => proposeCodingConfirmation('run', selectedCodingTask)} disabled={sourceBusy || !coding.model?.configured || hasChanges || !selectedCodingTask.preparation?.evidenceHash} title={!coding.model?.configured ? 'The configured local coding endpoint is unavailable.' : hasChanges ? 'The live checkout must be clean before a local run.' : !selectedCodingTask.preparation?.evidenceHash ? 'Prepare scoped evidence first.' : 'Create a durable run confirmation'}><Play size={15} /> Approve local run</button>}
                  {selectedCodingTask.status === 'running' && <button className="danger" onClick={() => action(`/api/source/coding/tasks/${selectedCodingTask.id}/cancel`, {}, 'Cancellation requested.')} disabled={sourceBusy}><X size={15} /> Cancel run</button>}
                  {selectedCodingTask.status === 'review' && <button className="primary" onClick={() => proposeCodingConfirmation('apply', selectedCodingTask)} disabled={sourceBusy || hasChanges} title={hasChanges ? 'The live checkout must be clean before Apply.' : 'Create a durable patch-apply confirmation'}><Check size={15} /> Apply reviewed patch</button>}
                  {['pending', 'prepared', 'needs-scope', 'needs-evidence', 'awaiting-advice', 'failed', 'interrupted', 'apply-interrupted', 'cancelled', 'review'].includes(selectedCodingTask.status) && <button className="danger" onClick={() => requestSourceConfirmation({ title: `Reject ${selectedCodingTask.title}?`, detail: selectedCodingTask.status === 'apply-interrupted' ? 'Inspect Source changes first. Closing this record does not assert whether the interrupted patch reached the live checkout.' : 'The proposal and isolated worktree will be discarded. The live checkout will not change.', path: `/api/source/coding/tasks/${selectedCodingTask.id}/reject`, body: {}, success: 'Coding proposal rejected.' })} disabled={sourceBusy}><Trash2 size={15} /> Reject</button>}
                </div>

                {codingConfirmation?.taskId === selectedCodingTask.id && <div className="coding-advice-box"><h4>Confirm {codingConfirmation.kind === 'run' ? 'local run' : 'patch apply'}</h4><p>This one-time confirmation is bound to the current sealed snapshot and expires at {new Date(codingConfirmation.expiresAt).toLocaleTimeString()}. {codingConfirmation.kind === 'run' ? 'The readiness receipt is observation only; confirmation authorizes isolated local inference and validation, and the worker rechecks every gate.' : 'It authorizes only this reviewed patch, applied unstaged.'}</p>{codingConfirmation.readiness && <><p><strong>Readiness receipt:</strong> {codingConfirmation.readiness.receiptHash.slice(0, 12)} · {codingConfirmation.readiness.ready ? 'Ready for explicit confirmation' : 'Blocked'}</p><ul>{codingConfirmation.readiness.gates.map((gate) => <li key={gate.gate}>{gate.ok ? 'Pass' : 'Blocked'} · {gate.gate}{gate.ok ? '' : ` (${gate.reasonCode})`}</li>)}</ul><p className="muted">Assessment started no runtime, worktree, or lease and granted no execution authority.</p></>}<div className="button-row"><button className="primary" onClick={confirmCodingAction} disabled={sourceBusy}>Confirm once</button><button className="secondary" onClick={() => setCodingConfirmation(null)} disabled={sourceBusy}>Cancel</button></div></div>}

                {['prepared', 'needs-evidence'].includes(selectedCodingTask.status) && <div className="coding-advice-box">
                  <h4>Optional browser advice</h4>
                  <p>{selectedCodingTask.status === 'needs-evidence' ? 'The in-scope read budget is exhausted. Use this only for one named missing fact, or reject and create a better-scoped task.' : 'Use only for one concrete missing fact. Local evidence remains primary.'}</p>
                  <select value={codingAdviceDraft.provider} onChange={(event) => setCodingAdviceDraft({ ...codingAdviceDraft, provider: event.target.value })}>{(coding.browser?.providers || []).map((item) => <option key={item.provider} value={item.provider}>{item.provider}{item.connected ? ' (connected)' : ' (offline)'}</option>)}</select>
                  <textarea value={codingAdviceDraft.question} onChange={(event) => setCodingAdviceDraft({ ...codingAdviceDraft, question: event.target.value })} placeholder="What exact implementation fact is missing from the approved source?" />
                  <button onClick={() => previewCodingAdvice(selectedCodingTask)} disabled={sourceBusy || codingAdviceDraft.question.trim().length < 12}>Preview exact prompt</button>
                </div>}
                {selectedCodingTask.browserAdvice?.status === 'preview' && <div className="coding-advice-box">
                  <h4>Review advisory egress</h4><p>Provider: {selectedCodingTask.browserAdvice.provider}<br />Prompt hash: <code>{selectedCodingTask.browserAdvice.promptHash?.slice(0, 16)}</code><br />Files: {selectedCodingTask.browserAdvice.suppliedFiles?.join(', ') || 'none'}</p>
                  <details><summary>Exact redacted prompt</summary><pre className="code-block compact-code">{selectedCodingTask.browserAdvice.prompt}</pre></details>
                  {selectedCodingTask.browserAdvice.provider === 'ChatGPT' && <label className="temporary-chat-option"><input type="checkbox" checked={codingAdviceDraft.temporaryChatConfirmed} onChange={(event) => setCodingAdviceDraft({ ...codingAdviceDraft, temporaryChatConfirmed: event.target.checked })} />Temporary Chat is enabled in ChatGPT</label>}
                  <button onClick={() => sendCodingAdvice(selectedCodingTask)} disabled={sourceBusy || (selectedCodingTask.browserAdvice.provider === 'ChatGPT' && !codingAdviceDraft.temporaryChatConfirmed)}>Confirm and send once</button>
                </div>}
                {selectedCodingTask.status === 'awaiting-advice' && <button onClick={() => action(`/api/source/coding/tasks/${selectedCodingTask.id}/advice/poll`, {}, 'Browser advice status refreshed.')} disabled={sourceBusy}><RefreshCcw size={15} /> Poll same advice job</button>}
                {selectedCodingTask.browserAdvice?.validation && <div className={cx('source-warning', selectedCodingTask.browserAdvice.validation.ok ? 'info' : 'bad')}><strong>{selectedCodingTask.browserAdvice.validation.ok ? 'Advice validated as untrusted' : 'Advice rejected'}</strong><small>{selectedCodingTask.browserAdvice.validation.reason || 'Scope authority remains unchanged.'}</small></div>}
              </aside>

              <section className="coding-console">
                <div className="coding-console-head"><strong>Run console</strong><span>Durable audit order</span></div>
                {(selectedCodingTask.audit || []).length ? selectedCodingTask.audit.map((event, index) => <div className="coding-console-row" key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString()}</time><span className={event.verdict === 'allow' ? 'good' : 'bad'}>{event.verdict}</span><strong>{event.phase.replaceAll('_', ' ')}</strong><p>{event.detail}<br /><small>{event.confidence == null ? 'Legacy record — confidence was not captured.' : `${Math.round(Number(event.confidence) * 100)}% confidence — ${event.evidenceBasis || 'No basis recorded.'}`}</small></p><code>{event.evidenceHash?.slice(0, 12)}</code></div>) : <p>No events recorded.</p>}
                <details><summary>Raw task record</summary><pre className="code-block compact-code">{JSON.stringify(selectedCodingTask, null, 2)}</pre></details>
              </section>
            </div>
          )}
        </div>
      )}

      {tab === 'sync' && (
        <div className="sc-tab-body sc-sync-grid">
          <div className="panel">
            <h2>Sync with remote</h2>
            <div className="decision-row">
              <button onClick={() => action('/api/source/fetch', {}, 'Fetched latest remote refs.')} disabled={sourceBusy}><RefreshCcw size={16} /> Fetch</button>
              <button onClick={() => action('/api/source/pull', {}, 'Pulled latest changes.')} disabled={sourceBusy || source?.hasConflicts}><Download size={16} /> Pull (ff-only)</button>
              <button onClick={() => requestSourceConfirmation({ title: `Rebase ${currentBranch}?`, detail: `Fetch and replay local commits onto origin/${currentBranch}. Local commit IDs may change.`, path: '/api/source/rebase', body: {}, success: 'Rebased onto origin.' })} disabled={sourceBusy}><GitBranch size={16} /> Pull --rebase</button>
              <button onClick={() => setPushArmed(true)} disabled={Boolean(pushDisabledReason) || pushArmed} title={pushDisabledReason || 'Review the push target before confirming'}><Upload size={16} /> Push...</button>
              <button onClick={runPublicationCheck} disabled={sourceBusy || publicationCheckBusy}><ShieldCheck size={16} /> {publicationCheckBusy ? 'Checking...' : 'Publication preflight'}</button>
            </div>
            {publicationCheck && (
              <div className={cx('source-warning', publicationCheck.allowed ? 'info' : 'bad')}>
                <strong>{publicationCheck.allowed ? 'Publication preflight passed' : 'Publication preflight blocked'}</strong>
                <small>{publicationCheck.reason}</small>
              </div>
            )}
            {pushArmed && (
              <div className="source-warning warn">
                <strong>Confirm push</strong>
                <small>
                  Runs <code>git push origin {currentBranch}</code> to remote <code>origin</code>{tokenConfigured ? ' using your saved token' : ''}. No force flags. {pushProtectedBranch ? `This is protected branch ${currentBranch}; confirmation is bound to that exact branch.` : 'The current review branch is confirmed explicitly.'}
                </small>
                <div className="decision-row">
                  <button className="primary" disabled={sourceBusy} onClick={async () => { await action('/api/source/push', { confirm: true, confirmProtectedBranch: pushProtectedBranch ? currentBranch : undefined }, `Pushed ${currentBranch} to origin.`); setPushArmed(false); }}>
                    <Upload size={16} /> Confirm push to origin
                  </button>
                  <button disabled={sourceBusy} onClick={() => setPushArmed(false)}><X size={16} /> Cancel</button>
                </div>
              </div>
            )}
            {operationOutput && <pre className="code-block compact-code">{operationOutput}</pre>}
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>Installer Build</h2>
              <button onClick={() => refreshInstallerBuild(true)} disabled={installerBusy || installerBuild?.running}><RefreshCcw size={14} /> Refresh</button>
            </div>
            <div className="tool-row">
              <div>
                <strong>Source-tab installer build</strong>
                <span>Runs the shared local installer pipeline from this connected git system and leaves the rest of the app responsive while it works.</span>
                <small>{installerBuild?.command || 'Starts scripts/build-installer.ps1, which packages the portable bundle and compiles the Inno installer.'}</small>
              </div>
              <div className="tool-actions">
                <Pill tone={installerStatusTone}>{installerBuild?.status || 'idle'}</Pill>
                <button className="primary" onClick={startInstallerBuild} disabled={installerBusy || installerBuild?.running}>
                  <Upload size={16} /> {installerBuild?.running ? 'Building...' : 'Build installer'}
                </button>
              </div>
            </div>
            <div className="connection-grid">
              <div><span>Started</span><strong>{installerBuild?.startedAt || 'Not started'}</strong></div>
              <div><span>Finished</span><strong>{installerBuild?.finishedAt || 'Not finished'}</strong></div>
              <div><span>Exit code</span><strong>{installerBuild?.exitCode ?? 'n/a'}</strong></div>
            </div>
            {installerBuild?.artifacts?.length ? (
              <div className="remote-list">
                {installerBuild.artifacts.map((artifact) => (
                  <div className="remote-row" key={artifact.path}>
                    <strong>{artifact.path}</strong>
                    <span>{artifact.type === 'file' && artifact.size != null ? `${artifact.size} bytes` : artifact.type} · {artifact.updatedAt}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="source-warning info">No installer artifacts detected yet.</div>
            )}
            {installerBuild?.output && <pre className="code-block compact-code">{installerBuild.output}</pre>}
          </div>

          <div className="panel">
            <h2>GitHub authentication</h2>
            <div className="connection-grid">
              <div>
                <span>Personal Access Token</span>
                <Pill tone={tokenConfigured ? 'good' : 'warn'}>{tokenConfigured ? 'Saved' : 'Not set'}</Pill>
                <small>Used for authenticated HTTPS pushes. Never stored in the git remote.</small>
              </div>
              <div>
                <span>GitHub CLI</span>
                <Pill tone={source?.github?.authenticated ? 'good' : 'warn'}>
                  {source?.github?.authenticated ? 'Logged in' : source?.github?.cliAvailable ? 'Login needed' : 'Unavailable'}
                </Pill>
                <small>{source?.github?.cliAvailable ? source?.github?.detail : source?.installHints?.githubCli}</small>
              </div>
              <div>
                <span>Git user</span>
                <strong>{source?.user?.name || 'Not set'}</strong>
                <small>{source?.user?.email || 'No email configured'}</small>
              </div>
            </div>
            <div className="decision-row">
              <button onClick={() => setShowTokenForm((value) => !value)} disabled={sourceBusy}><KeyRound size={16} /> {tokenConfigured ? 'Replace token' : 'Login with token (PAT)'}</button>
              <button onClick={() => openExternal('https://github.com/settings/tokens', 'GitHub token settings')} disabled={sourceBusy}><Github size={16} /> Create a PAT</button>
              {tokenConfigured && <button className="danger" onClick={() => action('/api/source/token/clear', {}, 'GitHub token cleared.')} disabled={sourceBusy}><X size={16} /> Clear token</button>}
              {source?.github?.cliAvailable && <button onClick={() => action('/api/source/login/github')} disabled={sourceBusy} title="Start GitHub CLI browser login"><Github size={16} /> gh login</button>}
            </div>
            {showTokenForm && (
              <div className="sc-token-form">
                <p>Create a token at GitHub → Settings → Developer settings → Tokens. Fine-grained tokens start with <code>github_pat_</code>; classic tokens start with <code>ghp_</code>. Grant this repository write access.</p>
                <div className="inline-form">
                  <input type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="ghp_... or github_pat_..." disabled={sourceBusy} />
                  <button className="primary" onClick={saveToken} disabled={sourceBusy || !tokenInput.trim()}><Check size={16} /> Save token</button>
                </div>
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>Remotes</h2>
              {currentRepoWebUrl && <button onClick={() => openExternal(currentRepoWebUrl, 'origin repository')} disabled={sourceBusy}><Github size={14} /> Open origin repo</button>}
            </div>
            {source?.remoteList?.length ? (
              <div className="remote-list">
                {source.remoteList.map((remote) => (
                  <div className="remote-row" key={remote.name}>
                    <strong>{remote.name}</strong>
                    <span>{remote.url}</span>
                  </div>
                ))}
              </div>
            ) : (
              <pre className="code-block">{source?.remotes || 'No Git remotes configured yet.'}</pre>
            )}
            <label>Set origin remote</label>
            <div className="inline-form">
              <input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} disabled={sourceBusy} />
              <button onClick={() => currentRemoteUrl
                ? requestSourceConfirmation({ title: 'Replace origin remote?', detail: `Future fetch, pull, and push operations will use ${remoteUrl}.`, path: '/api/source/remote', body: { url: remoteUrl }, success: 'Origin remote updated.' })
                : action('/api/source/remote', { url: remoteUrl }, 'Origin remote added.')}
                disabled={sourceBusy || !remoteUrl.trim()}><Github size={16} /> Set origin</button>
            </div>
            <label>Create GitHub repo</label>
            <div className="inline-form">
              <input value={githubRepo} onChange={(event) => setGithubRepo(event.target.value)} disabled={sourceBusy} placeholder="owner/repo" />
              <button onClick={() => action('/api/source/create/github', { repo: githubRepo, visibility: 'private' })} disabled={sourceBusy || !githubRepo.trim()}><Github size={16} /> Create private</button>
              <button onClick={() => openExternal('https://github.com/new', 'GitHub new repository page')} disabled={sourceBusy}>Open GitHub New</button>
            </div>
            <label>Create Hugging Face repo</label>
            <div className="inline-form">
              <input value={hfRepo} onChange={(event) => setHfRepo(event.target.value)} disabled={sourceBusy} placeholder="username/life-planner-models" />
              <select value={hfRepoType} onChange={(event) => setHfRepoType(event.target.value)} disabled={sourceBusy}>
                <option value="model">model</option>
                <option value="dataset">dataset</option>
                <option value="space">space</option>
              </select>
              <button onClick={() => action('/api/source/create/hf', { repo: hfRepo, type: hfRepoType, visibility: 'private' })} disabled={sourceBusy || !hfRepo.trim()}>Create private</button>
              <button onClick={() => openExternal('https://huggingface.co/new', 'Hugging Face new repository page')} disabled={sourceBusy}>Open HF New</button>
            </div>
          </div>

          <div className="panel">
            <h2>Tags</h2>
            <div className="inline-form">
              <input value={tagDraft.name} onChange={(event) => setTagDraft({ ...tagDraft, name: event.target.value })} placeholder="v1.0.0" disabled={sourceBusy} />
              <input value={tagDraft.message} onChange={(event) => setTagDraft({ ...tagDraft, message: event.target.value })} placeholder="Annotation (optional → lightweight)" disabled={sourceBusy} />
              <button className="primary" onClick={createTag} disabled={sourceBusy || !tagDraft.name.trim()}><Plus size={16} /> Create tag</button>
            </div>
            {tags.length === 0 ? (
              <div className="source-warning info">No tags yet.</div>
            ) : (
              <div className="sc-tag-list">
                {tags.map((tag) => (
                  <div className="sc-tag-row" key={tag.name}>
                    <strong>{tag.name}</strong>
                    <Pill tone={tag.annotated ? 'good' : 'default'}>{tag.annotated ? 'annotated' : 'light'}</Pill>
                    <span className="sc-tag-subject">{tag.subject}</span>
                    <div className="mini-actions">
                      <button onClick={() => pushTag(tag.name)} disabled={sourceBusy || !publicationAllowed} title={publicationAllowed ? 'Push this tag to origin' : source?.publication?.reason}><Upload size={13} /> Push</button>
                      <button className="danger" onClick={() => deleteTag(tag.name)} disabled={sourceBusy} title="Delete local tag"><Trash2 size={13} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const MODEL_SUGGESTIONS = [
  {
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    name: 'Qwen3.5 4B GGUF',
    size: '4B',
    tier: 'small',
    why: 'Public Qwen starter for modest hardware; Q4_K_M is the default file to try first.'
  },
  {
    repo: 'unsloth/Qwen3.5-9B-GGUF',
    name: 'Qwen3.5 9B GGUF',
    size: '9B',
    tier: 'medium',
    why: 'Public Qwen upgrade when RAM or VRAM has more headroom.'
  },
  {
    repo: 'unsloth/Qwen3.6-27B-GGUF',
    name: 'Qwen3.6 27B GGUF',
    size: '27B',
    tier: 'large',
    why: 'Public Qwen3.6 option for stronger local hardware.'
  },
  {
    repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
    name: 'Qwen3.6 35B-A3B GGUF',
    size: '35B-A3B',
    tier: 'large',
    why: 'Public Qwen3.6 MoE option for high-memory systems.'
  },
  {
    repo: 'bartowski/Phi-3.5-mini-instruct-GGUF',
    name: 'Phi 3.5 Mini Instruct',
    size: '3.8B',
    tier: 'small',
    why: 'Compact instruct model with modest RAM needs.'
  },
  {
    repo: 'bartowski/gemma-2-9b-it-GGUF',
    name: 'Gemma 2 9B IT',
    size: '9B',
    tier: 'large',
    why: 'Good upper-end local assistant candidate when RAM/VRAM allows.'
  },
  {
    repo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
    name: 'Mistral 7B Instruct v0.3',
    size: '7B',
    tier: 'medium',
    why: 'Reliable general instruct model for midrange machines.'
  },
  {
    repo: 'bartowski/Llama-3.1-8B-Instruct-GGUF',
    name: 'Llama 3.1 8B Instruct',
    size: '8B',
    tier: 'large',
    why: 'Strong general assistant option if memory headroom is comfortable.'
  }
];

function recommendedQwenForHardware(hardware) {
  if (!hardware) {
    return MODEL_SUGGESTIONS[0];
  }
  if (hardware.maxVramGb >= 24 || hardware.totalRamGb >= 96) {
    return MODEL_SUGGESTIONS.find((item) => item.repo === 'unsloth/Qwen3.6-35B-A3B-GGUF');
  }
  if (hardware.maxVramGb >= 16 || hardware.totalRamGb >= 64 || hardware.tier === 'large') {
    return MODEL_SUGGESTIONS.find((item) => item.repo === 'unsloth/Qwen3.6-27B-GGUF');
  }
  if (hardware.maxVramGb >= 8 || hardware.totalRamGb >= 24 || hardware.tier === 'medium') {
    return MODEL_SUGGESTIONS.find((item) => item.repo === 'unsloth/Qwen3.5-9B-GGUF');
  }
  return MODEL_SUGGESTIONS[0];
}

function SettingsView({ settings, setSettings, models, setModels, setNotice, openPrivateRepositorySync, openChatGptSync }) {
  const [modelFolders, setModelFolders] = useState((settings.modelFolders || []).join('\n'));
  const [hfToken, setHfToken] = useState(settings.hfToken || '');
  const [localModelEndpoint, setLocalModelEndpoint] = useState(settings.localModelEndpoint || '');
  const [localModelName, setLocalModelName] = useState(settings.localModelName || 'planner-assistant');
  const [localCodeModelEndpoint, setLocalCodeModelEndpoint] = useState(settings.localCodeModelEndpoint || '');
  const [localCodeModelName, setLocalCodeModelName] = useState(settings.localCodeModelName || '');
  const [localCodeModelLocalVerified, setLocalCodeModelLocalVerified] = useState(settings.localCodeModelLocalVerified === true);
  const [llamaCliPath, setLlamaCliPath] = useState(settings.llamaCliPath || '');
  const [llamaServerPath, setLlamaServerPath] = useState(settings.llamaServerPath || '');
  const [llamaServerPort, setLlamaServerPort] = useState(settings.llamaServerPort || 8080);
  const [llamaContextSize, setLlamaContextSize] = useState(settings.llamaContextSize || 16384);
  const [llamaGpuLayers, setLlamaGpuLayers] = useState(settings.llamaGpuLayers ?? 0);
  const [browserAgentMode, setBrowserAgentMode] = useState(settings.browserAgentMode || 'myChromeConnector');
  const [cloudEnabledProviders, setCloudEnabledProviders] = useState(settings.cloudEnabledProviders || ['ChatGPT']);
  const [cloudAccounts, setCloudAccounts] = useState([]);
  const browserAgentPort = window.location.port || '4177';
  const [repo, setRepo] = useState('unsloth/Qwen3.5-4B-GGUF');
  const [repoTouched, setRepoTouched] = useState(false);
  const [modelSearch, setModelSearch] = useState('Qwen GGUF');
  const [hardware, setHardware] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [modelDeleteArmed, setModelDeleteArmed] = useState(null);
  const [exportScope, setExportScope] = useState('all');
  const [publicExportPreview, setPublicExportPreview] = useState(null);
  const [publicExportBusy, setPublicExportBusy] = useState(false);
  const [partnerRelay, setPartnerRelay] = useState(null);
  const [partnerRelayEnabled, setPartnerRelayEnabled] = useState(true);
  const [partnerRelayHost, setPartnerRelayHost] = useState('https://relay.mostlyarmless.co.uk');
  const [partnerRelayPairingCode, setPartnerRelayPairingCode] = useState('');
  const [hfSearchResults, setHfSearchResults] = useState([]);
  const [hfFiles, setHfFiles] = useState([]);
  const [downloadFolder, setDownloadFolder] = useState(settings.modelDownloadFolder || '');
  const [responseDetail, setResponseDetail] = useState(normalizeDetailMode(settings.assistantResponseDetail));
  const [saveStatus, setSaveStatus] = useState('Settings load from local SQLite when the app starts. Click Save after changing model, endpoint, connector, or download values.');
  const recommendedQwen = useMemo(() => recommendedQwenForHardware(hardware), [hardware]);

  useEffect(() => {
    api('/api/hardware').then(setHardware).catch((err) => setNotice(err.message));
    api('/api/models/runtime').then((data) => {
      setRuntime(data);
      if (!llamaServerPath && data.llamaServerPath) setLlamaServerPath(data.llamaServerPath);
      if (!llamaCliPath && data.llamaCliPath) setLlamaCliPath(data.llamaCliPath);
    }).catch((err) => setNotice(err.message));
    api('/api/cloud/accounts').then(setCloudAccounts).catch((err) => setNotice(err.message));
    api('/api/partner-relay/status').then((status) => {
      setPartnerRelay(status);
      setPartnerRelayEnabled(Boolean(status.enabled));
      if (status.host) setPartnerRelayHost(status.host);
    }).catch((err) => setNotice(err.message));
  }, []);

  useEffect(() => {
    // One bounded pull on launch catches handoffs queued while LPS was off.
    // Artifacts remain in the separate review store; this is not model-context
    // ingestion and no retry loop is created when MA is unavailable.
    if (!partnerRelay?.enabled || !partnerRelay?.paired) return;
    syncPartnerRelay();
  }, [partnerRelay?.enabled, partnerRelay?.paired]);

  useEffect(() => {
    if (!hardware || !recommendedQwen || repoTouched) return;
    setRepo(recommendedQwen.repo);
  }, [hardware, recommendedQwen, repoTouched]);

  async function saveSettings() {
    setSaveStatus('Saving settings to local SQLite...');
    try {
      if (hfToken !== '[redacted]') {
        await api('/api/settings/huggingface-token', {
          method: 'POST',
          body: JSON.stringify({ token: hfToken })
        });
      }
      const data = await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          modelFolders: modelFolders.split('\n').map((s) => s.trim()).filter(Boolean),
          modelDownloadFolder: downloadFolder,
          localModelEndpoint,
          localModelName,
          localCodeModelEndpoint,
          localCodeModelName,
          localCodeModelLocalVerified,
          llamaCliPath,
          llamaServerPath,
          llamaServerPort: Number(llamaServerPort),
          llamaContextSize: Number(llamaContextSize),
          llamaGpuLayers: Number(llamaGpuLayers),
          browserAgentMode,
          cloudEnabledProviders,
          assistantResponseDetail: responseDetail
        })
      });
      setSettings(data);
      setRuntime(await api('/api/models/runtime'));
      setSaveStatus('Saved locally. These settings will load from SQLite on the next app start.');
      setNotice('Settings saved locally.');
    } catch (err) {
      setSaveStatus(`Save failed: ${err.message}`);
      setNotice(err.message);
      throw err;
    }
  }

  // Persist immediately so Chat reflects the new detail level without a Save
  // click or app restart — setSettings updates the shared state Chat reads.
  async function changeResponseDetail(value) {
    const next = normalizeDetailMode(value);
    setResponseDetail(next);
    try {
      const data = await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ assistantResponseDetail: next })
      });
      setSettings(data);
      setNotice(`Assistant response detail set to ${next}.`);
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function scan() {
    const data = await api('/api/models/scan', {
      method: 'POST',
      body: JSON.stringify({ folders: modelFolders.split('\n').map((s) => s.trim()).filter(Boolean) })
    });
    setModels(data.models);
    setNotice(`Detected ${data.discovered.length} verified GGUF model file(s).${data.issues?.length ? ` ${data.issues.length} folder/file issue(s) need attention.` : ''}`);
  }

  async function assign(id) {
    try {
      const result = await api(`/api/models/${id}/assign`, { method: 'POST', body: JSON.stringify({ role: 'Planner Assistant' }) });
      setModels(result.models);
      setRuntime(result.runtime);
      setNotice(result.runtimeError || result.message);
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function deleteModelFile(model) {
    try {
      const result = await api(`/api/models/${model.id}`, { method: 'DELETE', body: JSON.stringify({}) });
      setModels(result.models);
      setModelDeleteArmed(null);
      if (model.assigned_role) setRuntime(await api('/api/models/runtime'));
      setNotice(result.canRedownload
        ? `Deleted ${model.name}. It stays in the list — click Download to get it back.`
        : `Deleted ${model.name}'s file. No download source recorded; use Remove to clear the entry.`);
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function purgeModel(model) {
    try {
      const result = await api(`/api/models/${model.id}`, { method: 'DELETE', body: JSON.stringify({ purge: true }) });
      setModels(result.models);
      setModelDeleteArmed(null);
      setNotice(`Removed ${model.name} from the list.`);
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function redownloadModel(model) {
    try {
      setNotice(`Downloading ${model.name}...`);
      const result = await api(`/api/models/${model.id}/download`, { method: 'POST', body: JSON.stringify({}) });
      setModels(result.models);
      setNotice(`Downloaded ${model.name}.`);
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function startServer() {
    await saveSettings();
    const result = await api('/api/models/server/start', {
      method: 'POST',
      body: JSON.stringify({ llamaServerPath, port: Number(llamaServerPort), contextSize: Number(llamaContextSize), gpuLayers: Number(llamaGpuLayers) })
    });
    setRuntime(result.runtime);
    setNotice(result.message);
  }

  async function stopServer() {
    const result = await api('/api/models/server/stop', { method: 'POST' });
    setRuntime(result.runtime);
    setNotice(result.message);
  }

  async function lookupHF() {
    setHfFiles(await api(`/api/hf/files?repo=${encodeURIComponent(repo)}`));
  }

  async function searchHF() {
    setHfSearchResults(await api(`/api/hf/search?q=${encodeURIComponent(modelSearch)}`));
  }

  async function useRepo(nextRepo) {
    setRepoTouched(true);
    setRepo(nextRepo);
    setHfFiles(await api(`/api/hf/files?repo=${encodeURIComponent(nextRepo)}`));
  }

  async function download(file) {
    await saveSettings();
    const result = await api('/api/hf/download', { method: 'POST', body: JSON.stringify({ repo, file: file.path, folder: downloadFolder || undefined }) });
    setModels(result.models);
    setRuntime(result.runtime);
    setNotice(result.runtimeError || `Verified, loaded, and started ${file.path}.`);
  }

  async function setCloudProviderEnabled(provider, enabled) {
    const next = enabled ? [...new Set([...cloudEnabledProviders, provider])] : cloudEnabledProviders.filter((name) => name !== provider);
    setCloudEnabledProviders(next);
    try {
      const data = await api('/api/settings', { method: 'POST', body: JSON.stringify({ cloudEnabledProviders: next }) });
      setSettings(data);
      setCloudAccounts(await api('/api/cloud/accounts'));
      setNotice(enabled ? `${provider} enabled. Connect its browser session to show it in Chat.` : `${provider} removed from Chat.`);
    } catch (err) { setNotice(err.message); }
  }

  async function savePartnerRelay() {
    try {
      const status = await api('/api/partner-relay/config', {
        method: 'POST',
        body: JSON.stringify({
          enabled: partnerRelayEnabled,
          host: partnerRelayHost
        })
      });
      setPartnerRelay(status);
      setNotice(status.enabled ? 'Partner relay is configured. Sync remains explicit and review-gated.' : 'Partner relay is disabled.');
    } catch (err) { setNotice(err.message); }
  }

  async function pairPartnerRelay() {
    try {
      const status = await api('/api/partner-relay/pair', {
        method: 'POST',
        body: JSON.stringify({ pairingCode: partnerRelayPairingCode })
      });
      setPartnerRelay(status);
      setPartnerRelayPairingCode('');
      setNotice('MA-Dev pairing complete. This LPS device can now pull Captain-approved handoff PDFs for review.');
    } catch (err) { setNotice(err.message); }
  }

  async function syncPartnerRelay() {
    try {
      const result = await api('/api/partner-relay/sync', { method: 'POST', body: '{}' });
      setPartnerRelay(await api('/api/partner-relay/status'));
      setNotice(result.pulled ? `Received ${result.pulled} reviewed handoff checkpoint(s).` : 'Partner relay checked: no new handoff checkpoints.');
    } catch (err) { setNotice(err.message); }
  }

  async function previewPublicExport() {
    setPublicExportBusy(true);
    try {
      const preview = await api('/api/export/public/preview', { method: 'POST', body: '{}' });
      setPublicExportPreview(preview);
      setNotice(`Public export preview: ${preview.included} eligible, ${preview.blocked} blocked, ${preview.unknown} unknown.`);
    } catch (err) { setNotice(err.message); }
    finally { setPublicExportBusy(false); }
  }

  async function confirmPublicExport() {
    if (!publicExportPreview) return;
    setPublicExportBusy(true);
    try {
      const exported = await api('/api/export/public/confirm', {
        method: 'POST',
        body: JSON.stringify({ confirmationId: publicExportPreview.confirmationId, token: publicExportPreview.token })
      });
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'life-planner-public-export.json'; link.click();
      URL.revokeObjectURL(url);
      setPublicExportPreview(null);
      setNotice(`Downloaded classified public export with ${exported.projects.length + exported.knowledge_items.length} record(s).`);
    } catch (err) { setNotice(err.message); }
    finally { setPublicExportBusy(false); }
  }

  return (
    <section className="settings-grid">
      <div className="panel service-sync-panel">
        <h2>Connected services</h2>
        <p>Connect services deliberately. GitHub sync remains review-gated; ChatGPT opens in its isolated Life Planner provider window and does not pair the Chrome Browser Agent automatically.</p>
        <div className="decision-row">
          <button onClick={openPrivateRepositorySync} title="Open the private repository sync controls"><Github size={16} /> Private repo sync <RefreshCcw size={14} /></button>
          <button onClick={openChatGptSync} title="Open ChatGPT provider window"><ChatGptMark size={16} /> Open ChatGPT <RefreshCcw size={14} /></button>
        </div>
      </div>
      <div className="panel service-sync-panel">
        <h2>MA-Dev partner relay</h2>
        <p>Review-gated checkpoint delivery from MA-Dev. Fresh installs are ready to sync once Alex completes pairing; received PDFs stay outside local-agent context until explicit review.</p>
        <label className="checkbox-row"><input type="checkbox" checked={partnerRelayEnabled} onChange={(event) => setPartnerRelayEnabled(event.target.checked)} /> Enable MA-Dev sync</label>
        <label>Relay host<input value={partnerRelayHost} onChange={(event) => setPartnerRelayHost(event.target.value)} placeholder="https://relay.mostlyarmless.co.uk" /></label>
        <label>One-time pairing key<input type="password" value={partnerRelayPairingCode} onChange={(event) => setPartnerRelayPairingCode(event.target.value)} placeholder={partnerRelay?.paired ? 'Paired locally; enter a new MA key only to rotate' : 'Generate in MA-Dev, then enter once'} autoComplete="one-time-code" /></label>
        <div className="decision-row">
          <button onClick={savePartnerRelay}>Save relay</button>
          <button onClick={pairPartnerRelay} disabled={!partnerRelayPairingCode.trim()}>Pair this LPS device</button>
          <button onClick={syncPartnerRelay} disabled={!partnerRelay?.enabled}>Sync approved handoffs</button>
        </div>
        {partnerRelay && <small>{partnerRelay.enabled ? `Enabled · ${partnerRelay.received || 0} received checkpoint(s) · cursor ${partnerRelay.cursor || 0}` : 'Disabled until explicitly paired.'}</small>}
      </div>
      <div className="panel">
        <h2>Assistant response detail</h2>
        <p>Choose how much technical information Life Planner displays with assistant replies. Clean provides normal conversational answers. Detailed shows sources and memory actions. Developer shows full local runtime diagnostics.</p>
        <label>Detail level</label>
        <select value={responseDetail} onChange={(event) => changeResponseDetail(event.target.value)}>
          <option value="clean">Clean — conversational answer only</option>
          <option value="detailed">Detailed — answer plus sources and memory actions</option>
          <option value="developer">Developer — answer plus full runtime diagnostics</option>
        </select>
        <div className="source-warning info">
          <strong>Applies immediately</strong>
          <small>Saved to local settings and applied to Chat right away, including how diagnostics are shown for saved replies that already carry structured metadata. Markdown always renders; this only controls diagnostic visibility. Older replies keep their original wording.</small>
        </div>
      </div>
      <div className="panel">
        <h2>Model Picker</h2>
        <p>Hardware-aware suggestions for local GGUF instruct models.</p>
        <div className="connection-grid">
          <div><span>CPU</span><strong>{hardware?.cpu || 'Detecting...'}</strong><small>{hardware?.cores || 0} logical core(s)</small></div>
          <div><span>System RAM</span><strong>{hardware ? `${hardware.totalRamGb} GB` : 'Detecting...'}</strong><small>{hardware?.recommendation || 'Checking local hardware.'}</small></div>
          <div>
            <span>GPU / VRAM</span>
            <strong>{hardware?.gpus?.[0]?.name || 'No GPU detected'}</strong>
            <small>
              {hardware?.maxVramGb
                ? `${hardware.maxVramGb} GB VRAM via ${hardware.gpus?.[0]?.source || 'hardware probe'}${hardware.gpus?.[0]?.fallbackVramGb && hardware.gpus[0].fallbackVramGb !== hardware.maxVramGb ? `; Windows fallback said ${hardware.gpus[0].fallbackVramGb} GB` : ''}`
                : 'CPU/RAM mode likely.'}
            </small>
          </div>
          <div><span>Suggested tier</span><Pill tone={hardware?.tier === 'large' ? 'good' : hardware?.tier === 'medium' ? 'info' : 'warn'}>{hardware?.tier || 'detecting'}</Pill><small>Start conservative; upgrade if responses are fast.</small></div>
        </div>
        <label>Filter suggestions</label>
        <input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="7B instruct GGUF" />
        {recommendedQwen && (
          <div className="runtime-card">
            <Pill tone="good">Public default</Pill>
            <strong>{recommendedQwen.name}</strong>
            <span>{recommendedQwen.why}</span>
            <small>{recommendedQwen.repo}. Public file lookup and download do not need an HF token unless Hugging Face marks a repo gated/private.</small>
            <button onClick={() => useRepo(recommendedQwen.repo)}>Use recommended Qwen</button>
          </div>
        )}
        <div className="model-suggestions">
          {MODEL_SUGGESTIONS
            .filter((item) => `${item.repo} ${item.name} ${item.size} ${item.tier}`.toLowerCase().includes(modelSearch.toLowerCase()) || item.tier === hardware?.tier)
            .map((item) => (
              <div className="suggestion-row" key={item.repo}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.size} - {item.tier} - {item.why}</span>
                  <small>{item.repo}</small>
                </div>
                <button onClick={() => useRepo(item.repo)}>Use</button>
              </div>
            ))}
        </div>
      </div>
      <div className="panel">
        <h2>Local Model Registry</h2>
        <p>Rescan folders for real GGUF files, verify each file is readable, and assign one model to Planner Assistant.</p>
        <div className="runtime-card">
          <Pill tone={runtime?.endpointConfigured || runtime?.assigned ? 'good' : 'warn'}>{runtime?.endpointConfigured ? 'Endpoint configured' : runtime?.assigned ? 'Model assigned' : 'No model assigned'}</Pill>
          <strong>{runtime?.endpointConfigured ? runtime.endpointModelName : runtime?.model?.name || 'Planner Assistant unavailable'}</strong>
          <span>{runtime?.managedServerRunning ? `Managed llama-server running: ${runtime.managedEndpoint}` : runtime?.endpointConfigured ? `Endpoint: ${runtime.endpoint}` : runtime?.llamaCliConfigured ? `llama-cli: ${runtime.llamaCliExists ? 'found' : 'missing'}` : 'Configure a local endpoint, llama-server, or llama-cli to generate chat responses.'}</span>
        </div>
        <div className={cx('source-warning', runtime?.endpointConfigured || runtime?.assigned ? 'info' : 'warn')}>
          <strong>{runtime?.endpointConfigured || runtime?.assigned ? 'Model setup saved' : 'Model setup needed'}</strong>
          <small>{saveStatus}</small>
        </div>
        <label>Model folders</label>
        <textarea value={modelFolders} onChange={(event) => setModelFolders(event.target.value)} placeholder="C:\\Models&#10;D:\\LLMs" />
        <label>OpenAI-compatible local endpoint</label>
        <input value={localModelEndpoint} onChange={(event) => setLocalModelEndpoint(event.target.value)} placeholder="http://127.0.0.1:8080" />
        <label>Endpoint model name</label>
        <input value={localModelName} onChange={(event) => setLocalModelName(event.target.value)} placeholder="qwen2.5:7b-instruct" />
        <label>Optional coding-worker endpoint</label>
        <input value={localCodeModelEndpoint} onChange={(event) => setLocalCodeModelEndpoint(event.target.value)} placeholder="Blank uses the chat endpoint or bundled llama.cpp" />
        <label>Optional coding-worker model name</label>
        <input value={localCodeModelName} onChange={(event) => setLocalCodeModelName(event.target.value)} placeholder="Blank uses the selected local model" />
        <label className="temporary-chat-option">
          <input
            type="checkbox"
            checked={localCodeModelLocalVerified}
            onChange={(event) => setLocalCodeModelLocalVerified(event.target.checked)}
          />
          I confirm the configured coding/chat endpoint runs inference and model weights on this machine.
        </label>
        <small>Loopback alone is not proof. Leave this clear for a proxy or cloud-backed endpoint; local coding authority will fail closed. Bundled llama.cpp is verified automatically.</small>
        <label>llama-cli path</label>
        <input value={llamaCliPath} onChange={(event) => setLlamaCliPath(event.target.value)} placeholder="C:\\llama.cpp\\build\\bin\\llama-cli.exe" />
        <label>llama-server path</label>
        <input value={llamaServerPath} onChange={(event) => setLlamaServerPath(event.target.value)} placeholder="Bundled automatically; override only for a custom build" />
        <div className="inline-form">
          <input type="number" value={llamaServerPort} onChange={(event) => setLlamaServerPort(event.target.value)} placeholder="8080" />
          <input type="number" min="2048" max="131072" step="1024" value={llamaContextSize} onChange={(event) => setLlamaContextSize(event.target.value)} placeholder="16384" />
          <input type="number" min="0" max="999" step="1" value={llamaGpuLayers} onChange={(event) => setLlamaGpuLayers(event.target.value)} aria-label="llama.cpp GPU layers" />
        </div>
        <small>Context: use at least 16384 for local coding. GPU layers default to 0 (CPU) so Planner remains usable while a larger local coding model occupies GPU VRAM.</small>
        <div className="decision-row">
          <button onClick={saveSettings}><Check size={16} /> Save</button>
          <button className="primary" onClick={scan}><RefreshCcw size={16} /> Rescan GGUF</button>
          <button onClick={startServer} disabled={!runtime?.llamaServerExists || !runtime?.assigned}><Bot size={16} /> Start / verify server</button>
          <button onClick={stopServer} disabled={!runtime?.managedServerRunning}><X size={16} /> Stop server</button>
        </div>
        <div className="table-list">
          {models.length === 0 ? (
            <Empty title="No local models" body="Scan a folder for .gguf files, or download one from Hugging Face above." />
          ) : models.map((model) => (
            <div className="model-row" key={model.id}>
              <div>
                <strong>{model.name}</strong>
                <span>{model.path}</span>
                <small>
                  {model.assigned_role
                    ? <Pill tone="good">{model.assigned_role}</Pill>
                    : model.available
                      ? <Pill tone="info">Downloaded · ready to load</Pill>
                      : (model.hf_repo
                        ? <Pill tone="warn">Not downloaded</Pill>
                        : <Pill tone="bad">{model.file_error || 'File missing'}</Pill>)}
                  {model.size_bytes && model.available ? ` ${(model.size_bytes / 1e9).toFixed(2)} GB` : ''}
                  {!model.available && model.hf_repo ? ` ${model.hf_repo}` : ''}
                </small>
              </div>
              <div className="mini-actions">
                {model.available ? (
                  <>
                    <button className={model.assigned_role ? 'primary' : ''} onClick={() => assign(model.id)} title="Assign as Planner Assistant">
                      {model.assigned_role ? 'Assigned' : 'Load'}
                    </button>
                    {modelDeleteArmed === model.id ? (
                      <>
                        <button className="danger" onClick={() => deleteModelFile(model)} title="Delete the .gguf file from disk (entry stays, re-downloadable)"><Trash2 size={14} /> Delete file</button>
                        <button onClick={() => setModelDeleteArmed(null)}><X size={14} /> Cancel</button>
                      </>
                    ) : (
                      <button className="danger" onClick={() => setModelDeleteArmed(model.id)} title="Delete the file from disk"><Trash2 size={14} /> Delete</button>
                    )}
                  </>
                ) : model.hf_repo ? (
                  <>
                    <button className="primary" onClick={() => redownloadModel(model)} title="Re-download from Hugging Face"><Download size={14} /> Download</button>
                    <button className="danger" onClick={() => purgeModel(model)} title="Remove from list"><X size={14} /> Remove</button>
                  </>
                ) : (
                  <button className="danger" onClick={() => purgeModel(model)} title="Remove this stale entry (no download source)"><Trash2 size={14} /> Remove</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <h2>Browser Agent</h2>
        <p>Use the Chrome connector so browser-agent prompts run in the user's normal Chrome tabs.</p>
        <label>Automation mode</label>
        <select value={browserAgentMode} onChange={(event) => setBrowserAgentMode(event.target.value)}>
          <option value="myChromeConnector">My Chrome connector</option>
          <option value="debugChrome">Dedicated debug Chrome profile</option>
        </select>
        <label>Local connector port</label>
        <code>{browserAgentPort}</code>
        <div className="source-warning info">
          <strong>Chrome connector</strong>
          <small>Load the unpacked extension from browser-extension/lps-browser-agent in the same Chrome profile where the user is logged into ChatGPT, Gemini, Grok, or Claude. It talks only to 127.0.0.1:{browserAgentPort}; no public firewall rule is needed for localhost-only use.</small>
        </div>
        <div className="source-warning warn">
          <strong>Setup-gated</strong>
          <small>Saving the mode does not sign in, bypass verification, or start cloud automation. The connector port follows the running app and its generated pairing file.</small>
        </div>
      </div>
      <div className="panel">
        <h2>Hugging Face Download</h2>
        <p>Public GGUF repos can be listed and downloaded without a token. Add a token only for private or gated models.</p>
        <label>HF token</label>
        <input value={hfToken} onChange={(event) => setHfToken(event.target.value)} type="password" placeholder="Optional" />
        <label>Download folder</label>
        <input value={downloadFolder} onChange={(event) => setDownloadFolder(event.target.value)} placeholder="models" />
        <label>Repo</label>
        <div className="inline-form">
          <input value={repo} onChange={(event) => {
            setRepoTouched(true);
            setRepo(event.target.value);
          }} placeholder="unsloth/Qwen3.5-4B-GGUF" />
          <button onClick={lookupHF}>Files</button>
        </div>
        <div className="inline-form">
          <input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Search Hugging Face GGUF models" />
          <button onClick={searchHF}><SearchCheck size={16} /> Search</button>
        </div>
        <div className="table-list">
          {hfSearchResults.map((model) => (
            <div className="model-row" key={model.id}>
              <div>
                <strong>{model.id}</strong>
                <span>{model.downloads} downloads - {model.likes} likes</span>
              </div>
              <button onClick={() => useRepo(model.id)}>Files</button>
            </div>
          ))}
        </div>
        <div className="table-list">
          {hfFiles.map((file) => (
            <div className="model-row" key={file.path}>
              <div>
                <strong>{file.path}</strong>
                <span>{file.size ? `${Math.round(file.size / 1024 / 1024)} MB` : 'GGUF'}</span>
              </div>
              <button onClick={() => download(file)}><Download size={16} /></button>
            </div>
          ))}
        </div>
      </div>
      <div className="panel import-export">
        <h2>Import / Export</h2>
        <p>Build a portable context snapshot in the format that suits the next task. Files are exchange artifacts; SQLite remains canonical.</p>
        <label>Export scope</label>
        <select value={exportScope} onChange={(event) => setExportScope(event.target.value)}>
          <option value="all">Everything</option>
          <option value="projects">Projects</option>
          <option value="knowledge">Knowledge</option>
          <option value="roadmap">Development roadmap</option>
          <option value="chat">Chat history</option>
        </select>
        <div className="decision-row">
          <a className="primary link-button" href={`/api/export/context.pdf?scope=${exportScope}`}><Download size={16} /> PDF</a>
          <a className="link-button" href={`/api/export/context.html?scope=${exportScope}`}><Download size={16} /> Interactive HTML</a>
          <a className="link-button" href={`/api/export/context.md?scope=${exportScope}`}><Download size={16} /> Markdown</a>
          <a className="link-button" href={`/api/export/context.txt?scope=${exportScope}`}><Download size={16} /> Text</a>
          <a className="link-button" href={`/api/export/context.json?scope=${exportScope}`}><Download size={16} /> JSON</a>
        </div>
        <a className="link-button" href="/api/export/json?mode=backup"><Download size={16} /> Export Local Backup</a>
        <div className="source-warning warn">
          <strong>Classified public export</strong>
          <small>Only records explicitly marked public-shareable are eligible. Private, local-shareable, and unknown records are excluded. Review is bound to the current server-side selection.</small>
          {publicExportPreview && <small>{publicExportPreview.included} eligible; {publicExportPreview.blocked} blocked; {publicExportPreview.unknown} unknown. Confirmation expires at {new Date(publicExportPreview.expiresAt).toLocaleTimeString()}.</small>}
          <div className="decision-row">
            <button onClick={previewPublicExport} disabled={publicExportBusy}><SearchCheck size={16} /> {publicExportBusy ? 'Working…' : 'Preview public export'}</button>
            <button className="primary" onClick={confirmPublicExport} disabled={publicExportBusy || !publicExportPreview}><Download size={16} /> Confirm and download public JSON</button>
          </div>
        </div>
        <h3>Cloud accounts</h3>
        <p>Choose the providers you use. Each enabled provider appears as a small button in Chat. “Sign in” opens that provider in your normal browser; finish sign-in there, then keep the LPS Chrome connector enabled.</p>
        <div className="provider-settings">
          {(cloudAccounts.length ? cloudAccounts : CLOUD_AGENTS.map((agent) => ({ provider: agent.name, url: agent.url, enabled: cloudEnabledProviders.includes(agent.name), connected: false, model: `${agent.name} (browser-assisted)`, transport: 'browser session connector', actionable: 'Checking connection…' }))).map((account) => <div key={account.provider} className="provider-setting"><div><label className="temporary-chat-option"><input type="checkbox" checked={account.enabled} onChange={(event) => setCloudProviderEnabled(account.provider, event.target.checked)} />{account.provider}</label><small>{account.transport} · {account.connected ? 'Connected' : 'Disconnected'} · {account.model}<br />{account.actionable}</small></div><button onClick={async () => { try { await api('/api/browser/open-external', { method: 'POST', body: JSON.stringify({ url: account.url }) }); setNotice(`Opened ${account.provider} sign-in in your normal browser. Then install/reload the LPS Browser Agent and open a signed-in tab.`); } catch (err) { setNotice(err.message); } }}>{account.connected ? 'Reconnect' : 'Connect browser session'}</button></div>)}
        </div>
        <small>Saving provider choices does not share a prompt or credentials with any provider. Chat sends only after the visible exact-prompt review and an active connector.</small>
        <PdfImport setNotice={setNotice} />
        <JsonImport setNotice={setNotice} />
        <MarkdownImport setNotice={setNotice} />
      </div>
    </section>
  );
}

function PdfImport({ setNotice }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  async function importPdf() {
    if (!file || busy) return;
    setBusy(true);
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('PDF imports are limited to 15 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const result = await api('/api/import/pdf', { method: 'POST', body: JSON.stringify({ name: file.name, base64: btoa(binary) }) });
      setFile(null);
      setNotice(`Imported ${file.name}: ${result.pages} page(s), ${result.characters.toLocaleString()} extracted characters. Pending review.`);
    } catch (err) {
      setNotice(`PDF import failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="import-preview">
      <strong>Import PDF for local processing</strong>
      <small>Text is extracted locally, fingerprinted, and stored as a pending-review source document.</small>
      <input type="file" accept="application/pdf,.pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} />
      <button onClick={importPdf} disabled={!file || busy}><Upload size={16} /> {busy ? 'Extracting...' : 'Import PDF'}</button>
    </div>
  );
}

function JsonImport({ setNotice }) {
  const [jsonText, setJsonText] = useState('');
  const [preview, setPreview] = useState(null);
  const [importDuplicates, setImportDuplicates] = useState(false);
  async function previewJson() {
    try {
      const parsed = JSON.parse(jsonText);
      setPreview(await api('/api/import/json/preview', { method: 'POST', body: JSON.stringify(parsed) }));
    } catch (err) {
      setNotice(`JSON preview failed: ${err.message}`);
    }
  }
  async function importJson() {
    try {
      const parsed = JSON.parse(jsonText);
      const result = await api(`/api/import/json?mode=${importDuplicates ? 'import_all' : 'skip_duplicates'}`, { method: 'POST', body: JSON.stringify(parsed) });
      setJsonText('');
      setPreview(null);
      setNotice(`JSON imported: ${result.projects} project(s), ${result.knowledge_items} knowledge item(s). Skipped ${result.skipped_projects} project duplicate(s), ${result.skipped_knowledge_items} knowledge duplicate(s).`);
    } catch (err) {
      setNotice(`JSON import failed: ${err.message}`);
    }
  }
  return (
    <>
      <textarea value={jsonText} onChange={(event) => setJsonText(event.target.value)} placeholder='{"projects":[],"knowledge_items":[]}' />
      <label className="toggle-row">
        <input type="checkbox" checked={importDuplicates} onChange={(event) => setImportDuplicates(event.target.checked)} />
        Import duplicates
      </label>
      {preview && (
        <div className="import-preview">
          <strong>Preview</strong>
          <span>{preview.projects} project(s), {preview.knowledge_items} knowledge item(s)</span>
          <small>{preview.duplicate_projects} duplicate project(s), {preview.duplicate_knowledge_items} duplicate knowledge item(s)</small>
          {preview.ignored_sections?.length > 0 && <small>Ignored: {preview.ignored_sections.join(', ')}</small>}
        </div>
      )}
      <div className="decision-row">
        <button onClick={previewJson}><SearchCheck size={16} /> Preview JSON</button>
        <button onClick={importJson} disabled={!preview}><Upload size={16} /> Import JSON</button>
      </div>
    </>
  );
}

function MarkdownImport({ setNotice }) {
  const [markdown, setMarkdown] = useState('');
  async function importMarkdown() {
    await api('/api/import/markdown', { method: 'POST', body: JSON.stringify({ markdown }) });
    setMarkdown('');
    setNotice('Markdown imported as a pending source document.');
  }
  return (
    <>
      <textarea value={markdown} onChange={(event) => setMarkdown(event.target.value)} placeholder="# Source document..." />
      <button onClick={importMarkdown}><Upload size={16} /> Import Markdown</button>
    </>
  );
}

// Gate the app behind sign-in only when it's actually needed: a plain
// single-user server (desktop, or a phone reaching it via adb reverse) has
// no concept of accounts at all, so this checks /api/auth/me once and, for
// that ordinary case, renders the app immediately with no login screen ever
// shown -- exactly the pre-existing experience. Only a real hosted
// (LIFE_PLANNER_MULTI_USER) deployment with no/expired token shows the form.
function NativeAuthGate({ children }) {
  const [state, setState] = useState('checking');
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [serverUrl, setServerUrl] = useState(API);
  const [busy, setBusy] = useState(false);

  async function checkAuth() {
    setState('checking');
    try {
      const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      const response = await fetch(`${API}/api/auth/me`, { headers });
      if (response.status === 401) { setState('needs-auth'); return; }
      const payload = await response.json();
      setState(payload.ok && (!payload.data.multiUser || authToken) ? 'ready' : 'needs-auth');
    } catch {
      // Server unreachable -- let the app itself render and explain that
      // (the existing runtimeUnreachable messaging), rather than blocking
      // everything behind this gate on a network failure.
      setState('ready');
    }
  }

  useEffect(() => { checkAuth(); }, []);

  async function submit(action) {
    setBusy(true);
    setError('');
    try {
      setNativeServerUrl(serverUrl.trim().replace(/\/+$/, ''));
      const response = await fetch(`${API}/api/auth/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'register' ? { username, password, inviteCode } : { username, password })
      });
      const payload = await response.json();
      if (!payload.ok) { setError(payload.error || 'Sign-in failed.'); return; }
      setAuthToken(payload.data.token);
      setState('ready');
    } catch (err) {
      setError(`Could not reach ${serverUrl}. Check the server address and try again.`);
    } finally {
      setBusy(false);
    }
  }

  if (state === 'checking') return <div className="auth-gate"><p>Connecting…</p></div>;
  if (state === 'ready') return children;

  return (
    <div className="auth-gate">
      <h1>LifePlanSystem</h1>
      <p>Sign in or create an account on this Closed Beta server.</p>
      <label>
        Server address
        <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://your-beta-server.example.com" />
      </label>
      <label>
        Username
        <input value={username} onChange={(event) => setUsername(event.target.value)} autoCapitalize="none" autoCorrect="off" />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label>
        Invite code <span className="auth-gate-hint">(only needed to create a new account)</span>
        <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} autoCapitalize="none" autoCorrect="off" />
      </label>
      {error && <p className="auth-gate-error" role="alert">{error}</p>}
      <div className="auth-gate-actions">
        <button disabled={busy || !username || !password} onClick={() => submit('login')}>Sign in</button>
        <button disabled={busy || !username || !password} onClick={() => submit('register')}>Create account</button>
      </div>
    </div>
  );
}

const rootElement = document.getElementById('root');
window.__lifePlannerRoot ||= createRoot(rootElement);
window.__lifePlannerRoot.render(Capacitor.isNativePlatform() ? <NativeAuthGate><App /></NativeAuthGate> : <App />);
