import express from 'express';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { db, getSetting, migrate, setSetting } from './db.js';

migrate();

const app = express();
const port = Number(process.env.LIFE_PLANNER_PORT || 4177);
const execFileAsync = promisify(execFile);
const root = process.cwd();
let managedLlamaServer = null;
let browserContext = null;
let browserPage = null;
let browserMode = '';
let browserLaunchNote = '';

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
    child.on('error', () => {});
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

function consultationCandidate(candidate = {}) {
  return candidate.source === 'cloud consultation'
    || String(candidate.title || '').startsWith('Consultation suggestion:');
}

function normalizedMemoryCandidate(candidate = {}) {
  const consultation = consultationCandidate(candidate);
  const title = consultation
    ? String(candidate.title || '').replace(/^Consultation suggestion:\s*/, '').trim() || 'Cloud consultation response'
    : candidate.title;
  return {
    ...candidate,
    type: consultation ? 'consultation' : candidate.type,
    title
  };
}

function browserChallengeResult({ url = '', title = '', text = '' }) {
  const haystack = `${url}\n${title}\n${text}`.toLowerCase();
  if (haystack.includes('chatgpt.com/api/auth/error')) {
    return {
      blocked: true,
      reason: 'ChatGPT returned an auth error in the controlled browser profile. Reset controlled browser data, then open ChatGPT again.'
    };
  }
  const challengeTerms = [
    '__cf_chl_',
    'verify you are human',
    'checking if the site connection is secure',
    'this browser or app may not be secure',
    'try using a different browser',
    'unusual traffic',
    'captcha'
  ];
  const blocked = challengeTerms.some((term) => haystack.includes(term));
  if (!blocked) return { blocked: false, reason: '' };
  if (haystack.includes('this browser or app may not be secure')) {
    return {
      blocked: true,
      reason: 'The site rejected this controlled browser as insecure. Use External to sign in through your normal browser.'
    };
  }
  return {
    blocked: true,
    reason: 'The site opened a human-verification challenge in the controlled browser. Use External for ChatGPT/Google sign-in or complete the check manually if the site allows it.'
  };
}

function chatGptUnavailableResult({ url = '', title = '', text = '' }) {
  const challenge = browserChallengeResult({ url, title, text });
  if (challenge.blocked) return challenge;
  const haystack = `${url}\n${title}\n${text}`.toLowerCase();
  if (haystack.includes('log in') && haystack.includes('sign up') && !haystack.includes('message chatgpt')) {
    return {
      blocked: true,
      reason: 'ChatGPT opened, but the signed-in composer was not available. Sign in or finish verification in the controlled browser profile, then run the consultation again.'
    };
  }
  return { blocked: false, reason: '' };
}

function browserProfileDir() {
  return path.join(root, 'data', 'browser-profile');
}

async function controlledBrowserPage() {
  const automation = await browserAutomationStatus();
  if (!automation.playwright) throw new Error(automation.note);
  if (!automation.chromium) {
    throw new Error(`${automation.note} Expected executable: ${automation.executablePath || 'unknown'}`);
  }

  const { chromium } = await import('playwright');
  const userDataDir = browserProfileDir();
  fs.mkdirSync(userDataDir, { recursive: true });
  if (!browserContext) {
    const launchOptions = {
      headless: false,
      viewport: null,
      args: ['--start-maximized']
    };
    try {
      browserContext = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        channel: 'chrome'
      });
      browserMode = 'persistent Chrome';
      browserLaunchNote = 'Using a dedicated persistent Chrome profile for Life Planner automation.';
    } catch (error) {
      browserContext = await chromium.launchPersistentContext(userDataDir, launchOptions);
      browserMode = 'persistent Playwright Chromium';
      browserLaunchNote = `Chrome channel was unavailable, so Playwright Chromium is using the same persistent app profile. ${error.message}`;
    }
    browserContext.on('close', () => {
      browserContext = null;
      browserPage = null;
      browserMode = '';
      browserLaunchNote = '';
    });
  }
  const pages = browserContext.pages();
  browserPage = browserPage && !browserPage.isClosed() ? browserPage : pages[0] || await browserContext.newPage();
  return { page: browserPage, profile: userDataDir, mode: browserMode || 'persistent browser', launchNote: browserLaunchNote };
}

async function resetBrowserProfile() {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    browserPage = null;
  }
  const dataRoot = path.resolve(root, 'data');
  const userDataDir = path.resolve(dataRoot, 'browser-profile');
  if (!userDataDir.startsWith(`${dataRoot}${path.sep}`)) {
    throw new Error('Refusing to reset a browser profile outside the app data folder.');
  }
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  return userDataDir;
}

async function packageAvailable(packageName) {
  try {
    await import(packageName);
    return true;
  } catch {
    return false;
  }
}

async function browserAutomationStatus() {
  try {
    const { chromium } = await import('playwright');
    const executablePath = chromium.executablePath();
    const chromiumInstalled = Boolean(executablePath && fs.existsSync(executablePath));
    return {
      playwright: true,
      chromium: chromiumInstalled,
      executablePath,
      mode: chromiumInstalled ? 'available' : 'chromium missing',
      note: chromiumInstalled
        ? 'Playwright Chromium is installed and browser automation can run.'
        : 'Playwright is installed, but Chromium is missing. Run npx playwright install chromium or use Tooling > Install Playwright Chromium.'
    };
  } catch {
    return {
      playwright: false,
      chromium: false,
      executablePath: '',
      mode: 'manual consultation stub',
      note: 'Install Playwright to enable controlled browser consultation.'
    };
  }
}

function selectedContextFiles(paths = []) {
  const normalizedPaths = [...new Set((Array.isArray(paths) ? paths : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))]
    .slice(0, 8);
  const contexts = [];
  let totalChars = 0;
  for (const contextPath of normalizedPaths) {
    const target = safeWorkspacePath(contextPath);
    if (isProtectedWorkspacePath(target.normalized)) {
      throw new Error(`Protected/private file cannot be sent to a cloud consultant: ${target.normalized}`);
    }
    if (!fs.existsSync(target.absolute) || !fs.statSync(target.absolute).isFile()) {
      throw new Error(`Context file not found: ${target.normalized}`);
    }
    const raw = fs.readFileSync(target.absolute, 'utf8');
    const remaining = Math.max(0, 24000 - totalChars);
    if (!remaining) break;
    const content = raw.slice(0, Math.min(raw.length, remaining, 8000));
    totalChars += content.length;
    contexts.push({
      path: target.normalized,
      truncated: content.length < raw.length,
      content
    });
  }
  return contexts;
}

function buildCloudConsultationPrompt({ targetAgent = 'ChatGPT', localDraft = '', contexts = [] }) {
  const contextBlock = contexts.length
    ? [
      'Selected LifePlanSystem context:',
      ...contexts.map((item, index) => [
        `Context ${index + 1}: ${item.path}${item.truncated ? ' (truncated)' : ''}`,
        '```text',
        item.content,
        '```'
      ].join('\n'))
    ].join('\n\n')
    : 'Selected LifePlanSystem context: none supplied.';

  return [
    'You are acting as an external consultant for Life Planner, a local-first personal executive assistant.',
    `Target: ${targetAgent}.`,
    '',
    'Review the local draft below. Critique it, call out missing context or risky assumptions, and suggest concrete improvements.',
    'Treat the selected LifePlanSystem context as background only. Do not claim authority over memory, priorities, or plans.',
    'Your response will be returned to Life Planner as a reviewable suggestion only; it will not become memory or source-of-truth unless the user explicitly saves/reviews it later.',
    '',
    contextBlock,
    '',
    'Local draft:',
    localDraft.trim() || '(No local draft supplied yet.)'
  ].join('\n');
}

async function firstVisibleLocator(page, selectors, timeout = 1000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count() && await locator.isVisible({ timeout })) return locator;
    } catch {
      // Try the next selector.
    }
  }
  return null;
}

async function chatGptComposer(page) {
  return firstVisibleLocator(page, [
    '[data-testid="prompt-textarea"]',
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    'textarea[aria-label*="Message"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ], 1500);
}

async function extractChatGptAnswer(page) {
  const selectors = [
    '[data-message-author-role="assistant"]',
    'article:has([data-message-author-role="assistant"])',
    '[data-testid^="conversation-turn-"] .markdown',
    '.markdown'
  ];
  for (const selector of selectors) {
    try {
      const items = await page.locator(selector).allTextContents();
      const cleaned = items.map((item) => item.replace(/\s+\n/g, '\n').trim()).filter(Boolean);
      if (cleaned.length) return cleaned[cleaned.length - 1];
    } catch {
      // Try the next selector.
    }
  }
  return '';
}

async function waitForChatGptAnswer(page, previousAnswer = '') {
  let last = '';
  let stableTicks = 0;
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const currentUrl = page.url();
    const title = await page.title().catch(() => '');
    const visibleText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const blocked = chatGptUnavailableResult({ url: currentUrl, title, text: visibleText });
    if (blocked.blocked) {
      const error = new Error(blocked.reason);
      error.blocked = true;
      error.currentUrl = currentUrl;
      error.title = title;
      error.excerpt = visibleText.replace(/\s+/g, ' ').trim().slice(0, 1200);
      throw error;
    }

    const answer = await extractChatGptAnswer(page);
    const hasNewAnswer = answer && answer !== previousAnswer && answer.length > 20;
    if (hasNewAnswer && answer === last) {
      stableTicks += 1;
    } else if (hasNewAnswer) {
      stableTicks = 0;
      last = answer;
    }

    const stopButton = await firstVisibleLocator(page, ['button[aria-label*="Stop"]', '[data-testid="stop-button"]'], 400);
    if (hasNewAnswer && stableTicks >= 2 && !stopButton) return answer;
    await page.waitForTimeout(1800);
  }
  throw new Error('Timed out waiting for ChatGPT to finish responding. If the answer is visible, use the manual fallback controls.');
}

async function runChatGptConsultation({ prompt, url = 'https://chatgpt.com/' }) {
  const { page, profile, mode, launchNote } = await controlledBrowserPage();
  await page.goto(normalizeBrowserUrl(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
  const title = await page.title().catch(() => '');
  const currentUrl = page.url();
  const visibleText = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
  const blocked = chatGptUnavailableResult({ url: currentUrl, title, text: visibleText });
  if (blocked.blocked) {
    return {
      ok: false,
      blocked: true,
      blockReason: blocked.reason,
      url: currentUrl,
      title,
      profile,
      mode,
      launchNote,
      excerpt: visibleText.replace(/\s+/g, ' ').trim().slice(0, 1200)
    };
  }

  const composer = await chatGptComposer(page);
  if (!composer) {
    return {
      ok: false,
      blocked: true,
      blockReason: 'ChatGPT opened, but the message composer was not found. Sign in, finish any verification, or start a new chat in the persistent browser profile, then try again.',
      url: page.url(),
      title: await page.title().catch(() => ''),
      profile,
      mode,
      launchNote,
      excerpt: visibleText.replace(/\s+/g, ' ').trim().slice(0, 1200)
    };
  }

  const previousAnswer = await extractChatGptAnswer(page);
  await composer.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.insertText(prompt);

  const sendButton = await firstVisibleLocator(page, [
    '[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button:has-text("Send")'
  ], 1200);
  if (sendButton) {
    await sendButton.click({ timeout: 10000 });
  } else {
    await page.keyboard.press('Enter');
  }

  const answer = await waitForChatGptAnswer(page, previousAnswer);
  return {
    ok: true,
    answer,
    url: page.url(),
    title: await page.title().catch(() => ''),
    profile,
    mode,
    launchNote
  };
}

async function openExternalBrowser(url) {
  const options = { cwd: root, timeout: 10000, windowsHide: true };
  if (process.platform === 'win32') {
    await execFileAsync('rundll32.exe', ['url.dll,FileProtocolHandler', url], options);
    return;
  }
  if (process.platform === 'darwin') {
    await execFileAsync('open', [url], options);
    return;
  }
  await execFileAsync('xdg-open', [url], options);
}

async function openChromeBrowser(url) {
  if (process.platform === 'win32') {
    const candidates = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter(Boolean);
    const chromePath = candidates.find((candidate) => fs.existsSync(candidate));
    if (chromePath) {
      const launched = spawnCli(chromePath, [url]);
      if (!launched.started) throw new Error(launched.error || 'Chrome launch failed.');
      return { launcher: chromePath };
    }
    await execFileAsync('cmd.exe', ['/c', 'start', '', 'chrome', url], { cwd: root, timeout: 10000, windowsHide: false });
    return { launcher: 'chrome app registration' };
  }
  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-a', 'Google Chrome', url], { cwd: root, timeout: 10000, windowsHide: false });
    return { launcher: 'Google Chrome app' };
  }
  const launched = spawnCli('google-chrome', [url]);
  if (!launched.started) throw new Error(launched.error || 'Chrome launch failed. Install Chrome or use External.');
  return { launcher: 'google-chrome' };
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
  const raw = String(relativePath || '').trim();
  if (!raw || raw.includes('\0')) throw new Error('Invalid path.');
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw new Error('Use a workspace-relative path, not an absolute path.');
  }
  const normalized = raw.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => part === '..')) throw new Error('Path must stay inside the workspace.');
  const absolute = path.resolve(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) throw new Error('Path must stay inside the workspace.');
  return { normalized, absolute };
}

function isProtectedWorkspacePath(filePath = '') {
  const normalized = String(filePath).replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
  const protectedRoots = ['.git/', 'data/', 'dist/', 'node_modules/', 'release/', '.cache/'];
  const protectedNames = ['.env', '.env.local', '.env.production'];
  const protectedExts = ['.sqlite', '.sqlite3', '.db', '.gguf', '.safetensors', '.onnx', '.log'];
  return protectedRoots.some((rootName) => normalized.startsWith(rootName))
    || protectedNames.includes(normalized)
    || protectedExts.some((ext) => normalized.endsWith(ext));
}

function parseGitStatus(statusText = '') {
  return statusText.split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith('##'))
    .map((line) => {
      const status = line.slice(0, 2).trim() || '??';
      const filePath = line.slice(3).trim();
      return {
        status,
        path: filePath,
        staged: line[0] && line[0] !== ' ' && line[0] !== '?',
        protected: isProtectedWorkspacePath(filePath)
      };
    });
}

async function gitStatusSnapshot() {
  const [status, conflicts, branch, upstream, aheadBehind] = await Promise.all([
    runCli('git', ['status', '--short', '--branch']),
    runCli('git', ['diff', '--name-only', '--diff-filter=U']),
    runCli('git', ['branch', '--show-current']),
    runCli('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    runCli('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
  ]);
  const changedFiles = parseGitStatus(status.stdout);
  const conflictFiles = conflicts.stdout ? conflicts.stdout.split('\n').filter(Boolean) : [];
  const counts = { added: 0, modified: 0, deleted: 0, untracked: 0, protected: 0 };
  for (const file of changedFiles) {
    if (file.protected) counts.protected += 1;
    if (file.status.includes('?')) counts.untracked += 1;
    else if (file.status.includes('A')) counts.added += 1;
    else if (file.status.includes('D')) counts.deleted += 1;
    else counts.modified += 1;
  }
  let ahead = 0;
  let behind = 0;
  if (aheadBehind.ok && aheadBehind.stdout) {
    const [nextAhead, nextBehind] = aheadBehind.stdout.split(/\s+/).map((value) => Number(value) || 0);
    ahead = nextAhead;
    behind = nextBehind;
  }
  return {
    branch: branch.stdout || '(detached)',
    status: status.stdout,
    changedFiles,
    conflictFiles,
    hasConflicts: conflictFiles.length > 0,
    upstream: upstream.ok ? upstream.stdout : '',
    ahead,
    behind,
    counts
  };
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

function assignedPlannerModel() {
  return row("SELECT * FROM model_registry WHERE assigned_role = 'Planner Assistant' ORDER BY updated_at DESC LIMIT 1");
}

function readChatContextFiles(sessionId) {
  const contexts = allRows('SELECT path FROM chat_context_files WHERE session_id = ? ORDER BY added_at DESC', [sessionId]);
  let remaining = 10000;
  const files = [];
  for (const item of contexts) {
    if (remaining <= 0) break;
    try {
      const target = safeWorkspacePath(item.path);
      if (!fs.existsSync(target.absolute) || !fs.statSync(target.absolute).isFile()) continue;
      const text = fs.readFileSync(target.absolute, 'utf8').slice(0, remaining);
      remaining -= text.length;
      files.push({ path: target.normalized, text });
    } catch {
      // Ignore unreadable context files; they remain attached but do not block chat.
    }
  }
  return files;
}

function buildAssistantPrompt(sessionId, userMessage) {
  const memories = allRows(`
    SELECT type, title, body, status, confidence, owner, next_action
    FROM knowledge_items
    WHERE status IN ('active', 'stable')
    ORDER BY confidence DESC, updated_at DESC
    LIMIT 12
  `);
  const pending = allRows('SELECT title, type, confidence FROM memory_candidates WHERE status IN (?, ?) ORDER BY created_at DESC LIMIT 8', ['candidate', 'deferred']);
  const files = readChatContextFiles(sessionId);

  const memoryBlock = memories.length
    ? memories.map((item) => `- [${item.type}/${item.status}/${Math.round(Number(item.confidence || 0) * 100)}%] ${item.title}: ${item.body} Next: ${item.next_action || 'none'}`).join('\n')
    : '- No approved memories yet.';
  const pendingBlock = pending.length
    ? pending.map((item) => `- [${item.type}/${Math.round(Number(item.confidence || 0) * 100)}%] ${item.title}`).join('\n')
    : '- No pending memory candidates.';
  const fileBlock = files.length
    ? files.map((file) => `--- ${file.path} ---\n${file.text}`).join('\n\n')
    : 'No attached source files.';

  return [
    'You are Life Planner, a local-first personal executive assistant.',
    'Use the local database context below. Do not promote chat content to memory; mention candidate memories only as suggestions for user review.',
    'Cloud agents are consultants only. If external critique is needed, recommend using the Browser consultation workflow.',
    'Answer with a concise next step and any blockers or review items.',
    '',
    'Approved local knowledge:',
    memoryBlock,
    '',
    'Pending memory candidates:',
    pendingBlock,
    '',
    'Attached files:',
    fileBlock,
    '',
    'User message:',
    userMessage
  ].join('\n');
}

async function localModelStatus() {
  const model = assignedPlannerModel();
  const endpoint = String(getSetting('localModelEndpoint', '') || '').trim();
  const llamaCliPath = String(getSetting('llamaCliPath', '') || '').trim();
  const llamaServerPath = String(getSetting('llamaServerPath', '') || '').trim();
  const llamaServerPort = Number(getSetting('llamaServerPort', 8080) || 8080);
  return {
    assigned: Boolean(model),
    model,
    endpointConfigured: Boolean(endpoint),
    endpoint,
    llamaCliConfigured: Boolean(llamaCliPath),
    llamaCliPath,
    llamaCliExists: Boolean(llamaCliPath && fs.existsSync(llamaCliPath)),
    llamaServerConfigured: Boolean(llamaServerPath),
    llamaServerPath,
    llamaServerExists: Boolean(llamaServerPath && fs.existsSync(llamaServerPath)),
    llamaServerPort,
    managedServerRunning: Boolean(managedLlamaServer && !managedLlamaServer.killed),
    managedEndpoint: managedLlamaServer && !managedLlamaServer.killed ? `http://127.0.0.1:${llamaServerPort}` : ''
  };
}

async function runEndpointModel(endpoint, prompt) {
  const base = endpoint.replace(/\/+$/, '');
  const url = base.endsWith('/v1/chat/completions') ? base : `${base}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'planner-assistant',
      messages: [
        { role: 'system', content: 'You are Life Planner. Keep answers concise, local-first, and governance-aware.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 700
    })
  });
  if (!response.ok) throw new Error(`Local model endpoint failed: ${response.status} ${response.statusText}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || data.choices?.[0]?.text?.trim() || '';
}

async function runLlamaCli(llamaCliPath, modelPath, prompt) {
  const result = await execFileAsync(llamaCliPath, ['-m', modelPath, '-p', prompt, '-n', '700', '--temp', '0.3'], {
    cwd: root,
    timeout: 5 * 60 * 1000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  return result.stdout.trim();
}

async function runPlannerAssistant(sessionId, userMessage) {
  const status = await localModelStatus();
  if (!status.assigned) {
    return {
      mode: 'unavailable',
      content: 'Saved to chat. No Planner Assistant model is assigned yet; use Settings to scan/download a GGUF and load it as Planner Assistant.'
    };
  }

  const prompt = buildAssistantPrompt(sessionId, userMessage);
  try {
    if (status.managedEndpoint) {
      const content = await runEndpointModel(status.managedEndpoint, prompt);
      if (content) return { mode: 'managed llama-server', content };
    }
    if (status.endpointConfigured) {
      const content = await runEndpointModel(status.endpoint, prompt);
      if (content) return { mode: 'local endpoint', content };
    }
    if (status.llamaCliConfigured && status.llamaCliExists) {
      const content = await runLlamaCli(status.llamaCliPath, status.model.path, prompt);
      if (content) return { mode: 'llama-cli', content };
    }
  } catch (error) {
    return {
      mode: 'runtime error',
      content: `Saved to chat. Local model runtime failed: ${error.message}. The message remains available for memory review, and no memory was promoted automatically.`
    };
  }

  return {
    mode: 'unavailable',
    content: 'Saved to chat. A Planner Assistant model is assigned, but no runnable local runtime is configured. Add an OpenAI-compatible local endpoint or llama-cli path in Settings.'
  };
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
  const nextBest = pendingApprovals[0] || blockers[0] || candidates[0] || focus[0] || items[0] || null;

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

async function refreshPlannerState() {
  const changes = [];
  const browserReady = await browserAutomationStatus();
  const browserBlocker = row(
    "SELECT * FROM knowledge_items WHERE title = ? AND status NOT IN ('archived', 'deprecated', 'superseded')",
    ['Cloud browser automation is not configured yet']
  );

  if (browserReady.playwright && browserReady.chromium && browserBlocker) {
    const existing = row(
      "SELECT * FROM approvals WHERE action_type = 'update_memory' AND title = ? AND status = 'pending'",
      ['Retire resolved Playwright blocker']
    );
    if (!existing) {
      db.prepare(`
        INSERT INTO approvals (action_type, title, payload, priority)
        VALUES (?, ?, ?, 'P1')
      `).run('update_memory', 'Retire resolved Playwright blocker', JSON.stringify({
        id: browserBlocker.id,
        updates: {
          status: 'archived',
          confidence: 0.9,
          evidence: 'Planner refresh found the local Playwright package available.',
          next_action: 'Use the Browser tab for cloud consultation when needed.'
        }
      }));
      changes.push('Created approval to archive the resolved Playwright blocker.');
    }
  }

  return {
    changes,
    message: changes.length ? changes.join(' ') : 'Planner refresh complete. No governed changes proposed.'
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

app.post('/api/planner/refresh', async (_req, res) => {
  try {
    const result = await refreshPlannerState();
    ok(res, { ...result, planner: plannerData() });
  } catch (error) {
    fail(res, 500, error.message || 'Planner refresh failed.');
  }
});

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

app.get('/api/chat/sessions/:id/context', (req, res) => {
  ok(res, allRows('SELECT * FROM chat_context_files WHERE session_id = ? ORDER BY added_at DESC', [req.params.id]));
});

app.post('/api/chat/sessions/:id/context', (req, res) => {
  const session = row('SELECT * FROM chat_sessions WHERE id = ? AND deleted = 0', [req.params.id]);
  if (!session) return fail(res, 404, 'Session not found.');
  try {
    const target = safeWorkspacePath(req.body.path);
    if (!fs.existsSync(target.absolute) || !fs.statSync(target.absolute).isFile()) return fail(res, 404, 'Context file not found.');
    db.prepare(`
      INSERT INTO chat_context_files (session_id, path)
      VALUES (?, ?)
      ON CONFLICT(session_id, path) DO NOTHING
    `).run(req.params.id, target.normalized);
    ok(res, allRows('SELECT * FROM chat_context_files WHERE session_id = ? ORDER BY added_at DESC', [req.params.id]));
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.delete('/api/chat/sessions/:id/context/:contextId', (req, res) => {
  db.prepare('DELETE FROM chat_context_files WHERE id = ? AND session_id = ?').run(req.params.contextId, req.params.id);
  ok(res, allRows('SELECT * FROM chat_context_files WHERE session_id = ? ORDER BY added_at DESC', [req.params.id]));
});

app.post('/api/chat/sessions/:id/messages', async (req, res) => {
  const content = req.body.content?.trim();
  if (!content) return fail(res, 400, 'Message content is required.');
  const session = row('SELECT * FROM chat_sessions WHERE id = ? AND deleted = 0', [req.params.id]);
  if (!session) return fail(res, 404, 'Session not found.');
  const contexts = allRows('SELECT path FROM chat_context_files WHERE session_id = ? ORDER BY added_at DESC', [req.params.id]);
  const messageId = db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'user', content).lastInsertRowid;
  const candidateId = createCandidateFromMessage(Number(req.params.id), messageId, content);
  const contextLine = contexts.length
    ? `\n\nFiles in context: ${contexts.map((item) => item.path).join(', ')}. Source files are context only; I am not treating inference as source-of-truth.`
    : '';
  const assistant = await runPlannerAssistant(Number(req.params.id), content);
  const governanceLine = candidateId
    ? '\n\nMemory governance: I saved your note as a candidate for review and will not promote it until you approve it.'
    : '\n\nMemory governance: I saved this to chat history and did not extract a memory candidate from this short note.';
  const response = `${assistant.content}${governanceLine}${contextLine}\n\nRuntime: ${assistant.mode}.`;
  const assistantId = db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'assistant', response).lastInsertRowid;
  db.prepare('UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  ok(res, {
    messages: allRows('SELECT * FROM chat_messages WHERE id IN (?, ?) ORDER BY id ASC', [messageId, assistantId]),
    candidateId,
    runtime: assistant.mode
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
    const approved = normalizedMemoryCandidate(candidate);
    db.prepare(`
      INSERT INTO knowledge_items
      (type, title, body, source, status, confidence, last_reviewed, evidence, owner, next_action)
      VALUES (?, ?, ?, ?, 'active', ?, date('now'), ?, 'user', ?)
    `).run(approved.type, approved.title, approved.body, approved.source, Math.max(approved.confidence, 0.7), approved.evidence, 'Review during next planner pass.');
    db.prepare('UPDATE memory_candidates SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run('approved', candidate.id);
  } else {
    db.prepare('UPDATE memory_candidates SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run(decision === 'deny' ? 'denied' : 'deferred', candidate.id);
  }
  ok(res, { candidate: row('SELECT * FROM memory_candidates WHERE id = ?', [candidate.id]), planner: plannerData() });
});

app.patch('/api/memory/candidates/:id', (req, res) => {
  const candidate = row('SELECT * FROM memory_candidates WHERE id = ?', [req.params.id]);
  if (!candidate) return fail(res, 404, 'Candidate not found.');
  if (!['candidate', 'deferred'].includes(candidate.status)) return fail(res, 409, 'Only candidate or deferred memory can be edited.');
  const confidence = req.body.confidence === undefined ? candidate.confidence : Math.max(0, Math.min(1, Number(req.body.confidence) || 0));
  db.prepare(`
    UPDATE memory_candidates
    SET type = COALESCE(?, type),
        title = COALESCE(?, title),
        body = COALESCE(?, body),
        evidence = COALESCE(?, evidence),
        confidence = ?
    WHERE id = ?
  `).run(req.body.type || null, req.body.title || null, req.body.body || null, req.body.evidence || null, confidence, candidate.id);
  ok(res, { candidate: row('SELECT * FROM memory_candidates WHERE id = ?', [candidate.id]), planner: plannerData() });
});

app.post('/api/approvals/:id/:decision', (req, res) => {
  try {
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
      if (approval.action_type === 'update_project') {
        const target = row('SELECT * FROM projects WHERE id = ?', [payload.id]);
        if (!target) return fail(res, 404, 'Project not found.');
        const previous = payload.previous || {};
        for (const key of ['name', 'status', 'owner', 'next_action']) {
          if (Object.hasOwn(previous, key) && String(target[key] || '') !== String(previous[key] || '')) {
            return fail(res, 409, `Project changed after this proposal was created. Refresh before approving.`);
          }
        }
        if (Object.hasOwn(previous, 'confidence') && Number(target.confidence || 0) !== Number(previous.confidence || 0)) {
          return fail(res, 409, 'Project confidence changed after this proposal was created. Refresh before approving.');
        }
        const updates = payload.updates || {};
        db.prepare(`
          UPDATE projects
          SET name = COALESCE(?, name),
              status = COALESCE(?, status),
              owner = COALESCE(?, owner),
              confidence = COALESCE(?, confidence),
              last_reviewed = date('now'),
              evidence = COALESCE(?, evidence),
              next_action = COALESCE(?, next_action),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          updates.name ?? null,
          updates.status ?? null,
          updates.owner ?? null,
          updates.confidence ?? null,
          updates.evidence ?? `Approval ${approval.id}`,
          updates.next_action ?? null,
          target.id
        );
      }
      if (approval.action_type === 'add_memory') {
        db.prepare(`
          INSERT INTO knowledge_items (type, title, body, source, status, confidence, last_reviewed, evidence, owner, next_action)
          VALUES (?, ?, ?, ?, 'active', ?, date('now'), ?, ?, ?)
        `).run(payload.type || 'current state', payload.title, payload.body, payload.source || 'approved proposal', payload.confidence || 0.7, payload.evidence || `Approval ${approval.id}`, payload.owner || 'user', payload.next_action || 'Review during next planner pass.');
      }
      if (approval.action_type === 'repo_write') {
        const operation = payload.operation || 'update';
        const target = safeWorkspacePath(payload.targetFile);
        if (isProtectedWorkspacePath(target.normalized)) return fail(res, 400, `Protected runtime/private file cannot be changed: ${target.normalized}`);
        if (operation === 'rename') {
          const from = safeWorkspacePath(payload.fromFile);
          if (isProtectedWorkspacePath(from.normalized)) return fail(res, 400, `Protected runtime/private file cannot be renamed: ${from.normalized}`);
          if (!fs.existsSync(from.absolute) || !fs.statSync(from.absolute).isFile()) return fail(res, 404, 'Source file not found.');
          if (fs.existsSync(target.absolute)) return fail(res, 409, `Target already exists: ${target.normalized}`);
          const current = fs.readFileSync(from.absolute, 'utf8');
          if (Object.hasOwn(payload, 'previousContent') && current !== String(payload.previousContent || '')) return fail(res, 409, `File changed after this proposal was created. Refresh ${from.normalized} before approving.`);
          fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
          fs.renameSync(from.absolute, target.absolute);
        } else if (operation === 'delete') {
          if (!fs.existsSync(target.absolute) || !fs.statSync(target.absolute).isFile()) return fail(res, 404, 'File not found.');
          const current = fs.readFileSync(target.absolute, 'utf8');
          if (Object.hasOwn(payload, 'previousContent') && current !== String(payload.previousContent || '')) return fail(res, 409, `File changed after this proposal was created. Refresh ${target.normalized} before approving.`);
          fs.unlinkSync(target.absolute);
        } else {
          const exists = fs.existsSync(target.absolute);
          if (operation === 'create' && exists) return fail(res, 409, `File already exists: ${target.normalized}`);
          const current = exists ? fs.readFileSync(target.absolute, 'utf8') : '';
          if (Object.hasOwn(payload, 'previousContent') && current !== String(payload.previousContent || '')) return fail(res, 409, `File changed after this proposal was created. Refresh ${target.normalized} before approving.`);
          fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
          fs.writeFileSync(target.absolute, payload.content || '', 'utf8');
        }
      }
      if (approval.action_type === 'update_memory') {
        const target = row('SELECT * FROM knowledge_items WHERE id = ?', [payload.id]);
        if (!target) return fail(res, 404, 'Knowledge item not found.');
        const previous = payload.previous || {};
        if (Object.hasOwn(previous, 'updated_at') && String(target.updated_at || '') !== String(previous.updated_at || '')) return fail(res, 409, 'Memory changed after this proposal was created. Refresh before approving.');
        if (Object.hasOwn(previous, 'status') && String(target.status || '') !== String(previous.status || '')) return fail(res, 409, 'Memory status changed after this proposal was created. Refresh before approving.');
        if (Object.hasOwn(previous, 'confidence') && Number(target.confidence || 0) !== Number(previous.confidence || 0)) return fail(res, 409, 'Memory confidence changed after this proposal was created. Refresh before approving.');
        const updates = payload.updates || {};
        const nextStatus = updates.status || target.status;
        const allowedStatuses = ['active', 'stable', 'stale', 'deprecated', 'superseded', 'archived', 'pending review'];
        if (!allowedStatuses.includes(nextStatus)) return fail(res, 400, `Unsupported memory status: ${nextStatus}`);
        db.prepare(`
          UPDATE knowledge_items
          SET status = ?,
              confidence = COALESCE(?, confidence),
              last_reviewed = date('now'),
              evidence = COALESCE(?, evidence),
              next_action = COALESCE(?, next_action),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(nextStatus, updates.confidence ?? null, updates.evidence ?? null, updates.next_action ?? null, target.id);
      }
    }
    db.prepare('UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
    ok(res, plannerData());
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.post('/api/approvals/:id/revalidate', (req, res) => {
  try {
    const approval = row('SELECT * FROM approvals WHERE id = ?', [req.params.id]);
    if (!approval) return fail(res, 404, 'Approval not found.');
    const payload = JSON.parse(approval.payload || '{}');
    if (approval.action_type === 'repo_write') {
      const target = safeWorkspacePath(payload.operation === 'rename' ? payload.fromFile : payload.targetFile);
      if (isProtectedWorkspacePath(target.normalized)) return fail(res, 400, `Protected/private file cannot be changed: ${target.normalized}`);
      const exists = fs.existsSync(target.absolute);
      const current = exists && fs.statSync(target.absolute).isFile() ? fs.readFileSync(target.absolute, 'utf8') : '';
      const stale = Object.hasOwn(payload, 'previousContent') && current !== String(payload.previousContent || '');
      return ok(res, { valid: !stale, stale, message: stale ? `File changed since proposal: ${target.normalized}` : 'Proposal still matches current file state.' });
    }
    if (approval.action_type === 'update_project') {
      const target = row('SELECT * FROM projects WHERE id = ?', [payload.id]);
      if (!target) return ok(res, { valid: false, stale: true, message: 'Project no longer exists.' });
      const previous = payload.previous || {};
      const stale = ['name', 'status', 'owner', 'next_action'].some((key) => Object.hasOwn(previous, key) && String(target[key] || '') !== String(previous[key] || ''))
        || (Object.hasOwn(previous, 'confidence') && Number(target.confidence || 0) !== Number(previous.confidence || 0));
      return ok(res, { valid: !stale, stale, message: stale ? 'Project changed since proposal.' : 'Proposal still matches current project state.' });
    }
    ok(res, { valid: true, stale: false, message: 'No external stale checks are required for this approval.' });
  } catch (error) {
    fail(res, 400, error.message);
  }
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

app.get('/api/models/runtime', async (_req, res) => {
  ok(res, await localModelStatus());
});

app.post('/api/models/server/start', async (req, res) => {
  const status = await localModelStatus();
  if (!status.assigned) return fail(res, 400, 'Assign a Planner Assistant model before starting llama-server.');
  const serverPath = String(req.body.llamaServerPath || status.llamaServerPath || '').trim();
  const port = Number(req.body.port || status.llamaServerPort || 8080);
  const contextSize = Number(req.body.contextSize || getSetting('llamaContextSize', 4096) || 4096);
  if (!serverPath || !fs.existsSync(serverPath)) return fail(res, 400, 'Set a valid llama-server executable path first.');
  if (managedLlamaServer && !managedLlamaServer.killed) return ok(res, await localModelStatus());

  const args = ['-m', status.model.path, '--host', '127.0.0.1', '--port', String(port), '-c', String(contextSize)];
  const child = spawn(serverPath, args, {
    cwd: root,
    detached: false,
    stdio: 'ignore',
    windowsHide: true
  });
  child.on('error', () => {});
  child.on('exit', () => {
    if (managedLlamaServer === child) managedLlamaServer = null;
  });
  managedLlamaServer = child;
  setSetting('llamaServerPath', serverPath);
  setSetting('llamaServerPort', port);
  setSetting('llamaContextSize', contextSize);
  setSetting('localModelEndpoint', `http://127.0.0.1:${port}`);
  ok(res, { message: `llama-server starting on 127.0.0.1:${port}`, runtime: await localModelStatus() });
});

app.post('/api/models/server/stop', async (_req, res) => {
  if (managedLlamaServer && !managedLlamaServer.killed) {
    managedLlamaServer.kill();
    managedLlamaServer = null;
  }
  ok(res, { message: 'Managed llama-server stopped.', runtime: await localModelStatus() });
});

app.get('/api/hardware', async (_req, res) => {
  const cpu = os.cpus()?.[0]?.model || 'Unknown CPU';
  const cores = os.cpus()?.length || 0;
  const totalRamGb = Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10;
  let gpus = [];
  const nvidia = await runCli('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 10000 });
  if (nvidia.ok && nvidia.stdout) {
    gpus = nvidia.stdout.split('\n').filter(Boolean).map((line) => {
      const [name, memoryMb] = line.split(',').map((part) => part.trim());
      return {
        name: name || 'NVIDIA GPU',
        vramGb: memoryMb ? Math.round((Number(memoryMb) / 1024) * 10) / 10 : null,
        source: 'nvidia-smi'
      };
    });
  }
  if (process.platform === 'win32') {
    const gpuResult = await runCli('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"
    ], { timeout: 10000, maxBuffer: 1024 * 1024 });
    if (gpuResult.ok && gpuResult.stdout) {
      try {
        const parsed = JSON.parse(gpuResult.stdout);
        const cimGpus = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((gpu) => ({
          name: gpu.Name || 'Unknown GPU',
          vramGb: gpu.AdapterRAM ? Math.round((Number(gpu.AdapterRAM) / 1024 / 1024 / 1024) * 10) / 10 : null,
          source: 'win32-cim'
        }));
        if (gpus.length) {
          gpus = gpus.map((gpu) => {
            const fallback = cimGpus.find((candidate) => candidate.name === gpu.name);
            return fallback ? { ...gpu, fallbackVramGb: fallback.vramGb } : gpu;
          });
        } else {
          gpus = cimGpus;
        }
      } catch {
        if (!gpus.length) gpus = [];
      }
    }
  }
  const maxVramGb = Math.max(0, ...gpus.map((gpu) => Number(gpu.vramGb || 0)));
  let tier = 'small';
  let recommendation = 'Prefer 3B-4B instruct GGUF, Q4_K_M or Q5_K_M.';
  if (totalRamGb >= 48 || maxVramGb >= 12) {
    tier = 'large';
    recommendation = '7B-9B instruct GGUF should be comfortable; try Q4_K_M/Q5_K_M, Q6 if memory allows.';
  } else if (totalRamGb >= 24 || maxVramGb >= 8) {
    tier = 'medium';
    recommendation = 'Prefer 4B-7B instruct GGUF, Q4_K_M for responsiveness.';
  }
  ok(res, { cpu, cores, totalRamGb, gpus, maxVramGb, tier, recommendation });
});

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

app.get('/api/hf/search', async (req, res) => {
  const query = String(req.query.q || 'GGUF instruct').trim();
  const token = getSetting('hfToken', '');
  const response = await fetch(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=25`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) return fail(res, response.status, `Hugging Face search failed: ${response.statusText}`);
  const models = (await response.json()).map((model) => ({
    id: model.id,
    downloads: model.downloads || 0,
    likes: model.likes || 0,
    tags: model.tags || [],
    pipeline_tag: model.pipeline_tag || ''
  })).filter((model) => model.id && (model.id.toLowerCase().includes('gguf') || model.tags.some((tag) => String(tag).toLowerCase().includes('gguf'))));
  ok(res, models);
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
  const id = db.prepare(`
    INSERT INTO consultations (title, local_draft, target_agent, prompt, opened_url, opened_title, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    localDraft,
    req.body.target_agent || 'manual browser',
    req.body.prompt || null,
    req.body.opened_url || null,
    req.body.opened_title || null,
    req.body.sent_at || null
  ).lastInsertRowid;
  ok(res, row('SELECT * FROM consultations WHERE id = ?', [id]));
});

app.patch('/api/consultations/:id', (req, res) => {
  const before = row('SELECT * FROM consultations WHERE id = ?', [req.params.id]);
  if (!before) return fail(res, 404, 'Consultation not found.');
  db.prepare(`
    UPDATE consultations
    SET external_response = COALESCE(?, external_response),
        prompt = COALESCE(?, prompt),
        opened_url = COALESCE(?, opened_url),
        opened_title = COALESCE(?, opened_title),
        sent_at = COALESCE(?, sent_at),
        captured_at = COALESCE(?, captured_at),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    req.body.external_response ?? null,
    req.body.prompt ?? null,
    req.body.opened_url ?? null,
    req.body.opened_title ?? null,
    req.body.sent_at ?? null,
    req.body.captured_at ?? (req.body.external_response ? new Date().toISOString() : null),
    req.body.status ?? null,
    req.params.id
  );
  if (req.body.external_response && !before.external_response) {
    const consultation = row('SELECT * FROM consultations WHERE id = ?', [req.params.id]);
    const evidence = [
      `Consultation ${consultation.id}`,
      consultation.target_agent && `target ${consultation.target_agent}`,
      consultation.opened_url && `opened ${consultation.opened_url}`,
      'requires user review'
    ].filter(Boolean).join('; ');
    db.prepare(`
      INSERT INTO memory_candidates (type, title, body, source, evidence, confidence)
      VALUES ('consultation', ?, ?, 'cloud consultation', ?, 0.45)
    `).run(consultation.title || 'Cloud consultation response', consultation.external_response, evidence);
  }
  ok(res, row('SELECT * FROM consultations WHERE id = ?', [req.params.id]));
});

app.get('/api/browser/capabilities', async (_req, res) => {
  ok(res, {
    ...(await browserAutomationStatus()),
    externalBrowser: true,
    externalBrowserNote: 'The app can open your default external browser for sign-in or human-check pages.'
  });
});

app.post('/api/browser/open', async (req, res) => {
  let url;
  try {
    url = normalizeBrowserUrl(req.body.url);
  } catch (error) {
    return fail(res, 400, error.message);
  }

  try {
    const { page, profile, mode, launchNote } = await controlledBrowserPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const title = await page.title().catch(() => '');
    const currentUrl = page.url();
    const visibleText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const challenge = browserChallengeResult({ url: currentUrl, title, text: visibleText });
    if (req.body.consultation_id) {
      db.prepare(`
        UPDATE consultations
        SET opened_url = ?, opened_title = ?, sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP), status = 'sent', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(currentUrl, title, req.body.consultation_id);
    }
    ok(res, {
      url: currentUrl,
      title,
      profile,
      mode,
      excerpt: visibleText.replace(/\s+/g, ' ').trim().slice(0, 1200),
      blocked: challenge.blocked,
      blockReason: challenge.reason,
      note: `${launchNote || 'Browser opened with a persistent local profile.'} Cloud responses remain advisory and must be reviewed before promotion.`
    });
  } catch (error) {
    fail(res, 500, error.message || 'Browser automation failed.');
  }
});

app.post('/api/browser/consult', async (req, res) => {
  const targetAgent = String(req.body.target_agent || 'ChatGPT').trim();
  const localDraft = String(req.body.local_draft || '').trim();
  const url = req.body.url || 'https://chatgpt.com/';
  const chatGptTarget = targetAgent === 'ChatGPT' || String(url).toLowerCase().includes('chatgpt.com');
  if (!localDraft) return fail(res, 400, 'Enter a message before running cloud consultation.');
  if (!chatGptTarget) {
    return fail(res, 400, 'Automatic round trip currently supports ChatGPT only. Use manual fallback for other cloud agents.');
  }
  if (req.body.temporary_chat_required !== false && req.body.temporary_chat_confirmed !== true) {
    return fail(res, 400, 'Confirm ChatGPT Temporary Chat before sending the full consultation prompt. The app cannot verify this automatically.');
  }

  try {
    const contexts = selectedContextFiles(req.body.context_paths || []);
    const prompt = req.body.prompt?.trim() || buildCloudConsultationPrompt({
      targetAgent,
      localDraft,
      contexts
    });
    const result = await runChatGptConsultation({ prompt, url });
    if (result.blocked) {
      return ok(res, {
        ...result,
        prompt,
        contexts: contexts.map((item) => ({ path: item.path, truncated: item.truncated })),
        status: 'blocked',
        message: result.blockReason
      });
    }
    ok(res, {
      ...result,
      prompt,
      contexts: contexts.map((item) => ({ path: item.path, truncated: item.truncated })),
      status: 'answered',
      message: 'Cloud consultant response captured automatically. Review it before saving; nothing was saved or synced automatically.'
    });
  } catch (error) {
    fail(res, error.blocked ? 409 : 500, error.message || 'Automatic cloud consultation failed.');
  }
});

app.post('/api/browser/reset-profile', async (_req, res) => {
  try {
    const profile = await resetBrowserProfile();
    ok(res, {
      profile,
      message: 'Controlled browser data reset. Open ChatGPT again and sign in from a fresh profile.'
    });
  } catch (error) {
    fail(res, 500, error.message || 'Controlled browser profile reset failed.');
  }
});

app.post('/api/browser/open-external', async (req, res) => {
  let url;
  try {
    url = normalizeBrowserUrl(req.body.url);
  } catch (error) {
    return fail(res, 400, error.message);
  }

  try {
    await openExternalBrowser(url);
    if (req.body.consultation_id) {
      db.prepare(`
        UPDATE consultations
        SET opened_url = ?, opened_title = ?, sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP), status = 'sent', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(url, 'External browser', req.body.consultation_id);
    }
    ok(res, {
      url,
      title: 'External browser',
      mode: 'external',
      note: 'Opened in your default external browser. Use this for Google sign-in or human checks that reject controlled browsers.'
    });
  } catch (error) {
    fail(res, 500, error.message || 'External browser open failed.');
  }
});

app.post('/api/browser/open-chrome', async (req, res) => {
  let url;
  try {
    url = normalizeBrowserUrl(req.body.url);
  } catch (error) {
    return fail(res, 400, error.message);
  }

  try {
    const launch = await openChromeBrowser(url);
    if (req.body.consultation_id) {
      db.prepare(`
        UPDATE consultations
        SET opened_url = ?, opened_title = ?, sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP), status = 'sent', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(url, 'Chrome', req.body.consultation_id);
    }
    ok(res, {
      url,
      title: 'Chrome',
      mode: 'chrome',
      launcher: launch.launcher,
      note: 'Opened in your installed Chrome profile. The app did not read or copy Chrome cookies.'
    });
  } catch (error) {
    fail(res, 500, error.message || 'Chrome open failed. Install Chrome or use External.');
  }
});

app.get('/api/tooling/status', async (_req, res) => {
  const [nodeVersion, npmVersion, ghStatus, hfStatus, wingetStatus] = await Promise.all([
    runCli('node', ['--version']),
    runCli(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']),
    runCli('gh', ['auth', 'status']),
    runCli('hf', ['auth', 'whoami']),
    runCli('winget', ['--version'])
  ]);
  const browserAutomation = await browserAutomationStatus();

  ok(res, {
    node: { available: nodeVersion.ok, version: nodeVersion.stdout || nodeVersion.stderr },
    npm: { available: npmVersion.ok, version: npmVersion.stdout || npmVersion.stderr },
    playwright: {
      available: browserAutomation.playwright,
      chromiumCheck: browserAutomation.chromium,
      detail: browserAutomation.chromium
        ? `Chromium executable found: ${browserAutomation.executablePath}`
        : `${browserAutomation.note}${browserAutomation.executablePath ? ` Expected executable: ${browserAutomation.executablePath}` : ''}`
    },
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
    winget: {
      available: wingetStatus.available,
      version: wingetStatus.stdout || wingetStatus.stderr
    },
    installHints: {
      githubCli: wingetStatus.available ? 'winget install --id GitHub.cli' : 'Install GitHub CLI from cli.github.com because winget is not on PATH.',
      huggingFaceCli: 'pip install -U huggingface_hub[cli]'
    },
    installUrls: {
      githubCli: 'https://cli.github.com/',
      huggingFaceCli: 'https://huggingface.co/docs/huggingface_hub/guides/cli'
    }
  });
});

app.post('/api/tooling/install', async (req, res) => {
  const tool = req.body.tool;
  const installers = {
    playwright: () => npmInstall(['install', 'playwright']),
    playwrightChromium: () => npxRun(['playwright', 'install', 'chromium'])
  };
  if (!installers[tool]) return fail(res, 400, 'Supported tools: playwright, playwrightChromium.');
  const result = await installers[tool]();
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || `Failed to install ${tool}.`);
  ok(res, { tool, output: result.stdout || result.stderr || `${tool} installed locally.` });
});

app.get('/api/source/status', async (_req, res) => {
  const [inside, snapshot, remotes, log, userName, userEmail, ghStatus, hfWhoami, wingetStatus] = await Promise.all([
    runCli('git', ['rev-parse', '--is-inside-work-tree']),
    gitStatusSnapshot(),
    runCli('git', ['remote', '-v']),
    runCli('git', ['log', '--oneline', '--decorate', '-n', '8']),
    runCli('git', ['config', 'user.name']),
    runCli('git', ['config', 'user.email']),
    runCli('gh', ['auth', 'status']),
    runCli('hf', ['auth', 'whoami']),
    runCli('winget', ['--version'])
  ]);

  if (!inside.ok) return fail(res, 400, 'This folder is not a Git repository.');

  ok(res, {
    repoPath: root,
    branch: snapshot.branch,
    status: snapshot.status,
    changedFiles: snapshot.changedFiles,
    conflictFiles: snapshot.conflictFiles,
    hasConflicts: snapshot.hasConflicts,
    ahead: snapshot.ahead,
    behind: snapshot.behind,
    upstream: snapshot.upstream,
    counts: snapshot.counts,
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
    },
    winget: {
      available: wingetStatus.available,
      detail: wingetStatus.stdout || wingetStatus.stderr
    },
    installHints: {
      githubCli: wingetStatus.available ? 'winget install --id GitHub.cli' : 'Install GitHub CLI from cli.github.com because winget is not on PATH.',
      huggingFaceCli: 'pip install -U huggingface_hub[cli]'
    },
    installUrls: {
      githubCli: 'https://cli.github.com/',
      huggingFaceCli: 'https://huggingface.co/docs/huggingface_hub/guides/cli',
      github: 'https://github.com/login',
      huggingFace: 'https://huggingface.co/login'
    }
  });
});

app.get('/api/source/diff', async (_req, res) => {
  const diff = await runCli('git', ['diff', '--stat']);
  const detail = await runCli('git', ['diff', '--', '.'], { maxBuffer: 4 * 1024 * 1024 });
  ok(res, { stat: diff.stdout, detail: detail.stdout.slice(0, 50000), truncated: detail.stdout.length > 50000 });
});

app.post('/api/source/stage-all', async (_req, res) => {
  const snapshot = await gitStatusSnapshot();
  if (snapshot.hasConflicts) return fail(res, 409, `Resolve conflicts before staging: ${snapshot.conflictFiles.join(', ')}`);
  const protectedFiles = snapshot.changedFiles.filter((file) => file.protected).map((file) => file.path);
  if (protectedFiles.length) return fail(res, 409, `Protected/private files are present and were not staged: ${protectedFiles.join(', ')}`);
  const result = await runCli('git', ['add', '-A']);
  if (!result.ok) return fail(res, 500, result.stderr || 'git add failed');
  ok(res, { status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
});

app.post('/api/source/stage-file', async (req, res) => {
  try {
    const target = safeWorkspacePath(req.body.path);
    if (isProtectedWorkspacePath(target.normalized)) return fail(res, 409, `Protected/private file cannot be staged: ${target.normalized}`);
    const result = await runCli('git', ['add', '--', target.normalized]);
    if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git add failed');
    ok(res, { status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.post('/api/source/unstage-file', async (req, res) => {
  try {
    const target = safeWorkspacePath(req.body.path);
    const result = await runCli('git', ['restore', '--staged', '--', target.normalized]);
    if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git restore --staged failed');
    ok(res, { status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.post('/api/source/unstage-all', async (_req, res) => {
  const result = await runCli('git', ['restore', '--staged', '.']);
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git restore --staged failed');
  ok(res, { status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
});

app.post('/api/source/fetch', async (_req, res) => {
  const result = await runCli('git', ['fetch', '--all', '--prune'], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git fetch failed');
  ok(res, {
    output: result.stdout || result.stderr || 'Fetch complete.',
    status: (await runCli('git', ['status', '--short', '--branch'])).stdout
  });
});

app.post('/api/source/pull', async (_req, res) => {
  const branch = await runCli('git', ['branch', '--show-current']);
  if (!branch.stdout) return fail(res, 400, 'Cannot pull from detached HEAD.');
  const result = await runCli('git', ['pull', '--ff-only', 'origin', branch.stdout], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) return fail(res, 409, result.stderr || result.stdout || 'git pull --ff-only failed');
  ok(res, {
    output: result.stdout || result.stderr || 'Already up to date.',
    status: (await runCli('git', ['status', '--short', '--branch'])).stdout
  });
});

app.post('/api/source/commit', async (req, res) => {
  const message = req.body.message?.trim();
  if (!message) return fail(res, 400, 'Commit message is required.');
  const snapshot = await gitStatusSnapshot();
  if (snapshot.hasConflicts) return fail(res, 409, `Resolve conflicts before committing: ${snapshot.conflictFiles.join(', ')}`);
  if (!snapshot.changedFiles.some((file) => file.staged)) return fail(res, 400, 'Stage at least one file before committing.');
  if (snapshot.changedFiles.some((file) => file.protected && file.staged)) return fail(res, 409, 'A protected/private file is staged. Unstage it before committing.');
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

app.get('/api/source/branches', async (_req, res) => {
  const current = await runCli('git', ['branch', '--show-current']);
  const local = await runCli('git', ['branch', '--format=%(refname:short)']);
  const remote = await runCli('git', ['branch', '-r', '--format=%(refname:short)']);
  const branches = [
    ...local.stdout.split('\n').filter(Boolean).map((name) => ({ name, current: name === current.stdout, remote: false })),
    ...remote.stdout.split('\n')
      .filter((name) => name && !name.includes('HEAD') && name !== 'origin')
      .map((name) => ({ name, current: false, remote: true }))
  ];
  ok(res, { current: current.stdout, branches });
});

app.post('/api/source/checkout', async (req, res) => {
  const branch = req.body.branch?.trim();
  if (!branch) return fail(res, 400, 'Branch name is required.');
  const snapshot = await gitStatusSnapshot();
  if (snapshot.hasConflicts) return fail(res, 409, `Resolve conflicts before switching branches: ${snapshot.conflictFiles.join(', ')}`);
  if (snapshot.changedFiles.length && !req.body.allowDirty) return fail(res, 409, 'Working tree has changes. Commit, stash, or explicitly allow dirty branch switch.');
  const result = await runCli('git', ['switch', branch]);
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git switch failed');
  ok(res, { branch, output: result.stdout || result.stderr, status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
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

app.post('/api/source/login/github', async (_req, res) => {
  const cli = await runCli('gh', ['--version']);
  if (!cli.available) return fail(res, 404, 'GitHub CLI is not installed or not on PATH.');
  const result = spawnCli('gh', ['auth', 'login', '-w']);
  if (!result.available) return fail(res, 404, 'GitHub CLI is not installed or not on PATH.');
  ok(res, { message: 'GitHub CLI login started. Complete the browser/device flow, then refresh source status.' });
});

app.post('/api/source/login/hf', async (_req, res) => {
  const cli = await runCli('hf', ['--version']);
  if (!cli.available) return fail(res, 404, 'Hugging Face CLI is not installed or not on PATH. Use the HF token field in Settings instead.');
  const result = spawnCli('hf', ['auth', 'login']);
  if (!result.available) return fail(res, 404, 'Hugging Face CLI is not installed or not on PATH. Use the HF token field in Settings instead.');
  ok(res, { message: 'Hugging Face CLI login started. Complete the prompt, then refresh source status.' });
});

app.post('/api/source/create/github', async (req, res) => {
  const repo = String(req.body.repo || '').trim();
  const visibility = req.body.visibility === 'private' ? '--private' : '--public';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return fail(res, 400, 'Use owner/repo format, for example neuro-1977/lps.');
  const cli = await runCli('gh', ['--version']);
  if (!cli.available) return fail(res, 404, 'GitHub CLI is not installed or not on PATH. Use the Open GitHub New button instead.');
  const auth = await runCli('gh', ['auth', 'status']);
  if (!auth.ok) return fail(res, 401, 'GitHub CLI is not logged in. Use Login with Git first.');
  const result = await runCli('gh', ['repo', 'create', repo, visibility, '--confirm'], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'GitHub repo creation failed.');
  ok(res, { message: `GitHub repo ${repo} created. Set origin when ready, then push.`, output: result.stdout || result.stderr });
});

app.post('/api/source/create/hf', async (req, res) => {
  const repo = String(req.body.repo || '').trim();
  const type = ['model', 'dataset', 'space'].includes(req.body.type) ? req.body.type : 'model';
  const visibility = req.body.visibility === 'private' ? '--private' : '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return fail(res, 400, 'Use owner/repo format, for example username/life-planner-models.');
  const cli = await runCli('hf', ['--version']);
  if (!cli.available) return fail(res, 404, 'Hugging Face CLI is not installed or not on PATH. Use the Open HF New button instead.');
  const auth = await runCli('hf', ['auth', 'whoami']);
  if (!auth.ok) return fail(res, 401, 'Hugging Face CLI is not logged in. Use Login with HF first or save an HF token in Settings.');
  const args = ['repo', 'create', repo, '--type', type].concat(visibility ? [visibility] : []);
  const result = await runCli('hf', args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'Hugging Face repo creation failed.');
  ok(res, { message: `Hugging Face ${type} repo ${repo} created.`, output: result.stdout || result.stderr });
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
    if (isProtectedWorkspacePath(target.normalized)) return fail(res, 403, `Protected/private file cannot be previewed: ${target.normalized}`);
    if (!fs.existsSync(target.absolute) || !fs.statSync(target.absolute).isFile()) return fail(res, 404, 'File not found.');
    const content = fs.readFileSync(target.absolute, 'utf8');
    ok(res, { path: target.normalized, content, updatedAt: fs.statSync(target.absolute).mtime.toISOString() });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.post('/api/repo/proposals', (req, res) => {
  try {
    const operation = req.body.operation || 'update';
    const target = safeWorkspacePath(req.body.targetFile);
    if (isProtectedWorkspacePath(target.normalized)) return fail(res, 400, `Protected runtime/private file cannot be proposed for writing: ${target.normalized}`);
    const from = req.body.fromFile ? safeWorkspacePath(req.body.fromFile) : null;
    if (from && isProtectedWorkspacePath(from.normalized)) return fail(res, 400, `Protected runtime/private file cannot be proposed for writing: ${from.normalized}`);
    const current = fs.existsSync(target.absolute) ? fs.readFileSync(target.absolute, 'utf8') : '';
    const content = String(req.body.content || '');
    const verb = operation === 'create' ? 'Create' : operation === 'delete' ? 'Delete' : operation === 'rename' ? 'Rename' : 'Update';
    const title = req.body.title?.trim() || `${verb} ${operation === 'rename' && from ? from.normalized : target.normalized}`;
    const payload = {
      operation,
      targetFile: target.normalized,
      fromFile: from?.normalized,
      content,
      previousContent: Object.hasOwn(req.body, 'previousContent') ? String(req.body.previousContent || '') : current,
      summary: req.body.summary || `Repository file ${operation} proposal.`,
      risk: req.body.risk || (operation === 'update' ? 'medium' : 'high'),
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

function publicSettings(includeSecrets = false) {
  const settings = Object.fromEntries(allRows('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)]));
  if (!includeSecrets && Object.hasOwn(settings, 'hfToken')) settings.hfToken = settings.hfToken ? '[redacted]' : '';
  return settings;
}

function importPreview(data = {}) {
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const knowledgeItems = Array.isArray(data.knowledge_items) ? data.knowledge_items : [];
  const projectDuplicates = projects.filter((project) => project?.name && row('SELECT id FROM projects WHERE name = ? LIMIT 1', [project.name])).length;
  const knowledgeDuplicates = knowledgeItems.filter((item) => item?.title && row('SELECT id FROM knowledge_items WHERE title = ? LIMIT 1', [item.title])).length;
  return {
    projects: projects.length,
    knowledge_items: knowledgeItems.length,
    duplicate_projects: projectDuplicates,
    duplicate_knowledge_items: knowledgeDuplicates,
    ignored_sections: Object.keys(data).filter((key) => !['projects', 'knowledge_items'].includes(key))
  };
}

app.get('/api/export/json', (req, res) => {
  const mode = req.query.mode === 'backup' ? 'backup' : 'public';
  const includeSecrets = req.query.includeSecrets === '1';
  const data = {
    exported_at: new Date().toISOString(),
    mode,
    projects: allRows('SELECT * FROM projects'),
    knowledge_items: mode === 'backup'
      ? allRows('SELECT * FROM knowledge_items')
      : allRows("SELECT * FROM knowledge_items WHERE status IN ('active', 'stable')")
  };
  if (mode === 'backup') {
    data.memory_candidates = allRows('SELECT * FROM memory_candidates');
    data.chat_sessions = allRows('SELECT * FROM chat_sessions WHERE deleted = 0');
    data.chat_messages = allRows('SELECT * FROM chat_messages');
    data.consultations = allRows('SELECT * FROM consultations');
    data.settings = publicSettings(includeSecrets);
  }
  res.setHeader('Content-Disposition', `attachment; filename="life-planner-${mode}-export.json"`);
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
  if (!Array.isArray(data.projects) && !Array.isArray(data.knowledge_items)) return fail(res, 400, 'Import must include projects or knowledge_items arrays.');
  const mode = req.query.mode === 'import_all' || req.body.mode === 'import_all' ? 'import_all' : 'skip_duplicates';
  const imported = { projects: 0, knowledge_items: 0, skipped_projects: 0, skipped_knowledge_items: 0, mode };
  const insertProject = db.prepare(`
    INSERT INTO projects (name, status, owner, source, confidence, last_reviewed, evidence, next_action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const project of data.projects || []) {
    if (mode === 'skip_duplicates' && project.name && row('SELECT id FROM projects WHERE name = ? LIMIT 1', [project.name])) {
      imported.skipped_projects += 1;
      continue;
    }
    insertProject.run(project.name, project.status || 'active', project.owner || 'user', 'json import', project.confidence || 0.6, project.last_reviewed || null, project.evidence || '', project.next_action || '');
    imported.projects += 1;
  }
  const insertItem = db.prepare(`
    INSERT INTO knowledge_items (type, title, body, source, status, confidence, last_reviewed, evidence, owner, next_action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of data.knowledge_items || []) {
    if (mode === 'skip_duplicates' && item.title && row('SELECT id FROM knowledge_items WHERE title = ? LIMIT 1', [item.title])) {
      imported.skipped_knowledge_items += 1;
      continue;
    }
    insertItem.run(item.type || 'current state', item.title || 'Imported item', item.body || '', 'json import', item.status || 'pending review', item.confidence || 0.5, item.last_reviewed || null, item.evidence || '', item.owner || 'user', item.next_action || '');
    imported.knowledge_items += 1;
  }
  ok(res, imported);
});

app.post('/api/import/json/preview', (req, res) => {
  ok(res, importPreview(req.body || {}));
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

const distDir = path.join(root, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(port, '127.0.0.1', () => {
  console.log(`Life Planner running at http://127.0.0.1:${port}`);
});
