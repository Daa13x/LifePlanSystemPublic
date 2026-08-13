import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MODE_IDS, resolveAgentMode } from '../server/agentMode.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => { throw new Error(`Agent mode contract failed: ${message}`); };
const cases = [
  ['@coder fix this API test', 'coder', 'explicit'],
  ['/mode writer rewrite this email', 'writer', 'explicit'],
  ['I am overwhelmed and need a plan for my day', 'life_coach', 'inferred'],
  ['Build and validate the database migration', 'coder', 'inferred'],
  ['Help sequence these three dependencies', 'orchestrator', 'inferred']
];

for (const [input, expectedId, expectedSource] of cases) {
  const actual = resolveAgentMode(input);
  if (actual.id !== expectedId || actual.source !== expectedSource) {
    fail(`${JSON.stringify(input)} resolved to ${actual.id}/${actual.source}, expected ${expectedId}/${expectedSource}`);
  }
}

if (AGENT_MODE_IDS.join(',') !== 'orchestrator,coder,writer,life_coach') fail('role registry is not the approved neutral role set');
const indexSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
if (!indexSource.includes("import { resolveAgentMode } from './agentMode.js';")) fail('conversation prompt does not import the mode resolver');
if (!indexSource.includes('Current response role: ${agentMode.label}')) fail('conversation prompt does not apply the selected role');
if (!indexSource.includes('corporate-support apology scripts')) fail('conversation prompt does not enforce direct response style');
console.log('LPS agent mode contract passed: explicit and inferred neutral roles and direct response style are enforced.');
