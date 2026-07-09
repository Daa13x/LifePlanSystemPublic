#!/usr/bin/env node
// Verify local learning event docs, schema, and examples.
//
// Deterministic, local-only, docs/test-first. No network, no model calls, no
// runtime local learning engine, and no filesystem writes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const docPath = path.join(repoRoot, 'docs', 'agent_mode', 'LOCAL_LEARNING_EVENT_SCHEMA.md');
const schemaPath = path.join(repoRoot, 'docs', 'agent_mode', 'schemas', 'local-learning-event.schema.json');
const examplesDir = path.join(repoRoot, 'docs', 'agent_mode', 'examples');
const examplePaths = [
  path.join(examplesDir, 'local-learning-event.valid.json'),
  path.join(examplesDir, 'local-learning-event.requires-approval.json')
];

const REQUIRED_FIELDS = [
  'task_type',
  'selected_skills',
  'agent_target',
  'result_quality',
  'mistakes',
  'lesson',
  'skill_update_candidate',
  'memory_route',
  'approval_required'
];

const ALLOWED_AGENT_TARGETS = ['chatgpt', 'claude', 'codex', 'fable', 'human'];
const ALLOWED_RESULT_QUALITY = ['success', 'partial', 'blocked', 'unsafe', 'unknown'];
const ALLOWED_MEMORY_ROUTES = [
  'ignore',
  'temporary_handoff',
  'mistake_warning',
  'skill_improvement_candidate',
  'memory_inbox_candidate',
  'source_of_truth_candidate_requires_approval'
];

const FORBIDDEN = [
  ['OPENHANDS_EXECUTOR_INVOCATION_ENABLED=true', /OPENHANDS_EXECUTOR_INVOCATION_ENABLED\s*=\s*true/],
  ['fetch(', /\bfetch\s*\(/],
  ['axios', /\baxios\b/],
  ['child_process', /\bchild_process\b/],
  ['exec(', /\bexec\s*\(/],
  ['spawn(', /\bspawn\s*\(/],
  ['puppeteer', /\bpuppeteer\b/i],
  ['playwright', /\bplaywright\b/i],
  ['source_of_truth/ path', /source_of_truth\//],
  ['sk- secret prefix', /\bsk-/],
  ['password= secret', /password\s*=/i],
  ['token= secret', /\btoken\s*=/i]
];

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function rel(file) {
  return path.relative(repoRoot, file).replaceAll('\\', '/');
}

function safetyBoundaryTextAllowed(name, raw, label) {
  return name === 'docs/agent_mode/LOCAL_LEARNING_EVENT_SCHEMA.md'
    && label === 'source_of_truth/ path'
    && raw.includes('does not authorize writing to `source_of_truth/`');
}

function forbiddenHits(name, raw) {
  return FORBIDDEN
    .filter(([label, pattern]) => pattern.test(raw) && !safetyBoundaryTextAllowed(name, raw, label))
    .map(([label]) => label);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validateExample(name, json) {
  const missing = REQUIRED_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(json, field));
  line(missing.length === 0, `${name} contains required fields -> ${JSON.stringify(missing)}`);

  const extra = Object.keys(json).filter((field) => !REQUIRED_FIELDS.includes(field));
  line(extra.length === 0, `${name} contains no extra fields -> ${JSON.stringify(extra)}`);

  line(isNonEmptyString(json.task_type), `${name} task_type is a non-empty string`);
  line(Array.isArray(json.selected_skills) && json.selected_skills.every(isNonEmptyString),
    `${name} selected_skills is an array of strings`);
  line(ALLOWED_AGENT_TARGETS.includes(json.agent_target),
    `${name} agent_target uses an allowed value`);
  line(ALLOWED_RESULT_QUALITY.includes(json.result_quality),
    `${name} result_quality uses an allowed value`);
  line(Array.isArray(json.mistakes) && json.mistakes.every((item) => typeof item === 'string'),
    `${name} mistakes is an array of strings`);
  line(typeof json.lesson === 'string', `${name} lesson is a string`);
  line(typeof json.skill_update_candidate === 'string'
    || (json.skill_update_candidate && typeof json.skill_update_candidate === 'object' && !Array.isArray(json.skill_update_candidate)),
    `${name} skill_update_candidate is an object or string`);
  line(ALLOWED_MEMORY_ROUTES.includes(json.memory_route),
    `${name} memory_route uses an allowed value`);
  line(typeof json.approval_required === 'boolean',
    `${name} approval_required is a boolean`);
}

console.log('--- Local learning event schema verification ---');

const requiredPaths = [docPath, schemaPath, ...examplePaths];
for (const file of requiredPaths) {
  line(fs.existsSync(file), `${rel(file)} exists`);
}

const doc = readText(docPath);
const schemaRaw = readText(schemaPath);
const schema = JSON.parse(schemaRaw);
const examples = examplePaths.map((file) => ({ file, json: readJson(file), raw: readText(file) }));

for (const field of REQUIRED_FIELDS) {
  line(doc.includes(field), `document mentions ${field}`);
  line(schema.required?.includes(field), `schema requires ${field}`);
  line(Object.prototype.hasOwnProperty.call(schema.properties || {}, field), `schema defines ${field}`);
}

line(schema.nonAuthorizing === true, 'schema is marked non-authorizing');
line(schema.runtimeEnabled === false, 'schema runtimeEnabled is false');

line(JSON.stringify(schema.properties?.agent_target?.enum || []) === JSON.stringify(ALLOWED_AGENT_TARGETS),
  'schema agent_target enum is exact');
line(JSON.stringify(schema.properties?.result_quality?.enum || []) === JSON.stringify(ALLOWED_RESULT_QUALITY),
  'schema result_quality enum is exact');
line(JSON.stringify(schema.properties?.memory_route?.enum || []) === JSON.stringify(ALLOWED_MEMORY_ROUTES),
  'schema memory_route enum is exact');

line(schema.if?.properties?.memory_route?.const === 'source_of_truth_candidate_requires_approval',
  'schema conditional checks source-of-truth candidate memory_route const');
line(Array.isArray(schema.if?.required) && schema.if.required.includes('memory_route'),
  'schema conditional requires memory_route before applying approval rule');
line(schema.then?.properties?.approval_required?.const === true,
  'schema conditional requires approval_required true for source-of-truth candidates');

for (const route of ALLOWED_MEMORY_ROUTES) {
  line(doc.includes(route), `document mentions memory route ${route}`);
}

for (const item of examples) {
  validateExample(rel(item.file), item.json);
}

const scanTargets = [
  { name: rel(docPath), raw: doc },
  { name: rel(schemaPath), raw: schemaRaw },
  ...examples.map((item) => ({ name: rel(item.file), raw: item.raw }))
];

for (const target of scanTargets) {
  const hits = forbiddenHits(target.name, target.raw);
  line(hits.length === 0, `${target.name} contains no forbidden runtime/action tokens -> ${JSON.stringify(hits)}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS - local learning event schema is docs/test-first and non-authorizing.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
