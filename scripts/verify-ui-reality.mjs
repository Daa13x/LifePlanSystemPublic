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
for (const phrase of ['nothing recorded yet', 'Prepared — connection required', 'not tracked', 'local only']) {
  line(ui.includes(phrase), `honest-state language retained: "${phrase}"`);
}

// Real records/routes/history must not be faked: counts shown to the user come
// from server data (api(...)), never from a literal fabricated total.
line(/api\('\/api\/feedback'\)/.test(ui) && /api\('\/api\/workboard\/cards'\)/.test(ui), 'user-facing lists read real server data, not fabricated literals');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll UI-reality guard checks passed.');
process.exit(failures ? 1 : 0);
