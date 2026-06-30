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
            <button className="icon-button" onClick={() => refreshAll()} aria-label="Refresh"><RefreshCcw size={18} /></button>
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
        {view === 'repository' && <RepositoryExplorer setNotice={setNotice} />}
        {view === 'calibration' && <Calibration setNotice={setNotice} />}
        {view === 'source' && <SourceControl setNotice={setNotice} />}
        {view === 'browser' && <BrowserConsult setNotice={setNotice} refresh={reloadPlanner} />}
        {view === 'tooling' && <Tooling setNotice={setNotice} />}
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

function Memory({ memory, refresh }) {
  async function decide(id, decision) {
    await api(`/api/memory/candidates/${id}/${decision}`, { method: 'POST' });
    refresh();
  }
  return (
    <section className="two-column">
      <div className="panel">
        <h2>Candidate Review</h2>
        <p>Chat and cloud consultation outputs wait here before becoming active memory.</p>
        {memory.candidates.filter((c) => ['candidate', 'deferred'].includes(c.status)).map((candidate) => (
          <div className="review-card" key={candidate.id}>
            <div>
              <Pill tone="warn">{candidate.type}</Pill>
              <h3>{candidate.title}</h3>
              <p>{candidate.body}</p>
              <span>{candidate.evidence}</span>
            </div>
            <div className="decision-row">
              <button onClick={() => decide(candidate.id, 'approve')}><Check size={16} /> Approve</button>
              <button onClick={() => decide(candidate.id, 'defer')}><Clock3 size={16} /> Defer</button>
              <button className="danger" onClick={() => decide(candidate.id, 'deny')}><X size={16} /> Deny</button>
            </div>
          </div>
        ))}
      </div>
      <div className="panel">
        <h2>Approved Knowledge</h2>
        <p>Canonical database items with status, confidence, evidence, owner, and next action.</p>
        <div className="table-list">
          {memory.items.map((item) => <ItemRow item={item} key={item.id} />)}
        </div>
      </div>
    </section>
  );
}

function ApprovalQueue({ setNotice, refreshPlanner }) {
  const [items, setItems] = useState([]);

  async function load() {
    const data = await api('/api/planner');
    setItems(data.approvals);
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

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Approval Queue</h2>
          <p>Meaningful changes wait here before memory, plans, repo files, or priorities change.</p>
        </div>
        <button onClick={load}><RefreshCcw size={16} /> Refresh</button>
      </div>
      {items.length === 0 ? (
        <Empty title="No pending approvals" body="Staged changes will appear here with risk, source, and target details." />
      ) : (
        <div className="approval-list">
          {items.map((item) => {
            const payload = JSON.parse(item.payload || '{}');
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
                {payload.targetFile && <pre className="code-block compact-code">Target: {payload.targetFile}{'\n'}Source: {payload.source || 'unknown'}</pre>}
                {payload.previousContent !== undefined && (
                  <div className="diff-columns">
                    <pre className="code-block compact-code">{payload.previousContent || '(new file)'}</pre>
                    <pre className="code-block compact-code">{payload.content || '(empty)'}</pre>
                  </div>
                )}
                <div className="decision-row">
                  <button className="primary" onClick={() => decide(item.id, 'approve')}><Check size={16} /> Approve</button>
                  <button onClick={() => decide(item.id, 'defer')}><Clock3 size={16} /> Defer</button>
                  <button className="danger" onClick={() => decide(item.id, 'deny')}><X size={16} /> Deny</button>
                </div>
              </div>
            );
          })}
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

function BrowserConsult({ setNotice, refresh }) {
  const [cap, setCap] = useState(null);
  const [title, setTitle] = useState('Cloud critique request');
  const [draft, setDraft] = useState('');
  const [external, setExternal] = useState('');
  const [consultations, setConsultations] = useState([]);
  const [targetAgent, setTargetAgent] = useState('ChatGPT');
  const [browserUrl, setBrowserUrl] = useState('https://chatgpt.com/');
  const [browserResult, setBrowserResult] = useState(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [consultPrompt, setConsultPrompt] = useState('');

  async function load() {
    setCap(await api('/api/browser/capabilities'));
    setConsultations(await api('/api/consultations'));
  }
  useEffect(() => { load().catch((err) => setNotice(err.message)); }, []);

  async function saveConsultation() {
    const created = await api('/api/consultations', { method: 'POST', body: JSON.stringify({ title, local_draft: draft, target_agent: targetAgent }) });
    if (external.trim()) {
      await api(`/api/consultations/${created.id}`, { method: 'PATCH', body: JSON.stringify({ external_response: external, status: 'captured' }) });
    }
    setDraft('');
    setExternal('');
    await load();
    await refresh();
  }

  function buildConsultPrompt() {
    const prompt = [
      `You are acting as an external consultant for Life Planner, a local-first personal executive assistant.`,
      `Target: ${targetAgent}.`,
      ``,
      `Review the local draft below. Critique it, call out missing context or risky assumptions, and suggest concrete improvements.`,
      `Do not claim authority over memory, priorities, or plans. Your response will be pasted back into Life Planner as a reviewable suggestion only.`,
      ``,
      `Local draft:`,
      draft.trim() || '(No local draft supplied yet.)'
    ].join('\n');
    setConsultPrompt(prompt);
    return prompt;
  }

  async function copyConsultPrompt(promptOverride = '') {
    const prompt = promptOverride || consultPrompt || buildConsultPrompt();
    await navigator.clipboard.writeText(prompt);
    setNotice('Consultation prompt copied. Paste it into the cloud agent after login.');
  }

  async function openWithPrompt() {
    const prompt = buildConsultPrompt();
    await copyConsultPrompt(prompt);
    await openControlledBrowser();
  }

  async function openControlledBrowser() {
    setBrowserBusy(true);
    try {
      const result = await api('/api/browser/open', {
        method: 'POST',
        body: JSON.stringify({ url: browserUrl })
      });
      setBrowserResult(result);
      setNotice(`Opened browser: ${result.title || result.url}`);
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBrowserBusy(false);
    }
  }

  return (
    <section className="two-column browser-flow">
      <div className="panel">
        <h2>Consultation Draft</h2>
        <p>{cap?.playwright ? 'Playwright is available for browser automation. Local models run as-is; this app writes the context prompt.' : 'Manual browser stub is active. Paste external responses here for review.'}</p>
        <label>Cloud consultant</label>
        <div className="inline-form">
          <select value={targetAgent} onChange={(event) => setTargetAgent(event.target.value)}>
            <option>ChatGPT</option>
            <option>Gemini</option>
            <option>Grok</option>
            <option>Claude</option>
            <option>Other web agent</option>
          </select>
          <button onClick={buildConsultPrompt}><Sparkles size={16} /> Build prompt</button>
          <button onClick={copyConsultPrompt} disabled={!draft.trim() && !consultPrompt}><Clipboard size={16} /> Copy</button>
        </div>
        <label>Controlled browser URL</label>
        <div className="inline-form">
          <input value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} placeholder="https://chatgpt.com/" />
          <button onClick={openControlledBrowser} disabled={browserBusy || !cap?.playwright}>
            <Globe2 size={16} /> {browserBusy ? 'Opening...' : 'Open'}
          </button>
          <button className="primary" onClick={openWithPrompt} disabled={browserBusy || !cap?.playwright || !draft.trim()}>
            <Globe2 size={16} /> Copy + Open
          </button>
        </div>
        {browserResult && (
          <div className="browser-result">
            <Pill tone="good">Opened</Pill>
            <strong>{browserResult.title || browserResult.url}</strong>
            <span>{browserResult.url}</span>
            {browserResult.excerpt && <small>{browserResult.excerpt}</small>}
          </div>
        )}
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Local draft to critique..." />
        {consultPrompt && <textarea value={consultPrompt} onChange={(event) => setConsultPrompt(event.target.value)} placeholder="Generated consultation prompt..." />}
        <textarea value={external} onChange={(event) => setExternal(event.target.value)} placeholder="Captured cloud response or manual paste..." />
        <button className="primary" onClick={saveConsultation}><Globe2 size={16} /> Save as reviewable suggestion</button>
      </div>
      <div className="panel">
        <h2>Consultation History</h2>
        {consultations.map((item) => (
          <div className="review-card" key={item.id}>
            <Pill tone={item.status === 'captured' ? 'warn' : 'muted'}>{item.status}</Pill>
            <h3>{item.title}</h3>
            <span>{item.target_agent}</span>
            <p>{item.local_draft}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Tooling({ setNotice }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');

  async function refresh() {
    try {
      setStatus(await api('/api/tooling/status'));
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

  useEffect(() => { refresh(); }, []);

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
        <button onClick={refresh}><RefreshCcw size={16} /> Refresh</button>
      </div>

      <div className="panel">
        <h2>Runtime</h2>
        <div className="connection-grid">
          <div><span>Node</span><strong>{status?.node?.version || 'Checking...'}</strong></div>
          <div><span>npm</span><strong>{status?.npm?.version || 'Checking...'}</strong></div>
          <div><span>GitHub CLI</span><Pill tone={status?.githubCli?.authenticated ? 'good' : 'warn'}>{status?.githubCli?.available ? status?.githubCli?.authenticated ? 'Logged in' : 'Available' : 'Missing'}</Pill><small>{status?.installHints?.githubCli}</small></div>
          <div><span>HF CLI</span><Pill tone={status?.huggingFaceCli?.authenticated ? 'good' : 'warn'}>{status?.huggingFaceCli?.available ? status?.huggingFaceCli?.authenticated ? 'Logged in' : 'Available' : 'Missing'}</Pill><small>{status?.installHints?.huggingFaceCli}</small></div>
        </div>
      </div>

      <div className="panel">
        <h2>Browser Automation</h2>
        <p>Playwright is the app's browser-control stack for cloud consultation tabs and future desktop-app attachment where supported.</p>
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

      <div className="panel wide-panel">
        <h2>Notes</h2>
        <pre className="code-block">
{`What the app can install locally:
- npm install playwright
- npx playwright install chromium

What needs an OS/user install:
- GitHub CLI: ${status?.installHints?.githubCli || 'winget install --id GitHub.cli'}
- Hugging Face CLI: ${status?.installHints?.huggingFaceCli || 'pip install -U huggingface_hub[cli]'}

After installing CLI tools, use the Source tab login buttons and refresh status.`}
        </pre>
      </div>
    </section>
  );
}

function RepositoryExplorer({ setNotice }) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState('');
  const [summary, setSummary] = useState('');
  const [newPath, setNewPath] = useState('');
  const [renamePath, setRenamePath] = useState('');

  async function loadFiles(nextQuery = query) {
    try {
      setFiles(await api(`/api/repo/files?q=${encodeURIComponent(nextQuery)}`));
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

  useEffect(() => { loadFiles(); }, []);

  return (
    <section className="repo-layout">
      <div className="panel repo-list">
        <div className="inline-form">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search repo files" />
          <button onClick={() => loadFiles()}><RefreshCcw size={16} /></button>
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

function Calibration({ setNotice }) {
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
  }, []);

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

function SourceControl({ setNotice }) {
  const [source, setSource] = useState(null);
  const [diff, setDiff] = useState(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('codex/life-planner-ui');
  const [branches, setBranches] = useState({ current: '', branches: [] });
  const [branchToSwitch, setBranchToSwitch] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('https://github.com/neuro-1977/lps.git');
  const [sourceBusy, setSourceBusy] = useState(false);
  const [operationOutput, setOperationOutput] = useState('');

  async function refresh() {
    try {
      setSource(await api('/api/source/status'));
      setDiff(await api('/api/source/diff'));
      const branchData = await api('/api/source/branches');
      setBranches(branchData);
      setBranchToSwitch((current) => current || branchData.current || '');
    } catch (err) {
      setNotice(err.message);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function action(path, body, success) {
    if (sourceBusy) return;
    setSourceBusy(true);
    try {
      const result = await api(path, { method: 'POST', body: JSON.stringify(body || {}) });
      const output = result.output || result.status || result.log || result.message || '';
      setOperationOutput(output);
      setNotice(success || result.message || result.output || 'Source control action complete.');
      await refresh();
    } catch (err) {
      setNotice(err.message);
      setOperationOutput(err.message);
    } finally {
      setSourceBusy(false);
    }
  }

  const changedFiles = source?.changedFiles || [];
  const localBranches = (branches.branches || []).filter((branch) => !branch.remote);
  const hasChanges = changedFiles.length > 0;
  const protectedFiles = changedFiles.filter((file) => file.protected);
  const canStageAll = hasChanges && !sourceBusy && !source?.hasConflicts && protectedFiles.length === 0;
  const canCommit = !sourceBusy && Boolean(commitMessage.trim()) && !source?.hasConflicts;

  return (
    <section className="source-layout">
      <div className="panel source-hero">
        <div>
          <h2>Repository</h2>
          <p>{source?.repoPath || 'Reading repository state...'}</p>
        </div>
        <div className="source-actions">
          <button onClick={refresh} disabled={sourceBusy}><RefreshCcw size={16} /> Refresh</button>
          <button onClick={() => action('/api/source/login/github')} disabled={sourceBusy}><Github size={16} /> Login with Git</button>
          <a className="source-link" href="https://github.com/neuro-1977/lps" target="_blank" rel="noreferrer"><Github size={16} /> Open push repo</a>
          <a className="source-link" href="https://github.com/Daa13x/LifePlanSystemPublic" target="_blank" rel="noreferrer"><Github size={16} /> Upstream merge target</a>
          <button onClick={() => action('/api/source/login/hf')} disabled={sourceBusy}>Login with HF</button>
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
          </div>
          <div>
            <span>Hugging Face CLI</span>
            <Pill tone={source?.huggingface?.authenticated ? 'good' : 'warn'}>
              {source?.huggingface?.authenticated ? 'Logged in' : source?.huggingface?.cliAvailable ? 'Login needed' : 'Unavailable'}
            </Pill>
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
        <label>Commit message</label>
        <textarea value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe the source change..." disabled={sourceBusy} />
        <div className="decision-row">
          <button onClick={() => action('/api/source/stage-all', {}, 'Staged all changes.')} disabled={!canStageAll}><Check size={16} /> Stage all</button>
          <button onClick={() => action('/api/source/unstage-all', {}, 'Unstaged all files.')} disabled={sourceBusy || !changedFiles.some((file) => file.staged)}><X size={16} /> Unstage all</button>
          <button className="primary" onClick={() => action('/api/source/commit', { message: commitMessage }, 'Commit created.')} disabled={!canCommit}><Check size={16} /> Commit</button>
          <button onClick={() => action('/api/source/fetch', {}, 'Fetched latest remote refs.')} disabled={sourceBusy}><RefreshCcw size={16} /> Fetch</button>
          <button onClick={() => action('/api/source/pull', {}, 'Pulled latest changes.')} disabled={sourceBusy || source?.hasConflicts}><Download size={16} /> Pull</button>
          <button onClick={() => action('/api/source/push', {}, 'Pushed current branch.')} disabled={sourceBusy || source?.hasConflicts}><Upload size={16} /> Push</button>
        </div>
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
            <div className="source-file-row" key={`${file.status}-${file.path}`}>
              <div>
                <strong>{file.path}</strong>
                <span>{file.status}{file.staged ? ' staged' : ' unstaged'}</span>
              </div>
              {file.protected ? (
                <Pill tone="bad">Protected</Pill>
              ) : file.staged ? (
                <button onClick={() => action('/api/source/unstage-file', { path: file.path }, `Unstaged ${file.path}`)} disabled={sourceBusy}><X size={14} /> Unstage</button>
              ) : (
                <button onClick={() => action('/api/source/stage-file', { path: file.path }, `Staged ${file.path}`)} disabled={sourceBusy}><Check size={14} /> Stage</button>
              )}
            </div>
          ))}
        </div>
        <h2>Remotes</h2>
        <pre className="code-block">{source?.remotes || 'No Git remotes configured yet.'}</pre>
      </div>

      <div className="panel wide-panel">
        <h2>Recent Log</h2>
        <pre className="code-block">{source?.log || 'No commits yet.'}</pre>
        <h2>Diff</h2>
        <pre className="code-block">{diff?.stat || 'No diff stat.'}</pre>
        <pre className="code-block diff-detail">{diff?.detail || 'No unstaged diff.'}</pre>
        {diff?.truncated && <Pill tone="warn">Diff truncated</Pill>}
      </div>
    </section>
  );
}

const MODEL_SUGGESTIONS = [
  {
    repo: 'bartowski/Qwen2.5-3B-Instruct-GGUF',
    name: 'Qwen2.5 3B Instruct',
    size: '3B',
    tier: 'small',
    why: 'Fast baseline for low-memory laptops and quick planning.'
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

function SettingsView({ settings, setSettings, models, setModels, setNotice }) {
  const [modelFolders, setModelFolders] = useState((settings.modelFolders || []).join('\n'));
  const [hfToken, setHfToken] = useState(settings.hfToken || '');
  const [localModelEndpoint, setLocalModelEndpoint] = useState(settings.localModelEndpoint || '');
  const [llamaCliPath, setLlamaCliPath] = useState(settings.llamaCliPath || '');
  const [repo, setRepo] = useState('');
  const [modelSearch, setModelSearch] = useState('instruct gguf');
  const [hardware, setHardware] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [hfSearchResults, setHfSearchResults] = useState([]);
  const [hfFiles, setHfFiles] = useState([]);
  const [downloadFolder, setDownloadFolder] = useState(settings.modelDownloadFolder || '');

  useEffect(() => {
    api('/api/hardware').then(setHardware).catch((err) => setNotice(err.message));
    api('/api/models/runtime').then(setRuntime).catch((err) => setNotice(err.message));
  }, []);

  async function saveSettings() {
    const data = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        hfToken,
        modelFolders: modelFolders.split('\n').map((s) => s.trim()).filter(Boolean),
        modelDownloadFolder: downloadFolder,
        localModelEndpoint,
        llamaCliPath
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

  async function lookupHF() {
    setHfFiles(await api(`/api/hf/files?repo=${encodeURIComponent(repo)}`));
  }

  async function searchHF() {
    setHfSearchResults(await api(`/api/hf/search?q=${encodeURIComponent(modelSearch)}`));
  }

  async function useRepo(nextRepo) {
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
          <Pill tone={runtime?.assigned ? 'good' : 'warn'}>{runtime?.assigned ? 'Model assigned' : 'No model assigned'}</Pill>
          <strong>{runtime?.model?.name || 'Planner Assistant unavailable'}</strong>
          <span>{runtime?.endpointConfigured ? `Endpoint: ${runtime.endpoint}` : runtime?.llamaCliConfigured ? `llama-cli: ${runtime.llamaCliExists ? 'found' : 'missing'}` : 'Configure a local endpoint or llama-cli to generate chat responses.'}</span>
        </div>
        <label>Model folders</label>
        <textarea value={modelFolders} onChange={(event) => setModelFolders(event.target.value)} placeholder="C:\\Models&#10;D:\\LLMs" />
        <label>OpenAI-compatible local endpoint</label>
        <input value={localModelEndpoint} onChange={(event) => setLocalModelEndpoint(event.target.value)} placeholder="http://127.0.0.1:8080" />
        <label>llama-cli path</label>
        <input value={llamaCliPath} onChange={(event) => setLlamaCliPath(event.target.value)} placeholder="C:\\llama.cpp\\build\\bin\\llama-cli.exe" />
        <div className="decision-row">
          <button onClick={saveSettings}><Check size={16} /> Save</button>
          <button className="primary" onClick={scan}><RefreshCcw size={16} /> Scan GGUF</button>
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
        <h2>Hugging Face Download</h2>
        <p>Token is optional and stored only in local settings.</p>
        <label>HF token</label>
        <input value={hfToken} onChange={(event) => setHfToken(event.target.value)} type="password" placeholder="Optional" />
        <label>Download folder</label>
        <input value={downloadFolder} onChange={(event) => setDownloadFolder(event.target.value)} placeholder="models" />
        <label>Repo</label>
        <div className="inline-form">
          <input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="bartowski/Qwen2.5-7B-Instruct-GGUF" />
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
      const result = await api('/api/import/json', { method: 'POST', body: JSON.stringify(parsed) });
      setJsonText('');
      setPreview(null);
      setNotice(`JSON imported: ${result.projects} project(s), ${result.knowledge_items} knowledge item(s).`);
    } catch (err) {
      setNotice(`JSON import failed: ${err.message}`);
    }
  }
  return (
    <>
      <textarea value={jsonText} onChange={(event) => setJsonText(event.target.value)} placeholder='{"projects":[],"knowledge_items":[]}' />
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
