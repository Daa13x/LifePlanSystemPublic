#!/usr/bin/env node
// Focused contract check for the explicit chat-to-Knowledge handoff. This is
// intentionally source-level: no user data, browser, or live database is used.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'src/main.jsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const checks = [
  ['explicit session sync route', /app\.post\('\/api\/chat\/sessions\/:id\/memory-candidate'/],
  ['only user turns are included', /role = 'user' AND TRIM\(content\) <> ''/],
  ['sync has a bounded transcript', /LIMIT 40[\s\S]*slice\(0, 12000\)/],
  ['sync remains review-only', /review required/],
  ['pending sync is idempotent', /source = 'chat session sync'[\s\S]*reused: true/],
  ['sync audit is retained', /writeChatAudit\(sessionId, 'memory\.sync', 'ok'/],
  ['hover action calls session endpoint', /api\(`\/api\/chat\/sessions\/\$\{session\.id\}\/memory-candidate`/],
  ['accessible sync control', /aria-label=\{`Sync \$\{session\.title\} to memory`\}/],
  ['accessible delete control', /aria-label=\{`Delete \$\{session\.title\}`\}/],
  ['keyboard access keeps actions visible', /\.session-entry:focus-within \.session-hover-actions/],
  ['hover actions do not change layout', /position: absolute;[\s\S]*pointer-events: none/]
];
let failures = 0;
for (const [label, pattern] of checks) {
  const subject = label === 'hover action calls session endpoint' || label.includes('accessible') ? ui : label.includes('hover') || label.includes('keyboard') ? css : server;
  const pass = pattern.test(subject);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`);
  if (!pass) failures++;
}
if (failures) process.exit(1);
console.log('Chat session memory-sync contract verification passed.');
