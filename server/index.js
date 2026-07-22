import express from 'express';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { db, dbPath, getSetting, migrate, SECRET_SETTING_KEYS, setSetting } from './db.js';
import {
  OPENHANDS_MANDATORY_FORBIDDEN,
  normalizeRequestPath,
  violatesMandatoryForbidden,
  validateExecutorBaseBranch,
  OPENHANDS_EXECUTOR_LIMITS,
  checkWorktreeValidationSetup,
  checkExecutorMaxFilesChanged,
  summarizeExecutorCommandResult,
  limitExecutorReportText,
  buildOpenHandsInvocationConstraints,
  buildOpenHandsInvocationReadiness,
  parsePorcelainPaths,
  isChangedFileAllowed,
  enforceChangedFiles
} from './executorEnforcement.js';
import { resolveRunCliCwd } from './runCliCwd.js';
import { chromeProfileArgument, probeChromeExtension } from './browserExtensionInstall.js';
import {
  canUseGitHubToken,
  detectHighConfidenceSecrets,
  isProtectedWorkspacePath,
  parseNullSeparatedPaths,
  parsePorcelainStatus,
  publicPolicyMarkerPath,
  publicationBoundary,
  validateRemoteUrl
} from './sourceControlSafety.js';

migrate();
seedRoadmapIfEmpty();

// Safety net: a bug in one request handler must not silently take the whole
// local server down or leave it in a half-dead state. Log and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

// One-time seed so the Roadmap opens with the real current build state instead
// of an empty board. Only runs when the table is empty, so user edits and
// deletions are never overwritten on later starts.
function seedRoadmapIfEmpty() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM roadmap_items').get();
  if (existing.n > 0) return;
  const seed = [
    { title: 'LPS-native Source Control panel', detail: 'Tabbed git cockpit: changes/stage/discard/commit, history graph, branches (switch/create/merge/delete), sync (fetch/pull/rebase/push), PAT login.', status: 'done', category: 'feature' },
    { title: 'Full git management coverage', detail: 'Source Control handles all git: stash save/list/apply/pop/drop, discard-all (confirmed), in-app conflict resolution (ours/theirs/mark), and tags (create/list/delete/push).', status: 'done', category: 'feature' },
    { title: 'Model manager (llama.cpp + HF)', detail: 'The installer ships verified llama.cpp, provisions a verified starter GGUF, and model download/load performs atomic download, assignment, hidden server launch, log capture, and health proof.', resume_notes: 'COMPLETED 2026-07-22: pinned llama.cpp b8354 and Qwen2.5 starter digests are enforced. A real Windows /health and /v1/chat/completions acceptance returned LPS LOCAL READY. Later GGUF choices follow the same verified load path. See docs/LOCAL_AI_BROWSER_AND_DOCUMENT_GUIDE.md.', status: 'done', category: 'feature' },
    { title: 'CI/CD + local installer build', detail: 'On push, GitHub Actions builds the portable bundle + Inno installer and uploads both artifacts. A release-targeted dispatch attaches the installer to an existing GitHub Release. The Source tab can also build the installer locally with live status.', resume_notes: 'COMPLETED 2026-07-17: hosted push run 29578272261 and release-targeted run 29578538752 both passed every required build, runtime-safety, packaging, Inno, and artifact step. Release 1.0 now carries LifePlannerPortableSetup.exe (38,951,229 bytes; SHA-256 4C0970D64983EC1F87CC4A165AA2A696FBC803D6ED39964521A1538E7B762D51). The exact hosted asset was downloaded, silently installed, launched with its bundled Node runtime, verified through /api/health and the web UI, silently uninstalled, and copied to D:\\MA-Updates. Source provides the local non-blocking installer build endpoint and status UI.', status: 'done', category: 'infra' },
    { title: 'First-run setup / health gate', detail: 'Guided checklist for model + git + Playwright so a fresh launch is not inert. Turns scattered setup into one gated flow with live status.', resume_notes: 'P1 setup gate. Browser connector diagnostics advanced on 2026-07-22: Tooling now distinguishes files, Chrome registration, enabled state, current path/content, and live heartbeat, and opens the detected profile plus exact folder. See docs/handoffs/HANDOFF_2026-07-22_SERENITY_BROWSER_CONTROL_PARITY.md. The overall job remains planned: build one guided first-run checklist for database health, Git identity/publication readiness, local model runtime, Playwright Chromium, Chrome connector pairing, and installer/runtime version. Each check needs live evidence, a repair action, refresh, and a clear distinction between optional and blocking prerequisites. Add fresh-install and offline acceptance tests.', status: 'planned', category: 'feature' },
    { title: 'OpenHands real invocation', detail: 'Optional local-only OpenHands executor invocation behind the existing readiness gate.', resume_notes: 'PARKED/INACTIVE 2026-07-22: OpenHands is explicitly disabled by default and performs no automatic Docker/model probes. Ollama-specific routes/config were removed. Any future worker inherits LPS localCodeModelEndpoint/localCodeModelName, then the chat endpoint, then healthy bundled llama.cpp. Real invocation flag remains off until the existing safety design and runtime acceptance pass.', status: 'parked', category: 'infra' },
    { title: 'Brain-aware Chat provider router', detail: 'Chat routes to ChatGPT connector first with local model fallback; brain context loading foundation.', status: 'active', category: 'feature' },
    { title: 'Encrypt stored credentials with Windows DPAPI', detail: 'Keep GitHub, Hugging Face, and browser connector tokens out of plaintext SQLite while preserving redacted APIs and normal Source/browser behavior.', resume_notes: 'COMPLETED 2026-07-17: current-user Windows DPAPI encryption is enforced in server/db.js. Startup migrates legacy plaintext rows, secure-delete plus WAL truncation and VACUUM remove recoverable plaintext, empty values delete rows, and decrypt failures fail closed. verify:governance-safety proves migration, ciphertext-at-rest, redaction, replacement, and clearing. The live database was migrated and inspected without exposing values.', status: 'done', category: 'fix' },
    { title: 'Classified exports and transactional recovery', detail: 'Require explicit shareability classification and preview for public exports, then redesign Local Backup as a documented, transactional recovery format.', resume_notes: 'P1. Follow docs/handoffs/HANDOFF_2026-07-17_NEXT_AGENT_REPAIR_QUEUE.md section 2. Do not infer public safety from active/stable status. Add a persisted classification, blocked/unknown preview, format version and manifest, dry-run import, one transaction, rollback tests, and truthful UI naming. Independently confirmed by Serenity audit thread 019f248e-8ff9-7c51-83b8-a446de4ed437 at server/index.js:4663,4666,4680.', status: 'planned', category: 'fix' },
    { title: 'Cloud egress classification and provider-aware completion', detail: 'Block sensitive prose and file content from browser-agent egress until reviewed, and replace generic DOM/stability capture with provider-specific completion evidence.', resume_notes: 'P1. Follow repair queue section 3. Add a server-side egress decision before job creation, user preview/confirmation, provider adapters for ChatGPT/Gemini/Grok/Claude, deterministic DOM fixtures, bounded fallback, cancellation, terminal-job pruning, and extension reload/port-change acceptance. Serenity audit thread 019f248e-8ff9-7c51-83b8-a446de4ed437 independently confirmed both egress risk (server/index.js:670,677,2482,2498) and stale generic capture risk (background.js:99,148,199). Current Serenity reference implementations are data/native/extensions/browser-agent/conversation-capture.js and conversation-capture.test.cjs; review the privacy and stale-turn gaps in docs/handoffs/HANDOFF_2026-07-22_SERENITY_BROWSER_CONTROL_PARITY.md before porting.', status: 'planned', category: 'fix' },
    { title: 'Transactional chat consultation and import writes', detail: 'Make multi-row chat, consultation-candidate, model, and JSON import operations atomic with recoverable failure states and durable idempotency.', resume_notes: 'P1/P2. Follow repair queue section 4. Start with POST /api/import/json and chat send. Validate the complete payload before BEGIN IMMEDIATE, commit all rows together, roll back injected mid-operation failures, and add request/provenance keys for retry safety. Independently confirmed by Serenity audit thread 019f248e-8ff9-7c51-83b8-a446de4ed437 at server/index.js:4699,4711,1779,1784.', status: 'planned', category: 'fix' },
    { title: 'Repository Explorer realpath containment', detail: 'Apply canonical realpath and junction/symlink containment to every Repository Explorer read, list, preview, and proposal path.', resume_notes: 'P2. Follow repair queue section 5. Centralize an operation-aware resolver, reject protected paths before and after canonicalization, constrain parent realpaths for creates, and test symlink/junction escapes plus TOCTOU-sensitive cases. Independently confirmed by Serenity audit thread 019f248e-8ff9-7c51-83b8-a446de4ed437 at server/index.js:991,999,4599,4612.', status: 'planned', category: 'fix' },
    { title: 'Verified atomic downloads and llama readiness', detail: 'Download models and runtimes through temporary files with published integrity checks, and report llama-server ready only after bounded health proof.', resume_notes: 'COMPLETED 2026-07-22: same-volume partial downloads, published size/SHA-256 checks, fsync, atomic rename, cleanup, captured logs, bounded health polling, failed-child termination, installer provisioning, and real completion acceptance all pass. verify:local-ai-docs protects the contract.', status: 'done', category: 'infra' },
    { title: 'Portable PDF and context documents', detail: 'Import local PDFs and export selected Life Planner context as PDF, interactive HTML, Markdown, text, or JSON.', resume_notes: 'COMPLETED 2026-07-22: PDF.js extraction is local and bounded with SHA-256 provenance/pending review. PDF export uses local Chromium. Interactive HTML is self-contained, searchable, and CSP-restricted. Export scopes cover all, projects, knowledge, roadmap, and chat. Public export remains separately classification-gated.', status: 'done', category: 'feature' },
    { title: 'Installer launch health and process lifecycle', detail: 'Launch the installed app through a hidden, single-instance Windows tray host with health polling, useful failure output, pause/resume, and owned-process shutdown.', resume_notes: 'COMPLETED 2026-07-22: Windows tray support is part of main, not a separate product branch. Start Life Planner.vbs launches LifePlannerTray.ps1 without a visible Node or PowerShell terminal. The tray host uses a per-install/port mutex, rejects unrelated port owners, waits for /api/health, captures server logs, keeps the app alive after the browser closes, and exposes Open, Pause, Resume, and Exit. Exit terminates only the owned bundled Node process tree. Packaging and Inno shortcuts include the app icon and tray files; verify:tray-launcher is part of verify:runtime-safety. Compared against the native Serenity and KeepHerFlying tray lifecycles before acceptance.', status: 'done', category: 'fix' },
    { title: 'Signed attributable release artifacts', detail: 'Add checksums, SBOM, provenance, and code signing to release outputs without silently publishing unsigned binaries as trusted.', resume_notes: 'P2. Follow repair queue section 8. Generate SHA256SUMS and CycloneDX/SPDX output in CI, attach attestations, make signing conditional on an explicitly configured protected secret, verify signatures after download, and document unsigned-development behavior.', status: 'planned', category: 'infra' },
    { title: 'Responsive and keyboard accessible UI', detail: 'Remove desktop-only layout constraints and establish keyboard, focus, contrast, and automated accessibility acceptance.', resume_notes: 'P2. Follow repair queue section 9. Remove the 900px body minimum, define mobile Source/Settings behavior, add visible focus states and accessible names, run axe plus keyboard smoke tests, and capture desktop/mobile screenshots before completion. Independently confirmed by Serenity audit thread 019f248e-8ff9-7c51-83b8-a446de4ed437 at src/styles.css:43,877.', status: 'planned', category: 'feature' }
  ];
  const insert = db.prepare('INSERT INTO roadmap_items (title, detail, resume_notes, category, status, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  seed.forEach((item, index) => insert.run(item.title, item.detail, item.resume_notes || '', item.category, item.status, index));
}

const app = express();
const port = Number(process.env.LIFE_PLANNER_PORT || 4177);
const execFileAsync = promisify(execFile);
const root = process.cwd();
let managedLlamaServer = null;
let managedLlamaServerReady = false;
let managedLlamaServerStartPromise = null;
let browserContext = null;
let browserPage = null;
let browserMode = '';
let browserLaunchNote = '';
let cdpBrowser = null;
let browserAgentJobSeq = 1;
const browserAgentJobs = new Map();
const browserExtensionState = {
  lastSeen: 0,
  tabs: []
};

function emptyInstallerBuildState() {
  return {
    running: false,
    status: 'idle',
    command: '',
    startedAt: '',
    finishedAt: '',
    exitCode: null,
    output: '',
    artifacts: []
  };
}

let installerBuildState = emptyInstallerBuildState();

function appendInstallerBuildOutput(chunk) {
  if (!chunk) return;
  installerBuildState.output = `${installerBuildState.output}${String(chunk)}`.slice(-120000);
}

function summarizeInstallerArtifacts() {
  const targets = [
    path.join(root, 'release', 'LifePlannerPortableSetup.exe'),
    path.join(root, 'release', 'LifePlannerPortable')
  ];
  return targets
    .filter((target) => fs.existsSync(target))
    .map((target) => {
      const stat = fs.statSync(target);
      return {
        path: path.relative(root, target).replaceAll('\\', '/'),
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.isFile() ? stat.size : null,
        updatedAt: stat.mtime.toISOString()
      };
    });
}

function installerBuildSnapshot() {
  return {
    ...installerBuildState,
    artifacts: summarizeInstallerArtifacts()
  };
}

function installerBuildCommand() {
  const scriptPath = path.join(root, 'scripts', 'build-installer.ps1');
  if (process.platform === 'win32') {
    return { command: 'powershell.exe', args: ['-ExecutionPolicy', 'Bypass', '-File', scriptPath] };
  }
  return { command: 'pwsh', args: ['-ExecutionPolicy', 'Bypass', '-File', scriptPath] };
}

function startInstallerBuild() {
  if (installerBuildState.running) return installerBuildSnapshot();
  const scriptPath = path.join(root, 'scripts', 'build-installer.ps1');
  if (!fs.existsSync(scriptPath)) {
    installerBuildState = {
      ...emptyInstallerBuildState(),
      status: 'failed',
      finishedAt: new Date().toISOString(),
      output: `Installer build script not found: ${scriptPath}\n`
    };
    return installerBuildSnapshot();
  }

  const job = installerBuildCommand();
  installerBuildState = {
    running: true,
    status: 'running',
    command: `${job.command} ${job.args.join(' ')}`,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    exitCode: null,
    output: '',
    artifacts: summarizeInstallerArtifacts()
  };
  appendInstallerBuildOutput(`Starting installer build at ${installerBuildState.startedAt}\n`);

  let child;
  try {
    child = spawn(job.command, job.args, {
      cwd: root,
      windowsHide: true,
      shell: false
    });
  } catch (error) {
    installerBuildState = {
      ...installerBuildState,
      running: false,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      output: `${installerBuildState.output}Failed to start installer build: ${error.message}\n`
    };
    return installerBuildSnapshot();
  }

  child.stdout?.on('data', (chunk) => appendInstallerBuildOutput(chunk));
  child.stderr?.on('data', (chunk) => appendInstallerBuildOutput(chunk));
  child.on('error', (error) => {
    installerBuildState = {
      ...installerBuildState,
      running: false,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      output: `${installerBuildState.output}Installer build failed to start: ${error.message}\n`
    };
  });
  child.on('close', (code) => {
    installerBuildState = {
      ...installerBuildState,
      running: false,
      status: code === 0 ? 'completed' : 'failed',
      finishedAt: new Date().toISOString(),
      exitCode: code,
      artifacts: summarizeInstallerArtifacts()
    };
    appendInstallerBuildOutput(`Installer build ${code === 0 ? 'completed' : 'failed'} with exit code ${code}\n`);
  });

  return installerBuildSnapshot();
}

app.use(express.json({ limit: '25mb' }));

const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, status, message) => res.status(status).json({ ok: false, error: message });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCli(command, args, options = {}) {
  const timeoutMs = options.timeout || 20000;
  const maxBufferBytes = options.maxBuffer || 1024 * 1024;
  // A caller-provided cwd (e.g. the executor's isolated worktree) is honoured
  // only when it resolves inside the repo root; anything else is refused here
  // rather than executed elsewhere or silently retargeted to root.
  const cwdResolution = resolveRunCliCwd(root, options.cwd);
  if (!cwdResolution.ok) {
    return {
      available: true, ok: false, code: 'EBADCWD', signal: '',
      timedOut: false, outputLimitHit: false, timeoutMs, maxBufferBytes,
      stdout: '', stderr: `runCli refused cwd: ${cwdResolution.reason}`
    };
  }
  try {
    const useShell = process.platform === 'win32' && /\.cmd$/i.test(command);
    const result = await execFileAsync(command, args, {
      cwd: cwdResolution.cwd,
      timeout: timeoutMs,
      windowsHide: true,
      shell: useShell,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      maxBuffer: maxBufferBytes
    });
    const stdout = options.preserveOutput ? String(result.stdout || '') : result.stdout.trim();
    const stderr = options.preserveOutput ? String(result.stderr || '') : result.stderr.trim();
    return { available: true, ok: true, stdout, stderr, timedOut: false, outputLimitHit: false, timeoutMs, maxBufferBytes };
  } catch (error) {
    const missing = error.code === 'ENOENT';
    const outputLimitHit = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(String(error.message || ''));
    const timedOut = !outputLimitHit && Boolean(error.killed || error.signal || /timed out/i.test(String(error.message || '')));
    return {
      available: !missing,
      ok: false,
      code: error.code,
      signal: error.signal || '',
      timedOut,
      outputLimitHit,
      timeoutMs,
      maxBufferBytes,
      stdout: options.preserveOutput ? String(error.stdout || '') : error.stdout?.trim() || '',
      stderr: options.preserveOutput ? String(error.stderr || '') : error.stderr?.trim() || error.message
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

function copyTextToSystemClipboard(text) {
  const value = String(text || '');
  if (!value.trim()) throw new Error('Prompt text is required before copying.');
  const candidates = process.platform === 'win32'
    ? [{ command: 'clip.exe', args: [] }]
    : process.platform === 'darwin'
      ? [{ command: 'pbcopy', args: [] }]
      : [
        { command: 'wl-copy', args: [] },
        { command: 'xclip', args: ['-selection', 'clipboard'] },
        { command: 'xsel', args: ['--clipboard', '--input'] }
      ];

  return new Promise((resolve, reject) => {
    let index = 0;
    const tryNext = () => {
      const candidate = candidates[index++];
      if (!candidate) {
        reject(new Error('No system clipboard command was available.'));
        return;
      }
      const child = spawn(candidate.command, candidate.args, {
        cwd: root,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe']
      });
      let handled = false;
      const next = () => {
        if (handled) return;
        handled = true;
        tryNext();
      };
      child.on('error', next);
      child.on('close', (code) => {
        if (handled) return;
        handled = true;
        if (code === 0) {
          resolve({ command: candidate.command });
        } else {
          tryNext();
        }
      });
      child.stdin.end(value);
    };
    tryNext();
  });
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

function defaultCloudAgentUrl(targetAgent = '', fallbackUrl = '') {
  const agent = String(targetAgent || '').trim().toLowerCase();
  if (fallbackUrl) return fallbackUrl;
  if (agent === 'gemini') return 'https://gemini.google.com/app';
  if (agent === 'grok') return 'https://grok.com/';
  if (agent === 'claude') return 'https://claude.ai/new';
  return 'https://chatgpt.com/';
}

const cloudAgentHosts = {
  ChatGPT: ['chatgpt.com', 'auth.openai.com'],
  Gemini: ['gemini.google.com', 'accounts.google.com'],
  Grok: ['grok.com', 'x.com'],
  Claude: ['claude.ai']
};

function tabMatchesAgent(url = '', hosts = []) {
  try {
    const parsed = new URL(url);
    return hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function emptyAgentTabMap() {
  return Object.fromEntries(Object.keys(cloudAgentHosts).map((agent) => [agent, { open: false, count: 0, tabs: [] }]));
}

function agentTabsFromUrls(tabs = []) {
  const agents = emptyAgentTabMap();
  for (const [agent, hosts] of Object.entries(cloudAgentHosts)) {
    const matches = tabs
      .filter((tab) => tabMatchesAgent(tab.url, hosts))
      .map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url || '' }));
    agents[agent] = {
      open: matches.length > 0,
      count: matches.length,
      tabs: matches
    };
  }
  return agents;
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

function chromeDebugProfileDir() {
  return path.join(root, 'data', 'chrome-debug-profile');
}

function browserAgentExtensionDir() {
  return path.join(root, 'browser-extension', 'lps-browser-agent');
}

function browserPairingConfigPath() {
  return process.env.LIFE_PLANNER_CONNECTOR_CONFIG
    ? path.resolve(process.env.LIFE_PLANNER_CONNECTOR_CONFIG)
    : path.join(browserAgentExtensionDir(), 'pairing-config.json');
}

function ensureBrowserPairingConfig() {
  let token = String(getSetting('browserConnectorToken', '') || '');
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    token = crypto.randomBytes(32).toString('hex');
    setSetting('browserConnectorToken', token);
  }
  const configPath = browserPairingConfigPath();
  const payload = `${JSON.stringify({ bridgeUrl: `http://127.0.0.1:${port}`, token }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath) || fs.readFileSync(configPath, 'utf8') !== payload) {
    fs.writeFileSync(configPath, payload, 'utf8');
  }
  return { token, configPath };
}

const browserPairing = ensureBrowserPairingConfig();

function browserExtensionAuthorized(req) {
  const supplied = String(req.get('X-LPS-Connector-Token') || '');
  const expected = browserPairing.token;
  if (!supplied || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function requireBrowserExtension(req, res) {
  if (browserExtensionAuthorized(req)) return true;
  fail(res, 401, 'Browser connector authentication failed. Reload the unpacked LPS extension to refresh pairing.');
  return false;
}

function chromeExecutablePath() {
  if (process.platform !== 'win32') return '';
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function chromeUserDataRoot() {
  return process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
    : '';
}

function browserExtensionProbe() {
  return probeChromeExtension({
    userDataRoot: chromeUserDataRoot(),
    extensionPath: browserAgentExtensionDir()
  });
}

async function chromeDebugEndpointAvailable(endpoint = 'http://127.0.0.1:9222') {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function launchChromeDebugging(url = 'https://chatgpt.com/') {
  if (await chromeDebugEndpointAvailable()) return true;
  const chromePath = chromeExecutablePath();
  if (!chromePath) return false;
  const userDataDir = chromeDebugProfileDir();
  fs.mkdirSync(userDataDir, { recursive: true });
  const launched = spawnCli(chromePath, [
    '--remote-debugging-port=9222',
    '--remote-allow-origins=http://127.0.0.1:9222',
    `--user-data-dir=${userDataDir}`,
    '--start-maximized'
  ]);
  if (!launched.started) return false;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (await chromeDebugEndpointAvailable()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function pageMatchesHost(page, host) {
  try {
    const current = new URL(page.url());
    return current.hostname === host || current.hostname.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

async function realChromePage(url = 'https://chatgpt.com/') {
  const ready = await launchChromeDebugging(url);
  if (!ready) return null;
  const { chromium } = await import('playwright');
  if (!cdpBrowser || !cdpBrowser.isConnected?.()) {
    cdpBrowser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    cdpBrowser.on('disconnected', () => {
      cdpBrowser = null;
    });
  }
  const context = cdpBrowser.contexts()[0] || await cdpBrowser.newContext();
  const pages = context.pages();
  const target = new URL(normalizeBrowserUrl(url));
  const page = pages.find((candidate) => !candidate.isClosed() && pageMatchesHost(candidate, target.hostname))
    || await context.newPage();
  return {
    page,
    profile: chromeDebugProfileDir(),
    mode: 'real Chrome debug profile',
    launchNote: 'Using a dedicated real Chrome profile with DevTools enabled. Chrome 136+ does not allow DevTools automation against the default personal Chrome profile, but this profile saves its own cookies after login.'
  };
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
      chromiumSandbox: true,
      args: ['--start-maximized']
    };
    try {
      browserContext = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        channel: 'chrome'
      });
      browserMode = 'app-controlled Chrome profile';
      browserLaunchNote = 'Using an app-owned Chrome profile for automation, not your personal signed-in Chrome profile.';
    } catch (error) {
      browserContext = await chromium.launchPersistentContext(userDataDir, launchOptions);
      browserMode = 'app-controlled Playwright Chromium profile';
      browserLaunchNote = `Chrome channel was unavailable, so Playwright Chromium is using the same app-owned profile. ${error.message}`;
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
        : 'Playwright is installed, but Chromium is missing. The packaged app can install it silently on install/first launch, or you can use Tooling > Install Playwright Chromium.'
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

function classifyAndRedactCloudPrompt(prompt) {
  const findings = [];
  let redacted = String(prompt || '');
  const rules = [
    { type: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED PRIVATE KEY]' },
    { type: 'secret assignment', pattern: /\b(api[_ -]?key|token|password|secret)\s*[:=]\s*[^\s,;]{6,}/gi, replacement: (_match, label) => `${label}=[REDACTED]` },
    { type: 'credential', pattern: /\b(?:sk|hf|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED CREDENTIAL]' },
    { type: 'email address', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[REDACTED EMAIL]' },
    { type: 'phone number', pattern: /(?<!\w)(?:\+?\d[\d ()-]{8,}\d)(?!\w)/g, replacement: '[REDACTED PHONE]' }
  ];
  for (const rule of rules) {
    let count = 0;
    redacted = redacted.replace(rule.pattern, (...args) => {
      count += 1;
      return typeof rule.replacement === 'function' ? rule.replacement(...args) : rule.replacement;
    });
    if (count) findings.push({ type: rule.type, count, action: 'redacted' });
  }
  return { prompt: redacted, findings, changed: redacted !== prompt };
}

function prepareCloudEgress(req) {
  const targetAgent = String(req.body.target_agent || 'ChatGPT').trim();
  const localDraft = String(req.body.local_draft || '').trim();
  const contexts = selectedContextFiles(req.body.context_paths || []);
  const assembled = req.body.prompt?.trim() || buildCloudConsultationPrompt({ targetAgent, localDraft, contexts });
  const classified = classifyAndRedactCloudPrompt(assembled);
  const promptHash = crypto.createHash('sha256').update(`${targetAgent}\0${classified.prompt}`, 'utf8').digest('hex');
  return { targetAgent, localDraft, contexts, prompt: classified.prompt, promptHash, findings: classified.findings, changed: classified.changed };
}

function buildBrowserAgentAssistPrompt({ targetAgent = 'ChatGPT', localDraft = '', contexts = [] }) {
  const contextList = contexts.length
    ? contexts.map((item, index) => `${index + 1}. ${item.path}${item.truncated ? ' (truncated)' : ''}\n${item.content.slice(0, 2200)}`).join('\n\n')
    : 'No selected context files.';

  return [
    'You are the local Life Planner model helping the user prepare a browser-agent question.',
    'Rewrite the user draft into a concise, well-scoped prompt for the selected external browser agent.',
    'Keep the user intent intact. Do not answer the prompt yourself. Do not add authority over memory, priorities, or plans.',
    'Return only the final browser-agent prompt text.',
    '',
    `Selected browser agent: ${targetAgent}`,
    '',
    'Selected local context:',
    contextList,
    '',
    'User draft:',
    localDraft.trim() || '(No draft supplied.)'
  ].join('\n');
}

async function runBrowserPromptAssistant({ targetAgent = 'ChatGPT', localDraft = '', contexts = [] }) {
  const status = await localModelStatus();
  if (!status.assigned && !status.endpointConfigured) {
    return {
      available: false,
      mode: 'unavailable',
      message: 'No local Planner Assistant model is assigned and no local endpoint is configured. The typed draft is still ready to send manually or through browser automation.'
    };
  }

  const prompt = buildBrowserAgentAssistPrompt({ targetAgent, localDraft, contexts });
  try {
    if (status.managedEndpoint) {
      const content = await runEndpointModel(status.managedEndpoint, status.endpointModelName || status.model?.name, prompt);
      if (content) return { available: true, mode: 'managed llama-server', prompt: content };
    }
    if (status.endpointConfigured) {
      const content = await runEndpointModel(status.endpoint, status.endpointModelName, prompt);
      if (content) return { available: true, mode: `local endpoint (${status.endpointModelName})`, prompt: content };
    }
    if (status.llamaCliConfigured && status.llamaCliExists && status.model?.path) {
      const content = await runLlamaCli(status.llamaCliPath, status.model.path, prompt);
      if (content) return { available: true, mode: 'llama-cli', prompt: content };
    }
  } catch (error) {
    return {
      available: false,
      mode: 'runtime error',
      message: `Local Planner Assistant failed: ${error.message}. The typed draft is still ready to send manually or through browser automation.`
    };
  }

  return {
    available: false,
    mode: 'unavailable',
    message: 'A local model is configured, but no runnable local runtime answered. Check Settings, or send the typed draft without local assistance.'
  };
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

async function waitForChatGptComposerAfterManualClearance(page, timeout = 600000) {
  const started = Date.now();
  let lastState = {
    url: page.url(),
    title: '',
    text: '',
    blocked: { blocked: false, reason: '' }
  };

  while (Date.now() - started < timeout) {
    const composer = await chatGptComposer(page);
    if (composer) return { composer, state: lastState };

    const currentUrl = page.url();
    const title = await page.title().catch(() => '');
    const visibleText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const blocked = chatGptUnavailableResult({ url: currentUrl, title, text: visibleText });
    lastState = {
      url: currentUrl,
      title,
      text: visibleText,
      blocked
    };

    await page.waitForTimeout(blocked.blocked ? 2500 : 1200);
  }

  return { composer: null, state: lastState };
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
  const browser = await realChromePage(url);
  if (!browser) {
    throw new Error('Could not attach to real Chrome through DevTools on 127.0.0.1:9222. Life Planner tried to launch a dedicated real Chrome debug profile under data/chrome-debug-profile. The app-controlled Playwright profile is intentionally not used for ChatGPT because Cloudflare keeps rejecting it.');
  }
  const { page, profile, mode, launchNote } = browser;
  await page.goto(normalizeBrowserUrl(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
  const ready = await waitForChatGptComposerAfterManualClearance(page);
  const composer = ready.composer;
  if (!composer) {
    const { url: currentUrl, title, text, blocked } = ready.state;
    return {
      ok: false,
      blocked: true,
      blockReason: blocked.blocked
        ? `${blocked.reason} The app waited for manual clearance in the controlled browser profile before giving up.`
        : 'ChatGPT opened, but the message composer was not found after waiting for manual login or verification.',
      url: currentUrl,
      title,
      profile,
      mode,
      launchNote,
      excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 1200)
    };
  }

  const previousAnswer = await extractChatGptAnswer(page);
  await composer.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await composer.fill(prompt).catch(async () => {
    await page.keyboard.insertText(prompt);
  });
  await composer.evaluate((node) => {
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }).catch(() => {});

  const sendButton = await firstVisibleLocator(page, [
    '[data-testid="send-button"]',
    '[data-testid="composer-submit-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button:has-text("Send")'
  ], 2500);
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

async function openChromeBrowser(url, detectedProfilePath = '') {
  if (process.platform === 'win32') {
    const chromePath = chromeExecutablePath();
    if (chromePath) {
      const profileArgument = chromeProfileArgument(chromeUserDataRoot(), detectedProfilePath);
      const launched = spawnCli(chromePath, [...(profileArgument ? [profileArgument] : []), url]);
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

function safeExistingWorkspaceFile(relativePath = '') {
  const target = safeWorkspacePath(relativePath);
  if (!fs.existsSync(target.absolute)) throw new Error('File not found.');
  const stat = fs.lstatSync(target.absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Context must be a regular file, not a link or directory.');
  const resolvedRoot = fs.realpathSync(root);
  const resolvedFile = fs.realpathSync(target.absolute);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (!resolvedFile.startsWith(rootWithSep)) throw new Error('Resolved file must stay inside the workspace.');
  return { ...target, absolute: resolvedFile };
}

// Guards against git argument injection: runCli uses execFile (no shell), so
// there is no shell-metacharacter risk, but a value beginning with "-" would be
// parsed by git as an option (e.g. a branch literally named "--force"). Accept
// only names that start alphanumeric and use git's ordinary ref characters, and
// reject the sequences git itself forbids in ref names.
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/;

function safeGitRef(value) {
  const v = String(value || '').trim();
  if (!v || v.length > 255) return null;
  if (!SAFE_GIT_REF.test(v)) return null;
  if (v.includes('..') || v.endsWith('.lock') || v.endsWith('/') || v.includes('//') || v.includes('@{')) return null;
  return v;
}

// A remote URL is not a ref, but must still never be parsed as a git option.
function safeGitUrl(value) {
  const validation = validateRemoteUrl(value);
  return validation.ok ? validation.remote.raw : null;
}

async function sourcePublicationBoundary() {
  const origin = await runCli('git', ['remote', 'get-url', 'origin']);
  const boundary = publicationBoundary(origin.stdout, {
    hasPublicPolicy: fs.existsSync(publicPolicyMarkerPath(root))
  });
  return { ...boundary, originUrl: origin.stdout || '' };
}

function gitAskPassEnvironment(remoteUrl, token) {
  if (!token || !canUseGitHubToken(remoteUrl)) return undefined;
  const helperDir = path.join(os.tmpdir(), 'life-planner', 'git');
  const windows = process.platform === 'win32';
  const helperPath = path.join(helperDir, windows ? 'git-askpass.cmd' : 'git-askpass.sh');
  const helper = windows
    ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\necho %~1 | findstr /I /C:"username" >nul\r\nif not errorlevel 1 (\r\n  echo %LPS_GIT_ASKPASS_USERNAME%\r\n  exit /b 0\r\n)\r\necho %LPS_GIT_ASKPASS_TOKEN%\r\n'
    : '#!/bin/sh\ncase "$1" in *sername*) printf "%s\\n" "$LPS_GIT_ASKPASS_USERNAME" ;; *) printf "%s\\n" "$LPS_GIT_ASKPASS_TOKEN" ;; esac\n';
  fs.mkdirSync(helperDir, { recursive: true });
  if (!fs.existsSync(helperPath) || fs.readFileSync(helperPath, 'utf8') !== helper) {
    fs.writeFileSync(helperPath, helper, 'utf8');
    if (!windows) fs.chmodSync(helperPath, 0o700);
  }
  return {
    GIT_ASKPASS: helperPath,
    GIT_ASKPASS_REQUIRE: 'force',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    LPS_GIT_ASKPASS_USERNAME: 'x-access-token',
    LPS_GIT_ASKPASS_TOKEN: token
  };
}

const PUBLICATION_SECRET_GREP = '(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)';

async function scanPublicationTarget(ref) {
  const tree = await runCli('git', ['ls-tree', '-r', '--name-only', '-z', ref], {
    preserveOutput: true,
    maxBuffer: 8 * 1024 * 1024
  });
  if (!tree.ok) return { allowed: false, reason: `Unable to inspect publication target ${ref}.` };
  const protectedPaths = parseNullSeparatedPaths(tree.stdout).filter(isProtectedWorkspacePath);
  if (protectedPaths.length) {
    return { allowed: false, reason: `Publication target contains protected/private paths: ${protectedPaths.slice(0, 5).join(', ')}` };
  }

  const treeSecrets = await runCli('git', ['grep', '-I', '-n', '-E', PUBLICATION_SECRET_GREP, ref, '--', '.'], {
    maxBuffer: 2 * 1024 * 1024
  });
  if (treeSecrets.ok && treeSecrets.stdout) {
    return { allowed: false, reason: 'Publication target contains a high-confidence credential or private-key signature.' };
  }
  if (!treeSecrets.ok && treeSecrets.code !== 1) {
    return { allowed: false, reason: 'Unable to complete the publication secret scan.' };
  }

  const outgoing = await runCli('git', ['log', '-p', '--format=', ref, '--not', '--remotes=origin'], {
    maxBuffer: 8 * 1024 * 1024
  });
  if (!outgoing.ok) {
    const reason = outgoing.outputLimitHit
      ? 'Outgoing history exceeds the automatic safety-scan limit; review it manually.'
      : 'Unable to inspect outgoing commit history.';
    return { allowed: false, reason };
  }
  const secretKinds = detectHighConfidenceSecrets(outgoing.stdout);
  if (secretKinds.length) {
    return { allowed: false, reason: `Outgoing history contains high-confidence secret signatures: ${secretKinds.join(', ')}.` };
  }
  return { allowed: true, reason: 'Publication target passed protected-path and secret scans.' };
}

function parseRemotes(remoteText = '') {
  const map = new Map();
  for (const line of remoteText.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    const existing = map.get(name) || { name, fetchUrl: '', pushUrl: '' };
    if (kind === 'fetch') existing.fetchUrl = url;
    else existing.pushUrl = url;
    map.set(name, existing);
  }
  return [...map.values()].map((remote) => ({
    name: remote.name,
    url: remote.fetchUrl || remote.pushUrl,
    pushUrl: remote.pushUrl || remote.fetchUrl
  }));
}

async function gitStatusSnapshot() {
  const [status, porcelain, conflicts, branch, upstream, aheadBehind] = await Promise.all([
    runCli('git', ['status', '--short', '--branch']),
    runCli('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { preserveOutput: true }),
    runCli('git', ['diff', '--name-only', '-z', '--diff-filter=U'], { preserveOutput: true }),
    runCli('git', ['branch', '--show-current']),
    runCli('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    runCli('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
  ]);
  const changedFiles = parsePorcelainStatus(porcelain.stdout);
  const conflictFiles = parseNullSeparatedPaths(conflicts.stdout);
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

function bundledLocalRuntime() {
  const portableRoot = path.resolve(root, '..');
  return {
    serverPath: path.join(portableRoot, 'llama', 'llama-server.exe'),
    cliPath: path.join(portableRoot, 'llama', 'llama-cli.exe'),
    starterModelPath: path.join(root, 'data', 'models', 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'),
    starterRepo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF',
    starterFile: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'
  };
}

function ensureBundledLocalRuntimeDefaults() {
  const bundled = bundledLocalRuntime();
  const configuredServer = String(getSetting('llamaServerPath', '') || '').trim();
  if (fs.existsSync(bundled.serverPath) && (!configuredServer || !fs.existsSync(configuredServer))) {
    setSetting('llamaServerPath', bundled.serverPath);
  }
  const configuredCli = String(getSetting('llamaCliPath', '') || '').trim();
  if (fs.existsSync(bundled.cliPath) && (!configuredCli || !fs.existsSync(configuredCli))) {
    setSetting('llamaCliPath', bundled.cliPath);
  }
  if (!fs.existsSync(bundled.starterModelPath)) return;

  const stat = fs.statSync(bundled.starterModelPath);
  db.prepare(`
    INSERT INTO model_registry (name, path, size_bytes, source, hf_repo, hf_file, updated_at)
    VALUES (?, ?, ?, 'bundled-starter', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(path) DO UPDATE SET size_bytes = excluded.size_bytes, hf_repo = excluded.hf_repo, hf_file = excluded.hf_file, updated_at = CURRENT_TIMESTAMP
  `).run(bundled.starterFile, bundled.starterModelPath, stat.size, bundled.starterRepo, bundled.starterFile);
  if (!assignedPlannerModel()) {
    db.prepare("UPDATE model_registry SET assigned_role = 'Planner Assistant', updated_at = CURRENT_TIMESTAMP WHERE path = ?").run(bundled.starterModelPath);
  }
  const folders = getSetting('modelFolders', []);
  const modelFolder = path.dirname(bundled.starterModelPath);
  if (Array.isArray(folders) && !folders.some((folder) => path.resolve(folder) === path.resolve(modelFolder))) {
    setSetting('modelFolders', [...folders, modelFolder]);
  }
}

function readChatContextFiles(sessionId) {
  const contexts = allRows('SELECT path FROM chat_context_files WHERE session_id = ? ORDER BY added_at DESC', [sessionId]);
  let remaining = 10000;
  const files = [];
  for (const item of contexts) {
    if (remaining <= 0) break;
    try {
      const target = safeExistingWorkspaceFile(item.path);
      if (isProtectedWorkspacePath(target.normalized)) continue;
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
  const endpointModelName = String(getSetting('localModelName', 'planner-assistant') || '').trim() || 'planner-assistant';
  const llamaCliPath = String(getSetting('llamaCliPath', '') || '').trim();
  const llamaServerPath = String(getSetting('llamaServerPath', '') || '').trim();
  const llamaServerPort = Number(getSetting('llamaServerPort', 8080) || 8080);
  return {
    assigned: Boolean(model),
    model,
    endpointConfigured: Boolean(endpoint),
    endpoint,
    endpointModelName,
    llamaCliConfigured: Boolean(llamaCliPath),
    llamaCliPath,
    llamaCliExists: Boolean(llamaCliPath && fs.existsSync(llamaCliPath)),
    llamaServerConfigured: Boolean(llamaServerPath),
    llamaServerPath,
    llamaServerExists: Boolean(llamaServerPath && fs.existsSync(llamaServerPath)),
    llamaServerPort,
    managedServerRunning: Boolean(managedLlamaServer && !managedLlamaServer.killed),
    managedServerReady: Boolean(managedLlamaServer && !managedLlamaServer.killed && managedLlamaServerReady),
    managedEndpoint: managedLlamaServer && !managedLlamaServer.killed && managedLlamaServerReady ? `http://127.0.0.1:${llamaServerPort}` : '',
    bundledRuntime: fs.existsSync(bundledLocalRuntime().serverPath)
  };
}

async function stopManagedLlamaServer() {
  if (managedLlamaServer && !managedLlamaServer.killed) managedLlamaServer.kill();
  managedLlamaServer = null;
  managedLlamaServerReady = false;
}

async function waitForLlamaServer(endpoint, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) throw new Error(`llama-server exited before becoming ready (exit ${child.exitCode ?? 'unknown'}).`);
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`llama-server did not become healthy within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function startManagedLlamaServer(options = {}) {
  if (managedLlamaServerStartPromise) return managedLlamaServerStartPromise;
  managedLlamaServerStartPromise = (async () => {
    const status = await localModelStatus();
    if (!status.assigned || !status.model?.path || !fs.existsSync(status.model.path)) throw new Error('Assign a downloaded Planner Assistant GGUF before starting llama-server.');
    const serverPath = String(options.serverPath || status.llamaServerPath || '').trim();
    const port = Number(options.port || status.llamaServerPort || 8080);
    const contextSize = Number(options.contextSize || getSetting('llamaContextSize', 4096) || 4096);
    if (!serverPath || !fs.existsSync(serverPath)) throw new Error('The bundled llama-server runtime is missing. Repair the local model runtime from Settings.');
    const endpoint = `http://127.0.0.1:${port}`;
    if (managedLlamaServer && !managedLlamaServer.killed && managedLlamaServerReady) return localModelStatus();
    await stopManagedLlamaServer();

    const logDir = path.join(root, 'data', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const stdoutFd = fs.openSync(path.join(logDir, 'llama-server.stdout.log'), 'a');
    const stderrFd = fs.openSync(path.join(logDir, 'llama-server.stderr.log'), 'a');
    const args = ['-m', status.model.path, '--host', '127.0.0.1', '--port', String(port), '-c', String(contextSize)];
    const child = spawn(serverPath, args, { cwd: path.dirname(serverPath), detached: false, stdio: ['ignore', stdoutFd, stderrFd], windowsHide: true });
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    managedLlamaServer = child;
    managedLlamaServerReady = false;
    child.on('error', (error) => console.error('llama-server process error:', error.message));
    child.on('exit', () => {
      if (managedLlamaServer === child) {
        managedLlamaServer = null;
        managedLlamaServerReady = false;
      }
    });
    try {
      await waitForLlamaServer(endpoint, child);
    } catch (error) {
      if (!child.killed) child.kill();
      if (managedLlamaServer === child) managedLlamaServer = null;
      throw new Error(`${error.message} See data/logs/llama-server.stderr.log.`);
    }
    managedLlamaServerReady = true;
    setSetting('llamaServerPath', serverPath);
    setSetting('llamaServerPort', port);
    setSetting('llamaContextSize', contextSize);
    setSetting('localModelName', status.model.name || 'planner-assistant');
    return localModelStatus();
  })();
  try {
    return await managedLlamaServerStartPromise;
  } finally {
    managedLlamaServerStartPromise = null;
  }
}

ensureBundledLocalRuntimeDefaults();

async function runEndpointModel(endpoint, modelName, prompt) {
  const base = endpoint.replace(/\/+$/, '');
  const url = base.endsWith('/v1/chat/completions') ? base : `${base}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName || 'planner-assistant',
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
  let status = await localModelStatus();
  if (!status.assigned && !status.endpointConfigured) {
    return {
      mode: 'unavailable',
      content: 'Saved to chat. No Planner Assistant model is assigned and no OpenAI-compatible local endpoint is configured yet; choose a GGUF model in Settings.'
    };
  }

  const prompt = buildAssistantPrompt(sessionId, userMessage);
  try {
    if (status.endpointConfigured) {
      const content = await runEndpointModel(status.endpoint, status.endpointModelName, prompt);
      if (content) return { mode: `local endpoint (${status.endpointModelName})`, content };
    }
    if (status.assigned && status.llamaServerExists && !status.managedServerReady) {
      await startManagedLlamaServer();
      status = await localModelStatus();
    }
    if (status.managedEndpoint) {
      const content = await runEndpointModel(status.managedEndpoint, status.endpointModelName || status.model?.name, prompt);
      if (content) return { mode: 'bundled llama.cpp', content };
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
    content: 'Saved to chat. A Planner Assistant model is assigned or endpoint is configured, but no local runtime answered. Check the endpoint or repair the bundled runtime in Settings.'
  };
}

function browserConnectorConnected() {
  return Date.now() - browserExtensionState.lastSeen < 15000;
}

function browserSetupText(status = {}, connectorConnected = false) {
  const playwright = status.playwright ? 'Playwright installed' : 'Playwright missing';
  const chromium = status.chromium ? 'Chromium installed' : 'Chromium missing';
  const connector = connectorConnected ? 'Chrome connector connected' : 'Chrome connector disconnected';
  return `${playwright}; ${chromium}; ${connector}.`;
}

function normalizeBrowserBlocker(item, status = {}, connectorConnected = false) {
  if (item.title !== 'Cloud browser automation is not configured yet') return item;
  const ready = status.playwright && status.chromium && connectorConnected;
  return {
    ...item,
    body: ready
      ? 'Playwright, Chromium, and the Chrome connector are available. Cloud Consultant still requires an explicit user prompt, any required signed-in browser session, and Temporary Chat/manual confirmation before sending.'
      : `${browserSetupText(status, connectorConnected)} Cloud Consultant remains setup-gated until the connector is loaded in the signed-in Chrome profile and the user confirms any required Temporary Chat or session steps.`,
    evidence: status.note || item.evidence,
    next_action: ready
      ? 'Use the Browser tab only after reviewing the prompt and required save/review gates.'
      : status.playwright && status.chromium
        ? 'Load browser-extension/lps-browser-agent in the signed-in Chrome profile, then refresh Browser/Tooling status.'
        : 'Use Tooling to install the missing local browser component before trying controlled-browser fallback.'
  };
}

async function plannerData() {
  const browserReady = await browserAutomationStatus().catch(() => ({}));
  const connectorConnected = browserConnectorConnected();
  const items = allRows(`
    SELECT k.*, p.name AS project_name
    FROM knowledge_items k
    LEFT JOIN projects p ON p.id = k.project_id
    WHERE k.status NOT IN ('archived', 'deprecated', 'superseded')
    ORDER BY COALESCE(k.due_at, k.updated_at) ASC, k.confidence ASC
  `).map((item) => normalizeBrowserBlocker(item, browserReady, connectorConnected));
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
  const connectorConnected = browserConnectorConnected();
  const browserBlocker = row(
    "SELECT * FROM knowledge_items WHERE title = ? AND status NOT IN ('archived', 'deprecated', 'superseded')",
    ['Cloud browser automation is not configured yet']
  );

  if (browserReady.playwright && browserReady.chromium && connectorConnected && browserBlocker) {
    const existing = row(
      "SELECT * FROM approvals WHERE action_type = 'update_memory' AND title = ? AND status = 'pending'",
      ['Retire resolved browser connector blocker']
    );
    if (!existing) {
      db.prepare(`
        INSERT INTO approvals (action_type, title, payload, priority)
        VALUES (?, ?, ?, 'P1')
      `).run('update_memory', 'Retire resolved browser connector blocker', JSON.stringify({
        id: browserBlocker.id,
        updates: {
          status: 'archived',
          confidence: 0.9,
          evidence: 'Planner refresh found Playwright, Chromium, and the Chrome connector available.',
          next_action: 'Use the Browser tab for cloud consultation only after prompt review and required manual confirmation.'
        }
      }));
      changes.push('Created approval to archive the resolved browser-connector blocker.');
    }
  }

  return {
    changes,
    message: changes.length ? changes.join(' ') : 'Planner refresh complete. No governed changes proposed.'
  };
}

app.get('/api/health', (_req, res) => ok(res, { db: 'ready', storage: dbPath }));

app.get('/api/bootstrap', async (_req, res) => {
  ok(res, {
    settings: readSettingsRedacted(),
    planner: await plannerData(),
    sessions: allRows('SELECT * FROM chat_sessions WHERE deleted = 0 ORDER BY pinned DESC, updated_at DESC'),
    projects: allRows('SELECT * FROM projects ORDER BY updated_at DESC'),
    models: modelsWithExists()
  });
});

const ROADMAP_STATUSES = ['planned', 'active', 'paused', 'parked', 'done'];
const ROADMAP_CATEGORIES = ['feature', 'fix', 'infra', 'chore', 'idea'];

// --- Autonomous dev-task scanner -------------------------------------------
// Scans chat history and repo files for development-type tasks and stages them
// as roadmap candidates. It is deliberately dev-only: a line must carry a
// technical signal to qualify, so life-assistant content never leaks into the
// build roadmap. Detection is backend and autonomous; a human still accepts a
// candidate before it becomes a live roadmap item (LPS proposes, user approves).

// A qualifying line needs an intent cue (something to do) AND a dev cue (that it
// is technical). This pairing is what keeps "call the dentist" out.
const DEV_INTENT = /\b(todo|fixme|hack|xxx|need(s)? to|we should|let'?s|should (add|build|make|fix|wire|handle)|add|build|implement|create|refactor|wire up|hook up|fix|support|expose|gate|parked?|roadmap|next pr|future implementation|follow[- ]up)\b/i;
const DEV_CUE = /\b(endpoint|api|route|ui|component|panel|button|server|client|db|database|schema|migration|table|git|branch|merge|commit|push|diff|build|installer|model|gguf|llama|playwright|scanner|token|auth|regex|function|module|import|export|css|jsx|react|express|sqlite|openhands|executor|worktree|bug|crash|error|test|refactor)\b/i;
const DEV_CHECKLIST = /^\s*[-*]\s*\[\s\]\s+(.*)$/; // markdown unchecked "- [ ] ..."
const CODE_MARKER = /(?:\/\/|#|<!--|\*)\s*(TODO|FIXME|HACK|XXX)\b[:\-\s]*(.+)$/i;

function classifyDevTask(text) {
  const lower = text.toLowerCase();
  if (/\b(fixme|bug|crash|error|broken|regression|fix)\b/.test(lower)) return 'fix';
  if (/\b(refactor|schema|migration|infra|deploy|pipeline|executor|worktree|openhands)\b/.test(lower)) return 'infra';
  if (/\b(idea|maybe|consider|could|explore)\b/.test(lower)) return 'idea';
  return 'feature';
}

function cleanTaskTitle(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[-*\s>#]+/, '')
    .replace(/\s*(?:-->|\*\/|#\}|--\})\s*$/, '') // strip trailing comment closers
    .trim()
    .slice(0, 140);
}

function devTaskCandidateFrom(rawLine) {
  const line = String(rawLine || '').trim();
  if (line.length < 8 || line.length > 400) return null;
  const codeHit = line.match(CODE_MARKER);
  if (codeHit) {
    const title = cleanTaskTitle(codeHit[2]);
    if (title.length < 6) return null;
    return { title, category: classifyDevTask(line) };
  }
  const checklistHit = line.match(DEV_CHECKLIST);
  const candidateText = checklistHit ? checklistHit[1] : line;
  if (!DEV_INTENT.test(candidateText) || !DEV_CUE.test(candidateText)) return null;
  const title = cleanTaskTitle(candidateText);
  if (title.length < 8) return null;
  return { title, category: classifyDevTask(candidateText) };
}

function dedupeKey(sourceKind, title) {
  return crypto.createHash('sha1').update(`${sourceKind}|${title.toLowerCase().replace(/\s+/g, ' ').trim()}`).digest('hex');
}

// Skip re-staging anything that already exists as a candidate OR as a live
// roadmap item (so accepting then re-scanning does not resurrect it).
function roadmapAlreadyKnows(title) {
  const norm = title.toLowerCase().replace(/\s+/g, ' ').trim();
  return Boolean(row('SELECT id FROM roadmap_items WHERE lower(title) = ? LIMIT 1', [norm]));
}

function stageDevCandidate({ title, category, sourceKind, sourceRef, signal }) {
  if (roadmapAlreadyKnows(title)) return false;
  const key = dedupeKey('roadmap', title);
  const existing = row('SELECT id, status FROM roadmap_candidates WHERE dedupe_key = ?', [key]);
  if (existing) return false; // already staged or previously dismissed — do not nag again
  db.prepare(
    'INSERT INTO roadmap_candidates (title, detail, category, source_kind, source_ref, signal, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(title, '', category, sourceKind, sourceRef, String(signal || '').slice(0, 200), key);
  return true;
}

function scanChatForDevTasks(limitMessages = 400) {
  const messages = allRows('SELECT id, content FROM chat_messages ORDER BY id DESC LIMIT ?', [limitMessages]);
  let staged = 0;
  for (const message of messages) {
    for (const line of String(message.content || '').split('\n')) {
      const candidate = devTaskCandidateFrom(line);
      if (candidate && stageDevCandidate({ ...candidate, sourceKind: 'chat', sourceRef: `message:${message.id}`, signal: line })) staged += 1;
    }
  }
  return staged;
}

function scanFilesForDevTasks() {
  const roots = ['src', 'server', 'docs/todos'];
  const includeExt = new Set(['.js', '.jsx', '.ts', '.tsx', '.css', '.md', '.mjs']);
  const blockedDir = new Set(['node_modules', 'dist', 'data', '.git', 'release', '.cache']);
  const files = [];
  const stack = roots.map((rootDir) => path.join(root, rootDir)).filter((dir) => fs.existsSync(dir));
  while (stack.length && files.length < 600) {
    const current = stack.pop();
    let stat;
    try { stat = fs.statSync(current); } catch { continue; }
    if (stat.isDirectory()) {
      if (blockedDir.has(path.basename(current))) continue;
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    } else if (includeExt.has(path.extname(current))) {
      files.push(current);
    }
  }
  let staged = 0;
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (text.length > 400000) continue;
    const rel = path.relative(root, file).replaceAll('\\', '/');
    let lineNo = 0;
    for (const line of text.split('\n')) {
      lineNo += 1;
      // Only comment-marker tasks and markdown checklists from files, to avoid
      // matching ordinary prose or the scanner's own keyword lists.
      if (!CODE_MARKER.test(line) && !DEV_CHECKLIST.test(line)) continue;
      const candidate = devTaskCandidateFrom(line);
      if (candidate && stageDevCandidate({ ...candidate, sourceKind: 'file', sourceRef: `${rel}:${lineNo}`, signal: line.trim() })) staged += 1;
    }
  }
  return staged;
}

function scanDevTasks() {
  try {
    const fromChat = scanChatForDevTasks();
    const fromFiles = scanFilesForDevTasks();
    return { ok: true, staged: fromChat + fromFiles, fromChat, fromFiles };
  } catch (error) {
    return { ok: false, error: error.message, staged: 0 };
  }
}

app.get('/api/roadmap', (_req, res) => {
  ok(res, allRows('SELECT * FROM roadmap_items ORDER BY sort_order ASC, id ASC'));
});

app.post('/api/roadmap', (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return fail(res, 400, 'A title is required.');
  const status = ROADMAP_STATUSES.includes(req.body.status) ? req.body.status : 'planned';
  const category = ROADMAP_CATEGORIES.includes(req.body.category) ? req.body.category : 'feature';
  const maxOrder = row('SELECT MAX(sort_order) AS m FROM roadmap_items')?.m ?? -1;
  const id = db.prepare(
    'INSERT INTO roadmap_items (title, detail, resume_notes, category, status, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, String(req.body.detail || ''), String(req.body.resume_notes || ''), category, status, maxOrder + 1).lastInsertRowid;
  ok(res, row('SELECT * FROM roadmap_items WHERE id = ?', [id]));
});

app.patch('/api/roadmap/:id', (req, res) => {
  const item = row('SELECT * FROM roadmap_items WHERE id = ?', [req.params.id]);
  if (!item) return fail(res, 404, 'Roadmap item not found.');
  if (req.body.status !== undefined && !ROADMAP_STATUSES.includes(req.body.status)) {
    return fail(res, 400, `Status must be one of: ${ROADMAP_STATUSES.join(', ')}.`);
  }
  if (req.body.category !== undefined && !ROADMAP_CATEGORIES.includes(req.body.category)) {
    return fail(res, 400, `Category must be one of: ${ROADMAP_CATEGORIES.join(', ')}.`);
  }
  const next = {
    title: req.body.title !== undefined ? String(req.body.title).trim() || item.title : item.title,
    detail: req.body.detail !== undefined ? String(req.body.detail) : item.detail,
    resume_notes: req.body.resume_notes !== undefined ? String(req.body.resume_notes) : item.resume_notes,
    category: req.body.category !== undefined ? req.body.category : item.category,
    status: req.body.status !== undefined ? req.body.status : item.status,
    sort_order: req.body.sort_order !== undefined ? Number(req.body.sort_order) : item.sort_order
  };
  db.prepare(
    'UPDATE roadmap_items SET title = ?, detail = ?, resume_notes = ?, category = ?, status = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(next.title, next.detail, next.resume_notes, next.category, next.status, next.sort_order, item.id);
  ok(res, row('SELECT * FROM roadmap_items WHERE id = ?', [item.id]));
});

// Move an item one slot up or down by swapping sort_order with its neighbour in
// the same overall ordering. Keeps reordering robust without drag-and-drop.
app.post('/api/roadmap/:id/move', (req, res) => {
  const item = row('SELECT * FROM roadmap_items WHERE id = ?', [req.params.id]);
  if (!item) return fail(res, 404, 'Roadmap item not found.');
  const direction = req.body.direction === 'up' ? 'up' : 'down';
  const neighbour = direction === 'up'
    ? row('SELECT * FROM roadmap_items WHERE sort_order < ? OR (sort_order = ? AND id < ?) ORDER BY sort_order DESC, id DESC LIMIT 1', [item.sort_order, item.sort_order, item.id])
    : row('SELECT * FROM roadmap_items WHERE sort_order > ? OR (sort_order = ? AND id > ?) ORDER BY sort_order ASC, id ASC LIMIT 1', [item.sort_order, item.sort_order, item.id]);
  if (!neighbour) return ok(res, allRows('SELECT * FROM roadmap_items ORDER BY sort_order ASC, id ASC'));
  // node:sqlite DatabaseSync has no .transaction(); use explicit BEGIN/COMMIT.
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE roadmap_items SET sort_order = ? WHERE id = ?').run(neighbour.sort_order, item.id);
    db.prepare('UPDATE roadmap_items SET sort_order = ? WHERE id = ?').run(item.sort_order, neighbour.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return fail(res, 500, error.message || 'Reorder failed.');
  }
  ok(res, allRows('SELECT * FROM roadmap_items ORDER BY sort_order ASC, id ASC'));
});

app.delete('/api/roadmap/:id', (req, res) => {
  const item = row('SELECT * FROM roadmap_items WHERE id = ?', [req.params.id]);
  if (!item) return fail(res, 404, 'Roadmap item not found.');
  db.prepare('DELETE FROM roadmap_items WHERE id = ?').run(item.id);
  ok(res, { id: item.id });
});

app.get('/api/roadmap/candidates', (_req, res) => {
  ok(res, allRows("SELECT * FROM roadmap_candidates WHERE status = 'candidate' ORDER BY created_at DESC, id DESC"));
});

// Autonomous scan trigger. Also runs once at startup; this endpoint lets the UI
// (or a future interval) re-run it on demand.
app.post('/api/roadmap/scan', (_req, res) => {
  const result = scanDevTasks();
  if (!result.ok) return fail(res, 500, result.error || 'Dev-task scan failed.');
  ok(res, { ...result, candidates: allRows("SELECT * FROM roadmap_candidates WHERE status = 'candidate' ORDER BY created_at DESC, id DESC") });
});

app.post('/api/roadmap/candidates/:id/accept', (req, res) => {
  const candidate = row('SELECT * FROM roadmap_candidates WHERE id = ?', [req.params.id]);
  if (!candidate) return fail(res, 404, 'Candidate not found.');
  if (candidate.status !== 'candidate') return fail(res, 409, `Candidate was already ${candidate.status}.`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const claim = db.prepare("UPDATE roadmap_candidates SET status = 'processing' WHERE id = ? AND status = 'candidate'").run(candidate.id);
    if (claim.changes !== 1) throw Object.assign(new Error('Candidate is no longer pending.'), { statusCode: 409 });
    const maxOrder = row('SELECT MAX(sort_order) AS m FROM roadmap_items')?.m ?? -1;
    const detail = candidate.source_ref ? `From ${candidate.source_kind} (${candidate.source_ref}).` : '';
    const id = db.prepare(
      'INSERT INTO roadmap_items (title, detail, category, status, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(candidate.title, detail, candidate.category, 'planned', maxOrder + 1).lastInsertRowid;
    db.prepare("UPDATE roadmap_candidates SET status = 'accepted' WHERE id = ? AND status = 'processing'").run(candidate.id);
    db.exec('COMMIT');
    ok(res, row('SELECT * FROM roadmap_items WHERE id = ?', [id]));
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction was not active */ }
    fail(res, error.statusCode || 400, error.message);
  }
});

app.post('/api/roadmap/candidates/:id/dismiss', (req, res) => {
  const candidate = row('SELECT * FROM roadmap_candidates WHERE id = ?', [req.params.id]);
  if (!candidate) return fail(res, 404, 'Candidate not found.');
  db.prepare("UPDATE roadmap_candidates SET status = 'dismissed' WHERE id = ?").run(candidate.id);
  ok(res, { id: candidate.id });
});

app.get('/api/planner', async (_req, res) => ok(res, await plannerData()));

app.post('/api/planner/refresh', async (_req, res) => {
  try {
    const result = await refreshPlannerState();
    ok(res, { ...result, planner: await plannerData() });
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
    const target = safeExistingWorkspaceFile(req.body.path);
    if (isProtectedWorkspacePath(target.normalized)) return fail(res, 403, `Protected/private file cannot be attached to chat: ${target.normalized}`);
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

app.post('/api/memory/candidates/:id/:decision', async (req, res) => {
  const candidate = row('SELECT * FROM memory_candidates WHERE id = ?', [req.params.id]);
  if (!candidate) return fail(res, 404, 'Candidate not found.');
  const decision = req.params.decision;
  if (!['approve', 'deny', 'defer'].includes(decision)) return fail(res, 400, 'Decision must be approve, deny, or defer.');
  if (!['candidate', 'deferred'].includes(candidate.status)) return fail(res, 409, `Memory candidate was already ${candidate.status}.`);
  const claim = db.prepare("UPDATE memory_candidates SET status = 'processing' WHERE id = ? AND status IN ('candidate', 'deferred')").run(candidate.id);
  if (claim.changes !== 1) return fail(res, 409, 'Memory candidate is no longer pending.');
  try {
    if (decision === 'approve') {
      const approved = normalizedMemoryCandidate(candidate);
      db.prepare(`
        INSERT INTO knowledge_items
        (type, title, body, source, status, confidence, last_reviewed, evidence, owner, next_action)
        VALUES (?, ?, ?, ?, 'active', ?, date('now'), ?, 'user', ?)
      `).run(approved.type, approved.title, approved.body, approved.source, Math.max(approved.confidence, 0.7), approved.evidence, 'Review during next planner pass.');
      db.prepare("UPDATE memory_candidates SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'processing'").run(candidate.id);
    } else {
      db.prepare("UPDATE memory_candidates SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'processing'").run(decision === 'deny' ? 'denied' : 'deferred', candidate.id);
    }
  } catch (error) {
    db.prepare("UPDATE memory_candidates SET status = ? WHERE id = ? AND status = 'processing'").run(candidate.status, candidate.id);
    return fail(res, 500, error.message);
  }
  ok(res, { candidate: row('SELECT * FROM memory_candidates WHERE id = ?', [candidate.id]), planner: await plannerData() });
});

app.patch('/api/memory/candidates/:id', async (req, res) => {
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
  ok(res, { candidate: row('SELECT * FROM memory_candidates WHERE id = ?', [candidate.id]), planner: await plannerData() });
});

const APPROVAL_ACTION_TYPES = new Set(['create_project', 'update_project', 'add_memory', 'repo_write', 'update_memory']);

app.post('/api/approvals/:id/:decision', async (req, res) => {
  try {
    if (!['approve', 'deny', 'defer'].includes(req.params.decision)) return fail(res, 400, 'Decision must be approve, deny, or defer.');
    const approval = row('SELECT * FROM approvals WHERE id = ?', [req.params.id]);
    if (!approval) return fail(res, 404, 'Approval not found.');
    if (approval.status !== 'pending') return fail(res, 409, `Approval was already ${approval.status}.`);
    if (!APPROVAL_ACTION_TYPES.has(approval.action_type)) return fail(res, 400, `Unsupported approval action: ${approval.action_type}`);
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
    const transition = db.prepare("UPDATE approvals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'").run(status, req.params.id);
    if (transition.changes !== 1) return fail(res, 409, 'Approval is no longer pending.');
    ok(res, await plannerData());
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
  if (!APPROVAL_ACTION_TYPES.has(action_type)) return fail(res, 400, `Unsupported approval action: ${action_type}`);
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

// ── Knowledge items: direct CRUD ─────────────────────────────────────────────
// The planner was read-only over seed rows — every list rendered governance
// output with no way to put a real life item in. Direct user edits do not need
// the approval flow: approvals govern AGENT-proposed changes, the user is the
// authority the approvals defer to.
const ITEM_TYPES = ['goal', 'project', 'decision', 'reminder', 'current state', 'blocker', 'waiting', 'rule', 'note'];
const ITEM_STATUSES = ['active', 'stable', 'blocked', 'stale', 'pending review', 'done', 'archived', 'deprecated', 'superseded'];

app.get('/api/items', (req, res) => {
  const includeArchived = req.query.all === '1';
  const rows = includeArchived
    ? allRows('SELECT * FROM knowledge_items ORDER BY updated_at DESC')
    : allRows("SELECT * FROM knowledge_items WHERE status NOT IN ('archived', 'deprecated', 'superseded') ORDER BY COALESCE(due_at, updated_at) ASC");
  ok(res, rows);
});

app.post('/api/items', (req, res) => {
  const title = req.body.title?.trim();
  if (!title) return fail(res, 400, 'Item title is required.');
  const type = ITEM_TYPES.includes(req.body.type) ? req.body.type : 'note';
  const status = ITEM_STATUSES.includes(req.body.status) ? req.body.status : 'active';
  const id = db.prepare(`
    INSERT INTO knowledge_items (type, title, body, source, status, confidence, last_reviewed, owner, next_action, project_id, due_at)
    VALUES (?, ?, ?, 'manual', ?, ?, date('now'), ?, ?, ?, ?)
  `).run(
    type, title, req.body.body?.trim() || title, status,
    Number(req.body.confidence ?? 0.9),
    req.body.owner === 'app' ? 'app' : 'user',
    req.body.next_action?.trim() || null,
    req.body.project_id ? Number(req.body.project_id) : null,
    req.body.due_at || null
  ).lastInsertRowid;
  ok(res, row('SELECT * FROM knowledge_items WHERE id = ?', [id]));
});

app.patch('/api/items/:id', (req, res) => {
  const existing = row('SELECT * FROM knowledge_items WHERE id = ?', [req.params.id]);
  if (!existing) return fail(res, 404, 'Item not found.');
  const fields = {};
  if (req.body.title?.trim()) fields.title = req.body.title.trim();
  if (req.body.body !== undefined) fields.body = String(req.body.body);
  if (ITEM_TYPES.includes(req.body.type)) fields.type = req.body.type;
  if (ITEM_STATUSES.includes(req.body.status)) fields.status = req.body.status;
  if (req.body.next_action !== undefined) fields.next_action = req.body.next_action || null;
  if (req.body.due_at !== undefined) fields.due_at = req.body.due_at || null;
  if (req.body.project_id !== undefined) fields.project_id = req.body.project_id ? Number(req.body.project_id) : null;
  if (req.body.confidence !== undefined) fields.confidence = Number(req.body.confidence);
  if (req.body.reviewed) fields.last_reviewed = new Date().toISOString().slice(0, 10);
  if (!Object.keys(fields).length) return fail(res, 400, 'No recognised fields to update.');
  fields.updated_at = new Date().toISOString();
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE knowledge_items SET ${sets} WHERE id = ?`).run(...Object.values(fields), req.params.id);
  ok(res, row('SELECT * FROM knowledge_items WHERE id = ?', [req.params.id]));
});

// Registry rows enriched with whether the .gguf is still on disk, so the UI can
// show "ready to load" vs a stale entry whose file was moved/deleted elsewhere.
function modelsWithExists() {
  return allRows('SELECT * FROM model_registry ORDER BY assigned_role DESC, name ASC')
    .map((model) => ({ ...model, exists: Boolean(model.path && fs.existsSync(model.path)) }));
}

app.get('/api/models', (_req, res) => ok(res, modelsWithExists()));

app.delete('/api/models/:id', (req, res) => {
  const model = row('SELECT * FROM model_registry WHERE id = ?', [req.params.id]);
  if (!model) return fail(res, 404, 'Model not found.');
  // purge removes the list entry entirely (for a stale entry with no HF origin
  // that cannot be re-downloaded). The default delete removes the file on disk
  // but KEEPS the entry, flipping it from downloaded to a re-downloadable state.
  if (req.body?.purge) {
    db.prepare('DELETE FROM model_registry WHERE id = ?').run(model.id);
    return ok(res, { id: model.id, purged: true, models: modelsWithExists() });
  }
  let fileRemoved = false;
  if (model.path && /\.gguf$/i.test(model.path) && fs.existsSync(model.path) && fs.statSync(model.path).isFile()) {
    try {
      fs.unlinkSync(model.path);
      fileRemoved = true;
    } catch (error) {
      return fail(res, 500, `Could not delete the model file: ${error.message}`);
    }
  }
  // A file that is gone can no longer be the assigned Planner Assistant.
  if (model.assigned_role) db.prepare('UPDATE model_registry SET assigned_role = NULL WHERE id = ?').run(model.id);
  ok(res, { id: model.id, fileRemoved, canRedownload: Boolean(model.hf_repo && model.hf_file), models: modelsWithExists() });
});

app.get('/api/models/runtime', async (_req, res) => {
  ok(res, await localModelStatus());
});

app.post('/api/models/server/start', async (req, res) => {
  try {
    const runtime = await startManagedLlamaServer({
      serverPath: req.body.llamaServerPath,
      port: req.body.port,
      contextSize: req.body.contextSize
    });
    ok(res, { message: `llama-server is healthy at ${runtime.managedEndpoint}`, runtime });
  } catch (error) {
    fail(res, 503, error.message);
  }
});

app.post('/api/models/server/stop', async (_req, res) => {
  await stopManagedLlamaServer();
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
  ok(res, { discovered, models: modelsWithExists() });
});

app.post('/api/models/:id/assign', async (req, res) => {
  const role = req.body.role || 'Planner Assistant';
  const model = row('SELECT * FROM model_registry WHERE id = ?', [req.params.id]);
  if (!model) return fail(res, 404, 'Model not found.');
  if (model.path && !fs.existsSync(model.path)) {
    return fail(res, 409, 'That model file is no longer on disk. Re-download it or remove the stale entry before assigning.');
  }
  db.prepare('UPDATE model_registry SET assigned_role = NULL WHERE assigned_role = ?').run(role);
  db.prepare('UPDATE model_registry SET assigned_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(role, req.params.id);
  await stopManagedLlamaServer();
  let runtime = await localModelStatus();
  let runtimeError = '';
  if (!runtime.endpointConfigured && runtime.llamaServerExists) {
    try {
      runtime = await startManagedLlamaServer();
    } catch (error) {
      runtimeError = error.message;
      runtime = await localModelStatus();
    }
  }
  ok(res, { models: modelsWithExists(), runtime, runtimeError, message: runtimeError ? 'Model assigned, but llama.cpp did not become ready.' : 'Model assigned and local runtime ready.' });
});

app.get('/api/hf/files', async (req, res) => {
  const repo = String(req.query.repo || '').trim();
  if (!repo.includes('/')) return fail(res, 400, 'Provide a Hugging Face repo like org/model.');
  const token = getSetting('hfToken', '');
  const response = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) return fail(res, response.status, `Hugging Face lookup failed: ${response.statusText}`);
  const quantRank = (filePath = '') => {
    const lower = filePath.toLowerCase();
    if (lower.includes('q4_k_m')) return 0;
    if (lower.includes('q4_k_s')) return 1;
    if (lower.includes('iq4')) return 2;
    if (lower.includes('q5_k_m')) return 3;
    if (lower.includes('q5_k_s')) return 4;
    if (lower.includes('q6_k')) return 5;
    if (lower.includes('q3_k_m')) return 6;
    if (lower.includes('q3')) return 7;
    if (lower.includes('q8_0')) return 8;
    if (lower.includes('bf16') || lower.includes('f16')) return 20;
    return 10;
  };
  const files = (await response.json())
    .filter((f) => f.type === 'file' && f.path.toLowerCase().endsWith('.gguf'))
    .sort((a, b) => quantRank(a.path) - quantRank(b.path) || (a.size || 0) - (b.size || 0) || a.path.localeCompare(b.path));
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

function validateHfModelReference(repo, file) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error('Invalid Hugging Face repository name.');
  const normalized = String(file || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || !normalized.toLowerCase().endsWith('.gguf')) {
    throw new Error('Invalid GGUF file path.');
  }
  return normalized;
}

async function publishedHfFileMetadata(repo, file, token) {
  const response = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1&expand=1`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) throw new Error(`Hugging Face metadata lookup failed: ${response.status} ${response.statusText}`);
  const metadata = (await response.json()).find((item) => item.type === 'file' && item.path === file);
  if (!metadata) throw new Error('The selected GGUF was not found in the published repository tree.');
  return { size: Number(metadata.lfs?.size || metadata.size || 0), sha256: String(metadata.lfs?.oid || '').toLowerCase() };
}

async function downloadHfModelAtomically({ repo, file, target, token }) {
  const normalizedFile = validateHfModelReference(repo, file);
  const metadata = await publishedHfFileMetadata(repo, normalizedFile, token);
  if (!metadata.size || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error('Hugging Face did not publish a usable size and SHA-256 for this GGUF.');
  if (fs.existsSync(target)) throw new Error('The target model file already exists. Remove it before downloading again.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.${process.pid}.${Date.now()}.partial`;
  try {
    const url = `https://huggingface.co/${repo}/resolve/main/${normalizedFile}`;
    const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    await pipeline(response.body, fs.createWriteStream(partial, { flags: 'wx' }));
    const stat = fs.statSync(partial);
    if (stat.size !== metadata.size) throw new Error(`Downloaded size ${stat.size} does not match published size ${metadata.size}.`);
    const actualSha256 = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const input = fs.createReadStream(partial);
      input.on('error', reject);
      input.on('data', (chunk) => hash.update(chunk));
      input.on('end', () => resolve(hash.digest('hex')));
    });
    if (actualSha256 !== metadata.sha256) throw new Error('Downloaded GGUF SHA-256 does not match the publisher digest.');
    const fd = fs.openSync(partial, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(partial, target);
    return { size: stat.size, sha256: actualSha256 };
  } catch (error) {
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    throw error;
  }
}

app.post('/api/hf/download', async (req, res) => {
  const repo = String(req.body.repo || '').trim();
  const file = String(req.body.file || '').trim();
  if (!repo || !file) return fail(res, 400, 'Repo and file are required.');
  const folder = req.body.folder || getSetting('modelDownloadFolder', path.resolve('models'));
  const token = getSetting('hfToken', '');
  const target = path.join(folder, path.basename(file));
  let downloaded;
  try {
    downloaded = await downloadHfModelAtomically({ repo, file, target, token });
  } catch (error) {
    return fail(res, 502, error.message);
  }
  // Record the HF origin so a later delete can flip the entry to "download"
  // and re-fetch the exact same file.
  const id = db.prepare(`
    INSERT INTO model_registry (name, path, size_bytes, source, hf_repo, hf_file)
    VALUES (?, ?, ?, 'huggingface', ?, ?)
    ON CONFLICT(path) DO UPDATE SET size_bytes = excluded.size_bytes, hf_repo = excluded.hf_repo, hf_file = excluded.hf_file, updated_at = CURRENT_TIMESTAMP
  `).run(path.basename(file), target, downloaded.size, repo, file);
  const model = row('SELECT * FROM model_registry WHERE path = ?', [target]);
  db.prepare("UPDATE model_registry SET assigned_role = NULL WHERE assigned_role = 'Planner Assistant'").run();
  db.prepare("UPDATE model_registry SET assigned_role = 'Planner Assistant', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(model.id);
  setSetting('modelDownloadFolder', folder);
  await stopManagedLlamaServer();
  let runtime = await localModelStatus();
  let runtimeError = '';
  if (!runtime.endpointConfigured && runtime.llamaServerExists) {
    try { runtime = await startManagedLlamaServer(); } catch (error) { runtimeError = error.message; runtime = await localModelStatus(); }
  }
  ok(res, { id: model.id, target, size: downloaded.size, sha256: downloaded.sha256, models: modelsWithExists(), runtime, runtimeError });
});

// Re-download a known model whose file was deleted, using its stored HF origin,
// back to its original path. Flips the list entry download -> downloaded.
app.post('/api/models/:id/download', async (req, res) => {
  const model = row('SELECT * FROM model_registry WHERE id = ?', [req.params.id]);
  if (!model) return fail(res, 404, 'Model not found.');
  if (!model.hf_repo || !model.hf_file) return fail(res, 400, 'This model has no recorded Hugging Face origin, so it cannot be re-downloaded. Re-scan the folder instead.');
  if (model.path && fs.existsSync(model.path)) return fail(res, 409, 'The model file is already on disk.');
  const token = getSetting('hfToken', '');
  const target = model.path || path.join(getSetting('modelDownloadFolder', path.resolve('models')), path.basename(model.hf_file));
  let downloaded;
  try {
    downloaded = await downloadHfModelAtomically({ repo: model.hf_repo, file: model.hf_file, target, token });
  } catch (error) {
    return fail(res, 502, error.message);
  }
  db.prepare('UPDATE model_registry SET path = ?, size_bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(target, downloaded.size, model.id);
  ok(res, { id: model.id, target, size: downloaded.size, sha256: downloaded.sha256, models: modelsWithExists() });
});

// Single source of truth for client- and export-facing settings. There is no
// unredacted mode: code that needs a credential must request its known key
// directly through getSetting, which performs DPAPI decryption server-side.
function readSettingsRedacted() {
  const settings = Object.fromEntries(allRows('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)]));
  for (const key of SECRET_SETTING_KEYS) {
    if (Object.hasOwn(settings, key)) {
      settings[key] = getSetting(key, '') ? '[redacted]' : '';
    }
  }
  return settings;
}

app.get('/api/settings', (_req, res) => {
  ok(res, readSettingsRedacted());
});

app.post('/api/settings', (req, res) => {
  const secretKeys = Object.keys(req.body).filter((key) => SECRET_SETTING_KEYS.has(key));
  if (secretKeys.length) return fail(res, 400, `Secret settings require a dedicated endpoint: ${secretKeys.join(', ')}`);
  for (const [key, value] of Object.entries(req.body)) {
    setSetting(key, value);
  }
  ok(res, readSettingsRedacted());
});

app.post('/api/settings/huggingface-token', (req, res) => {
  const token = String(req.body.token || '').trim();
  if (token && !/^hf_[A-Za-z0-9]{20,}$/.test(token)) return fail(res, 400, 'Enter a valid Hugging Face access token or leave it blank.');
  setSetting('hfToken', token);
  ok(res, { configured: Boolean(token) });
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
    const { page, profile, mode, launchNote } = await realChromePage(url) || await controlledBrowserPage();
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

app.post('/api/browser/consult/preview', (req, res) => {
  try {
    const prepared = prepareCloudEgress(req);
    ok(res, {
      targetAgent: prepared.targetAgent,
      prompt: prepared.prompt,
      promptHash: prepared.promptHash,
      findings: prepared.findings,
      changed: prepared.changed,
      contexts: prepared.contexts.map((item) => ({ path: item.path, truncated: item.truncated })),
      note: 'Review this exact final prompt. Confirmation is bound to its SHA-256 and cloud provider; any edit or provider change invalidates it.'
    });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.post('/api/browser/consult', async (req, res) => {
  const targetAgent = String(req.body.target_agent || 'ChatGPT').trim();
  const localDraft = String(req.body.local_draft || '').trim();
  const url = defaultCloudAgentUrl(targetAgent, req.body.url);
  const chatGptTarget = targetAgent === 'ChatGPT' || String(url).toLowerCase().includes('chatgpt.com');
  if (!localDraft) return fail(res, 400, 'Enter a message before running cloud consultation.');
  if (chatGptTarget && req.body.temporary_chat_required !== false && req.body.temporary_chat_confirmed !== true) {
    return fail(res, 400, 'Confirm ChatGPT Temporary Chat before sending the full consultation prompt. The app cannot verify this automatically.');
  }

  try {
    const prepared = prepareCloudEgress(req);
    const confirmation = req.body.egress_confirmation || {};
    if (confirmation.promptHash !== prepared.promptHash || confirmation.targetAgent !== prepared.targetAgent) {
      return fail(res, 428, 'Review and confirm the final redacted cloud prompt for this provider before sending. The prompt or provider changed since confirmation.');
    }
    const contexts = prepared.contexts;
    const prompt = prepared.prompt;
    if (getSetting('browserAgentMode', 'myChromeConnector') === 'myChromeConnector') {
      const connectorFresh = Date.now() - browserExtensionState.lastSeen < 15000;
      if (!connectorFresh) {
        return fail(res, 409, 'Chrome connector is not connected. Install or reload the unpacked extension in browser-extension/lps-browser-agent, then keep LPS open in your normal Chrome.');
      }
      const id = browserAgentJobSeq++;
      const job = {
        id,
        status: 'pending',
        targetAgent,
        url,
        prompt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: null,
        error: ''
      };
      browserAgentJobs.set(id, job);
      const started = Date.now();
      while (Date.now() - started < 240000) {
        if (job.status === 'answered' || job.status === 'blocked' || job.status === 'error') {
          break;
        }
        await sleep(1000);
      }
      const terminal = job.status === 'answered' || job.status === 'blocked' || job.status === 'error';
      const status = terminal
        ? job.status
        : 'timeout';
      return ok(res, {
        ok: status === 'answered',
        blocked: status === 'blocked' || status === 'error' || status === 'timeout',
        status,
        prompt,
        answer: job.result?.answer || '',
        url: job.result?.url || url,
        title: job.result?.title || targetAgent,
        mode: 'my Chrome connector',
        message: job.result?.message || job.error || (status === 'pending'
          ? 'Chrome connector has the request queued. Check the cloud-agent tab in your Chrome.'
          : status === 'timeout'
            ? 'Chrome connector did not return a completed browser-agent reply before the timeout. Check the cloud-agent tab, then run it again.'
            : 'Chrome connector sent the browser-agent question.'),
        contexts: contexts.map((item) => ({ path: item.path, truncated: item.truncated }))
      });
    }
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

app.get('/api/browser/agent-tabs', async (_req, res) => {
  const connectorFresh = Date.now() - browserExtensionState.lastSeen < 15000;
  if (connectorFresh) {
    return ok(res, {
      cdpAvailable: false,
      connectorAvailable: true,
      agents: agentTabsFromUrls(browserExtensionState.tabs)
    });
  }
  if (!(await chromeDebugEndpointAvailable())) {
    return ok(res, {
      cdpAvailable: false,
      connectorAvailable: false,
      agents: emptyAgentTabMap()
    });
  }
  try {
    const response = await fetch('http://127.0.0.1:9222/json/list');
    if (!response.ok) throw new Error(`Chrome tab lookup failed: ${response.statusText}`);
    const tabs = await response.json();
    const agents = {};
    for (const [agent, hosts] of Object.entries(cloudAgentHosts)) {
      const matches = tabs
        .filter((tab) => tab.type === 'page' && tabMatchesAgent(tab.url, hosts))
        .map((tab) => ({ id: tab.id, title: tab.title, url: tab.url }));
      agents[agent] = {
        open: matches.length > 0,
        count: matches.length,
        tabs: matches
      };
    }
    ok(res, { cdpAvailable: true, connectorAvailable: false, agents });
  } catch (error) {
    fail(res, 500, error.message || 'Chrome tab lookup failed.');
  }
});

app.get('/api/browser/extension/install-info', (_req, res) => {
  const extensionPath = browserAgentExtensionDir();
  const probe = browserExtensionProbe();
  const connected = Date.now() - browserExtensionState.lastSeen < 15000;
  const currentCopyLoaded = probe.chromeLoaded && (probe.exactPathMatch || probe.currentContentMatch);
  const recommendedAction = connected
    ? 'The connector heartbeat is live.'
    : probe.installedInChrome && !probe.chromeLoaded
      ? 'Enable the Life Planner Browser Agent in the detected Chrome profile.'
      : probe.chromeLoaded && !currentCopyLoaded
        ? 'Chrome loaded an older or different extension folder. Reload the current LPS copy.'
        : probe.chromeLoaded
          ? 'Keep Chrome open and reload the extension if the heartbeat does not return.'
          : 'Enable Developer mode and load the current unpacked extension folder.';
  ok(res, {
    extensionPath,
    manifestPath: path.join(extensionPath, 'manifest.json'),
    pairingConfigPath: browserPairing.configPath,
    installed: connected,
    connected,
    filesPresent: fs.existsSync(path.join(extensionPath, 'manifest.json')),
    installedInChrome: probe.installedInChrome,
    chromeLoaded: probe.chromeLoaded,
    detectedProfilePath: probe.detectedProfilePath,
    installedExtensionId: probe.installedExtensionId,
    installedPath: probe.installedPath,
    otherBrowserAgentPaths: probe.otherBrowserAgentPaths,
    exactPathMatch: probe.exactPathMatch,
    currentContentMatch: probe.currentContentMatch,
    requiresInstall: !probe.installedInChrome,
    requiresEnable: probe.installedInChrome && !probe.chromeLoaded,
    requiresReload: probe.chromeLoaded && !currentCopyLoaded,
    waitingForHeartbeat: currentCopyLoaded && !connected,
    recommendedAction,
    chromeExtensionsUrl: 'chrome://extensions',
    manualChromeStepRequired: !connected,
    manualChromeBoundary: 'Chrome requires your own click for Developer mode, Load unpacked, Enable, and Reload. LPS opens the correct screen and folder but does not automate protected extension controls.',
    instructions: [
      'Open chrome://extensions in the Chrome profile that runs LPS.',
      'Enable Developer mode.',
      'Click Load unpacked.',
      `Select ${extensionPath}.`
    ]
  });
});

app.post('/api/browser/extension/install-helper', async (_req, res) => {
  const extensionPath = browserAgentExtensionDir();
  try {
    const probe = browserExtensionProbe();
    await copyTextToSystemClipboard(extensionPath);
    await openChromeBrowser('chrome://extensions', probe.detectedProfilePath);
    let folderOpened = false;
    if (process.platform === 'win32') {
      await execFileAsync('explorer.exe', [extensionPath], { cwd: root, timeout: 10000, windowsHide: true });
      folderOpened = true;
    }
    ok(res, {
      extensionPath,
      copied: true,
      opened: true,
      folderOpened,
      detectedProfilePath: probe.detectedProfilePath,
      installedInChrome: probe.installedInChrome,
      chromeLoaded: probe.chromeLoaded,
      exactPathMatch: probe.exactPathMatch,
      currentContentMatch: probe.currentContentMatch,
      manualChromeStepRequired: true,
      message: probe.installedInChrome
        ? 'The detected Chrome profile and exact LPS extension folder are open. Enable or Reload the extension yourself, then wait for the heartbeat.'
        : 'The detected Chrome profile and exact LPS extension folder are open. Enable Developer mode and click Load unpacked yourself.'
    });
  } catch (error) {
    fail(res, 500, error.message || 'Browser-agent install helper failed.');
  }
});

app.post('/api/browser/extension/heartbeat', (req, res) => {
  if (!requireBrowserExtension(req, res)) return;
  const tabs = Array.isArray(req.body.tabs) ? req.body.tabs : [];
  browserExtensionState.lastSeen = Date.now();
  browserExtensionState.tabs = tabs
    .filter((tab) => tab && typeof tab.url === 'string')
    .filter((tab) => Object.values(cloudAgentHosts).some((hosts) => tabMatchesAgent(tab.url, hosts)))
    .map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url || '' }))
    .slice(0, 100);
  ok(res, {
    connected: true,
    agents: agentTabsFromUrls(browserExtensionState.tabs)
  });
});

app.get('/api/browser/extension/next', (req, res) => {
  if (!requireBrowserExtension(req, res)) return;
  const now = Date.now();
  for (const item of browserAgentJobs.values()) {
    if (item.status === 'claimed' && item.leaseExpiresAt < now) {
      item.status = 'pending';
      item.claimToken = '';
      item.leaseExpiresAt = 0;
    }
  }
  const job = [...browserAgentJobs.values()]
    .filter((item) => item.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!job) return ok(res, { job: null });
  job.status = 'claimed';
  job.updatedAt = now;
  job.claimToken = crypto.randomBytes(24).toString('hex');
  job.leaseExpiresAt = now + 120000;
  ok(res, {
    job: {
      id: job.id,
      targetAgent: job.targetAgent,
      url: job.url,
      prompt: job.prompt,
      claimToken: job.claimToken,
      leaseExpiresAt: job.leaseExpiresAt
    }
  });
});

app.post('/api/browser/extension/jobs/:id', (req, res) => {
  if (!requireBrowserExtension(req, res)) return;
  const job = browserAgentJobs.get(Number(req.params.id));
  if (!job) return fail(res, 404, 'Browser-agent job not found.');
  if (!job.claimToken || req.body.claimToken !== job.claimToken) return fail(res, 403, 'Browser-agent job claim token is invalid.');
  if (Date.now() > job.leaseExpiresAt) return fail(res, 409, 'Browser-agent job claim expired; request the job again.');
  const status = ['pending', 'claimed', 'sent', 'answered', 'blocked', 'error'].includes(req.body.status)
    ? req.body.status
    : 'error';
  job.status = status;
  job.updatedAt = Date.now();
  job.error = req.body.error || '';
  job.result = {
    url: req.body.url || job.url,
    title: req.body.title || job.targetAgent,
    answer: req.body.answer || '',
    message: req.body.message || ''
  };
  if (['answered', 'blocked', 'error'].includes(status)) {
    job.claimToken = '';
    job.leaseExpiresAt = 0;
  }
  ok(res, { job });
});

app.post('/api/browser/assist-prompt', async (req, res) => {
  const targetAgent = String(req.body.target_agent || 'ChatGPT').trim();
  const localDraft = String(req.body.local_draft || '').trim();
  if (!localDraft) return fail(res, 400, 'Enter a browser-agent question before asking the local model to assist.');

  try {
    const contexts = selectedContextFiles(req.body.context_paths || []);
    const result = await runBrowserPromptAssistant({
      targetAgent,
      localDraft,
      contexts
    });
    ok(res, {
      ...result,
      contexts: contexts.map((item) => ({ path: item.path, truncated: item.truncated }))
    });
  } catch (error) {
    fail(res, 500, error.message || 'Local browser-agent prompt assistance failed.');
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

app.post('/api/browser/copy-prompt', async (req, res) => {
  const text = String(req.body.prompt || '');
  try {
    const copied = await copyTextToSystemClipboard(text);
    ok(res, {
      copied: true,
      clipboard: copied.command,
      note: 'Prompt copied to the system clipboard.'
    });
  } catch (error) {
    fail(res, 500, error.message || 'Prompt copy failed.');
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
    const copied = req.body.prompt
      ? await copyTextToSystemClipboard(req.body.prompt)
      : null;
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
      copied: Boolean(copied),
      clipboard: copied?.command || '',
      note: copied
        ? 'Prompt copied to the system clipboard, then opened in your default external browser. Paste it into the cloud agent after sign-in.'
        : 'Opened in your default external browser. Use this for Google sign-in or human checks that reject controlled browsers.'
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
    const copied = req.body.prompt
      ? await copyTextToSystemClipboard(req.body.prompt)
      : null;
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
      copied: Boolean(copied),
      clipboard: copied?.command || '',
      note: copied
        ? 'Prompt copied to the system clipboard, then opened Chrome. Paste it into the cloud agent after sign-in.'
        : 'Opened in your installed Chrome profile. The app did not read or copy Chrome cookies.'
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

// ── OpenHands local worker tooling ──────────────────────────────────────────
// OpenHands is a local worker, never the brain: LPS only checks status, starts/
// stops the one known container, and stores reviewable task-request files.
// No arbitrary commands, no automatic execution, no writes to brain locations.
const OPENHANDS_CONTAINER = 'openhands-app';
const OPENHANDS_URL = 'http://localhost:3000';
const LPS_TOOLING_DIR = path.join(root, '.lps', 'tooling', 'openhands');
const OPENHANDS_REQUEST_DIR = path.join(LPS_TOOLING_DIR, 'requests');
const OPENHANDS_REPORT_DIR = path.join(LPS_TOOLING_DIR, 'reports');

// OpenHands executor path-enforcement helpers (OPENHANDS_MANDATORY_FORBIDDEN,
// normalizeRequestPath, violatesMandatoryForbidden, parsePorcelainPaths,
// isChangedFileAllowed, enforceChangedFiles) live in ./executorEnforcement.js so
// the rejection path can be exercised by a committed verification script without
// booting the server. Imported at the top of this file. Behaviour is unchanged.

async function probeHttp(url, timeoutMs = 3000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: true, code: response.status };
  } catch {
    return { reachable: false, code: 0 };
  }
}

// Docker may be missing from PATH depending on how the server was launched;
// fall back to Docker Desktop's standard CLI location on Windows.
let dockerCommand = 'docker';

async function runDocker(args, options = {}) {
  const attempted = dockerCommand;
  let result = await runCli(attempted, args, options);
  if (!result.available) {
    const fallback = process.platform === 'win32' && process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')
      : '';
    // Concurrent callers may race the shared dockerCommand switch, so retry
    // whenever THIS call's attempt failed and the fallback is a different path.
    if (fallback && attempted !== fallback && fs.existsSync(fallback)) {
      dockerCommand = fallback;
      result = await runCli(fallback, args, options);
    }
  }
  return result;
}

function openHandsEnabled() {
  return getSetting('openHandsEnabled', false) === true;
}

function dockerAccessibleEndpoint(endpoint) {
  if (!endpoint) return '';
  try {
    const parsed = new URL(endpoint);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') parsed.hostname = 'host.docker.internal';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return endpoint;
  }
}

function openHandsExecConfig() {
  const codeEndpoint = String(getSetting('localCodeModelEndpoint', '') || '').trim();
  const chatEndpoint = String(getSetting('localModelEndpoint', '') || '').trim();
  const configuredEndpoint = codeEndpoint || chatEndpoint;
  const port = Number(getSetting('llamaServerPort', 8080) || 8080);
  const endpoint = configuredEndpoint || (managedLlamaServerReady ? `http://127.0.0.1:${port}` : '');
  const model = String(getSetting('localCodeModelName', '') || getSetting('localModelName', 'planner-assistant') || 'planner-assistant').trim();
  return {
    model: `openai/${model}`,
    baseUrl: dockerAccessibleEndpoint(endpoint),
    apiKeyRef: 'LPS-managed OpenAI-compatible endpoint credential',
    source: codeEndpoint ? 'coding-worker endpoint' : chatEndpoint ? 'chat endpoint fallback' : managedLlamaServerReady ? 'bundled llama.cpp' : 'not ready'
  };
}

app.get('/api/tooling/openhands/status', async (_req, res) => {
  if (!openHandsEnabled()) {
    return ok(res, {
      enabled: false,
      optional: true,
      active: false,
      installed: 'not checked',
      url: OPENHANDS_URL,
      model: openHandsExecConfig(),
      note: 'OpenHands is optional and inactive. Enable it explicitly before LPS probes Docker or starts a container.'
    });
  }
  const [docker, container, http] = await Promise.all([
    runDocker(['--version'], { timeout: 10000 }),
    runDocker(['ps', '-a', '--filter', `name=${OPENHANDS_CONTAINER}`, '--format', '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}'], { timeout: 15000 }),
    probeHttp(OPENHANDS_URL)
  ]);
  const line = (container.stdout || '').split('\n').find((item) => item.startsWith(`${OPENHANDS_CONTAINER}|`)) || '';
  const [, state = '', statusText = '', image = ''] = line.split('|');
  const installed = docker.ok ? (line ? 'installed' : 'missing') : 'unknown';
  ok(res, {
    enabled: true,
    optional: true,
    active: state === 'running',
    url: OPENHANDS_URL,
    docker: { available: docker.ok, version: docker.stdout || docker.stderr },
    installed,
    container: {
      name: OPENHANDS_CONTAINER,
      exists: Boolean(line),
      running: state === 'running',
      state,
      status: statusText,
      image
    },
    http,
    note: !docker.ok
      ? 'Docker CLI is unavailable, so container state is unknown. Start Docker Desktop first.'
      : !line
        ? 'OpenHands container not found. Install it once with the official docker run command from docs.openhands.dev; LPS does not install it automatically.'
        : ''
  });
});

app.post('/api/tooling/openhands/config', (req, res) => {
  if (typeof req.body.enabled !== 'boolean') return fail(res, 400, 'enabled must be true or false.');
  setSetting('openHandsEnabled', req.body.enabled);
  ok(res, {
    enabled: req.body.enabled,
    optional: true,
    note: req.body.enabled ? 'OpenHands enabled. Status checks may now probe Docker.' : 'OpenHands disabled. Automatic Docker and model probes are off.'
  });
});

app.post('/api/tooling/openhands/start', async (_req, res) => {
  if (!openHandsEnabled()) return fail(res, 409, 'OpenHands is optional and disabled. Enable it explicitly first.');
  // Fixed, known-safe command: start the one named container. Never docker run.
  const result = await runDocker(['start', OPENHANDS_CONTAINER], { timeout: 60000 });
  if (!result.ok) {
    return fail(res, 500, result.stderr || result.stdout || `docker start ${OPENHANDS_CONTAINER} failed. If the container does not exist, install OpenHands once per docs.openhands.dev.`);
  }
  const http = await probeHttp(OPENHANDS_URL, 5000);
  ok(res, { started: true, container: OPENHANDS_CONTAINER, http, message: `Started ${OPENHANDS_CONTAINER}. The UI can take ~30s to answer on ${OPENHANDS_URL}.` });
});

app.post('/api/tooling/openhands/stop', async (_req, res) => {
  const result = await runDocker(['stop', OPENHANDS_CONTAINER], { timeout: 90000 });
  if (!result.ok) {
    return fail(res, 500, result.stderr || result.stdout || `docker stop ${OPENHANDS_CONTAINER} failed.`);
  }
  ok(res, { stopped: true, container: OPENHANDS_CONTAINER, message: `Stopped ${OPENHANDS_CONTAINER}.` });
});

app.get('/api/tooling/openhands/model-status', async (_req, res) => {
  const runtime = await localModelStatus();
  const config = openHandsExecConfig();
  ok(res, {
    enabled: openHandsEnabled(),
    configured: Boolean(config.baseUrl),
    config,
    runtime,
    note: config.baseUrl
      ? `Future coding workers use LPS's ${config.source}; no Ollama-specific dependency exists.`
      : 'Configure an OpenAI-compatible endpoint or start the bundled llama.cpp runtime before enabling a coding worker.'
  });
});

function readOpenHandsRequests() {
  if (!fs.existsSync(OPENHANDS_REQUEST_DIR)) return [];
  const requests = [];
  for (const entry of fs.readdirSync(OPENHANDS_REQUEST_DIR)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(OPENHANDS_REQUEST_DIR, entry), 'utf8'));
      const reportMd = path.join(OPENHANDS_REPORT_DIR, `${parsed.id}.md`);
      const reportJson = path.join(OPENHANDS_REPORT_DIR, `${parsed.id}.json`);
      parsed.reportPath = fs.existsSync(reportMd)
        ? path.relative(root, reportMd).replaceAll('\\', '/')
        : fs.existsSync(reportJson)
          ? path.relative(root, reportJson).replaceAll('\\', '/')
          : '';
      requests.push(parsed);
    } catch {
      requests.push({ id: entry, title: `Unreadable request file: ${entry}`, status: 'invalid', createdAt: '', requestedBy: 'unknown' });
    }
  }
  return requests.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

app.get('/api/tooling/openhands/requests', (_req, res) => {
  ok(res, readOpenHandsRequests());
});

let openHandsRequestSeq = 1;

app.post('/api/tooling/openhands/requests', (req, res) => {
  if (!openHandsEnabled()) return fail(res, 409, 'OpenHands is optional and disabled. Enable it before creating worker requests.');
  const title = String(req.body.title || '').trim();
  const objective = String(req.body.objective || '').trim();
  if (!title) return fail(res, 400, 'Request title is required.');
  if (!objective) return fail(res, 400, 'Request objective is required.');

  const targetRepoPath = String(req.body.targetRepoPath || '').trim() || root;
  const baseBranchCheck = validateExecutorBaseBranch(req.body.baseBranch || 'main');
  if (!baseBranchCheck.ok) return fail(res, 400, `Request rejected: ${baseBranchCheck.reason}.`);
  const baseBranch = baseBranchCheck.baseBranch;
  const allowedPaths = (Array.isArray(req.body.allowedPaths) ? req.body.allowedPaths : String(req.body.allowedPaths || '').split('\n'))
    .map((item) => String(item).trim()).filter(Boolean);
  const forbiddenPaths = (Array.isArray(req.body.forbiddenPaths) ? req.body.forbiddenPaths : String(req.body.forbiddenPaths || '').split('\n'))
    .map((item) => String(item).trim()).filter(Boolean);

  const blockedAllowed = allowedPaths.filter((item) => violatesMandatoryForbidden(item));
  if (blockedAllowed.length) {
    return fail(res, 400, `Request rejected: allowed paths overlap protected locations (${blockedAllowed.join(', ')}). source_of_truth, memory, secrets, .env, data, rules, .git and .lps are never workable.`);
  }
  const secretHints = /api[\s_-]?key|token|password|secret|credential/i;
  if (secretHints.test(title) || secretHints.test(objective)) {
    return fail(res, 400, 'Request rejected: it appears to reference credentials/secrets. OpenHands requests must not involve keys, tokens, or passwords.');
  }

  const maxFilesRaw = Number(req.body.maxFilesChanged);
  const maxFilesChanged = Math.min(5, Math.max(1, Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? Math.floor(maxFilesRaw) : 5));

  const createdAt = new Date().toISOString();
  const id = `oh-req-${createdAt.replace(/[:.]/g, '-')}-${openHandsRequestSeq++}`;
  const request = {
    id,
    title: title.slice(0, 160),
    objective: objective.slice(0, 4000),
    requestedBy: String(req.body.requestedBy || 'unknown').trim().slice(0, 80) || 'unknown',
    targetRepoPath,
    baseBranch,
    baseBranchAtCreation: baseBranch,
    allowedPaths,
    forbiddenPaths: [...new Set([...forbiddenPaths, ...OPENHANDS_MANDATORY_FORBIDDEN])],
    testCommand: String(req.body.testCommand || '').trim().slice(0, 300),
    maxFilesChanged,
    // First version: every gate is always on, regardless of what the caller sent.
    requiresApprovalBeforeRun: true,
    requiresApprovalBeforeCommit: true,
    requiresApprovalBeforePush: true,
    riskLevel: maxFilesChanged <= 3 && String(req.body.testCommand || '').trim() ? 'low' : 'medium',
    createdAt,
    status: 'pending',
    reportPath: ''
  };

  fs.mkdirSync(OPENHANDS_REQUEST_DIR, { recursive: true });
  fs.mkdirSync(OPENHANDS_REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OPENHANDS_REQUEST_DIR, `${id}.json`), JSON.stringify(request, null, 2), 'utf8');
  ok(res, { request, storedAt: path.relative(root, path.join(OPENHANDS_REQUEST_DIR, `${id}.json`)).replaceAll('\\', '/'), note: 'Request stored for review. Nothing runs until it is approved; execution is not automated in this version.' });
});

// ── OpenHands Approved Request Runner (first safe layer) ─────────────────────
// This is a GATED runner, not an autonomous agent. It acts only on a request a
// human has explicitly approved, and its only "execution" is running a command
// from a fixed allowlist (validation/build). It never invokes OpenHands to edit
// code, and never commits, pushes, merges, resets, deletes, or force-pushes.
// The request's own `testCommand` is honoured only if it exactly matches an
// allowlist entry; arbitrary commands are refused.
const RUNNER_VALIDATION_ALLOWLIST = {
  'node --check server/index.js': { command: 'node', args: ['--check', 'server/index.js'] },
  'npm run build': { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', 'build'] }
};
const RUNNER_DEFAULT_VALIDATION = 'node --check server/index.js';

// Resolve a request id to its file, refusing anything that could escape the
// requests directory (the id is server-generated, but never trust the URL).
function openHandsRequestFile(id) {
  const raw = String(id || '').trim();
  if (!/^oh-req-[A-Za-z0-9._-]+$/.test(raw)) throw new Error('Invalid request id.');
  const absolute = path.resolve(OPENHANDS_REQUEST_DIR, `${raw}.json`);
  const dirWithSep = OPENHANDS_REQUEST_DIR.endsWith(path.sep) ? OPENHANDS_REQUEST_DIR : `${OPENHANDS_REQUEST_DIR}${path.sep}`;
  if (!absolute.startsWith(dirWithSep)) throw new Error('Request id must stay inside the requests directory.');
  return absolute;
}

function loadOpenHandsRequest(id) {
  const file = openHandsRequestFile(id);
  if (!fs.existsSync(file)) return null;
  return { file, request: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

async function changedTrackedFiles() {
  const status = await runCli('git', ['status', '--porcelain']);
  return new Set((status.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean));
}

app.post('/api/tooling/openhands/requests/:id/approve', (req, res) => {
  if (!openHandsEnabled()) return fail(res, 409, 'OpenHands is disabled.');
  try {
    const loaded = loadOpenHandsRequest(req.params.id);
    if (!loaded) return fail(res, 404, 'Request not found.');
    const { file, request } = loaded;
    if (request.status === 'validated' || request.status === 'validation-failed') {
      return fail(res, 409, `Request already ran (status: ${request.status}). Approval cannot be re-applied after a run.`);
    }
    const baseBranch = normalizeStoredBaseBranch(request);
    const createdBaseBranch = String(request.baseBranchAtCreation || baseBranch);
    if (createdBaseBranch !== baseBranch) {
      return fail(res, 409, `Approval refused: baseBranch changed from "${createdBaseBranch}" to "${baseBranch}" after request creation. Create a new request for a different base branch.`);
    }
    request.status = 'approved';
    request.approvedAt = new Date().toISOString();
    request.approvedBy = String(req.body.approvedBy || 'user').trim().slice(0, 80) || 'user';
    request.baseBranchAtCreation = createdBaseBranch;
    request.approvedBaseBranch = baseBranch;
    request.approvedBaseBranchAt = request.approvedAt;
    fs.writeFileSync(file, JSON.stringify(request, null, 2), 'utf8');
    ok(res, { request, note: 'Human approval recorded. The gated runner may now run allowlisted validation only.' });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.post('/api/tooling/openhands/requests/:id/run', async (req, res) => {
  if (!openHandsEnabled()) return fail(res, 409, 'OpenHands is disabled.');
  let loaded;
  try {
    loaded = loadOpenHandsRequest(req.params.id);
  } catch (error) {
    return fail(res, 400, error.message);
  }
  if (!loaded) return fail(res, 404, 'Request not found.');
  const { file, request } = loaded;

  // Gate 1: explicit human approval must be recorded.
  if (request.status !== 'approved') {
    return fail(res, 403, `Runner refused: request is "${request.status}", not "approved". A human must approve it before it can run.`);
  }
  // Gate 2: protected-path re-check (defence in depth vs. a hand-edited file).
  const blocked = (request.allowedPaths || []).filter((item) => violatesMandatoryForbidden(item));
  if (blocked.length) {
    return fail(res, 403, `Runner refused: request allows protected paths (${blocked.join(', ')}).`);
  }
  // Gate 3: only an allowlisted validation command may run. A supplied
  // testCommand is honoured solely if it matches the allowlist exactly.
  const requested = String(request.testCommand || '').trim();
  const commandKey = requested || RUNNER_DEFAULT_VALIDATION;
  const validation = RUNNER_VALIDATION_ALLOWLIST[commandKey];
  if (!validation) {
    return fail(res, 400, `Runner refused: "${requested}" is not in the validation allowlist. Allowed: ${Object.keys(RUNNER_VALIDATION_ALLOWLIST).join(', ')}. Arbitrary commands are never executed.`);
  }

  // Snapshot before/after so we measure files the RUN changed (not pre-existing
  // edits), and enforce maxFilesChanged against real filesystem effect.
  const before = await changedTrackedFiles();
  const result = await runCli(validation.command, validation.args, { timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  const after = await changedTrackedFiles();
  const runChanged = [...after].filter((line) => !before.has(line));
  const maxFiles = Number(request.maxFilesChanged) || 5;
  const withinMax = runChanged.length <= maxFiles;
  const validationOk = result.ok && withinMax;
  const status = validationOk ? 'validated' : 'validation-failed';

  const reportLines = [
    `# OpenHands Runner Report — ${request.id}`,
    '',
    `- Title: ${request.title}`,
    `- Objective: ${request.objective}`,
    `- Requested by: ${request.requestedBy}`,
    `- Approved by: ${request.approvedBy || 'unknown'} at ${request.approvedAt || 'unknown'}`,
    `- Run at: ${new Date().toISOString()}`,
    `- Working directory: ${root}`,
    '',
    '## Validation (allowlisted command only)',
    `- Command: \`${commandKey}\``,
    `- Exit ok: ${result.ok}`,
    `- Files changed by this run: ${runChanged.length} (limit ${maxFiles}) ${withinMax ? 'within limit' : 'OVER LIMIT'}`,
    runChanged.length ? runChanged.map((line) => `  - ${line}`).join('\n') : '  - none',
    '',
    '### stdout',
    '```',
    (result.stdout || '(empty)').slice(0, 4000),
    '```',
    '### stderr',
    '```',
    (result.stderr || '(empty)').slice(0, 4000),
    '```',
    '',
    '## Safety',
    'This gated runner ran an allowlisted validation command only. It did NOT edit',
    'source files, invoke OpenHands to change code, commit, push, merge, reset,',
    'delete, or force-push. Any real code change and any commit/push remain manual,',
    'separately-approved steps.',
    ''
  ];
  fs.mkdirSync(OPENHANDS_REPORT_DIR, { recursive: true });
  const reportFile = path.join(OPENHANDS_REPORT_DIR, `${request.id}.md`);
  fs.writeFileSync(reportFile, reportLines.join('\n'), 'utf8');

  request.status = status;
  request.runAt = new Date().toISOString();
  request.runBy = String(req.body.runBy || 'user').trim().slice(0, 80) || 'user';
  request.validationCommand = commandKey;
  request.validationOk = validationOk;
  request.reportPath = path.relative(root, reportFile).replaceAll('\\', '/');
  fs.writeFileSync(file, JSON.stringify(request, null, 2), 'utf8');

  ok(res, {
    request,
    status,
    validationOk,
    filesChangedByRun: runChanged,
    reportPath: request.reportPath,
    performedActions: ['ran allowlisted validation command', 'wrote report'],
    refusedActions: ['commit', 'push', 'merge', 'reset', 'delete', 'force-push', 'arbitrary command', 'OpenHands code edit'],
    message: validationOk
      ? 'Validation passed. Report written. No files were changed, committed, or pushed by the runner.'
      : (result.ok ? 'Validation command succeeded but the run exceeded the file-change limit; marked validation-failed.' : 'Validation command failed. See the report; nothing was committed or pushed.')
  });
});

app.get('/api/tooling/openhands/requests/:id/report', (req, res) => {
  try {
    const raw = String(req.params.id || '').trim();
    if (!/^oh-req-[A-Za-z0-9._-]+$/.test(raw)) return fail(res, 400, 'Invalid request id.');
    const reportFile = path.resolve(OPENHANDS_REPORT_DIR, `${raw}.md`);
    const dirWithSep = OPENHANDS_REPORT_DIR.endsWith(path.sep) ? OPENHANDS_REPORT_DIR : `${OPENHANDS_REPORT_DIR}${path.sep}`;
    if (!reportFile.startsWith(dirWithSep)) return fail(res, 400, 'Report id must stay inside the reports directory.');
    if (!fs.existsSync(reportFile)) return fail(res, 404, 'No report yet for this request.');
    ok(res, { id: raw, reportPath: path.relative(root, reportFile).replaceAll('\\', '/'), content: fs.readFileSync(reportFile, 'utf8') });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

// ── OpenHands Execution Worker (dry-run / plan-only, first safe slice) ────────
// This layer is deliberately NON-mutating. It does NOT invoke OpenHands, create
// worktrees, edit files, or run Git write operations. It only (a) records a
// SECOND explicit human confirmation beyond approval, and (b) produces an
// execution PLAN after verifying every safety gate, writing a report a human
// reviews. Real code editing is a later, separately-approved layer.
const PROTECTED_EXEC_BRANCHES = ['main', 'master'];

// Fixed OpenHands wiring — request JSON can never override any of this.

function proposedExecutionBranch(id) {
  const suffix = String(id).replace(/[^A-Za-z0-9._-]/g, '').slice(-40);
  return `openhands/exec-${suffix}`;
}

async function branchExists(name) {
  const result = await runCli('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  return result.ok && Boolean(result.stdout);
}

async function resolveBaseBranchCommit(baseBranch) {
  const result = await runCli('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseBranch}^{commit}`]);
  const sha = String(result.stdout || '').trim();
  return {
    ok: result.ok && /^[0-9a-f]{40}$/i.test(sha),
    sha,
    detail: result.ok && sha ? `${baseBranch} resolves to ${sha.slice(0, 12)}` : `${baseBranch} does not resolve to a commit`
  };
}

function normalizeStoredBaseBranch(request) {
  const check = validateExecutorBaseBranch(request.baseBranch || 'main');
  if (!check.ok) throw new Error(`Invalid base branch: ${check.reason}.`);
  request.baseBranch = check.baseBranch;
  return check.baseBranch;
}

// Evaluate every execution gate WITHOUT mutating anything. Returns structured
// pass/fail plus the concrete plan the (future) executor would follow.
async function evaluateExecutionPlan(request) {
  const gates = [];
  const pass = (name, ok, detail) => { gates.push({ gate: name, ok, detail }); return ok; };

  const approved = pass('human_approval', request.status === 'approved' || request.status === 'execution-planned',
    request.status === 'approved' || request.status === 'execution-planned' ? `status is ${request.status}` : `status is ${request.status}, needs approved`);
  const confirmed = pass('second_confirmation', request.executionConfirmed === true,
    request.executionConfirmed === true ? `confirmed by ${request.executionConfirmedBy || 'unknown'}` : 'execution not confirmed (second human confirmation required)');

  const allowedPaths = Array.isArray(request.allowedPaths) ? request.allowedPaths : [];
  const forbiddenPaths = Array.isArray(request.forbiddenPaths) ? request.forbiddenPaths : [];
  const allowedNonEmpty = pass('allowed_paths_present', allowedPaths.length > 0,
    allowedPaths.length ? `${allowedPaths.length} allowed path(s)` : 'no allowedPaths — executor would have nothing safe to scope to');
  // Scan the ALLOWED paths only: forbiddenPaths deliberately contains the
  // protected prefixes (it is the deny-list), so scanning it would always flag.
  const protectedHits = allowedPaths.filter((item) => violatesMandatoryForbidden(item));
  const protectedClean = pass('protected_path_scan', protectedHits.length === 0,
    protectedHits.length ? `BLOCKED — an allowed path touches protected locations: ${protectedHits.join(', ')}` : 'no allowed path references protected locations');

  const baseCheck = validateExecutorBaseBranch(request.baseBranch || 'main');
  const baseBranch = baseCheck.baseBranch;
  const baseSyntaxOk = pass('base_branch_ref_syntax', baseCheck.ok,
    baseCheck.ok ? `base branch "${baseBranch}" is syntactically safe` : `BLOCKED - ${baseCheck.reason}`);
  const createdBaseBranch = String(request.baseBranchAtCreation || '');
  const baseCreatedPinned = pass('base_branch_creation_pin', baseCheck.ok && createdBaseBranch === baseBranch,
    createdBaseBranch
      ? `created with "${createdBaseBranch}"${createdBaseBranch === baseBranch ? '' : ` but request currently says "${baseBranch}"`}`
      : 'missing creation-time base pin; create a new request or re-approve before execution');
  const approvedBaseBranch = String(request.approvedBaseBranch || '');
  const baseApprovedPinned = pass('base_branch_approval_pin', baseCheck.ok && approvedBaseBranch === baseBranch,
    approvedBaseBranch
      ? `approved with "${approvedBaseBranch}"${approvedBaseBranch === baseBranch ? '' : ` but request currently says "${baseBranch}"`}`
      : 'missing approval-time base pin; re-approve before execution');
  const confirmedBaseBranch = String(request.executionConfirmedBaseBranch || '');
  const baseConfirmedPinned = pass('base_branch_confirmation_pin', baseCheck.ok && request.executionConfirmed === true && confirmedBaseBranch === baseBranch,
    request.executionConfirmed === true
      ? (confirmedBaseBranch
        ? `confirmed with "${confirmedBaseBranch}"${confirmedBaseBranch === baseBranch ? '' : ` but request currently says "${baseBranch}"`}`
        : 'missing confirmation-time base pin; confirm execution again')
      : 'execution not confirmed; base branch will be pinned at confirmation');
  const baseResolution = baseCheck.ok
    ? await resolveBaseBranchCommit(baseBranch)
    : { ok: false, sha: '', detail: 'base branch syntax is invalid, so it was not resolved' };
  const baseRefResolves = pass('base_branch_resolves', baseResolution.ok, baseResolution.detail);
  const execBranch = proposedExecutionBranch(request.id);
  const execNameSafe = pass('execution_branch_not_main_master', !PROTECTED_EXEC_BRANCHES.includes(execBranch.toLowerCase()),
    `dedicated execution branch would be "${execBranch}"`);
  const execBranchFree = !(await branchExists(execBranch));
  pass('execution_branch_available', execBranchFree, execBranchFree ? `"${execBranch}" does not exist yet` : `"${execBranch}" already exists`);

  const maxFilesCheck = checkExecutorMaxFilesChanged(request.maxFilesChanged);
  const maxFiles = maxFilesCheck.maxFiles;
  const maxFilesSane = pass('max_files_changed', maxFilesCheck.ok, maxFilesCheck.reason);

  const requested = String(request.testCommand || '').trim();
  const validationKey = requested || RUNNER_DEFAULT_VALIDATION;
  const validationAllowlisted = pass('validation_command_allowlisted', Boolean(RUNNER_VALIDATION_ALLOWLIST[validationKey]),
    RUNNER_VALIDATION_ALLOWLIST[validationKey] ? `post-change validation would run: ${validationKey}` : `"${requested}" is not allowlisted — arbitrary commands are refused`);

  const eligible = approved && confirmed && allowedNonEmpty && protectedClean && baseSyntaxOk
    && baseCreatedPinned && baseApprovedPinned && baseConfirmedPinned && baseRefResolves
    && execNameSafe && execBranchFree && maxFilesSane && validationAllowlisted;

  return {
    eligible,
    gates,
    plan: {
      dryRun: true,
      executionBranch: execBranch,
      baseBranch,
      baseCommit: baseResolution.sha,
      isolation: 'dedicated git worktree/branch from the pinned base branch (not created in this dry run)',
      allowedPaths,
      forbiddenPaths,
      maxFilesChanged: maxFiles,
      limits: OPENHANDS_EXECUTOR_LIMITS,
      validationCommand: validationKey,
      openHandsConfig: openHandsExecConfig(),
      openHandsInvoked: false,
      filesChanged: [],
      wouldRefuse: ['auto-commit', 'auto-push', 'auto-merge', 'reset --hard', 'branch delete', 'force-push', 'push to main/master', 'arbitrary shell from request', 'editing protected paths', 'base branch changes after approval', 'future invocation without tool-level constraints']
    }
  };
}

app.post('/api/tooling/openhands/requests/:id/confirm-execution', (req, res) => {
  if (!openHandsEnabled()) return fail(res, 409, 'OpenHands is disabled.');
  try {
    const loaded = loadOpenHandsRequest(req.params.id);
    if (!loaded) return fail(res, 404, 'Request not found.');
    const { file, request } = loaded;
    if (request.status !== 'approved' && request.status !== 'execution-planned') {
      return fail(res, 403, `Second confirmation refused: request is "${request.status}". It must be human-approved first.`);
    }
    const baseBranch = normalizeStoredBaseBranch(request);
    if (!request.approvedBaseBranch) {
      return fail(res, 409, 'Second confirmation refused: this request was approved before base-branch pinning existed. Re-approve it to pin the base branch.');
    }
    if (request.approvedBaseBranch !== baseBranch) {
      return fail(res, 409, `Second confirmation refused: request baseBranch is "${baseBranch}" but approval pinned "${request.approvedBaseBranch}". Re-create the request for a different base branch.`);
    }
    request.executionConfirmed = true;
    request.executionConfirmedAt = new Date().toISOString();
    request.executionConfirmedBy = String(req.body.confirmedBy || 'user').trim().slice(0, 80) || 'user';
    request.executionConfirmedBaseBranch = baseBranch;
    request.executionConfirmedBaseBranchAt = request.executionConfirmedAt;
    fs.writeFileSync(file, JSON.stringify(request, null, 2), 'utf8');
    ok(res, { request, note: 'Second execution confirmation recorded. You may now run the dry-run execution plan. No code will be edited; the plan is review-only.' });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.post('/api/tooling/openhands/requests/:id/execution-plan', async (req, res) => {
  if (!openHandsEnabled()) return fail(res, 409, 'OpenHands is disabled.');
  let loaded;
  try {
    loaded = loadOpenHandsRequest(req.params.id);
  } catch (error) {
    return fail(res, 400, error.message);
  }
  if (!loaded) return fail(res, 404, 'Request not found.');
  const { file, request } = loaded;

  if (request.status !== 'approved' && request.status !== 'execution-planned') {
    return fail(res, 403, `Execution plan refused: request is "${request.status}", not approved.`);
  }
  if (request.executionConfirmed !== true) {
    return fail(res, 428, 'Execution plan refused: a second explicit human confirmation is required first (confirm-execution).');
  }

  const evaluation = await evaluateExecutionPlan(request);
  const toolConstraints = buildOpenHandsInvocationConstraints({
    request,
    plan: evaluation.plan,
    config: openHandsExecConfig(),
    limits: OPENHANDS_EXECUTOR_LIMITS,
    invocationEnabled: OPENHANDS_EXECUTOR_INVOCATION_ENABLED
  });
  evaluation.plan.toolInvocationConstraints = toolConstraints;
  const serviceProbe = await probeHttp(OPENHANDS_URL, 1500);
  const serviceCheck = { checked: true, url: OPENHANDS_URL, ...serviceProbe };
  const dryRunDependencySetup = {
    ...checkWorktreeValidationSetup(evaluation.plan.validationCommand, () => false, process.platform),
    checked: true,
    reason: evaluation.plan.validationCommand === 'npm run build'
      ? 'Dependency gate will run inside the isolated worktree; npm build dependencies cannot be proven in dry-run.'
      : 'No dependency preflight is required for this validation command.'
  };
  if (evaluation.plan.validationCommand === 'npm run build') {
    dryRunDependencySetup.ok = false;
    dryRunDependencySetup.setupGated = true;
  }
  const readiness = buildOpenHandsInvocationReadiness({
    invocationEnabled: OPENHANDS_EXECUTOR_INVOCATION_ENABLED,
    toolConstraints,
    serviceCheck,
    dependencySetup: dryRunDependencySetup,
    dryRunReportShown: true,
    postRunPatchRequiresSeparateApproval: true
  });
  evaluation.plan.invocationReadiness = readiness;
  const planEligible = evaluation.eligible && toolConstraints.ok;
  const worktrees = await runCli('git', ['worktree', 'list']);

  const gateLines = evaluation.gates.map((g) => `- [${g.ok ? 'PASS' : 'BLOCK'}] ${g.gate}: ${g.detail}`).join('\n');
  const toolConstraintLines = toolConstraints.checks.map((g) => `- [${g.ok ? 'PASS' : 'SETUP-GATED'}] ${g.gate}: ${g.detail}`).join('\n');
  const readinessLines = readiness.checks.map((g) => `- [${g.ok ? 'PASS' : 'SETUP-GATED'}] ${g.gate}: ${g.detail}`).join('\n');
  const reportLines = [
    `# OpenHands Execution Plan (DRY RUN) — ${request.id}`,
    '',
    `- Title: ${request.title}`,
    `- Objective: ${request.objective}`,
    `- Requested by: ${request.requestedBy}`,
    `- Approved by: ${request.approvedBy || 'unknown'} at ${request.approvedAt || 'unknown'}`,
    `- Execution confirmed by: ${request.executionConfirmedBy || 'unknown'} at ${request.executionConfirmedAt || 'unknown'}`,
    `- Planned at: ${new Date().toISOString()}`,
    '',
    '## Execution branch / worktree (would be created; NOT created here)',
    `- Dedicated branch: ${evaluation.plan.executionBranch}`,
    `- Isolation: ${evaluation.plan.isolation}`,
    `- Base reference (pinned, read-only): ${evaluation.plan.baseBranch || '(invalid)'}`,
    `- Base commit: ${evaluation.plan.baseCommit || '(not resolved)'}`,
    '',
    '## Safety gates',
    gateLines,
    '',
    '## Protected-path scan',
    `- Result: ${evaluation.gates.find((g) => g.gate === 'protected_path_scan')?.detail}`,
    `- Hard-blocked prefixes: ${OPENHANDS_MANDATORY_FORBIDDEN.join(', ')}`,
    '',
    '## Max files changed',
    `- ${evaluation.gates.find((g) => g.gate === 'max_files_changed')?.detail}`,
    '',
    '## Changed files (dry run)',
    '- none — no worktree was created, no files were edited, OpenHands was not invoked.',
    '',
    '## Diff summary',
    '- none (dry run).',
    '',
    '## Validation output',
    `- Not executed in the plan. Post-change validation would run: \`${evaluation.plan.validationCommand}\`.`,
    '',
    '## OpenHands wiring (fixed; request JSON cannot override)',
    `- Model: ${openHandsExecConfig().model}`,
    `- Base URL: ${openHandsExecConfig().baseUrl}`,
    `- API key: ${openHandsExecConfig().apiKeyRef}`,
    `- Invoked in this dry run: no`,
    '',
    '## Future invocation constraints (preflight only)',
    `- Status: ${toolConstraints.ok ? 'complete' : 'setup-gated'}`,
    `- Reason: ${toolConstraints.reason}`,
    toolConstraintLines,
    '',
    '## Invocation readiness gate (preflight only)',
    `- Status: ${readiness.ok ? 'ready' : 'setup-gated'}`,
    `- Reason: ${readiness.reason}`,
    readinessLines,
    '',
    '## Refused / blocked actions',
    evaluation.plan.wouldRefuse.map((a) => `- ${a}`).join('\n'),
    '',
    '## Current git worktrees (read-only)',
    '```',
    (worktrees.stdout || '(none)').slice(0, 1000),
    '```',
    '',
    '## Human next steps',
    planEligible
      ? '- All gates passed. A human may later approve the real (still-unbuilt) executor. Until then, no code has been changed. Any commit/push/PR remains a manual step via the Source Control panel.'
      : '- One or more gates/setup checks BLOCKED (see above). Fix the request (paths / approval / confirmation / tool constraints) before any execution is considered. Nothing was changed.',
    ''
  ];
  fs.mkdirSync(OPENHANDS_REPORT_DIR, { recursive: true });
  const reportFile = path.join(OPENHANDS_REPORT_DIR, `${request.id}.md`);
  fs.writeFileSync(reportFile, reportLines.join('\n'), 'utf8');

  request.status = 'execution-planned';
  request.executionPlannedAt = new Date().toISOString();
  request.executionEligible = planEligible;
  request.executionPlannedBaseBranch = evaluation.plan.baseBranch;
  request.executionPlannedBaseCommit = evaluation.plan.baseCommit;
  request.executionToolConstraintsOk = toolConstraints.ok;
  request.executionToolConstraintsReason = toolConstraints.reason;
  request.invocationReadinessOk = readiness.ok;
  request.invocationReadinessReason = readiness.reason;
  request.reportPath = path.relative(root, reportFile).replaceAll('\\', '/');
  fs.writeFileSync(file, JSON.stringify(request, null, 2), 'utf8');

  ok(res, {
    request,
    eligible: planEligible,
    gates: evaluation.gates,
    plan: evaluation.plan,
    reportPath: request.reportPath,
    performedActions: ['evaluated safety gates', 'wrote dry-run plan report'],
    refusedActions: ['edit code', 'invoke OpenHands', 'create worktree', 'commit', 'push', 'merge', 'reset', 'delete branch', 'force-push', 'run arbitrary command'],
    message: planEligible
      ? 'Dry-run plan complete: all gates passed. No code was changed and OpenHands was not invoked.'
      : 'Dry-run plan complete: one or more gates/setup checks BLOCKED. No code was changed. See the report.'
  });
});

// ── OpenHands Worktree Executor harness (gated; real invocation OFF) ──────────
// FIRST real-executor slice. It proves the isolated-worktree + gate + post-
// change-enforcement + validation + report flow, but the actual OpenHands
// invocation is DISABLED behind this server-side constant. Nothing here edits
// the user's working tree, main/master, or the user's current branch: all work
// happens in a throwaway git worktree on a dedicated openhands/exec-<id> branch.
const OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false;
const OPENHANDS_WORKTREE_DIR = path.join(LPS_TOOLING_DIR, 'worktrees');

// Normalise a repo-relative changed path from `git status --porcelain` output.
// parsePorcelainPaths, isChangedFileAllowed, and enforceChangedFiles are
// imported from ./executorEnforcement.js (see the top-of-file import). They are
// the same functions, moved to a pure module so the enforcement rejection path
// is testable without booting the server.

// Real OpenHands call lives here in the future. Disabled by the constant above,
// so this slice never contacts the model endpoint and never edits code.
async function invokeOpenHandsExecutor(toolConstraints, readiness) {
  if (!toolConstraints || toolConstraints.ok !== true) {
    return {
      invoked: false,
      setupGated: true,
      reason: `Real OpenHands invocation refused: missing tool-level constraints (${toolConstraints?.missing?.join(', ') || 'unknown'}).`,
      constraints: toolConstraints || null
    };
  }
  if (!readiness || readiness.ok !== true) {
    return {
      invoked: false,
      setupGated: true,
      reason: `Real OpenHands invocation refused: readiness gate is setup-gated (${readiness?.missing?.join(', ') || 'unknown'}).`,
      constraints: toolConstraints.constraints,
      readiness: readiness || null
    };
  }
  if (!OPENHANDS_EXECUTOR_INVOCATION_ENABLED) {
    return {
      invoked: false,
      setupGated: false,
      reason: 'Real OpenHands invocation is intentionally DISABLED (server-side constant OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false). No code was generated or edited.',
      constraints: toolConstraints.constraints,
      readiness
    };
  }
  // Future, separately-approved slice would call the OpenHands agent-server here
  // with OPENHANDS_EXEC_CONFIG (fixed model/endpoint/key), allowedPaths,
  // mandatory forbidden paths, base pin, and runtime/output limits from
  // toolConstraints. Intentionally not reachable in this build.
  return { invoked: false, reason: 'not implemented' };
}

app.post('/api/tooling/openhands/requests/:id/execute', async (req, res) => {
  if (!openHandsEnabled()) return fail(res, 409, 'OpenHands is disabled.');
  let loaded;
  try {
    loaded = loadOpenHandsRequest(req.params.id);
  } catch (error) {
    return fail(res, 400, error.message);
  }
  if (!loaded) return fail(res, 404, 'Request not found.');
  const { file, request } = loaded;

  // Gate 1: every dry-run gate must pass (approval, second confirmation,
  // allowedPaths, protected scan, branch-not-main/master, branch-free,
  // maxFiles, allowlisted validation).
  const evaluation = await evaluateExecutionPlan(request);
  if (!evaluation.eligible) {
    return fail(res, 403, `Executor refused: not eligible. Blocked gates: ${evaluation.gates.filter((g) => !g.ok).map((g) => g.gate).join(', ')}. Approve, confirm execution, and fix paths first.`);
  }
  const toolConstraints = buildOpenHandsInvocationConstraints({
    request,
    plan: evaluation.plan,
    config: openHandsExecConfig(),
    limits: OPENHANDS_EXECUTOR_LIMITS,
    invocationEnabled: OPENHANDS_EXECUTOR_INVOCATION_ENABLED
  });
  if (!toolConstraints.ok) {
    return fail(res, 428, `Executor refused: future OpenHands invocation constraints are setup-gated (${toolConstraints.missing.join(', ')}). Fix approval, paths, base pin, limits, or model config before execution.`);
  }

  const execBranch = proposedExecutionBranch(request.id);
  const pinnedBaseBranch = evaluation.plan.baseBranch;
  const pinnedBaseCommit = evaluation.plan.baseCommit;
  // Gate 2: never main/master, never the user's current branch, never an
  // existing branch.
  const currentBranch = (await runCli('git', ['branch', '--show-current'])).stdout.trim();
  if (PROTECTED_EXEC_BRANCHES.includes(execBranch.toLowerCase())) return fail(res, 403, 'Executor refused: execution branch resolves to main/master.');
  if (execBranch === currentBranch) return fail(res, 403, 'Executor refused: execution branch equals the current working branch.');
  if (await branchExists(execBranch)) return fail(res, 409, `Executor refused: branch ${execBranch} already exists. Review or remove it first (never auto-deleted).`);

  const worktreePath = path.join(OPENHANDS_WORKTREE_DIR, String(request.id).replace(/[^A-Za-z0-9._-]/g, ''));
  const worktreeRel = path.relative(root, worktreePath).replaceAll('\\', '/');
  let worktreeCreated = false;
  const refusedActions = ['auto-commit', 'auto-push', 'auto-merge', 'reset --hard', 'delete branch', 'force-push', 'push to main/master', 'arbitrary request shell', 'edit outside allowedPaths', 'base branch changes after approval', 'future invocation without tool-level constraints'];

  try {
    // Isolated worktree on a fresh dedicated branch from the pinned base commit
    // (never touches main tree; never uses the caller's current HEAD).
    fs.mkdirSync(OPENHANDS_WORKTREE_DIR, { recursive: true });
    const add = await runCli('git', ['worktree', 'add', '-b', execBranch, worktreePath, '--', pinnedBaseCommit], { timeout: OPENHANDS_EXECUTOR_LIMITS.worktreeCreateTimeoutMs });
    if (!add.ok) return fail(res, 500, `Executor could not create the isolated worktree: ${add.stderr || add.stdout}`);
    worktreeCreated = true;

    // Build the readiness gate before any future invocation could run. This
    // checks only local readiness; it never starts OpenHands or bypasses login.
    const validationKey = String(request.testCommand || '').trim() || RUNNER_DEFAULT_VALIDATION;
    const validation = RUNNER_VALIDATION_ALLOWLIST[validationKey];
    const hasWorktreePath = (relativePath) => {
      const parts = String(relativePath || '').replaceAll('\\', '/').replace(/\/+$/, '').split('/').filter(Boolean);
      return parts.length > 0 && fs.existsSync(path.join(worktreePath, ...parts));
    };
    const validationSetup = { ...checkWorktreeValidationSetup(validationKey, hasWorktreePath, process.platform), checked: true };
    const serviceProbe = await probeHttp(OPENHANDS_URL, 1500);
    const serviceCheck = { checked: true, url: OPENHANDS_URL, ...serviceProbe };
    const dryRunReportShown = request.status === 'execution-planned' && Boolean(request.reportPath) && Boolean(request.executionPlannedAt);
    const readiness = buildOpenHandsInvocationReadiness({
      invocationEnabled: OPENHANDS_EXECUTOR_INVOCATION_ENABLED,
      toolConstraints,
      serviceCheck,
      dependencySetup: validationSetup,
      dryRunReportShown,
      postRunPatchRequiresSeparateApproval: true
    });

    // Invocation (disabled by constant → no edits made).
    const invocation = await invokeOpenHandsExecutor(toolConstraints, readiness);

    // Post-run enforcement against ACTUAL changed files in the worktree.
    const wtStatus = await runCli('git', ['-C', worktreePath, 'status', '--porcelain']);
    const changedFiles = parsePorcelainPaths(wtStatus.stdout);
    const enforcement = enforceChangedFiles(changedFiles, request);
    const hasRealDiff = changedFiles.length > 0;

    // Blocker #2: `git diff` omits untracked NEW files, so a future run that
    // creates a file would produce an incomplete patch. Mark untracked files
    // intent-to-add in the WORKTREE's own index (isolated; no commit; the main
    // repo is never touched), then `git diff --binary` so both tracked edits and
    // full new-file contents (text inline, binary as base85) are captured and
    // the patch stays re-appliable. Enforcement above already ran against the
    // real changed set, before this index touch.
    const untrackedFiles = (wtStatus.stdout || '').split('\n')
      .filter((line) => line.startsWith('??'))
      .map((line) => line.slice(2).trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
    let untrackedCaptured = 0;
    if (untrackedFiles.length) {
      const addRes = await runCli('git', ['-C', worktreePath, 'add', '-N', '--', ...untrackedFiles], { timeout: OPENHANDS_EXECUTOR_LIMITS.untrackedIntentTimeoutMs });
      if (addRes.ok) untrackedCaptured = untrackedFiles.length;
    }
    const wtDiff = await runCli('git', ['-C', worktreePath, 'diff', '--binary'], { maxBuffer: OPENHANDS_EXECUTOR_LIMITS.diffOutputMaxBytes });
    const diffLimit = summarizeExecutorCommandResult(wtDiff, { label: 'git diff --binary', outputMaxBytes: OPENHANDS_EXECUTOR_LIMITS.diffOutputMaxBytes });

    // Always persist the diff artifact so the report has a review pointer.
    // If git diff hits the explicit output limit, the report says so and the
    // preserved worktree remains the source of truth for review.
    fs.mkdirSync(OPENHANDS_REPORT_DIR, { recursive: true });
    const patchFile = path.join(OPENHANDS_REPORT_DIR, `${request.id}.patch`);
    fs.writeFileSync(patchFile, wtDiff.stdout || '', 'utf8');
    const patchRel = path.relative(root, patchFile).replaceAll('\\', '/');
    const diffPreview = limitExecutorReportText(wtDiff.stdout || '(empty)', OPENHANDS_EXECUTOR_LIMITS.diffReportPreviewMaxChars, 'diff preview');
    const untrackedNote = untrackedFiles.length
      ? `${untrackedCaptured}/${untrackedFiles.length} untracked new file(s) captured via intent-to-add`
      : 'no untracked new files';

    // Allowlisted validation only, run inside the worktree.
    let validationResult = {
      command: validationKey,
      ran: false,
      ok: null,
      setupGated: Boolean(validation && validationSetup.setupGated),
      missingDependencies: validationSetup.missing,
      limitHit: false,
      limit: '',
      resultReason: validation ? validationSetup.reason : 'not run',
      outputTruncated: false,
      output: validation ? validationSetup.reason : 'not run'
    };
    if (validation && validationSetup.ok) {
      const vr = await runCli(validation.command, validation.args, {
        cwd: worktreePath,
        timeout: OPENHANDS_EXECUTOR_LIMITS.validationTimeoutMs,
        maxBuffer: OPENHANDS_EXECUTOR_LIMITS.validationOutputMaxBytes
      });
      const validationLimit = summarizeExecutorCommandResult(vr, {
        label: validationKey,
        timeoutMs: OPENHANDS_EXECUTOR_LIMITS.validationTimeoutMs,
        outputMaxBytes: OPENHANDS_EXECUTOR_LIMITS.validationOutputMaxBytes
      });
      const validationOutput = limitExecutorReportText(vr.stdout || vr.stderr || '', OPENHANDS_EXECUTOR_LIMITS.validationReportOutputMaxChars, 'validation output');
      validationResult = {
        command: validationKey,
        ran: true,
        ok: vr.ok,
        setupGated: false,
        missingDependencies: [],
        limitHit: validationLimit.limitHit,
        limit: validationLimit.limit,
        resultReason: validationLimit.reason,
        outputTruncated: validationOutput.truncated,
        output: validationOutput.text || '(no output)'
      };
    }

    const reportLines = [
      `# OpenHands Worktree Executor Report — ${request.id}`,
      '',
      `- Title: ${request.title}`,
      `- Objective: ${request.objective}`,
      `- Requested by: ${request.requestedBy}`,
      `- Approved by: ${request.approvedBy || 'unknown'} / Execution confirmed by: ${request.executionConfirmedBy || 'unknown'}`,
      `- Run at: ${new Date().toISOString()}`,
      '',
      '## Execution isolation',
      `- Execution branch: ${execBranch}`,
      `- Base reference (pinned, read-only): ${pinnedBaseBranch}`,
      `- Base commit used for worktree: ${pinnedBaseCommit}`,
      `- Worktree path: ${worktreeRel}`,
      `- Worktree after run: ${hasRealDiff ? 'PRESERVED for human review' : 'removed (no diff to review)'}`,
      `- Touched main working tree: no`,
      `- Ran on main/master: no`,
      '',
      '## OpenHands invocation',
      `- Invoked: ${invocation.invoked ? 'yes' : 'NO'}`,
      `- Reason: ${invocation.reason}`,
      `- Model config (server-derived; request cannot override): ${openHandsExecConfig().model} @ ${openHandsExecConfig().baseUrl}, key ${openHandsExecConfig().apiKeyRef}`,
      '',
      '## Tool-level invocation constraints (preflight; no real invocation)',
      `- Status: ${toolConstraints.ok ? 'complete' : 'setup-gated'}`,
      `- Reason: ${toolConstraints.reason}`,
      toolConstraints.checks.map((g) => `- [${g.ok ? 'PASS' : 'SETUP-GATED'}] ${g.gate}: ${g.detail}`).join('\n'),
      '',
      '## Invocation readiness gate (preflight; no real invocation)',
      `- Status: ${readiness.ok ? 'ready' : 'setup-gated'}`,
      `- Reason: ${readiness.reason}`,
      readiness.checks.map((g) => `- [${g.ok ? 'PASS' : 'SETUP-GATED'}] ${g.gate}: ${g.detail}`).join('\n'),
      '',
      '## Changed files (actual, in worktree)',
      changedFiles.length ? changedFiles.map((f) => `- ${f}`).join('\n') : '- none',
      '',
      '## Path enforcement against actual changes',
      `- allowedPaths / forbiddenPaths / protected-path scan: ${enforcement.ok ? 'PASS' : 'BLOCKED'}`,
      enforcement.violations.length ? enforcement.violations.map((v) => `  - ${v}`).join('\n') : '  - no violations',
      `- maxFilesChanged: ${enforcement.changedCount}/${enforcement.maxFiles}`,
      `- Allowed file-count limit range: ${OPENHANDS_EXECUTOR_LIMITS.maxFilesChangedMin}-${OPENHANDS_EXECUTOR_LIMITS.maxFilesChangedMax}`,
      '',
      '## Diff summary',
      changedFiles.length ? `- ${changedFiles.length} file(s) changed` : '- no diff (no edits were made)',
      '',
      '## Full diff',
      `- Diff artifact written to: ${patchRel} (git diff --binary; capture limit ${OPENHANDS_EXECUTOR_LIMITS.diffOutputMaxBytes} bytes; ${untrackedNote})`,
      `- Diff capture: ${diffLimit.limitHit ? 'LIMIT HIT' : 'ok'} - ${diffLimit.reason}`,
      diffPreview.truncated
        ? `- ${diffPreview.reason}; use the .patch file and preserved worktree for review.`
        : '- The diff preview fits within the report limit.',
      '```diff',
      diffPreview.text,
      '```',
      '',
      '## Runtime / output limits',
      `- Validation timeout: ${OPENHANDS_EXECUTOR_LIMITS.validationTimeoutMs} ms`,
      `- Validation output capture limit: ${OPENHANDS_EXECUTOR_LIMITS.validationOutputMaxBytes} bytes`,
      `- Validation report output limit: ${OPENHANDS_EXECUTOR_LIMITS.validationReportOutputMaxChars} chars`,
      `- Diff capture limit: ${OPENHANDS_EXECUTOR_LIMITS.diffOutputMaxBytes} bytes`,
      `- Diff report preview limit: ${OPENHANDS_EXECUTOR_LIMITS.diffReportPreviewMaxChars} chars`,
      '',
      '## Validation output (allowlisted; run in worktree)',
      `- Command: ${validationResult.command} — ${validationResult.ran ? (validationResult.ok ? 'ok' : 'failed') : (validationResult.setupGated ? 'setup-gated' : 'not run')}`,
      `- Dependency preflight: ${validationSetup.ok ? 'ok' : 'setup-gated'} — ${validationSetup.reason}`,
      `- Runtime/output result: ${validationResult.limitHit ? 'LIMIT HIT' : 'ok'} — ${validationResult.resultReason}`,
      validationResult.outputTruncated ? `- Validation output report cap: truncated to ${OPENHANDS_EXECUTOR_LIMITS.validationReportOutputMaxChars} chars` : '- Validation output report cap: not truncated',
      '```',
      validationResult.output,
      '```',
      '',
      '## Refused / blocked actions',
      refusedActions.map((a) => `- ${a}`).join('\n'),
      '',
      '## Human next steps',
      hasRealDiff
        ? `- The worktree (${worktreeRel}) and branch (${execBranch}) are PRESERVED. Review the .patch, then use the gated Source Control panel for any commit/push/PR. The executor never commits, pushes, or merges.`
        : '- Real OpenHands invocation is OFF, so no code was edited and there is nothing to review; the worktree was removed. When invocation is later enabled and produces a diff, the worktree is preserved for review instead.',
      ''
    ];
    fs.mkdirSync(OPENHANDS_REPORT_DIR, { recursive: true });
    const reportFile = path.join(OPENHANDS_REPORT_DIR, `${request.id}.md`);
    fs.writeFileSync(reportFile, reportLines.join('\n'), 'utf8');

    request.status = 'executor-ran';
    request.executorRanAt = new Date().toISOString();
    request.openHandsInvoked = invocation.invoked;
    request.executorEnforcementOk = enforcement.ok;
    request.executorBaseBranch = pinnedBaseBranch;
    request.executorBaseCommit = pinnedBaseCommit;
    request.executorValidationCommand = validationResult.command;
    request.executorValidationRan = validationResult.ran;
    request.executorValidationOk = validationResult.ok;
    request.executorValidationSetupGated = validationResult.setupGated;
    request.executorValidationMissingDependencies = validationResult.missingDependencies;
    request.executorValidationLimitHit = validationResult.limitHit;
    request.executorValidationLimit = validationResult.limit;
    request.executorValidationResultReason = validationResult.resultReason;
    request.executorLimits = OPENHANDS_EXECUTOR_LIMITS;
    request.executorDiffLimitHit = diffLimit.limitHit;
    request.executorDiffResultReason = diffLimit.reason;
    request.executorToolConstraintsOk = toolConstraints.ok;
    request.executorToolConstraintsReason = toolConstraints.reason;
    request.executorToolConstraints = toolConstraints.constraints;
    request.executorInvocationReadinessOk = readiness.ok;
    request.executorInvocationReadinessReason = readiness.reason;
    request.reportPath = path.relative(root, reportFile).replaceAll('\\', '/');
    request.patchPath = patchRel;
    request.worktreePreserved = hasRealDiff;
    fs.writeFileSync(file, JSON.stringify(request, null, 2), 'utf8');

    // Blocker #1: teardown BEFORE responding, but PRESERVE the worktree/branch
    // whenever a real diff exists so a human can review the actual edits in place
    // (the full .patch alone is not a substitute for the working tree). With
    // invocation OFF the diff is empty, so the worktree is removed to keep the
    // repo clean. The branch is never auto-deleted either way.
    let worktreeRemoved = false;
    if (hasRealDiff) {
      // Preserve: neither the teardown nor the error-path net removes it.
      worktreeCreated = false;
    } else {
      const removed = await runCli('git', ['worktree', 'remove', '--force', worktreePath], { timeout: OPENHANDS_EXECUTOR_LIMITS.worktreeRemoveTimeoutMs });
      await runCli('git', ['worktree', 'prune']);
      worktreeRemoved = removed.ok;
      worktreeCreated = false;
    }

    ok(res, {
      worktreeRemoved,
      worktreePreserved: hasRealDiff,
      request,
      invocationEnabled: OPENHANDS_EXECUTOR_INVOCATION_ENABLED,
      openHandsInvoked: invocation.invoked,
      toolConstraints,
      invocationReadiness: readiness,
      executionBranch: execBranch,
      baseBranch: pinnedBaseBranch,
      baseCommit: pinnedBaseCommit,
      worktreePath: worktreeRel,
      changedFiles,
      enforcement,
      validation: validationResult,
      limits: OPENHANDS_EXECUTOR_LIMITS,
      diffLimit,
      reportPath: request.reportPath,
      patchPath: patchRel,
      untrackedCaptured,
      untrackedFiles: untrackedFiles.length,
      refusedActions,
      message: hasRealDiff
        ? `Executor harness ran in an isolated worktree from pinned base ${pinnedBaseBranch}@${pinnedBaseCommit.slice(0, 12)}. A diff exists, so the worktree (${worktreeRel}) and branch ${execBranch} are PRESERVED for human review; the full diff is at ${patchRel}. Nothing was committed, pushed, or merged.`
        : `Executor harness ran in an isolated worktree from pinned base ${pinnedBaseBranch}@${pinnedBaseCommit.slice(0, 12)}. Real OpenHands invocation is DISABLED, so no code was edited; the worktree was removed and branch ${execBranch} left in place (never auto-deleted). Full (empty) diff written to ${patchRel}. ${validationResult.setupGated ? validationSetup.reason : 'Allowlisted validation setup was checked.'} Nothing was committed, pushed, or merged.`
    });
  } catch (error) {
    fail(res, 500, `Executor harness error: ${error.message}`);
  } finally {
    // Error-path safety net: if teardown did not already run (an error was
    // thrown before it), remove the throwaway worktree. Never deletes a branch.
    if (worktreeCreated) {
      await runCli('git', ['worktree', 'remove', '--force', worktreePath], { timeout: OPENHANDS_EXECUTOR_LIMITS.worktreeRemoveTimeoutMs });
      await runCli('git', ['worktree', 'prune']);
    }
  }
});

app.get('/api/source/status', async (_req, res) => {
  const [inside, snapshot, remotes, log, userName, userEmail, ghStatus, hfWhoami, wingetStatus, publication] = await Promise.all([
    runCli('git', ['rev-parse', '--is-inside-work-tree']),
    gitStatusSnapshot(),
    runCli('git', ['remote', '-v']),
    runCli('git', ['log', '--oneline', '--decorate', '-n', '8']),
    runCli('git', ['config', 'user.name']),
    runCli('git', ['config', 'user.email']),
    runCli('gh', ['auth', 'status']),
    runCli('hf', ['auth', 'whoami']),
    runCli('winget', ['--version']),
    sourcePublicationBoundary()
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
    remoteList: parseRemotes(remotes.stdout),
    publication,
    log: log.stdout,
    user: {
      name: userName.stdout,
      email: userEmail.stdout
    },
    github: {
      cliAvailable: ghStatus.available,
      authenticated: ghStatus.ok,
      tokenConfigured: githubTokenConfigured(),
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
  const status = await runCli('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    preserveOutput: true,
    maxBuffer: 2 * 1024 * 1024
  });
  if (!status.ok) return fail(res, 409, status.stderr || 'Unable to inspect changed paths safely.');
  const changedFiles = parsePorcelainStatus(status.stdout);
  const protectedFiles = changedFiles.filter((file) => file.protected);
  if (protectedFiles.length) {
    return ok(res, {
      stat: '',
      detail: '',
      truncated: false,
      protectedOmitted: protectedFiles.length,
      note: 'General diff hidden because protected/private files changed. Review safe files individually.'
    });
  }
  const changedPaths = changedFiles.filter((file) => file.status !== '??').map((file) => file.path);
  if (!changedPaths.length) return ok(res, { stat: '', detail: '', truncated: false, protectedOmitted: 0, note: '' });
  const diffArgs = ['diff', 'HEAD', '--', ...changedPaths];
  const stat = await runCli('git', ['diff', '--stat', 'HEAD', '--', ...changedPaths], { maxBuffer: 2 * 1024 * 1024 });
  const detail = await runCli('git', diffArgs, { maxBuffer: 4 * 1024 * 1024 });
  if (!detail.ok) return fail(res, 409, detail.stderr || 'Unable to render the safe diff.');
  ok(res, { stat: stat.stdout, detail: detail.stdout.slice(0, 50000), truncated: detail.stdout.length > 50000, protectedOmitted: 0, note: '' });
});

app.get('/api/source/publication-check', async (_req, res) => {
  const boundary = await sourcePublicationBoundary();
  if (!boundary.allowed) return ok(res, { allowed: false, boundary, scan: null, reason: boundary.reason });
  const scan = await scanPublicationTarget('HEAD');
  ok(res, {
    allowed: scan.allowed,
    boundary,
    scan,
    reason: scan.reason
  });
});

app.get('/api/source/build-installer', async (_req, res) => {
  ok(res, installerBuildSnapshot());
});

app.post('/api/source/build-installer', async (_req, res) => {
  const snapshot = await gitStatusSnapshot();
  if (snapshot.hasConflicts) return fail(res, 409, `Resolve conflicts before building an installer: ${snapshot.conflictFiles.join(', ')}`);
  if (snapshot.changedFiles.length) return fail(res, 409, 'Commit or stash all source changes before building an installer. Release artifacts must correspond to a clean commit.');
  ok(res, startInstallerBuild());
});

// Per-file side-by-side diff: committed (HEAD) content vs current working-tree
// content, so the UI can render two columns. Read-only, workspace-confined, and
// protected/private files are refused rather than leaked.
const FILE_DIFF_MAX_BYTES = 400000;

function looksBinary(text) {
  return text.includes('\0');
}

app.get('/api/source/file-diff', async (req, res) => {
  try {
    const target = safeWorkspacePath(req.query.path);
    if (isProtectedWorkspacePath(target.normalized)) {
      return fail(res, 403, `Protected/private file cannot be diffed here: ${target.normalized}`);
    }

    const snapshot = await gitStatusSnapshot();
    const statusEntry = snapshot.changedFiles.find((file) => file.path === target.normalized);
    const originalPath = statusEntry?.originalPath || target.normalized;
    if (isProtectedWorkspacePath(originalPath)) {
      return fail(res, 403, `Protected/private original file cannot be diffed here: ${originalPath}`);
    }

    // OLD side: content at HEAD. Renames read from their original path.
    const head = await runCli('git', ['show', `HEAD:${originalPath}`], { maxBuffer: 8 * 1024 * 1024 });
    const oldContent = head.ok ? head.stdout : '';
    const inHead = head.ok;

    // NEW side: current working-tree file. Missing (deleted) -> empty.
    let newContent = '';
    let existsNow = false;
    if (fs.existsSync(target.absolute) && fs.statSync(target.absolute).isFile()) {
      existsNow = true;
      newContent = fs.readFileSync(target.absolute, 'utf8');
    }

    const binary = looksBinary(oldContent) || looksBinary(newContent);
    const oldTooLarge = oldContent.length > FILE_DIFF_MAX_BYTES;
    const newTooLarge = newContent.length > FILE_DIFF_MAX_BYTES;
    const changeType = !inHead ? 'added' : !existsNow ? 'deleted' : 'modified';

    ok(res, {
      path: target.normalized,
      originalPath: statusEntry?.originalPath || '',
      changeType,
      binary,
      tooLarge: oldTooLarge || newTooLarge,
      oldContent: binary || oldTooLarge ? '' : oldContent,
      newContent: binary || newTooLarge ? '' : newContent,
      note: binary
        ? 'Binary file: side-by-side text diff is not shown.'
        : (oldTooLarge || newTooLarge)
          ? 'File is large; side-by-side text diff was skipped to stay responsive.'
          : ''
    });
  } catch (error) {
    fail(res, 400, error.message);
  }
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
  const names = await runCli('git', ['remote']);
  if (!names.ok) return fail(res, 500, names.stderr || 'Unable to list git remotes.');
  const remotes = names.stdout.split('\n').map((name) => name.trim()).filter(Boolean);
  if (!remotes.length) return fail(res, 400, 'No git remotes are configured.');
  const token = getSetting('githubToken', '');
  const outputs = [];
  for (const remote of remotes) {
    const remoteUrl = (await runCli('git', ['remote', 'get-url', remote])).stdout;
    const result = await runCli('git', ['fetch', remote, '--prune'], {
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      env: gitAskPassEnvironment(remoteUrl, token)
    });
    outputs.push(`[${remote}] ${result.stdout || result.stderr || 'Fetch complete.'}`);
    if (!result.ok) return fail(res, 500, outputs.join('\n'));
  }
  ok(res, {
    output: outputs.join('\n'),
    status: (await runCli('git', ['status', '--short', '--branch'])).stdout
  });
});

app.post('/api/source/pull', async (_req, res) => {
  const branch = await runCli('git', ['branch', '--show-current']);
  const branchName = branch.stdout.trim();
  if (!branchName) return fail(res, 400, 'Cannot pull from detached HEAD.');
  const upstream = await runCli('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const remoteName = upstream.ok && upstream.stdout.includes('/') ? upstream.stdout.split('/')[0] : 'origin';
  const remoteUrl = (await runCli('git', ['remote', 'get-url', remoteName])).stdout;
  if (!remoteUrl) return fail(res, 400, `No ${remoteName} remote is configured for ${branchName}.`);
  const args = upstream.ok ? ['pull', '--ff-only'] : ['pull', '--ff-only', remoteName, branchName];
  const result = await runCli('git', args, {
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: gitAskPassEnvironment(remoteUrl, getSetting('githubToken', ''))
  });
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
  const branch = safeGitRef(req.body.branch);
  if (!branch) return fail(res, 400, 'Invalid branch name. Use letters, numbers, and . _ / - (not starting with a dash).');
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
  const branch = safeGitRef(req.body.branch);
  if (!branch) return fail(res, 400, 'Invalid branch name.');
  const snapshot = await gitStatusSnapshot();
  if (snapshot.hasConflicts) return fail(res, 409, `Resolve conflicts before switching branches: ${snapshot.conflictFiles.join(', ')}`);
  if (snapshot.changedFiles.length && !req.body.allowDirty) return fail(res, 409, 'Working tree has changes. Commit, stash, or explicitly allow dirty branch switch.');
  const result = await runCli('git', ['switch', branch]);
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git switch failed');
  ok(res, { branch, output: result.stdout || result.stderr, status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
});

app.post('/api/source/checkout-remote', async (req, res) => {
  const remoteBranch = safeGitRef(req.body.branch);
  if (!remoteBranch || !remoteBranch.includes('/')) return fail(res, 400, 'Choose a remote branch such as origin/feature-name.');
  const [remote, ...branchParts] = remoteBranch.split('/');
  const localBranch = safeGitRef(req.body.localBranch || branchParts.join('/'));
  if (!safeGitRef(remote) || !localBranch) return fail(res, 400, 'Remote or local branch name is invalid.');
  const snapshot = await gitStatusSnapshot();
  if (snapshot.hasConflicts) return fail(res, 409, `Resolve conflicts before switching branches: ${snapshot.conflictFiles.join(', ')}`);
  if (snapshot.changedFiles.length) return fail(res, 409, 'Commit or stash working-tree changes before tracking a remote branch.');
  const verify = await runCli('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteBranch}`]);
  if (!verify.ok) return fail(res, 404, `Remote branch ${remoteBranch} was not found. Fetch remotes first.`);
  const existing = await runCli('git', ['show-ref', '--verify', '--quiet', `refs/heads/${localBranch}`]);
  const args = existing.ok ? ['switch', localBranch] : ['switch', '--track', '-c', localBranch, remoteBranch];
  const result = await runCli('git', args);
  if (!result.ok) return fail(res, 409, result.stderr || result.stdout || 'Unable to track remote branch.');
  ok(res, { branch: localBranch, upstream: remoteBranch, output: result.stdout || result.stderr, status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
});

// Push is deliberately narrow: current branch -> origin only, never forced,
// never main/master, and never without explicit confirmation from the UI.
const PROTECTED_PUSH_BRANCHES = ['main', 'master'];

app.post('/api/source/push', async (req, res) => {
  const branch = await runCli('git', ['branch', '--show-current']);
  const branchName = (branch.stdout || '').trim();
  if (!branchName) return fail(res, 400, 'Cannot push from detached HEAD.');
  if (PROTECTED_PUSH_BRANCHES.includes(branchName.toLowerCase())) {
    if (req.body?.confirmProtectedBranch !== branchName) {
      return fail(res, 428, `Pushing protected branch "${branchName}" requires a second branch-bound confirmation.`);
    }
  }
  if (req.body?.force) {
    return fail(res, 403, 'Force push is not supported from Life Planner.');
  }
  if (req.body?.confirm !== true) {
    return fail(res, 428, `Push needs explicit confirmation. Confirm to run: git push -u origin ${branchName} (no force flags).`);
  }
  const publication = await sourcePublicationBoundary();
  if (!publication.allowed) return fail(res, 403, publication.reason);
  const publicationScan = await scanPublicationTarget('HEAD');
  if (!publicationScan.allowed) return fail(res, 403, publicationScan.reason);
  // Prefer the stored PAT only for a verified HTTPS github.com origin so a push works even
  // when no credential helper or gh login is present. The token is passed on the
  // command line only for this one invocation, never persisted into the remote.
  const token = getSetting('githubToken', '');
  const originUrl = (await runCli('git', ['remote', 'get-url', 'origin'])).stdout;
  const useToken = token && canUseGitHubToken(originUrl);
  const pushArgs = ['push', '-u', 'origin', branchName];
  const result = await runCli('git', pushArgs, {
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: gitAskPassEnvironment(originUrl, token)
  });
  if (!result.ok) {
    // Scrub the token from any error text before returning it to the client.
    const scrub = (text) => token ? String(text || '').split(token).join('***') : text;
    return fail(res, 500, scrub(result.stderr || result.stdout || 'git push failed'));
  }
  ok(res, { remote: 'origin', branch: branchName, authenticated: Boolean(useToken), output: result.stdout || result.stderr });
});

app.post('/api/source/remote', async (req, res) => {
  const url = safeGitUrl(req.body.url);
  const name = req.body.name ? safeGitRef(req.body.name) : 'origin';
  if (!url) return fail(res, 400, 'Use an approved github.com or huggingface.co HTTPS/SSH repository URL without embedded credentials.');
  if (!name) return fail(res, 400, 'Invalid remote name.');
  const existing = await runCli('git', ['remote', 'get-url', name]);
  if (existing.ok && req.body?.confirm !== true) {
    return fail(res, 428, `Replacing remote "${name}" changes future fetch, pull, and push targets and requires explicit confirmation.`);
  }
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
  const createPublic = req.body.visibility === 'public';
  if (createPublic && req.body.confirmPublic !== true) return fail(res, 428, 'Public repository creation requires explicit confirmation.');
  const visibility = createPublic ? '--public' : '--private';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return fail(res, 400, 'Use owner/repo format, for example username/life-planner-app.');
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
  const createPublic = req.body.visibility === 'public';
  if (createPublic && req.body.confirmPublic !== true) return fail(res, 428, 'Public repository creation requires explicit confirmation.');
  const visibility = createPublic ? '' : '--private';
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

// GitHub Personal Access Token: encrypted with current-user Windows DPAPI,
// redacted on read, and supplied to Git through ephemeral AskPass transport.
const GITHUB_PAT_PREFIXES = ['ghp_', 'github_pat_'];

function githubTokenConfigured() {
  return Boolean(getSetting('githubToken', ''));
}

app.post('/api/source/token', (req, res) => {
  const token = String(req.body.token || '').trim();
  if (!token) return fail(res, 400, 'A GitHub Personal Access Token is required.');
  if (!GITHUB_PAT_PREFIXES.some((prefix) => token.toLowerCase().startsWith(prefix))) {
    return fail(res, 400, 'Token should start with github_pat_ (fine-grained) or ghp_ (classic).');
  }
  setSetting('githubToken', token);
  ok(res, { configured: true, message: 'GitHub token saved. It is used only for authenticated pushes and never stored in the git remote.' });
});

app.post('/api/source/token/clear', (_req, res) => {
  setSetting('githubToken', '');
  ok(res, { configured: false, message: 'GitHub token cleared.' });
});

app.post('/api/source/rebase', async (req, res) => {
  if (req.body?.confirm !== true) return fail(res, 428, 'Rebase rewrites local commit history and requires explicit confirmation.');
  const branch = await runCli('git', ['branch', '--show-current']);
  const branchName = (branch.stdout || '').trim();
  if (!branchName) return fail(res, 400, 'Cannot rebase from detached HEAD.');
  const upstream = await runCli('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const remoteName = upstream.ok && upstream.stdout.includes('/') ? upstream.stdout.split('/')[0] : 'origin';
  const remoteUrl = (await runCli('git', ['remote', 'get-url', remoteName])).stdout;
  if (!remoteUrl) return fail(res, 400, `No ${remoteName} remote is configured for ${branchName}.`);
  const args = upstream.ok ? ['pull', '--rebase'] : ['pull', '--rebase', remoteName, branchName];
  const result = await runCli('git', args, {
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: gitAskPassEnvironment(remoteUrl, getSetting('githubToken', ''))
  });
  const snapshot = await gitStatusSnapshot();
  if (!result.ok && !snapshot.hasConflicts) return fail(res, 409, result.stderr || result.stdout || 'git pull --rebase failed');
  ok(res, {
    output: result.stdout || result.stderr || 'Rebase complete.',
    hasConflicts: snapshot.hasConflicts,
    conflictFiles: snapshot.conflictFiles,
    status: snapshot.status
  });
});

app.post('/api/source/merge', async (req, res) => {
  if (req.body?.confirm !== true) return fail(res, 428, 'Merging changes the current branch and requires explicit confirmation.');
  const branch = safeGitRef(req.body.branch);
  if (!branch) return fail(res, 400, 'Invalid branch name to merge.');
  const current = await runCli('git', ['branch', '--show-current']);
  if (branch === (current.stdout || '').trim()) return fail(res, 400, 'Cannot merge a branch into itself.');
  const result = await runCli('git', ['merge', '--no-edit', branch], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  const snapshot = await gitStatusSnapshot();
  if (!result.ok && !snapshot.hasConflicts) return fail(res, 409, result.stderr || result.stdout || 'git merge failed');
  ok(res, {
    branch,
    output: result.stdout || result.stderr || `Merged ${branch}.`,
    hasConflicts: snapshot.hasConflicts,
    conflictFiles: snapshot.conflictFiles,
    status: snapshot.status
  });
});

app.post('/api/source/abort-merge', async (_req, res) => {
  // Works for both a conflicted merge and a conflicted rebase.
  let result = await runCli('git', ['merge', '--abort']);
  if (!result.ok) {
    const rebaseAbort = await runCli('git', ['rebase', '--abort']);
    if (rebaseAbort.ok) result = rebaseAbort;
  }
  if (!result.ok) return fail(res, 409, result.stderr || result.stdout || 'Nothing to abort (no merge or rebase in progress).');
  ok(res, { output: result.stdout || result.stderr || 'Aborted in-progress merge/rebase.', status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
});

app.post('/api/source/delete-branch', async (req, res) => {
  const branch = safeGitRef(req.body.branch);
  if (!branch) return fail(res, 400, 'Invalid branch name.');
  if (['main', 'master'].includes(branch.toLowerCase())) return fail(res, 403, `Refusing to delete protected branch "${branch}".`);
  const current = await runCli('git', ['branch', '--show-current']);
  if (branch === (current.stdout || '').trim()) return fail(res, 409, 'Cannot delete the branch you are currently on. Switch first.');
  if (req.body.force && req.body?.confirm !== true) return fail(res, 428, `Force-deleting branch "${branch}" requires explicit confirmation.`);
  const flag = req.body.force ? '-D' : '-d';
  const result = await runCli('git', ['branch', flag, branch]);
  if (!result.ok) {
    if (!req.body.force && /not fully merged/i.test(result.stderr || result.stdout || '')) {
      return fail(res, 409, `Branch "${branch}" is not fully merged. Re-run with force to delete it anyway.`);
    }
    return fail(res, 500, result.stderr || result.stdout || 'git branch delete failed');
  }
  ok(res, { branch, output: result.stdout || result.stderr || `Deleted branch ${branch}.` });
});

app.post('/api/source/discard-file', async (req, res) => {
  try {
    const target = safeWorkspacePath(req.body.path);
    if (isProtectedWorkspacePath(target.normalized)) return fail(res, 409, `Protected/private file cannot be discarded here: ${target.normalized}`);
    // Untracked files have nothing to restore from; git restore is a no-op there.
    const tracked = await runCli('git', ['ls-files', '--error-unmatch', '--', target.normalized]);
    if (!tracked.ok) return fail(res, 400, `"${target.normalized}" is untracked; delete it manually if unwanted.`);
    const result = await runCli('git', ['restore', '--worktree', '--', target.normalized]);
    if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git restore failed');
    ok(res, { path: target.normalized, status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.get('/api/source/history', async (_req, res) => {
  const limit = 40;
  const sep = '\x1f';
  const result = await runCli('git', ['log', `--pretty=format:%h${sep}%s${sep}%an${sep}%ar${sep}%D`, '--decorate', '-n', String(limit)], { maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) return ok(res, { commits: [] });
  const commits = result.stdout.split('\n').filter(Boolean).map((line) => {
    const [shortHash, subject, author, relative, decorations] = line.split(sep);
    const refs = (decorations || '').split(',').map((ref) => ref.replace(/^\s*HEAD ->\s*/, '').trim()).filter(Boolean);
    return { shortHash, subject, author, relative, refs };
  });
  ok(res, { commits });
});

// --- Stash ------------------------------------------------------------------
app.get('/api/source/stash', async (_req, res) => {
  const result = await runCli('git', ['stash', 'list', '--pretty=format:%gd%x1f%s']);
  const entries = result.ok && result.stdout
    ? result.stdout.split('\n').filter(Boolean).map((line, index) => {
      const [ref, subject] = line.split('\x1f');
      return { index, ref: ref || `stash@{${index}}`, subject: subject || '' };
    })
    : [];
  ok(res, { entries });
});

app.post('/api/source/stash', async (req, res) => {
  const message = String(req.body.message || '').trim();
  const args = ['stash', 'push'];
  if (req.body.includeUntracked) args.push('--include-untracked');
  if (message) args.push('-m', message);
  const result = await runCli('git', args, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git stash failed');
  if (/no local changes to save/i.test(result.stdout)) return fail(res, 400, 'No local changes to stash.');
  ok(res, { output: result.stdout || result.stderr || 'Changes stashed.', status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
});

app.post('/api/source/stash/apply', async (req, res) => {
  const index = Number.isInteger(req.body.index) ? req.body.index : 0;
  const subcommand = req.body.pop ? 'pop' : 'apply';
  if (req.body.pop && req.body?.confirm !== true) return fail(res, 428, `Popping stash@{${index}} removes it after apply and requires explicit confirmation.`);
  const result = await runCli('git', ['stash', subcommand, `stash@{${index}}`], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  const snapshot = await gitStatusSnapshot();
  if (!result.ok && !snapshot.hasConflicts) return fail(res, 409, result.stderr || result.stdout || `git stash ${subcommand} failed`);
  ok(res, { output: result.stdout || result.stderr || `Stash ${subcommand} complete.`, hasConflicts: snapshot.hasConflicts, conflictFiles: snapshot.conflictFiles });
});

app.post('/api/source/stash/drop', async (req, res) => {
  const index = Number.isInteger(req.body.index) ? req.body.index : 0;
  if (req.body?.confirm !== true) return fail(res, 428, `Dropping stash@{${index}} is destructive and requires explicit confirmation.`);
  const result = await runCli('git', ['stash', 'drop', `stash@{${index}}`]);
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git stash drop failed');
  ok(res, { output: result.stdout || result.stderr || 'Stash dropped.' });
});

// --- Discard all tracked working-tree changes -------------------------------
// Destructive: needs explicit confirm. Restores tracked files to HEAD/index;
// untracked files are left alone (never auto-deleted from here).
app.post('/api/source/discard-all', async (req, res) => {
  if (req.body?.confirm !== true) {
    return fail(res, 428, 'Discarding all working-tree changes is destructive. Confirm to run: git restore --worktree -- . (untracked files are left untouched).');
  }
  const snapshot = await gitStatusSnapshot();
  if (snapshot.hasConflicts) return fail(res, 409, 'Resolve or abort the conflict first; discard-all will not run mid-merge.');
  const result = await runCli('git', ['restore', '--worktree', '--', '.']);
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git restore failed');
  ok(res, { output: 'Discarded all tracked working-tree changes.', status: (await runCli('git', ['status', '--short', '--branch'])).stdout });
});

// --- In-app conflict resolution ---------------------------------------------
// Resolve one conflicted file by taking a whole side, or mark it resolved after
// a manual edit. All three end by staging the file so the merge can proceed.
app.post('/api/source/resolve', async (req, res) => {
  try {
    const target = safeWorkspacePath(req.body.path);
    if (isProtectedWorkspacePath(target.normalized)) {
      return fail(res, 403, `Protected/private conflict cannot be resolved from the Source panel: ${target.normalized}`);
    }
    const snapshot = await gitStatusSnapshot();
    if (!snapshot.conflictFiles.includes(target.normalized)) {
      return fail(res, 409, `"${target.normalized}" is not a conflicted file.`);
    }
    const side = req.body.side;
    if (side === 'ours' || side === 'theirs') {
      const checkout = await runCli('git', ['checkout', `--${side}`, '--', target.normalized]);
      if (!checkout.ok) return fail(res, 500, checkout.stderr || checkout.stdout || `git checkout --${side} failed`);
    } else if (side !== 'mark') {
      return fail(res, 400, "side must be 'ours', 'theirs', or 'mark' (stage the current file contents as resolved).");
    }
    const add = await runCli('git', ['add', '--', target.normalized]);
    if (!add.ok) return fail(res, 500, add.stderr || add.stdout || 'git add failed');
    const after = await gitStatusSnapshot();
    ok(res, {
      path: target.normalized,
      resolved: side,
      remainingConflicts: after.conflictFiles,
      hasConflicts: after.hasConflicts,
      status: after.status
    });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

// --- Tags -------------------------------------------------------------------
app.get('/api/source/tags', async (_req, res) => {
  // for-each-ref does not interpret %x1f (that is a git-log token); embed the
  // actual unit-separator character in the format string instead.
  const sep = '\x1f';
  const result = await runCli('git', ['for-each-ref', '--sort=-creatordate', `--format=%(refname:short)${sep}%(objecttype)${sep}%(contents:subject)`, 'refs/tags'], { maxBuffer: 2 * 1024 * 1024 });
  const tags = result.ok && result.stdout
    ? result.stdout.split('\n').filter(Boolean).map((line) => {
      const [name, objecttype, subject] = line.split(sep);
      return { name, annotated: objecttype === 'tag', subject: subject || '' };
    })
    : [];
  ok(res, { tags });
});

app.post('/api/source/tags', async (req, res) => {
  const name = safeGitRef(req.body.name);
  if (!name) return fail(res, 400, 'Invalid tag name. Use letters, numbers, and . _ / - (not starting with a dash).');
  const message = String(req.body.message || '').trim();
  const refArg = req.body.ref ? safeGitRef(req.body.ref) : '';
  if (req.body.ref && !refArg) return fail(res, 400, 'Invalid target ref for the tag.');
  const args = message ? ['tag', '-a', name, '-m', message] : ['tag', name];
  if (refArg) args.push(refArg);
  const result = await runCli('git', args);
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git tag failed');
  ok(res, { name, output: result.stdout || result.stderr || `Created tag ${name}.` });
});

app.post('/api/source/tags/delete', async (req, res) => {
  const name = safeGitRef(req.body.name);
  if (!name) return fail(res, 400, 'Invalid tag name.');
  const result = await runCli('git', ['tag', '-d', name]);
  if (!result.ok) return fail(res, 500, result.stderr || result.stdout || 'git tag -d failed');
  ok(res, { name, output: result.stdout || result.stderr || `Deleted tag ${name}.` });
});

// Pushing a tag publishes to origin; gate it behind explicit confirmation, and
// reuse the stored PAT for HTTPS origins the same way branch push does.
app.post('/api/source/tags/push', async (req, res) => {
  const name = safeGitRef(req.body.name);
  if (!name) return fail(res, 400, 'Invalid tag name.');
  if (req.body?.confirm !== true) {
    return fail(res, 428, `Pushing tag "${name}" publishes it to origin. Confirm to run: git push origin ${name}.`);
  }
  const publication = await sourcePublicationBoundary();
  if (!publication.allowed) return fail(res, 403, publication.reason);
  const publicationScan = await scanPublicationTarget(name);
  if (!publicationScan.allowed) return fail(res, 403, publicationScan.reason);
  const token = getSetting('githubToken', '');
  const originUrl = (await runCli('git', ['remote', 'get-url', 'origin'])).stdout;
  const useToken = token && canUseGitHubToken(originUrl);
  const result = await runCli('git', ['push', 'origin', `refs/tags/${name}`], {
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: gitAskPassEnvironment(originUrl, token)
  });
  if (!result.ok) {
    const scrub = (text) => token ? String(text || '').split(token).join('***') : text;
    return fail(res, 500, scrub(result.stderr || result.stdout || 'git push tag failed'));
  }
  ok(res, { name, authenticated: Boolean(useToken), output: result.stdout || result.stderr || `Pushed tag ${name} to origin.` });
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

function publicSettings() {
  return readSettingsRedacted();
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

const EXPORT_SCOPES = new Set(['all', 'projects', 'knowledge', 'roadmap', 'chat']);

function requestedExportScope(req) {
  const scope = String(req.query.scope || 'all').toLowerCase();
  if (!EXPORT_SCOPES.has(scope)) throw new Error(`Supported export scopes: ${[...EXPORT_SCOPES].join(', ')}.`);
  return scope;
}

function buildLifePlannerExport(scope = 'all') {
  const include = (name) => scope === 'all' || scope === name;
  const data = { format: 'life-planner-portable-context', version: 1, exported_at: new Date().toISOString(), scope };
  if (include('projects')) data.projects = allRows('SELECT * FROM projects ORDER BY name');
  if (include('knowledge')) data.knowledge_items = allRows('SELECT * FROM knowledge_items ORDER BY type, title');
  if (include('roadmap')) data.roadmap_items = allRows('SELECT * FROM roadmap_items ORDER BY sort_order, id');
  if (include('chat')) {
    data.chat_sessions = allRows('SELECT * FROM chat_sessions WHERE deleted = 0 ORDER BY updated_at DESC');
    data.chat_messages = allRows('SELECT * FROM chat_messages ORDER BY session_id, created_at, id');
  }
  return data;
}

function exportSections(data) {
  const sections = [];
  for (const [name, records] of Object.entries(data)) {
    if (!Array.isArray(records)) continue;
    sections.push({ name, title: name.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), records });
  }
  return sections;
}

function exportAsMarkdown(data) {
  const lines = ['# Life Planner Context Export', '', `Exported: ${data.exported_at}`, `Scope: ${data.scope}`, 'Format: life-planner-portable-context/v1', ''];
  for (const section of exportSections(data)) {
    lines.push(`## ${section.title}`, '');
    if (!section.records.length) lines.push('_No records._', '');
    for (const [index, record] of section.records.entries()) {
      const heading = record.title || record.name || record.subject || `${section.title} ${index + 1}`;
      lines.push(`### ${String(heading).replaceAll('\n', ' ')}`, '');
      for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined || value === '') continue;
        const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
        lines.push(`- **${key.replaceAll('_', ' ')}:** ${rendered.replaceAll('\n', '\n  ')}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function exportAsInteractiveHtml(data) {
  const sections = exportSections(data).map((section) => `
    <section data-section="${escapeHtml(section.name)}">
      <h2>${escapeHtml(section.title)} <span>${section.records.length}</span></h2>
      <div class="records">${section.records.map((record, index) => {
        const heading = record.title || record.name || record.subject || `${section.title} ${index + 1}`;
        const search = JSON.stringify(record).toLowerCase();
        return `<article data-search="${escapeHtml(search)}"><h3>${escapeHtml(heading)}</h3><dl>${Object.entries(record).filter(([, value]) => value !== null && value !== '').map(([key, value]) => `<dt>${escapeHtml(key.replaceAll('_', ' '))}</dt><dd>${escapeHtml(typeof value === 'object' ? JSON.stringify(value, null, 2) : value)}</dd>`).join('')}</dl></article>`;
      }).join('')}</div>
    </section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Life Planner Context</title><style>
  :root{--ink:#17211d;--paper:#f6f0e4;--accent:#cb4b16;--line:#c9bea9}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#eee4d2,#faf7ef);color:var(--ink);font:16px Georgia,serif}header{padding:3rem clamp(1rem,5vw,5rem);background:#17352d;color:#fff}header h1{font-size:clamp(2rem,6vw,4.5rem);margin:0}header p{max-width:70ch}.tools{position:sticky;top:0;padding:1rem clamp(1rem,5vw,5rem);background:#f6f0e4ee;border-bottom:1px solid var(--line);backdrop-filter:blur(10px)}input{width:min(720px,100%);padding:.8rem 1rem;border:2px solid #17352d;background:#fff;font:inherit}main{padding:2rem clamp(1rem,5vw,5rem)}section{margin:0 0 3rem}h2{font-size:2rem;border-bottom:3px solid var(--accent);padding-bottom:.35rem}h2 span{font:1rem sans-serif;background:var(--accent);color:#fff;padding:.2rem .5rem}article{background:#fff;border:1px solid var(--line);border-left:6px solid #17352d;padding:1rem 1.25rem;margin:1rem 0;box-shadow:0 5px 18px #3b30251a}dt{font:700 .75rem sans-serif;text-transform:uppercase;letter-spacing:.08em;color:#765}dd{white-space:pre-wrap;margin:.2rem 0 1rem;overflow-wrap:anywhere}.hidden{display:none}@media print{.tools{display:none}body{background:#fff}header{padding:1rem 0;background:#fff;color:#000}main{padding:0}article{break-inside:avoid;box-shadow:none}}
  </style></head><body><header><h1>Life Planner Context</h1><p>Portable, searchable export. Generated ${escapeHtml(data.exported_at)}. Scope: ${escapeHtml(data.scope)}. This artifact is a snapshot; SQLite remains canonical.</p></header><div class="tools"><label for="search">Search this export</label><br><input id="search" type="search" placeholder="Type to filter records" autofocus></div><main>${sections}</main><script>const q=document.querySelector('#search');q.addEventListener('input',()=>{const v=q.value.toLowerCase().trim();document.querySelectorAll('article').forEach(x=>x.classList.toggle('hidden',v&&!x.dataset.search.includes(v)));document.querySelectorAll('section').forEach(x=>x.classList.toggle('hidden',![...x.querySelectorAll('article')].some(a=>!a.classList.contains('hidden'))));});</script></body></html>`;
}

app.get('/api/export/context.:format', async (req, res) => {
  let scope;
  try { scope = requestedExportScope(req); } catch (error) { return fail(res, 400, error.message); }
  const format = String(req.params.format || '').toLowerCase();
  const data = buildLifePlannerExport(scope);
  const baseName = `life-planner-${scope}-context`;
  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.json"`);
    return res.json(data);
  }
  const markdown = exportAsMarkdown(data);
  if (format === 'md' || format === 'txt') {
    res.setHeader('Content-Type', `${format === 'md' ? 'text/markdown' : 'text/plain'}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.${format}"`);
    return res.send(markdown);
  }
  const html = exportAsInteractiveHtml(data);
  if (format === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.html"`);
    return res.send(html);
  }
  if (format !== 'pdf') return fail(res, 400, 'Supported formats: json, md, txt, html, pdf.');
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('**/*', (route) => route.request().url() === 'about:blank' ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
    return res.send(pdf);
  } catch (error) {
    return fail(res, 503, `PDF rendering failed: ${error.message}. Install Playwright Chromium from Tooling and retry.`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.post('/api/import/pdf', async (req, res) => {
  const name = path.basename(String(req.body.name || 'Imported document.pdf'));
  const base64 = String(req.body.base64 || '');
  if (!base64) return fail(res, 400, 'PDF data is required.');
  let bytes;
  try { bytes = Buffer.from(base64, 'base64'); } catch { return fail(res, 400, 'PDF data is not valid base64.'); }
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return fail(res, 400, 'The selected file is not a PDF.');
  if (bytes.length > 15 * 1024 * 1024) return fail(res, 413, 'PDF imports are limited to 15 MB.');
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(bytes), disableWorker: true, isEvalSupported: false, useSystemFonts: true });
    const document = await loading.promise;
    const pageCount = document.numPages;
    if (pageCount > 500) throw new Error('PDF imports are limited to 500 pages.');
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => String(item.str || '')).join(' ').replace(/\s+/g, ' ').trim());
      if (pages.join('\n').length > 2_000_000) throw new Error('Extracted PDF text exceeds the 2,000,000 character safety limit.');
    }
    await loading.destroy();
    const text = pages.map((pageText, index) => `## Page ${index + 1}\n\n${pageText || '[No extractable text]'}`).join('\n\n');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const id = db.prepare(`
      INSERT INTO knowledge_items (type, title, body, source, status, confidence, evidence, owner, next_action)
      VALUES ('source document', ?, ?, 'local PDF import', 'pending review', 0.5, ?, 'user', 'Review extracted text and classify any durable knowledge.')
    `).run(name, text, `${pageCount} page PDF; SHA-256 ${sha256}`).lastInsertRowid;
    ok(res, { item: row('SELECT * FROM knowledge_items WHERE id = ?', [id]), pages: pageCount, sha256, characters: text.length });
  } catch (error) {
    fail(res, 422, `PDF extraction failed: ${error.message}`);
  }
});

app.get('/api/export/json', (req, res) => {
  const mode = req.query.mode === 'backup' ? 'backup' : 'public';
  if (mode === 'public') {
    return fail(res, 409, 'Public export is disabled until every included record has an explicit shareability classification and the final preview is confirmed. Use a local context export instead.');
  }
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
    data.settings = publicSettings(false);
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

// Final error handler: keep API responses JSON-shaped (matches fail()) even for
// malformed request bodies or errors thrown synchronously in a handler, instead
// of leaking Express's default HTML error page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || (err.type === 'entity.parse.failed' ? 400 : 500);
  const message = status === 400 ? 'Invalid request body (expected valid JSON).' : (err.message || 'Internal server error.');
  console.error('Request error:', err.message || err);
  if (res.headersSent) return;
  res.status(status).json({ ok: false, error: message });
});

const DEV_TASK_SCAN_INTERVAL_MS = 15 * 60 * 1000;

function runDevTaskScan(reason) {
  const result = scanDevTasks();
  if (result.ok && result.staged > 0) {
    console.log(`Dev-task scan (${reason}): staged ${result.staged} roadmap candidate(s) (${result.fromChat} chat, ${result.fromFiles} file).`);
  }
}

app.listen(port, '127.0.0.1', () => {
  console.log(`Life Planner running at http://127.0.0.1:${port}`);
  // Autonomous dev-task scan on startup, deferred so it never blocks boot, then
  // a light periodic re-scan. Dedupe keeps repeat runs from re-staging anything.
  setTimeout(() => runDevTaskScan('startup'), 1500);
  setInterval(() => runDevTaskScan('interval'), DEV_TASK_SCAN_INTERVAL_MS).unref();
});
