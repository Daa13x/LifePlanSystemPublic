import express from 'express';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { db, getSetting, migrate, setSetting } from './db.js';

migrate();

const app = express();
const port = Number(process.env.LIFE_PLANNER_PORT || 4177);
const execFileAsync = promisify(execFile);
const root = process.cwd();

app.use(express.json({ limit: '25mb' }));

const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, status, message) => res.status(status).json({ ok: false, error: message });

async function runCli(command, args, options = {}) {
  try {
    const useShell = process.platform === 'win32' && /\.cmd$/i.test(command);
    const result = await execFileAsync(command, args, {
      cwd: root,
      timeout: options.timeout || 20000,
      windowsHide: true,
      shell: useShell,
      maxBuffer: options.maxBuffer || 1024 * 1024
    });
    return { available: true, ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const missing = error.code === 'ENOENT';
    return {
      available: !missing,
      ok: false,
      code: error.code,
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || error.message
    };
  }
}

function spawnCli(command, args) {
  try {
    const child = spawn(command, args, {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false
    });
    child.unref();
    return { available: true, started: true };
  } catch (error) {
    return { available: false, started: false, error: error.message };
  }
}

function normalizeBrowserUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error('URL is required.');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;
  throw new Error('Enter a full http(s) URL or a domain such as chatgpt.com.');
}

async function packageAvailable(packageName) {
  try {
    await import(packageName);
    return true;
  } catch {
    return false;
  }
}

async function npmInstall(args) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return runCli(npmCommand, args, { timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
}

async function npxRun(args) {
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return runCli(npxCommand, args, { timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
}

function safeWorkspacePath(relativePath = '') {
  const normalized = String(relativePath).replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) throw new Error('Invalid path.');
  const absolute = path.resolve(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) throw new Error('Path must stay inside the workspace.');
  return { normalized, absolute };
}

function allRows(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function row(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function classifyCandidate(text) {
  const lower = text.toLowerCase();
  if (lower.includes('blocked') || lower.includes('blocker')) return 'blocker';
  if (lower.includes('prefer') || lower.includes('rule') || lower.includes('always') || lower.includes('never')) return 'rule';
  if (lower.includes('waiting') || lower.includes('follow up')) return 'waiting';
  if (lower.includes('goal')) return 'goal';
  if (lower.includes('remind') || lower.includes('reminder')) return 'reminder';
  if (lower.includes('decided') || lower.includes('decision')) return 'decision';
  return 'current state';
}

function createCandidateFromMessage(sessionId, messageId, content) {
  const trimmed = content.trim();
  if (trimmed.length < 24) return null;
  const type = classifyCandidate(trimmed);
  const title = trimmed.split(/[.!?\n]/)[0].slice(0, 96) || 'Chat memory candidate';
  return db.prepare(`
    INSERT INTO memory_candidates
    (session_id, source_message_id, type, title, body, source, evidence, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, messageId, type, title, trimmed, 'chat', `Chat session ${sessionId}, message ${messageId}`, 0.52).lastInsertRowid;
}

function plannerData() {
  const items = allRows(`
    SELECT k.*, p.name AS project_name
    FROM knowledge_items k
    LEFT JOIN projects p ON p.id = k.project_id
    WHERE k.status NOT IN ('archived', 'deprecated', 'superseded')
    ORDER BY COALESCE(k.due_at, k.updated_at) ASC, k.confidence ASC
  `);
  const pendingApprovals = allRows('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC', ['pending']);
  const candidates = allRows('SELECT * FROM memory_candidates WHERE status IN (?, ?) ORDER BY created_at DESC', ['candidate', 'deferred']);
  const staleCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const stale = items.filter((item) => {
    const reviewed = item.last_reviewed ? new Date(item.last_reviewed).getTime() : 0;
    return reviewed < staleCutoff || item.status === 'stale' || item.confidence < 0.55;
  });
  const focus = items.filter((item) => ['goal', 'project', 'decision', 'reminder', 'current state'].includes(item.type) && ['active', 'stable'].includes(item.status)).slice(0, 5);
  const blockers = items.filter((item) => item.type === 'blocker' || item.status === 'blocked').slice(0, 5);
  const waiting = items.filter((item) => item.type === 'waiting' || item.owner === 'user').slice(0, 6);
  const automatic = items.filter((item) => item.owner === 'app' && item.status === 'active').slice(0, 5);
  const nextBest = blockers[0] || pendingApprovals[0] || candidates[0] || focus[0] || items[0] || null;

  return {
    summary: {
      focus: focus.length,
      blockers: blockers.length,
      waiting: waiting.length,
      automatic: automatic.length,
      stale: stale.length,
      approvals: pendingApprovals.length,
      candidates: candidates.length
    },
    focus,
    blockers,
    waiting,
    automatic,
    stale: stale.slice(0, 6),
    approvals: pendingApprovals.slice(0, 5),
    candidates: candidates.slice(0, 5),
    nextBest
  };
}

app.get('/api/health', (_req, res) => ok(res, { db: 'ready', storage: path.resolve('data/life-planner.sqlite') }));

app.get('/api/bootstrap', (_req, res) => {
  ok(res, {
    settings: Object.fromEntries(allRows('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)])),
    planner: plannerData(),
    sessions: allRows('SELECT * FROM chat_sessions WHERE deleted = 0 ORDER BY pinned DESC, updated_at DESC'),
    projects: allRows('SELECT * FROM projects ORDER BY updated_at DESC'),
    models: allRows('SELECT * FROM model_registry ORDER BY assigned_role DESC, name ASC')
  });
});

app.get('/api/planner', (_req, res) => ok(res, plannerData()));

app.get('/api/chat/sessions', (_req, res) => ok(res, allRows('SELECT * FROM chat_sessions WHERE deleted = 0 ORDER BY pinned DESC, updated_at DESC')));

app.post('/api/chat/sessions', (req, res) => {
  const title = req.body.title?.trim() || 'New session';
  const id = db.prepare('INSERT INTO chat_sessions (title) VALUES (?)').run(title).lastInsertRowid;
  ok(res, row('SELECT * FROM chat_sessions WHERE id = ?', [id]));
});

app.patch('/api/chat/sessions/:id', (req, res) => {
  const allowed = ['title', 'pinned', 'deleted'];
  const updates = Object.entries(req.body).filter(([key]) => allowed.includes(key));
  if (!updates.length) return fail(res, 400, 'No supported fields provided.');
  for (const [key, value] of updates) {
    db.prepare(`UPDATE chat_sessions SET ${key} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(value, req.params.id);
  }
  ok(res, row('SELECT * FROM chat_sessions WHERE id = ?', [req.params.id]));
});

app.get('/api/chat/sessions/:id/messages', (req, res) => {
  ok(res, allRows('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC', [req.params.id]));
});

app.post('/api/chat/sessions/:id/messages', (req, res) => {
  const content = req.body.content?.trim();
  if (!content) return fail(res, 400, 'Message content is required.');
  const session = row('SELECT * FROM chat_sessions WHERE id = ? AND deleted = 0', [req.params.id]);
  if (!session) return fail(res, 404, 'Session not found.');
  const messageId = db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'user', content).lastInsertRowid;
  const candidateId = createCandidateFromMessage(Number(req.params.id), messageId, content);
  const response = candidateId
    ? 'Saved your note as a memory candidate for review. I will not promote it until you approve it.'
    : 'Saved to the chat history. I did not extract a memory candidate from this short note.';
  const assistantId = db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'assistant', response).lastInsertRowid;
  db.prepare('UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  ok(res, {
    messages: allRows('SELECT * FROM chat_messages WHERE id IN (?, ?) ORDER BY id ASC', [messageId, assistantId]),
    candidateId
  });
});

app.get('/api/memory', (_req, res) => {
  ok(res, {
    candidates: allRows('SELECT * FROM memory_candidates ORDER BY created_at DESC'),
    items: allRows(`
      SELECT k.*, p.name AS project_name
      FROM knowledge_items k
      LEFT JOIN projects p ON p.id = k.project_id
      ORDER BY k.updated_at DESC
    `)
  });
});

app.post('/api/memory/candidates/:id/:decision', (req, res) => {
  const candidate = row('SELECT * FROM memory_candidates WHERE id = ?', [req.params.id]);
  if (!candidate) return fail(res, 404, 'Candidate not found.');
  const decision = req.params.decision;
  if (!['approve', 'deny', 'defer'].includes(decision)) return fail(res, 400, 'Decision must be approve, deny, or defer.');
  if (decision === 'approve') {
    db.prepare(`
      INSERT INTO knowledge_items
      (type, title, body, source, status, confidence, last_reviewed, evidence, owner, next_action)
      VALUES (?, ?, ?, ?, 'active', ?, date('now'), ?, 'user', ?)
    `).run(candidate.type, candidate.title, candidate.body, candidate.source, Math.max(candidate.confidence, 0.7), candidate.evidence, 'Review during next planner pass.');
    db.prepare('UPDATE memory_candidates SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run('approved', candidate.id);
  } else {
    db.prepare('UPDATE memory_candidates SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run(decision === 'deny' ? 'denied' : 'deferred', candidate.id);
  }
  ok(res, { candidate: row('SELECT * FROM memory_candidates WHERE id = ?', [candidate.id]), planner: plannerData() });
});

app.post('/api/approvals/:id/:decision', (req, res) => {
  if (!['approve', 'deny', 'defer'].includes(req.params.decision)) return fail(res, 400, 'Decision must be approve, deny, or defer.');
  const approval = row('SELECT * FROM approvals WHERE id = ?', [req.params.id]);
  if (!approval) return fail(res, 404, 'Approval not found.');
  const status = req.params.decision === 'approve' ? 'approved' : req.params.decision === 'deny' ? 'denied' : 'deferred';
  if (status === 'approved') {
    const payload = JSON.parse(approval.payload);
    if (approval.action_type === 'create_project') {
      db.prepare(`
        INSERT INTO projects (name, status, owner, source, confidence, last_reviewed, evidence, next_action)
        VALUES (?, ?, ?, 'approved proposal', ?, date('now'), ?, ?)
      `).run(payload.name, payload.status || 'active', payload.owner || 'user', payload.confidence || 0.75, payload.evidence || `Approval ${approval.id}`, payload.next_action || 'Define next action.');
    }
    if (approval.action_type === 'add_memory') {
      db.prepare(`
        INSERT INTO knowledge_items (type, title, body, source, status, confidence, last_reviewed, evidence, owner, next_action)
        VALUES (?, ?, ?, ?, 'active', ?, date('now'), ?, ?, ?)
      `).run(payload.type || 'current state', payload.title, payload.body, payload.source || 'approved proposal', payload.confidence || 0.7, payload.evidence || `Approval ${approval.id}`, payload.owner || 'user', payload.next_action || 'Review during next planner pass.');
    }
    if (approval.action_type === 'repo_write') {
      const target = safeWorkspacePath(payload.targetFile);
      fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
      fs.writeFileSync(target.absolute, payload.content || '', 'utf8');
    }
  }
  db.prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
  ok(res, plannerData());
});

app.post('/api/approvals', (req, res) => {
  const { action_type, title, payload, priority } = req.body;
  if (!action_type || !title || !payload) return fail(res, 400, 'action_type, title, and payload are required.');
  const id = db.prepare(`
    INSERT INTO approvals (action_type, title, payload, priority)
    VALUES (?, ?, ?, ?)
  `).run(action_type, title, JSON.stringify(payload), priority || 'P2').lastInsertRowid;
  ok(res, row('SELECT * FROM approvals WHERE id = ?', [id]));
});

app.get('/api/projects', (_req, res) => ok(res, allRows('SELECT * FROM projects ORDER BY updated_at DESC')));

app.post('/api/projects', (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return fail(res, 400, 'Project name is required.');
  const id = db.prepare(`
    INSERT INTO projects (name, status, owner, source, confidence, last_reviewed, evidence, next_action)
    VALUES (?, ?, ?, 'manual', ?, date('now'), ?, ?)
  `).run(name, req.body.status || 'active', req.body.owner || 'user', Number(req.body.confidence || 0.75), req.body.evidence || 'Manual entry', req.body.next_action || '').lastInsertRowid;
  ok(res, row('SELECT * FROM projects WHERE id = ?', [id]));
});

app.get('/api/models', (_req, res) => ok(res, allRows('SELECT * FROM model_registry ORDER BY assigned_role DESC, name ASC')));

app.post('/api/models/scan', (req, res) => {
  const folders = req.body.folders?.length ? req.body.folders : getSetting('modelFolders', []);
  const discovered = [];
  for (const folder of folders) {
    if (!folder || !fs.existsSync(folder)) continue;
    const stack = [folder];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
          const stat = fs.statSync(full);
          db.prepare(`
            INSERT INTO model_registry (name, path, size_bytes, source, updated_at)
            VALUES (?, ?, ?, 'local', CURRENT_TIMESTAMP)
            ON CONFLICT(path) DO UPDATE SET size_bytes = excluded.size_bytes, updated_at = CURRENT_TIMESTAMP
          `).run(entry.name, full, stat.size);
          discovered.push(full);
        }
      }
    }
  }
  setSetting('modelFolders', folders);
  ok(res, { discovered, models: allRows('SELECT * FROM model_registry ORDER BY assigned_role DESC, name ASC') });
});

app.post('/api/models/:id/assign', (req, res) => {
  const role = req.body.role || 'Planner Assistant';
  db.prepare('UPDATE model_registry SET assigned_role = NULL WHERE assigned_role = ?').run(role);
  db.prepare('UPDATE model_registry SET assigned_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(role, req.params.id);
  ok(res, allRows('SELECT * FROM model_registry ORDER BY assigned_role DESC, name ASC'));
});

app.get('/api/hf/files', async (req, res) => {
  const repo = String(req.query.repo || '').trim();
  if (!repo.includes('/')) return fail(res, 400, 'Provide a Hugging Face repo like org/model.');
  const token = getSetting('hfToken', '');
  const response = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) return fail(res, response.status, `Hugging Face lookup failed: ${response.statusText}`);
  const files = (await response.json()).filter((f) => f.type === 'file' && f.path.toLowerCase().endsWith('.gguf'));
  ok(res, files);
});

app.post('/api/hf/download', async (req, res) => {
  const { repo, file } = req.body;
  if (!repo || !file) return fail(res, 400, 'Repo and file are required.');
  const folder = req.body.folder || getSetting('modelDownloadFolder', path.resolve('models'));
  fs.mkdirSync(folder, { recursive: true });
  const token = getSetting('hfToken', '');
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
  const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok || !response.body) return fail(res, response.status, `Download failed: ${response.statusText}`);
  const target = path.join(folder, path.basename(file));
  await pipeline(response.body, fs.createWriteStream(target));
  const stat = fs.statSync(target);
  const id = db.prepare(`
    INSERT INTO model_registry (name, path, size_bytes, source)
    VALUES (?, ?, ?, 'huggingface')
    ON CONFLICT(path) DO UPDATE SET size_bytes = excluded.size_bytes, updated_at = CURRENT_TIMESTAMP
  `).run(path.basename(file), target, stat.size).lastInsertRowid;
  setSetting('modelDownloadFolder', folder);
  ok(res, { id, target, size: stat.size });
});

app.get('/api/settings', (_req, res) => {
  ok(res, Object.fromEntries(allRows('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)])));
});

app.post('/api/settings', (req, res) => {
  for (const [key, value] of Object.entries(req.body)) setSetting(key, value);
  ok(res, Object.fromEntries(allRows('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)])));
});

app.get('/api/consultations', (_req, res) => ok(res, allRows('SELECT * FROM consultations ORDER BY updated_at DESC')));

app.post('/api/consultations', (req, res) => {
  const title = req.body.title?.trim() || 'External consultation';
  const localDraft = req.body.local_draft?.trim();
  if (!localDraft) return fail(res, 400, 'Local draft is required.');
  const id = db.prepare('INSERT INTO consultations (title, local_draft, target_agent) VALUES (?, ?, ?)').run(title, localDraft, req.body.target_agent || 'manual browser').lastInsertRowid;
  ok(res, row('SELECT * FROM consultations WHERE id = ?', [id]));
});

app.patch('/api/consultations/:id', (req, res) => {
  db.prepare(`
    UPDATE consultations
    SET external_response = COALESCE(?, external_response),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.body.external_response ?? null, req.body.status ?? null, req.params.id);
  if (req.body.external_response) {
    const consultation = row('SELECT * FROM consultations WHERE id = ?', [req.params.id]);
    db.prepare(`
      INSERT INTO memory_candidates (type, title, body, source, evidence, confidence)
      VALUES ('decision', ?, ?, 'cloud consultation', ?, 0.45)
    `).run(`Consultation suggestion: ${consultation.title}`, consultation.external_response, `Consultation ${consultation.id}; requires user review.`);
  }
  ok(res, row('SELECT * FROM consultations WHERE id = ?', [req.params.id]));
});

app.get('/api/browser/capabilities', async (_req, res) => {
  try {
    await import('playwright');
    ok(res, { playwright: true, mode: 'available' });
  } catch {
    ok(res, { playwright: false, mode: 'manual consultation stub', note: 'Install Playwright to enable controlled browser consultation.' });
  }
});

app.post('/api/browser/open', async (req, res) => {
  let url;
  try {
    url = normalizeBrowserUrl(req.body.url);
  } catch (error) {
    return fail(res, 400, error.message);
  }

  try {
    const { chromium } = await import('playwright');
    const userDataDir = path.join(root, 'data', 'browser-profile');
    fs.mkdirSync(userDataDir, { recursive: true });
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: null,
      args: ['--start-maximized']
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const title = await page.title().catch(() => '');
    const currentUrl = page.url();
    const visibleText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    ok(res, {
      url: currentUrl,
      title,
      profile: userDataDir,
      excerpt: visibleText.replace(/\s+/g, ' ').trim().slice(0, 1200),
      note: 'Browser opened with a persistent local Playwright profile. Cloud responses remain advisory and must be reviewed before promotion.'
    });
  } catch (error) {
    fail(res, 500, error.message || 'Browser automation failed.');
  }
});

app.get('/api/tooling/status', async (_req, res) => {
  const [nodeVersion, npmVersion, ghStatus, hfStatus] = await Promise.all([
    runCli('node', ['--version']),
    runCli(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']),
    runCli('gh', ['auth', 'status']),
    runCli('hf', ['auth', 'whoami'])
  ]);
  const playwright = await packageAvailable('playwright');
  const puppeteer = await packageAvailable('puppeteer');
  const playwrightChromium = playwright
    ? await npxRun(['playwright', 'install', '--dry-run', 'chromium'])
    : { ok: false, available: false, stderr: 'Playwright package is not installed.' };

  ok(res, {
    node: { available: nodeVersion.ok, version: nodeVersion.stdout || nodeVersion.stderr },
    npm: { available: npmVersion.ok, version: npmVersion.stdout || npmVersion.stderr },
    playwright: {
      available: playwright,
      chromiumCheck: playwrightChromium.ok,
      detail: playwrightChromium.stdout || playwrightChromium.stderr
    },
    puppeteer: { available: puppeteer },
    githubCli: {
      available: ghStatus.available,
      authenticated: ghStatus.ok,
      detail: ghStatus.stdout || ghStatus.stderr
    },
    huggingFaceCli: {
      available: hfStatus.available,
      authenticated: hfStatus.ok,
      detail: hfStatus.stdout || hfStatus.stderr
    },
    installHints: {
      githubCli: 'winget install --id GitHub.cli',
      huggingFaceCli: 'pip install -U huggingface_hub[cli]'
    }
  });
});

app.post('/api/tooling/install', async (req, res) => {
  const tool = req.body.tool;
  const installers = {
    playwright: () => npmInstall(['install', 'playwright']),
    playwrightChromium: () => npxRun(['playwright', 'install', 'chromium']),
    puppeteer: () => npmInstall(['install', 'puppeteer'])
  };
  if (!installers[tool]) return fail(res, 400, 'Supported tools: playwright, playwrightChromium, puppeteer.');
  const result = await installers[tool]();
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || `Failed to install ${tool}.`);
  ok(res, { tool, output: result.stdout || result.stderr || `${tool} installed locally.` });
});

app.get('/api/source/status', async (_req, res) => {
  const [inside, branch, status, remotes, log, userName, userEmail, ghStatus, hfWhoami] = await Promise.all([
    runCli('git', ['rev-parse', '--is-inside-work-tree']),
    runCli('git', ['branch', '--show-current']),
    runCli('git', ['status', '--short', '--branch']),
    runCli('git', ['remote', '-v']),
    runCli('git', ['log', '--oneline', '--decorate', '-n', '8']),
    runCli('git', ['config', 'user.name']),
    runCli('git', ['config', 'user.email']),
    runCli('gh', ['auth', 'status']),
    runCli('hf', ['auth', 'whoami'])
  ]);

  if (!inside.ok) return fail(res, 400, 'This folder is not a Git repository.');

  ok(res, {
    repoPath: root,
    branch: branch.stdout || '(detached)',
    status: status.stdout,
    remotes: remotes.stdout,
    log: log.stdout,
    user: {
      name: userName.stdout,
      email: userEmail.stdout
    },
    github: {
      cliAvailable: ghStatus.available,
      authenticated: ghStatus.ok,
      detail: ghStatus.ok ? ghStatus.stdout || ghStatus.stderr : ghStatus.stderr
    },
    huggingface: {
      cliAvailable: hfWhoami.available,
      authenticated: hfWhoami.ok,
      detail: hfWhoami.ok ? hfWhoami.stdout : hfWhoami.stderr
    }
  });
});

app.get('/api/source/diff', async (_req, res) => {
  const diff = await runCli('git', ['diff', '--stat']);
  const detail = await runCli('git', ['diff', '--', '.'], { maxBuffer: 4 * 1024 * 1024 });
  ok(res, { stat: diff.stdout, detail: detail.stdout.slice(0, 50000), truncated: detail.stdout.length > 50000 });
});

app.post('/api/source/stage-all', async (_req, res) => {
  const result = await runCli('git', ['add', '-A']);
  if (!result.ok) return fail(res, 500, result.stderr || 'git add failed');
  ok(res, { status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
});

app.post('/api/source/commit', async (req, res) => {
  const message = req.body.message?.trim();
  if (!message) return fail(res, 400, 'Commit message is required.');
  const result = await runCli('git', ['commit', '-m', message], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git commit failed');
  ok(res, { output: result.stdout, log: (await runCli('git', ['log', '--oneline', '--decorate', '-n', '8'])).stdout });
});

app.post('/api/source/branch', async (req, res) => {
  const branch = req.body.branch?.trim();
  if (!branch) return fail(res, 400, 'Branch name is required.');
  const result = await runCli('git', ['switch', '-c', branch]);
  if (!result.ok) return fail(res, 500, result.stderr || 'git branch creation failed');
  ok(res, { branch, output: result.stdout || result.stderr });
});

app.post('/api/source/push', async (_req, res) => {
  const branch = await runCli('git', ['branch', '--show-current']);
  if (!branch.stdout) return fail(res, 400, 'Cannot push from detached HEAD.');
  const result = await runCli('git', ['push', '-u', 'origin', branch.stdout], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git push failed');
  ok(res, { output: result.stdout || result.stderr });
});

app.post('/api/source/remote', async (req, res) => {
  const url = req.body.url?.trim();
  const name = req.body.name?.trim() || 'origin';
  if (!url) return fail(res, 400, 'Remote URL is required.');
  const existing = await runCli('git', ['remote', 'get-url', name]);
  const result = existing.ok
    ? await runCli('git', ['remote', 'set-url', name, url])
    : await runCli('git', ['remote', 'add', name, url]);
  if (!result.ok) return fail(res, 500, result.stderr || 'git remote update failed');
  ok(res, { remotes: (await runCli('git', ['remote', '-v'])).stdout });
});

app.post('/api/source/login/github', (_req, res) => {
  const result = spawnCli('gh', ['auth', 'login', '-w']);
  if (!result.available) return fail(res, 404, 'GitHub CLI is not installed or not on PATH.');
  ok(res, { message: 'GitHub CLI login started. Complete the browser/device flow, then refresh source status.' });
});

app.post('/api/source/login/hf', (_req, res) => {
  const result = spawnCli('hf', ['auth', 'login']);
  if (!result.available) return fail(res, 404, 'Hugging Face CLI is not installed or not on PATH. Use the HF token field in Settings instead.');
  ok(res, { message: 'Hugging Face CLI login started. Complete the prompt, then refresh source status.' });
});

app.get('/api/repo/files', (req, res) => {
  const query = String(req.query.q || '').toLowerCase();
  const includeExt = new Set(['.md', '.mdx', '.json', '.txt', '.yml', '.yaml']);
  const blocked = new Set(['.git', 'node_modules', 'dist', 'data']);
  const files = [];
  const stack = [root];
  while (stack.length && files.length < 500) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (blocked.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (includeExt.has(path.extname(entry.name).toLowerCase()) && (!query || relative.toLowerCase().includes(query))) {
        const stat = fs.statSync(absolute);
        files.push({ path: relative, size: stat.size, updatedAt: stat.mtime.toISOString() });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  ok(res, files);
});

app.get('/api/repo/file', (req, res) => {
  try {
    const target = safeWorkspacePath(req.query.path);
    if (!fs.existsSync(target.absolute) || !fs.statSync(target.absolute).isFile()) return fail(res, 404, 'File not found.');
    const content = fs.readFileSync(target.absolute, 'utf8');
    ok(res, { path: target.normalized, content, updatedAt: fs.statSync(target.absolute).mtime.toISOString() });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.post('/api/repo/proposals', (req, res) => {
  try {
    const target = safeWorkspacePath(req.body.targetFile);
    const current = fs.existsSync(target.absolute) ? fs.readFileSync(target.absolute, 'utf8') : '';
    const content = String(req.body.content || '');
    const title = req.body.title?.trim() || `Update ${target.normalized}`;
    const payload = {
      targetFile: target.normalized,
      content,
      previousContent: current,
      summary: req.body.summary || 'Repository file update proposal.',
      risk: req.body.risk || 'medium',
      source: req.body.source || 'Repository Explorer'
    };
    const id = db.prepare(`
      INSERT INTO approvals (action_type, title, payload, priority)
      VALUES ('repo_write', ?, ?, ?)
    `).run(title, JSON.stringify(payload), req.body.priority || 'P1').lastInsertRowid;
    ok(res, row('SELECT * FROM approvals WHERE id = ?', [id]));
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.get('/api/export/json', (_req, res) => {
  const data = {
    exported_at: new Date().toISOString(),
    projects: allRows('SELECT * FROM projects'),
    knowledge_items: allRows('SELECT * FROM knowledge_items'),
    memory_candidates: allRows('SELECT * FROM memory_candidates'),
    chat_sessions: allRows('SELECT * FROM chat_sessions WHERE deleted = 0'),
    chat_messages: allRows('SELECT * FROM chat_messages'),
    settings: Object.fromEntries(allRows('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)]))
  };
  res.setHeader('Content-Disposition', 'attachment; filename="life-planner-export.json"');
  res.json(data);
});

app.get('/api/export/markdown', (_req, res) => {
  const items = allRows('SELECT * FROM knowledge_items ORDER BY type, title');
  const lines = ['# Life Planner Export', '', `Exported: ${new Date().toISOString()}`, ''];
  for (const item of items) {
    lines.push(`## ${item.title}`, '', `Type: ${item.type}`, `Status: ${item.status}`, `Confidence: ${item.confidence}`, `Source: ${item.source}`, '', item.body, '', `Next action: ${item.next_action || 'None'}`, '');
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="life-planner-export.md"');
  res.send(lines.join('\n'));
});

app.post('/api/import/json', (req, res) => {
  const data = req.body;
  const imported = { projects: 0, knowledge_items: 0 };
  const insertProject = db.prepare(`
    INSERT INTO projects (name, status, owner, source, confidence, last_reviewed, evidence, next_action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const project of data.projects || []) {
    insertProject.run(project.name, project.status || 'active', project.owner || 'user', 'json import', project.confidence || 0.6, project.last_reviewed || null, project.evidence || '', project.next_action || '');
    imported.projects += 1;
  }
  const insertItem = db.prepare(`
    INSERT INTO knowledge_items (type, title, body, source, status, confidence, last_reviewed, evidence, owner, next_action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of data.knowledge_items || []) {
    insertItem.run(item.type || 'current state', item.title || 'Imported item', item.body || '', 'json import', item.status || 'pending review', item.confidence || 0.5, item.last_reviewed || null, item.evidence || '', item.owner || 'user', item.next_action || '');
    imported.knowledge_items += 1;
  }
  ok(res, imported);
});

app.post('/api/import/markdown', (req, res) => {
  const markdown = String(req.body.markdown || '').trim();
  if (!markdown) return fail(res, 400, 'Markdown content is required.');
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] || 'Imported markdown document';
  const id = db.prepare(`
    INSERT INTO knowledge_items (type, title, body, source, status, confidence, evidence, owner, next_action)
    VALUES ('source document', ?, ?, 'markdown import', 'pending review', 0.5, 'Imported markdown text', 'user', 'Review and extract durable knowledge.')
  `).run(title, markdown).lastInsertRowid;
  ok(res, row('SELECT * FROM knowledge_items WHERE id = ?', [id]));
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Life Planner API running at http://127.0.0.1:${port}`);
});
