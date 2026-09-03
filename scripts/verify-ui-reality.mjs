#!/usr/bin/env node
// UI reality regression guard (uncle-feedback item 7). The route-and-state
// audit is already complete; this keeps it from regressing by asserting the UI
// carries no fabricated data/simulated success, and that honest partial/empty/
// setup-gated states remain in place. Local-only, static. Exit 0 = pass.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const srcDir = path.join(root, 'src');
const files = fs.readdirSync(srcDir).filter((name) => name.endsWith('.jsx') || name.endsWith('.js'));
const sources = files.map((name) => ({ name, text: fs.readFileSync(path.join(srcDir, name), 'utf8') }));

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- UI reality guard ---');

// Unambiguous fabricated-data / simulated-success markers. Deliberately tight so
// legitimate input `placeholder=` attributes and TODO/FIXME feature copy do not
// trip it. Any hit is a real regression to investigate.
const BANNED = [
  /lorem ipsum/i,
  /\bfake(?:Data|Count|Success|Response|Result)\b/,
  /\bdummy(?:Data|Value|Response)\b/,
  /\bsimulated success\b/i,
  /\bmockResponse\b/,
  /\bhardcodedCount\b/,
  /\bplaceholderData\b/
];
for (const { name, text } of sources) {
  for (const pattern of BANNED) {
    const hit = text.match(pattern);
    line(!hit, `${name} is free of fabricated-data marker ${pattern}${hit ? ` (found "${hit[0]}")` : ''}`);
  }
}

// The audit's honest-state vocabulary must remain present: truthful empty,
// setup-gated, and not-tracked states rather than fake fills.
const ui = sources.find((s) => s.name === 'main.jsx')?.text || '';
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const codingWorker = fs.readFileSync(path.join(root, 'server', 'nativeCodingWorker.js'), 'utf8');
for (const phrase of ['Save chat log later', 'Sync everything later', 'Automatic ChatGPT response will appear here']) {
  line(!ui.includes(phrase), `browser consultation omits unsupported promise: "${phrase}"`);
}
line(ui.includes('Legacy record — confidence was not captured.'), 'legacy coding audit records are not displayed as fabricated zero-confidence assessments');
line(ui.includes('Controller evidence excerpt') && ui.includes('entry.resultPreview'), 'coding review exposes retained controller evidence excerpts rather than only model summaries or hashes');
line(codingWorker.includes('export const NATIVE_CODING_LIMITS = Object.freeze({'), 'native coding publishes one authoritative UI/backend limit contract');
line(server.includes('limits: NATIVE_CODING_LIMITS'), 'coding status API exposes authoritative worker limits');
line(ui.includes('coding.limits?.maxToolRounds ?? 16') && ui.includes('coding.limits?.maxEvidenceRecoveryAttempts ?? 5') && ui.includes('coding.limits?.maxValidationRepairAttempts ?? 1'), 'coding UI renders backend-owned tool and recovery limits with matching safe fallbacks');
line(!ui.includes('up to eight scoped') && !ui.includes('/ 3 bounded gap-resolution'), 'coding UI no longer carries stale hard-coded worker limits');
line(ui.includes("['prepared', 'needs-evidence'].includes(selectedCodingTask.status)") && ui.includes('The in-scope read budget is exhausted.'), 'needs-evidence offers the truthful advisory-or-rescope path instead of presenting a blind rerun as recovery');
line(ui.includes('Create a durable run confirmation') && ui.includes('Create a durable patch-apply confirmation') && ui.includes('Confirm once'), 'coding run and apply use explicit token-backed confirmation controls rather than UI-only success state');
line(/button\.primary:disabled,[\s\S]*background: var\(--panel-2\)/.test(styles), 'disabled primary actions use a neutral unavailable state instead of success styling');
for (const phrase of ['nothing recorded yet', 'Prepared — connection required', 'not tracked', 'local only']) {
  line(ui.includes(phrase), `honest-state language retained: "${phrase}"`);
}

// Real records/routes/history must not be faked: counts shown to the user come
// from server data (api(...)), never from a literal fabricated total.
line(/api\('\/api\/feedback'\)/.test(ui) && /api\('\/api\/workboard\/cards'\)/.test(ui), 'user-facing lists read real server data, not fabricated literals');
line(!/capabilities\?\.length\s*\?\?\s*\d+/.test(ui), 'Chat does not fabricate a capability count while connection truth is unavailable');
line(!ui.includes('function ChatConnectionBar('), 'Chat omits the permanent runtime/capability dashboard');
line(server.includes("mode: 'action registry'") && server.includes("endpointType: 'action-registry'"), 'Chat diagnostics are delivered conversationally through the action registry');
line(!server.includes('warmManagedLlamaServerAtStartup') && !server.includes('Warming the assigned local model in the background'), 'opening LPS does not prewarm or retry a local model in the background');
line(/if \(status\.assigned && status\.llamaServerExists && !status\.managedServerReady\)[\s\S]*await startManagedLlamaServer\(\)/.test(server), 'the assigned local model remains demand-loadable by a real inference request');
line(!ui.includes("settings.storageLocation || 'Checking local database…'"), 'System storage status does not depend on the dormant arbitrary storageLocation setting');
line(ui.includes("const storageAvailable = Boolean(runtime?.activeDatabasePath)") && ui.includes("storageAvailable ? 'Local SQLite database' : boot ? 'Database unavailable'"), 'System storage availability derives from authoritative runtime diagnostics without exposing a filesystem path');
line(ui.includes('<p role="status" aria-live="polite">{storage}</p>'), 'dynamic System storage truth is exposed as a polite status update');
line(ui.includes('const connectionRequestRef = useRef(0)') && ui.includes('isLatestChatConnectionRequest('), 'late same-session connection probes cannot overwrite the latest capability truth');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll UI-reality guard checks passed.');
process.exit(failures ? 1 : 0);
