#!/usr/bin/env node
// Verify LifeSkillSystem skill docs are complete and safe.
//
// Deterministic, local-only, docs-only. No network, no OpenHands call, no server
// boot, no filesystem writes. It scans docs/agent_mode/skills/ for files named
// SKILL.md and checks:
//   - required frontmatter-ish metadata fields are present;
//   - required sections are present;
//   - no forbidden runtime/secret/unsafe tokens appear.
//
// Exit code 0 = all skills complete and safe; non-zero = a check failed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const skillsDir = path.join(repoRoot, 'docs', 'agent_mode', 'skills');

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

// Recursively collect files literally named SKILL.md (the template file,
// SKILL_TEMPLATE.md, is intentionally NOT matched).
function findSkillFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findSkillFiles(full));
    else if (entry.name === 'SKILL.md') out.push(full);
  }
  return out;
}

const REQUIRED_METADATA = ['name', 'description', 'platforms', 'status', 'safety_level'];
const REQUIRED_SECTIONS = [
  '## Purpose',
  '## When to use',
  '## Safety checks',
  '## Output format',
  '## Escalate to Fable/Codex when'
];

// Forbidden tokens. Precise on purpose so legitimate prose does not false-trip:
// - `source_of_truth` is the underscore PATH token (skills discuss the concept
//   as "source-of-truth"/"source of truth", which is allowed);
// - `\bsk-` matches the OpenAI-style key prefix at a word boundary, not the "sk"
//   inside "task-"/"risk-";
// - shell/network callers require the "(" so words like "execute"/"fetch the
//   video" are allowed.
const FORBIDDEN = [
  ['OPENHANDS_EXECUTOR_INVOCATION_ENABLED=true', /OPENHANDS_EXECUTOR_INVOCATION_ENABLED\s*=\s*true/],
  ['fetch(', /\bfetch\s*\(/],
  ['axios', /\baxios\b/],
  ['child_process', /\bchild_process\b/],
  ['exec(', /\bexec\s*\(/],
  ['spawn(', /\bspawn\s*\(/],
  ['source_of_truth (path token)', /source_of_truth/],
  ['sk- secret prefix', /\bsk-/],
  ['password= secret', /password\s*=/i],
  ['token= secret', /\btoken\s*=/i]
];

function frontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

console.log('--- LifeSkillSystem skill verification ---');

const skillFiles = findSkillFiles(skillsDir);
line(skillFiles.length > 0, `found SKILL.md files -> ${skillFiles.length}`);

for (const file of skillFiles) {
  const rel = path.relative(repoRoot, file).replaceAll('\\', '/');
  const raw = fs.readFileSync(file, 'utf8');
  const fm = frontmatter(raw);

  const missingMeta = REQUIRED_METADATA.filter((key) => !new RegExp(`^${key}\\s*:`, 'm').test(fm));
  line(missingMeta.length === 0, `${rel} has required metadata -> ${JSON.stringify(missingMeta)}`);

  const missingSections = REQUIRED_SECTIONS.filter((section) => !raw.includes(section));
  line(missingSections.length === 0, `${rel} has required sections -> ${JSON.stringify(missingSections)}`);

  const hits = FORBIDDEN.filter(([, pattern]) => pattern.test(raw)).map(([label]) => label);
  line(hits.length === 0, `${rel} contains no forbidden runtime/secret tokens -> ${JSON.stringify(hits)}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS - LifeSkillSystem skills are complete, instruction-only, and non-authorizing.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
