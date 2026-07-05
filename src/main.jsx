import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  Clipboard,
  Clock3,
  Download,
  FileText,
  FolderKanban,
  Github,
  GitBranch,
  Globe2,
  ListChecks,
  MessageSquareText,
  Moon,
  Plus,
  RefreshCcw,
  SearchCheck,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
  X
} from 'lucide-react';
import './styles.css';

const API = '';

const nav = [
  { id: 'planner', label: 'Planner', icon: ListChecks },
  { id: 'chat', label: 'Chat', icon: MessageSquareText },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'repository', label: 'Repository', icon: FileText },
  { id: 'calibration', label: 'Calibration', icon: SearchCheck },
  { id: 'source', label: 'Source', icon: GitBranch },
  { id: 'browser', label: 'Browser', icon: Globe2 },
  { id: 'tooling', label: 'Tooling', icon: Wrench },
  { id: 'settings', label: 'Settings', icon: Settings }
];

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || 'Request failed');
  return payload.data;
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

function App() {
  const [view, setView] = useState('planner');
  const [theme, setTheme] = useState(() => localStorage.getItem('life-planner-theme') || 'dark');
  const [boot, setBoot] = useState(null);
  const [planner, setPlanner] = useState(null);
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

  async function refreshAll() {
    const data = await api('/api/bootstrap');
    setBoot(data);
    setPlanner(data.planner);
    setProjects(data.projects);
    setModels(data.models);
    setSettings(data.settings || {});
    setSessions(data.sessions);
    if (!selectedSession && data.sessions[0]) setSelectedSession(data.sessions[0].id);
    const mem = await api('/api/memory');
    setMemory(mem);
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
    if (!selectedSession) return;
    api(`/api/chat/sessions/${selectedSession}/messages`).then(setMessages).catch((err) => setNotice(err.message));
  }, [selectedSession]);

  const activeSession = useMemo(() => sessions.find((session) => session.id === selectedSession), [sessions, selectedSession]);

  async function reloadPlanner() {
    setPlanner(await api('/api/planner'));
    setMemory(await api('/api/memory'));
  }

  async function runPlannerRefresh() {
    const result = await api('/api/planner/refresh', { method: 'POST' });
    setPlanner(result.planner);
    setMemory(await api('/api/memory'));
    setNotice(result.message);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><img src="/life-planner-logo.png" alt="" /></div>
          <div>
            <strong>Life Planner</strong>
            <span>Local-first assistant</span>
          </div>
        </div>
        <nav>
          {nav.map((entry) => {
            const Icon = entry.icon;
            return (
              <button key={entry.id} className={cx('nav-item', view === entry.id && 'selected')} onClick={() => setView(entry.id)}>
                <Icon size={18} />
                <span>{entry.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <Pill tone="good">SQLite</Pill>
          <span>{boot?.settings?.storageLocation || 'Local database'}</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{nav.find((entry) => entry.id === view)?.label}</h1>
            <p>One source of truth, many views. Chat becomes candidate memory only after review.</p>
          </div>
          <div className="top-actions">
            {notice && <span className="notice">{notice}</span>}
            <button className="icon-button" onClick={refreshCurrentView} disabled={refreshBusy} aria-label="Refresh" title={refreshBusy ? 'Refreshing current view...' : 'Refresh current view'}>
              <RefreshCcw size={18} />
            </button>
            <ThemeToggle theme={theme} setTheme={setTheme} />
          </div>
        </header>

        {view === 'planner' && <Planner planner={planner} refresh={reloadPlanner} runRefresh={runPlannerRefresh} />}
        {view === 'chat' && (
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
          />
        )}
        {view === 'memory' && <Memory memory={memory} refresh={reloadPlanner} />}
        {view === 'approvals' && <ApprovalQueue setNotice={setNotice} refreshPlanner={reloadPlanner} />}
        {view === 'projects' && <Projects projects={projects} setProjects={setProjects} setNotice={setNotice} refreshAll={refreshAll} />}
        {view === 'repository' && <RepositoryExplorer setNotice={setNotice} refreshSignal={refreshSignal} />}
        {view === 'calibration' && <Calibration setNotice={setNotice} refreshSignal={refreshSignal} />}
        {view === 'source' && <SourceControl setNotice={setNotice} refreshSignal={refreshSignal} />}
        {view === 'browser' && <BrowserConsult setNotice={setNotice} refresh={reloadPlanner} refreshSignal={refreshSignal} />}
        {view === 'tooling' && <Tooling setNotice={setNotice} refreshSignal={refreshSignal} />}
        {view === 'settings' && (
          <SettingsView
            settings={settings}
            setSettings={setSettings}
            models={models}
            setModels={setModels}
            setNotice={setNotice}
          />
        )}
      </main>
    </div>
  );
}

function Planner({ planner, refresh, runRefresh }) {
  if (!planner) return <div className="loading">Loading planner context...</div>;
  const nextBestBody = planner.nextBest?.body
    || (planner.nextBest?.action_type ? 'Review and approve, deny, or defer this proposed change.' : 'Add goals, projects, or memory candidates to feed the planner.');
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
        <button className="primary subtle" onClick={runRefresh}>Run planner refresh</button>
      </div>

      <div className="bucket-grid">
        {buckets.map(([title, items, tone]) => (
          <div className="bucket" key={title}>
            <div className="bucket-title">
              <h3>{title}</h3>
              <Pill tone={tone}>{items.length}</Pill>
            </div>
            {items.length ? items.map((item) => <ItemRow key={`${title}-${item.id}`} item={item} />) : <Empty title="Nothing here" body="The database has no matching active items." />}
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

function Chat({ sessions, activeSession, selectedSession, setSelectedSession, setSessions, messages, setMessages, refreshAll, setNotice }) {
  const [draft, setDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState('');
  const [repoFiles, setRepoFiles] = useState([]);
  const [contextFiles, setContextFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState('');

  async function send() {
    if (!draft.trim() || !selectedSession || chatBusy) return;
    setChatBusy(true);
    try {
      const result = await api(`/api/chat/sessions/${selectedSession}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: draft })
      });
      setMessages((current) => [...current, ...result.messages]);
      setRuntimeMode(result.runtime || '');
      setDraft('');
      refreshAll();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setChatBusy(false);
    }
  }

  async function newSession() {
    const session = await api('/api/chat/sessions', { method: 'POST', body: JSON.stringify({ title: 'New planning chat' }) });
    setSessions((current) => [session, ...current]);
    setSelectedSession(session.id);
  }

  async function patchSession(id, body) {
    const updated = await api(`/api/chat/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    setSessions((current) => current.map((session) => (session.id === id ? updated : session)).filter((session) => !session.deleted));
    if (body.deleted && selectedSession === id) setSelectedSession(sessions.find((session) => session.id !== id)?.id || null);
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

  useEffect(() => {
    api('/api/repo/files?q=').then(setRepoFiles).catch((err) => setNotice(err.message));
  }, []);

  useEffect(() => {
    loadContext();
  }, [selectedSession]);

  return (
    <section className="chat-layout">
      <div className="session-list">
        <button className="primary" onClick={newSession}><Plus size={16} /> New chat</button>
        {sessions.map((session) => (
          <button key={session.id} className={cx('session-row', session.id === selectedSession && 'selected')} onClick={() => setSelectedSession(session.id)}>
            <span>{session.pinned ? 'Pinned' : 'Chat'}</span>
            <strong>{session.title}</strong>
          </button>
        ))}
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
          <div className="inline-form">
            <select value={selectedFile} onChange={(event) => setSelectedFile(event.target.value)}>
              <option value="">Attach repo file as context</option>
              {repoFiles.map((file) => <option value={file.path} key={file.path}>{file.path}</option>)}
            </select>
            <button onClick={addContextFile} disabled={!selectedFile}><Plus size={16} /> Add</button>
          </div>
          <div className="context-chips">
            {contextFiles.length === 0 ? <span>No repo files attached.</span> : contextFiles.map((file) => (
              <button key={file.id} onClick={() => removeContextFile(file.id)} title="Remove context file">
                <FileText size={13} />
                <span>{file.path}</span>
                <X size={13} />
              </button>
            ))}
          </div>
        </div>
        <div className="messages">
          {messages.map((message) => (
            <div className={cx('message', message.role)} key={message.id}>
              <span>{message.role}</span>
              <p>{message.content}</p>
            </div>
          ))}
        </div>
        <div className="composer">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Tell Life Planner what changed, what is blocked, or what needs review..." disabled={chatBusy} />
          <button className="primary" onClick={send} disabled={chatBusy || !draft.trim()}><Bot size={16} /> {chatBusy ? 'Thinking...' : 'Send'}</button>
        </div>
      </div>
    </section>
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
      <div className="decision-row">
        {canEdit && <button onClick={() => onSave(candidate)}><Check size={16} /> Save metadata</button>}
        <button className="primary" onClick={() => onDecision(candidate.id, 'approve')}><Check size={16} /> Approve</button>
        <button onClick={() => onDecision(candidate.id, 'defer')}><Clock3 size={16} /> Defer</button>
        <button className="danger" onClick={() => onDecision(candidate.id, 'deny')}><X size={16} /> Deny</button>
      </div>
    </div>
  );
}

function Memory({ memory, refresh }) {
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

  return (
    <section className="two-column">
      <div className="panel">
        <h2>Candidate Review</h2>
        <p>Chat and cloud consultation outputs wait here before becoming active memory.</p>
        {memory.candidates.filter((c) => ['candidate', 'deferred'].includes(c.status)).map((candidate) => (
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
      <div className="panel">
        <h2>Approved Knowledge</h2>
        <p>Canonical database items with status, confidence, evidence, owner, and next action.</p>
        <div className="table-list">
          {memory.items.map((item) => (
            <div className="memory-row" key={item.id}>
              <ItemRow item={item} />
              <div className="mini-actions text-actions">
                <button onClick={() => proposeMemoryUpdate(item, { status: item.status, confidence: item.confidence, evidence: 'Reviewed from Memory tab.', next_action: item.next_action }, `Review memory: ${item.title}`)}>Review</button>
                <button onClick={() => proposeMemoryUpdate(item, { status: 'stale', confidence: Math.min(Number(item.confidence || 0), 0.45), evidence: 'Marked stale from Memory tab.', next_action: 'Verify before relying on this memory.' }, `Mark stale: ${item.title}`)}>Stale</button>
                <button className="danger" onClick={() => proposeMemoryUpdate(item, { status: 'superseded', confidence: 0.3, evidence: 'Superseded from Memory tab.', next_action: 'Use newer approved memory instead.' }, `Supersede memory: ${item.title}`)}>Supersede</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ApprovalQueue({ setNotice, refreshPlanner }) {
  const [items, setItems] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [checks, setChecks] = useState({});

  async function load(announce = false) {
    const data = await api('/api/planner');
    setItems(data.approvals);
    setCandidates(data.candidates || []);
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

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Approval Queue</h2>
          <p>Meaningful changes wait here before memory, plans, repo files, or priorities change.</p>
        </div>
        <button onClick={() => load(true)}><RefreshCcw size={16} /> Refresh</button>
      </div>
      {items.length === 0 && candidates.length === 0 ? (
        <Empty title="No pending approvals" body="Staged changes and memory candidates will appear here for explicit review." />
      ) : (
        <div className="approval-list">
          {items.length > 0 && <h3>Governed Changes</h3>}
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
  const [projectDraft, setProjectDraft] = useState({ name: '', status: 'active', owner: 'user', confidence: 0.75, next_action: '' });

  function startEdit(project) {
    setEditing(project);
    setProjectDraft({
      name: project.name || '',
      status: project.status || 'active',
      owner: project.owner || 'user',
      confidence: Number(project.confidence || 0.75),
      next_action: project.next_action || ''
    });
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
              next_action: editing.next_action || ''
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
  const browserReady = Boolean(cap?.playwright && cap?.chromium);
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
          : browserDisabledReason;
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
          : 'Run automatic consultation to send the prompt, wait for ChatGPT, and fill this box automatically. Manual paste is only a fallback.';

  async function load() {
    setCap(await api('/api/browser/capabilities'));
    setAgentTabs(await api('/api/browser/agent-tabs').catch(() => ({ cdpAvailable: false, agents: {} })));
    setConsultations(await api('/api/consultations'));
  }
  useEffect(() => { load().catch((err) => setNotice(err.message)); }, [refreshSignal]);
  useEffect(() => {
    api('/api/repo/files?q=').then(setRepoFiles).catch((err) => setNotice(err.message));
  }, []);

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
          temporary_chat_confirmed: temporaryChatConfirmed
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
        {!browserReady && (
          <div className="source-warning warn">
            Browser automation disabled: {browserDisabledReason || cap?.note || 'Browser automation is not ready.'}
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
        <div className="decision-row">
          <button className="primary" onClick={runAutomaticConsultation} disabled={Boolean(automaticDisabledReason)} title={automaticDisabledReason || 'Open ChatGPT, send the browser-agent question, wait for the response, and fill the answer box'}>
            <Sparkles size={16} /> {consultBusy ? 'Sending...' : 'Send to browser agent'}
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
        <textarea value={external} onChange={(event) => setExternal(event.target.value)} placeholder="Automatic ChatGPT response will appear here. Manual paste is a fallback if automation is blocked." />
        {external.trim() && (
          <div className="save-choice">
            <strong>What do you want to keep?</strong>
            <small>Nothing has been saved yet. Choose one explicit action after reviewing the answer.</small>
            <div className="decision-row">
              <button className="primary" onClick={saveConsultation} title="Save this response as a reviewable memory candidate"><Globe2 size={16} /> Save response candidate</button>
              <button disabled title="Future option: save the browser/chat transcript without creating memory">Save chat log later</button>
              <button disabled title="Future option: create a governed sync proposal after review">Sync everything later</button>
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
  const [ollama, setOllama] = useState(null);
  const [model, setModel] = useState(null);
  const [requests, setRequests] = useState([]);
  const [busy, setBusy] = useState('');
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
  const checkOllama = () => run('ollama', async () => setOllama(await api('/api/tooling/ollama/status')));
  const checkModel = () => run('model', async () => setModel(await api('/api/tooling/ollama/model-status')));
  const loadRequests = () => run('requests', async () => setRequests(await api('/api/tooling/openhands/requests')));

  useEffect(() => {
    checkOpenHands();
    checkOllama();
    checkModel();
    loadRequests();
  }, [refreshSignal]);

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
        <Pill tone="info">local worker</Pill>
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
          <span>Ollama</span>
          <Pill tone={ollama?.running ? 'good' : 'bad'}>{ollama?.running ? `running ${ollama.version}` : 'unreachable'}</Pill>
          <small>{model ? `${model.model}: ${model.present ? 'present' : 'missing'}` : 'model unchecked'}</small>
        </div>
      </div>
      {status?.note && <div className="source-warning warn"><small>{status.note}</small></div>}
      {model && !model.present && <div className="source-warning warn"><small>{model.note} Installed coder models: {model.coderModels.join(', ') || 'none'}</small></div>}

      <div className="decision-row">
        <button onClick={checkOpenHands} disabled={Boolean(busy)}><RefreshCcw size={16} /> {busy === 'oh-status' ? 'Checking...' : 'Check OpenHands'}</button>
        <button onClick={startOpenHands} disabled={Boolean(busy) || !status?.container?.exists || status?.container?.running}><Bot size={16} /> {busy === 'start' ? 'Starting...' : 'Start OpenHands'}</button>
        <button onClick={stopOpenHands} disabled={Boolean(busy) || !status?.container?.running}><X size={16} /> {busy === 'stop' ? 'Stopping...' : 'Stop OpenHands'}</button>
        <button onClick={openUi} disabled={Boolean(busy)}><Globe2 size={16} /> Open OpenHands UI</button>
        <button onClick={checkOllama} disabled={Boolean(busy)}><RefreshCcw size={16} /> Check Ollama</button>
        <button onClick={checkModel} disabled={Boolean(busy)}><SearchCheck size={16} /> Check coding model</button>
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

      <h3>Requests</h3>
      {requests.length === 0 ? (
        <Empty title="No requests yet" body="Stored OpenHands task requests will appear here for review." />
      ) : (
        <div className="table-list">
          {requests.map((request) => (
            <div className="review-card" key={request.id}>
              <div className="review-card-heading">
                <Pill tone={request.status === 'pending' ? 'warn' : request.status === 'complete' ? 'good' : 'muted'}>{request.status}</Pill>
                <Pill tone={request.riskLevel === 'low' ? 'good' : 'warn'}>{request.riskLevel || 'unrated'} risk</Pill>
              </div>
              <h3>{request.title}</h3>
              <div className="candidate-meta">
                <span>By: {request.requestedBy}</span>
                <span>Created: {request.createdAt ? new Date(request.createdAt).toLocaleString() : 'unknown'}</span>
                <span>Repo: {request.targetRepoPath}</span>
                <span>Max files: {request.maxFilesChanged}</span>
                {request.reportPath && <span>Report: {request.reportPath}</span>}
              </div>
            </div>
          ))}
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
            <span>{connector?.installed ? 'Connected to this LPS session.' : 'Load the unpacked extension in the Chrome profile that runs LPS.'}</span>
            <small>{connector?.extensionPath || 'browser-extension/lps-browser-agent'}</small>
          </div>
          <div className="tool-actions">
            <Pill tone={connector?.installed ? 'good' : 'warn'}>{connector?.installed ? 'Connected' : 'Not loaded'}</Pill>
            <button disabled={Boolean(busy)} onClick={installBrowserAgent}>
              {busy === 'browserAgent' ? 'Opening...' : 'Install connector'}
            </button>
          </div>
        </div>
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

function SourceControl({ setNotice, refreshSignal = 0 }) {
  const [source, setSource] = useState(null);
  const [diff, setDiff] = useState(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('codex/life-planner-ui');
  const [branches, setBranches] = useState({ current: '', branches: [] });
  const [branchToSwitch, setBranchToSwitch] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('https://github.com/neuro-1977/lps.git');
  const [githubRepo, setGithubRepo] = useState('neuro-1977/lps');
  const [hfRepo, setHfRepo] = useState('');
  const [hfRepoType, setHfRepoType] = useState('model');
  const [sourceBusy, setSourceBusy] = useState(false);
  const [operationOutput, setOperationOutput] = useState('');
  const [diffPath, setDiffPath] = useState('');
  const [fileDiff, setFileDiff] = useState(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [pushArmed, setPushArmed] = useState(false);

  async function refresh(announce = false) {
    try {
      setSource(await api('/api/source/status'));
      setDiff(await api('/api/source/diff'));
      const branchData = await api('/api/source/branches');
      setBranches(branchData);
      setBranchToSwitch((current) => current || branchData.current || '');
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

  const changedFiles = source?.changedFiles || [];
  const stagedFiles = changedFiles.filter((file) => file.staged);
  const localBranches = (branches.branches || []).filter((branch) => !branch.remote);
  const currentBranch = source?.branch || '';
  const pushProtectedBranch = ['main', 'master'].includes(currentBranch.toLowerCase());
  const pushDisabledReason = sourceBusy
    ? 'A source control operation is already running.'
    : source?.hasConflicts
      ? 'Resolve conflicts before pushing.'
      : pushProtectedBranch
        ? `Pushing ${currentBranch} from Life Planner is blocked. Push a review branch instead.`
        : '';
  const hasChanges = changedFiles.length > 0;
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

  return (
    <section className="source-layout">
      <div className="panel source-hero">
        <div>
          <h2>Repository</h2>
          <p>{source?.repoPath || 'Reading repository state...'}</p>
        </div>
        <div className="source-actions">
          <button onClick={() => refresh(true)} disabled={sourceBusy}><RefreshCcw size={16} /> Refresh</button>
          <button onClick={() => action('/api/source/login/github')} disabled={Boolean(githubLoginDisabledReason)} title={githubLoginDisabledReason || 'Start GitHub CLI browser login'}><Github size={16} /> Login with Git</button>
          <button onClick={() => openExternal(source?.installUrls?.githubCli || 'https://cli.github.com/', 'GitHub CLI download')} disabled={sourceBusy}><Download size={16} /> GitHub CLI</button>
          <button onClick={() => openExternal('https://github.com/neuro-1977/lps', 'push repo')} disabled={sourceBusy}><Github size={16} /> Open push repo</button>
          <button onClick={() => openExternal('https://github.com/Daa13x/LifePlanSystemPublic', 'upstream merge target')} disabled={sourceBusy}><Github size={16} /> Upstream merge target</button>
          <button onClick={() => action('/api/source/login/hf')} disabled={Boolean(hfLoginDisabledReason)} title={hfLoginDisabledReason || 'Start Hugging Face CLI login'}>Login with HF</button>
          <button onClick={() => openExternal(source?.installUrls?.huggingFaceCli || 'https://huggingface.co/docs/huggingface_hub/guides/cli', 'Hugging Face CLI docs')} disabled={sourceBusy}>HF CLI docs</button>
        </div>
      </div>

      <div className="panel">
        <h2>Connection</h2>
        <p>Active pushes go to <code>neuro-1977/lps</code>. Merge handoff target is <code>Daa13x/LifePlanSystemPublic</code>.</p>
        <div className="connection-grid">
          <div>
            <span>Branch</span>
            <strong>{source?.branch || 'Unknown'}</strong>
            <small>{source?.upstream ? `${source.ahead || 0} ahead / ${source.behind || 0} behind ${source.upstream}` : 'No upstream detected'}</small>
          </div>
          <div>
            <span>Git user</span>
            <strong>{source?.user?.name || 'Not set'}</strong>
            <small>{source?.user?.email || 'No email configured'}</small>
          </div>
          <div>
            <span>GitHub CLI</span>
            <Pill tone={source?.github?.authenticated ? 'good' : 'warn'}>
              {source?.github?.authenticated ? 'Logged in' : source?.github?.cliAvailable ? 'Login needed' : 'Unavailable'}
            </Pill>
            <small>{source?.github?.cliAvailable ? source?.github?.detail : source?.installHints?.githubCli}</small>
          </div>
          <div>
            <span>Hugging Face CLI</span>
            <Pill tone={source?.huggingface?.authenticated ? 'good' : 'warn'}>
              {source?.huggingface?.authenticated ? 'Logged in' : source?.huggingface?.cliAvailable ? 'Login needed' : 'Unavailable'}
            </Pill>
            <small>{source?.huggingface?.cliAvailable ? source?.huggingface?.detail : source?.installHints?.huggingFaceCli}</small>
          </div>
          <div>
            <span>Working tree</span>
            <strong>{hasChanges ? `${changedFiles.length} changed` : 'Clean'}</strong>
            <small>{source?.hasConflicts ? `${source.conflictFiles.length} conflict(s)` : `${protectedFiles.length} protected file(s)`}</small>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Write</h2>
        <p>These buttons run local Git commands in this workspace. Protected runtime files are blocked from staging and commits.</p>
        {sourceBusy && <div className="source-warning info">Running source control operation...</div>}
        {source && !source.github?.cliAvailable && <div className="source-warning warn">GitHub CLI login is unavailable because <code>gh</code> is not installed or not on PATH. Use GitHub CLI above to open the official download page, install it, restart the app terminal, then refresh.</div>}
        {source && !source.huggingface?.cliAvailable && <div className="source-warning warn">Hugging Face CLI login is unavailable because <code>hf</code> is not installed or not on PATH. Use HF CLI docs above, or add an HF token in Settings.</div>}
        {source && !source.winget?.available && <div className="source-warning warn">winget is not on PATH, so the app cannot run <code>winget install --id GitHub.cli</code> for you.</div>}
        {source?.hasConflicts && <div className="source-warning bad">Resolve conflicts before staging or committing: {source.conflictFiles.join(', ')}</div>}
        {protectedFiles.length > 0 && <div className="source-warning warn">Protected files present: {protectedFiles.map((file) => file.path).join(', ')}</div>}
        <label>Create branch</label>
        <div className="inline-form">
          <input value={branchName} onChange={(event) => setBranchName(event.target.value)} disabled={sourceBusy} />
          <button onClick={() => action('/api/source/branch', { branch: branchName }, `Created branch ${branchName}`)} disabled={sourceBusy}><GitBranch size={16} /> Create</button>
        </div>
        <label>Switch branch</label>
        <div className="inline-form">
          <select value={branchToSwitch} onChange={(event) => setBranchToSwitch(event.target.value)} disabled={sourceBusy}>
            {localBranches.map((branch) => (
              <option value={branch.name} key={branch.name}>{branch.name}</option>
            ))}
          </select>
          <button onClick={() => action('/api/source/checkout', { branch: branchToSwitch }, `Switched to ${branchToSwitch}`)} disabled={sourceBusy || !branchToSwitch || branchToSwitch === source?.branch}><GitBranch size={16} /> Switch</button>
        </div>
        <label>Origin remote</label>
        <div className="inline-form">
          <input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} disabled={sourceBusy} />
          <button onClick={() => action('/api/source/remote', { url: remoteUrl }, 'Origin remote updated.')} disabled={sourceBusy}><Github size={16} /> Set origin</button>
        </div>
        <label>Create GitHub repo</label>
        <div className="inline-form">
          <input value={githubRepo} onChange={(event) => setGithubRepo(event.target.value)} disabled={sourceBusy} placeholder="owner/repo" />
          <button onClick={() => action('/api/source/create/github', { repo: githubRepo, visibility: 'public' })} disabled={sourceBusy || !githubRepo.trim()}><Github size={16} /> Create public</button>
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
          <button onClick={() => action('/api/source/create/hf', { repo: hfRepo, type: hfRepoType, visibility: 'public' })} disabled={sourceBusy || !hfRepo.trim()}>Create public</button>
          <button onClick={() => openExternal('https://huggingface.co/new', 'Hugging Face new repository page')} disabled={sourceBusy}>Open HF New</button>
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
          <button onClick={() => action('/api/source/stage-all', {}, 'Staged all changes.')} disabled={!canStageAll}><Check size={16} /> Stage all</button>
          <button onClick={() => action('/api/source/unstage-all', {}, 'Unstaged all files.')} disabled={sourceBusy || !changedFiles.some((file) => file.staged)}><X size={16} /> Unstage all</button>
          <button className="primary" onClick={() => action('/api/source/commit', { message: commitMessage }, 'Commit created.')} disabled={!canCommit}><Check size={16} /> Commit</button>
          <button onClick={() => action('/api/source/fetch', {}, 'Fetched latest remote refs.')} disabled={sourceBusy}><RefreshCcw size={16} /> Fetch</button>
          <button onClick={() => action('/api/source/pull', {}, 'Pulled latest changes.')} disabled={sourceBusy || source?.hasConflicts}><Download size={16} /> Pull</button>
          <button
            onClick={() => setPushArmed(true)}
            disabled={Boolean(pushDisabledReason) || pushArmed}
            title={pushDisabledReason || 'Review the push target before confirming'}
          >
            <Upload size={16} /> Push...
          </button>
        </div>
        {pushArmed && (
          <div className="source-warning warn">
            <strong>Confirm push</strong>
            <small>
              This will run <code>git push -u origin {currentBranch}</code> — the current review branch to remote <code>origin</code> only.
              No force flags. Life Planner refuses to push main/master.
            </small>
            <div className="decision-row">
              <button
                className="primary"
                disabled={sourceBusy}
                onClick={async () => {
                  await action('/api/source/push', { confirm: true }, `Pushed ${currentBranch} to origin.`);
                  setPushArmed(false);
                }}
              >
                <Upload size={16} /> Confirm push to origin
              </button>
              <button disabled={sourceBusy} onClick={() => setPushArmed(false)}><X size={16} /> Cancel</button>
            </div>
          </div>
        )}
        {operationOutput && <pre className="code-block compact-code">{operationOutput}</pre>}
      </div>

      <div className="panel">
        <h2>Status</h2>
        <pre className="code-block">{source?.status || 'No status yet.'}</pre>
        <h2>Changed Files</h2>
        <div className="source-file-list">
          {changedFiles.length === 0 ? (
            <Empty title="Clean" body="No changed files." />
          ) : changedFiles.map((file) => (
            <div className={cx('source-file-row', diffPath === file.path && 'selected')} key={`${file.status}-${file.path}`}>
              <div>
                <strong>{file.path}</strong>
                <span>{file.status}{file.staged ? ' staged' : ' unstaged'}</span>
              </div>
              <div className="mini-actions">
                {!file.protected && (
                  <button onClick={() => openFileDiff(file.path)} disabled={diffBusy} title="Show side-by-side diff"><FileText size={14} /> Diff</button>
                )}
                {file.protected ? (
                  <Pill tone="bad">Protected</Pill>
                ) : file.staged ? (
                  <button onClick={() => action('/api/source/unstage-file', { path: file.path }, `Unstaged ${file.path}`)} disabled={sourceBusy}><X size={14} /> Unstage</button>
                ) : (
                  <button onClick={() => action('/api/source/stage-file', { path: file.path }, `Staged ${file.path}`)} disabled={sourceBusy}><Check size={14} /> Stage</button>
                )}
              </div>
            </div>
          ))}
        </div>
        <h2>Remotes</h2>
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
      </div>

      <div className="panel wide-panel">
        <div className="panel-heading">
          <h2>Side-by-side Diff{diffPath ? `: ${diffPath}` : ''}</h2>
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
          <Empty title="No file selected" body="Click Diff on a changed file to compare committed vs current side by side." />
        )}
        <h2>Recent Log</h2>
        <pre className="code-block">{source?.log || 'No commits yet.'}</pre>
        <h2>Aggregate Diff</h2>
        <pre className="code-block">{diff?.stat || 'No diff stat.'}</pre>
        <pre className="code-block diff-detail">{diff?.detail || 'No unstaged diff.'}</pre>
        {diff?.truncated && <Pill tone="warn">Diff truncated</Pill>}
      </div>
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

function SettingsView({ settings, setSettings, models, setModels, setNotice }) {
  const [modelFolders, setModelFolders] = useState((settings.modelFolders || []).join('\n'));
  const [hfToken, setHfToken] = useState(settings.hfToken || '');
  const [localModelEndpoint, setLocalModelEndpoint] = useState(settings.localModelEndpoint || '');
  const [localModelName, setLocalModelName] = useState(settings.localModelName || 'planner-assistant');
  const [llamaCliPath, setLlamaCliPath] = useState(settings.llamaCliPath || '');
  const [llamaServerPath, setLlamaServerPath] = useState(settings.llamaServerPath || '');
  const [llamaServerPort, setLlamaServerPort] = useState(settings.llamaServerPort || 8080);
  const [llamaContextSize, setLlamaContextSize] = useState(settings.llamaContextSize || 4096);
  const [browserAgentMode, setBrowserAgentMode] = useState(settings.browserAgentMode || 'myChromeConnector');
  const [browserAgentPort, setBrowserAgentPort] = useState(settings.browserAgentPort || 4177);
  const [repo, setRepo] = useState('unsloth/Qwen3.5-4B-GGUF');
  const [repoTouched, setRepoTouched] = useState(false);
  const [modelSearch, setModelSearch] = useState('Qwen GGUF');
  const [hardware, setHardware] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [hfSearchResults, setHfSearchResults] = useState([]);
  const [hfFiles, setHfFiles] = useState([]);
  const [downloadFolder, setDownloadFolder] = useState(settings.modelDownloadFolder || '');
  const recommendedQwen = useMemo(() => recommendedQwenForHardware(hardware), [hardware]);

  useEffect(() => {
    api('/api/hardware').then(setHardware).catch((err) => setNotice(err.message));
    api('/api/models/runtime').then(setRuntime).catch((err) => setNotice(err.message));
  }, []);

  useEffect(() => {
    if (!hardware || !recommendedQwen || repoTouched) return;
    setRepo(recommendedQwen.repo);
  }, [hardware, recommendedQwen, repoTouched]);

  async function saveSettings() {
    const data = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        hfToken,
        modelFolders: modelFolders.split('\n').map((s) => s.trim()).filter(Boolean),
        modelDownloadFolder: downloadFolder,
        localModelEndpoint,
        localModelName,
        llamaCliPath,
        llamaServerPath,
        llamaServerPort: Number(llamaServerPort),
        llamaContextSize: Number(llamaContextSize),
        browserAgentMode,
        browserAgentPort: Number(browserAgentPort)
      })
    });
    setSettings(data);
    setRuntime(await api('/api/models/runtime'));
    setNotice('Settings saved locally.');
  }

  async function scan() {
    const data = await api('/api/models/scan', {
      method: 'POST',
      body: JSON.stringify({ folders: modelFolders.split('\n').map((s) => s.trim()).filter(Boolean) })
    });
    setModels(data.models);
    setNotice(`Detected ${data.discovered.length} GGUF model file(s).`);
  }

  async function assign(id) {
    setModels(await api(`/api/models/${id}/assign`, { method: 'POST', body: JSON.stringify({ role: 'Planner Assistant' }) }));
    setRuntime(await api('/api/models/runtime'));
    setNotice('Loaded model assignment for Planner Assistant.');
  }

  async function startServer() {
    await saveSettings();
    const result = await api('/api/models/server/start', {
      method: 'POST',
      body: JSON.stringify({ llamaServerPath, port: Number(llamaServerPort), contextSize: Number(llamaContextSize) })
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
    await scan();
    setNotice(`Downloaded ${file.path} to ${result.target}. Use Load to assign it.`);
  }

  return (
    <section className="settings-grid">
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
        <p>Scan folders for GGUF files and assign one model to Planner Assistant.</p>
        <div className="runtime-card">
          <Pill tone={runtime?.endpointConfigured || runtime?.assigned ? 'good' : 'warn'}>{runtime?.endpointConfigured ? 'Endpoint configured' : runtime?.assigned ? 'Model assigned' : 'No model assigned'}</Pill>
          <strong>{runtime?.endpointConfigured ? runtime.endpointModelName : runtime?.model?.name || 'Planner Assistant unavailable'}</strong>
          <span>{runtime?.managedServerRunning ? `Managed llama-server running: ${runtime.managedEndpoint}` : runtime?.endpointConfigured ? `Endpoint: ${runtime.endpoint}` : runtime?.llamaCliConfigured ? `llama-cli: ${runtime.llamaCliExists ? 'found' : 'missing'}` : 'Configure a local endpoint, llama-server, or llama-cli to generate chat responses.'}</span>
        </div>
        <label>Model folders</label>
        <textarea value={modelFolders} onChange={(event) => setModelFolders(event.target.value)} placeholder="C:\\Models&#10;D:\\LLMs" />
        <label>OpenAI-compatible local endpoint</label>
        <input value={localModelEndpoint} onChange={(event) => setLocalModelEndpoint(event.target.value)} placeholder="http://127.0.0.1:8080" />
        <label>Endpoint model name</label>
        <input value={localModelName} onChange={(event) => setLocalModelName(event.target.value)} placeholder="qwen2.5:7b-instruct" />
        <label>llama-cli path</label>
        <input value={llamaCliPath} onChange={(event) => setLlamaCliPath(event.target.value)} placeholder="C:\\llama.cpp\\build\\bin\\llama-cli.exe" />
        <label>llama-server path</label>
        <input value={llamaServerPath} onChange={(event) => setLlamaServerPath(event.target.value)} placeholder="C:\\llama.cpp\\build\\bin\\llama-server.exe" />
        <div className="inline-form">
          <input type="number" value={llamaServerPort} onChange={(event) => setLlamaServerPort(event.target.value)} placeholder="8080" />
          <input type="number" value={llamaContextSize} onChange={(event) => setLlamaContextSize(event.target.value)} placeholder="4096" />
        </div>
        <div className="decision-row">
          <button onClick={saveSettings}><Check size={16} /> Save</button>
          <button className="primary" onClick={scan}><RefreshCcw size={16} /> Scan GGUF</button>
          <button onClick={startServer} disabled={!llamaServerPath || !runtime?.assigned}><Bot size={16} /> Start server</button>
          <button onClick={stopServer} disabled={!runtime?.managedServerRunning}><X size={16} /> Stop server</button>
        </div>
        <div className="table-list">
          {models.map((model) => (
            <div className="model-row" key={model.id}>
              <div>
                <strong>{model.name}</strong>
                <span>{model.path}</span>
              </div>
              <button className={model.assigned_role ? 'primary' : ''} onClick={() => assign(model.id)}>
                {model.assigned_role || 'Load'}
              </button>
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
        <input type="number" value={browserAgentPort} onChange={(event) => setBrowserAgentPort(event.target.value)} placeholder="4177" />
        <div className="source-warning info">
          <strong>Chrome connector</strong>
          <small>Load the unpacked extension from browser-extension/lps-browser-agent in the same Chrome profile where the user is logged into ChatGPT, Gemini, Grok, or Claude. It talks only to 127.0.0.1:{browserAgentPort}; no public firewall rule is needed for localhost-only use.</small>
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
        <p>Files are exchange formats. The SQLite database remains canonical.</p>
        <a className="primary link-button" href="/api/export/json?mode=public"><Download size={16} /> Export Public JSON</a>
        <a className="link-button" href="/api/export/json?mode=backup"><Download size={16} /> Export Local Backup</a>
        <a className="link-button" href="/api/export/markdown"><Download size={16} /> Export Markdown</a>
        <JsonImport setNotice={setNotice} />
        <MarkdownImport setNotice={setNotice} />
      </div>
    </section>
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

const rootElement = document.getElementById('root');
window.__lifePlannerRoot ||= createRoot(rootElement);
window.__lifePlannerRoot.render(<App />);
