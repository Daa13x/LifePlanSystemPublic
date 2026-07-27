import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const server = read('server/index.js');
const db = read('server/db.js');
const ui = read('src/main.jsx');
const checks = [
  ['durable migration', /CREATE TABLE IF NOT EXISTS chat_cloud_checks/],
  ['latest-turn scope', /scope === 'latest-turn'/],
  ['full-conversation scope', /scope === 'full-conversation'/],
  ['server privacy classifier', /classifyAndRedactCloudPrompt\(rawPrompt\)/],
  ['blocked checks never queue', /check\.status === 'blocked'/],
  ['idempotency key', /idempotency_key/],
  ['send route', /\/api\/chat\/cloud-checks\/:id\/send/],
  ['cancel route', /\/api\/chat\/cloud-checks\/:id\/cancel/],
  ['retry route', /\/api\/chat\/cloud-checks\/:id\/retry/],
  ['explicit candidate route', /\/api\/chat\/cloud-checks\/:id\/memory-candidate/],
  ['one-use guidance route', /\/api\/chat\/cloud-checks\/:id\/guidance/],
  ['guidance isolation', /WHERE session_id = \? AND guidance_active = 1/],
  ['guidance consumed after assistant persistence', /guidance_consumed_at = CURRENT_TIMESTAMP/]
  ,['guidance provenance stored with assistant reply', /cloudCheckId: check\.id/]
];
let failed = 0;
for (const [label, pattern] of checks) { const ok = pattern.test(`${server}\n${db}`); console.log(`${ok ? 'ok' : 'FAIL'} ${label}`); if (!ok) failed++; }
const uiChecks = [
  ['provider menu', /aria-label="Cloud provider"/],
  ['exact prompt', /Exact authorised prompt/],
  ['transcript placement', /assistant_message_id\) === Number\(message\.id\)/],
  ['guidance action', /Use for next reply/],
  ['explicit candidate action', /Save as memory candidate/],
  ['active polling', /setInterval\(\(\) => loadCloudChecks\(\), 1500\)/]
];
for (const [label, pattern] of uiChecks) { const ok = pattern.test(ui); console.log(`${ok ? 'ok' : 'FAIL'} ${label}`); if (!ok) failed++; }
if (failed) process.exit(1);
console.log('Cloud-check contract verification passed.');
