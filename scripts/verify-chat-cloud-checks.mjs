import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUD_GUIDANCE_MAX_CHARS } from '../server/chatReliability.js';

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
  ,['guidance provenance stored with assistant reply', /cloudCheckId: check\.id/],
  ['model registry is connector-truthful', /Current model selected in ChatGPT/],
  ['server validates focus length without truncation', /instruction\.length > CLOUD_GUIDANCE_MAX_CHARS[\s\S]*Your text was not truncated/],
  ['send requires matching provider tab', /No signed-in \$\{check\.provider\} tab is connected/],
  ['dismissal keeps persisted audit record', /feedback_dismissed_at = COALESCE/]
];
let failed = 0;
for (const [label, pattern] of checks) { const ok = pattern.test(`${server}\n${db}`); console.log(`${ok ? 'ok' : 'FAIL'} ${label}`); if (!ok) failed++; }
const uiChecks = [
  ['composer provider buttons', /cloud-provider-button/],
  ['exact prompt', /Exact authorised prompt/],
  ['transcript placement', /assistant_message_id\) === Number\(message\.id\)/],
  ['guidance action', /Use for next reply/],
  ['dismissed feedback provenance', /feedback_dismissed_at/],
  ['dismissed feedback hidden from normal transcript', /&& !check\.feedback_dismissed_at/],
  ['provider model selector', /Cloud provider model/],
  ['reviewed focus instruction', /Focus for the cloud consultant/],
  ['explicit candidate action', /Save as memory candidate/],
  ['active polling', /setInterval\(\(\) => loadCloudChecks\(\), 1500\)/]
  ,['visible focus limit', /cloudInstruction\.length\.toLocaleString\(\)\} \/ \{CLOUD_GUIDANCE_MAX_CHARS\.toLocaleString\(\)\}/]
  ,['focus text is never browser-truncated', !ui.includes('maxLength={1200}')]
];
for (const [label, expectation] of uiChecks) { const ok = typeof expectation === 'boolean' ? expectation : expectation.test(ui); console.log(`${ok ? 'ok' : 'FAIL'} ${label}`); if (!ok) failed++; }
if (failed) process.exit(1);
console.log(`Cloud-check contract verification passed with a visible ${CLOUD_GUIDANCE_MAX_CHARS.toLocaleString()} character focus boundary.`);
