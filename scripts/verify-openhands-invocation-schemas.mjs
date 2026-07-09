#!/usr/bin/env node
// Verify disabled OpenHands invocation schema/spec files and examples.
//
// Local-only and dependency-free: no network, no OpenHands call, no server boot,
// no filesystem writes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const schemaDir = path.join(repoRoot, 'docs', 'tooling', 'openhands_invocation_schemas');
const fixtureDir = path.join(repoRoot, 'docs', 'tooling', 'openhands_invocation_examples');
const adapterPath = path.join(repoRoot, 'server', 'openhandsInvocationAdapter.js');

const requiredStatuses = [
  'setup-gated',
  'blocked',
  'refused',
  'validation-failed',
  'timeout',
  'output-capped',
  'invalid-response',
  'not-implemented',
  'disabled'
];

const deniedBooleans = [
  'patchApproved',
  'commitAllowed',
  'pushAllowed',
  'mergeAllowed',
  'branchDeletionAllowed',
  'resetAllowed',
  'stashPopAllowed',
  'mainMasterWriteAllowed',
  'privateMemoryAccessAllowed',
  'dependencyProvisioningAllowed'
];

const requiredHumanReviewFields = ['requiresHumanReview', 'requiresSeparatePostRunApproval'];
const secretValuePattern = /(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC |)PRIVATE KEY|password\s*[:=]\s*["']?[^"',\s]+|secret\s*[:=]\s*["']?[^"',\s]+|token\s*[:=]\s*["']?[^"',\s]+)/i;
const unsafeHumanStepPattern = /\b(auto-commit|auto-push|auto-merge|delete branch|reset|stash-pop|enable invocation)\b/i;
const allowedEndpointPatterns = [
  /^http:\/\/localhost(?::[0-9]+)?(?:\/.*)?$/,
  /^http:\/\/127\.0\.0\.1(?::[0-9]+)?(?:\/.*)?$/,
  /^http:\/\/example\.invalid(?::[0-9]+)?(?:\/.*)?$/
];

let failures = 0;
const line = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

function readJsonFiles(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fullPath = path.join(dir, name);
      const raw = fs.readFileSync(fullPath, 'utf8');
      return { name, fullPath, raw, json: JSON.parse(raw) };
    });
}

function walk(value, visit, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, [...pathParts, String(index)]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      visit(key, item, [...pathParts, key]);
      walk(item, visit, [...pathParts, key]);
    }
  }
}

function hasOnlyExampleEndpoints(json) {
  const bad = [];
  walk(json, (key, value, pathParts) => {
    if ((key === 'endpoint' || key === 'baseUrl') && typeof value === 'string') {
      if (!allowedEndpointPatterns.some((pattern) => pattern.test(value))) {
        bad.push({ path: pathParts.join('.'), value });
      }
    }
  });
  return bad;
}

function hasNoSecretFieldValues(json) {
  const bad = [];
  walk(json, (key, value, pathParts) => {
    const lower = key.toLowerCase();
    if (['apikey', 'apikeyvalue', 'secret', 'token', 'password', 'privatekey'].includes(lower) && value) {
      bad.push({ path: pathParts.join('.'), key });
    }
  });
  return bad;
}

console.log('--- OpenHands invocation schema and fixture verification ---');

const schemas = readJsonFiles(schemaDir);
const fixtures = readJsonFiles(fixtureDir);

line(schemas.length >= 8, `schema/spec files load -> ${schemas.map((item) => item.name).join(', ')}`);
line(fixtures.length >= 12, `fixture files load -> ${fixtures.map((item) => item.name).join(', ')}`);

for (const schema of schemas) {
  const spec = schema.json;
  const missingTopLevel = ['kind', 'name', 'requiredFields', 'allowedStatusValues', 'safetyBooleansMustBeFalse', 'humanReviewFieldsMustBeTrue', 'forbiddenSecretFields', 'allowedEndpointPatterns', 'nonAuthorizing']
    .filter((field) => !(field in spec));
  line(missingTopLevel.length === 0, `${schema.name} has required spec fields -> ${JSON.stringify(missingTopLevel)}`);

  const missingStatuses = requiredStatuses.filter((status) => !spec.allowedStatusValues?.includes(status));
  line(missingStatuses.length === 0, `${schema.name} includes required status values -> ${JSON.stringify(missingStatuses)}`);

  const missingDenied = deniedBooleans.filter((field) => !spec.safetyBooleansMustBeFalse?.includes(field));
  line(missingDenied.length === 0, `${schema.name} requires denied autonomy booleans -> ${JSON.stringify(missingDenied)}`);

  const missingHumanReview = requiredHumanReviewFields.filter((field) => !spec.humanReviewFieldsMustBeTrue?.includes(field));
  line(missingHumanReview.length === 0, `${schema.name} requires human review fields -> ${JSON.stringify(missingHumanReview)}`);
  line(spec.nonAuthorizing === true, `${schema.name} is marked non-authorizing`);

  // The spec's own endpoint patterns must be usable regexes that accept the
  // canonical local/example endpoints and reject remote ones. (This guards
  // against escaping mistakes: a broken pattern that matches nothing would
  // otherwise pass every structural check above.)
  const specPatterns = (spec.allowedEndpointPatterns || []).map((source) => new RegExp(source));
  const mustMatch = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://example.invalid/path'];
  const mustReject = ['https://api.openai.com', 'http://127a0b0c1:3000', 'http://evil.example.com'];
  const unmatched = mustMatch.filter((endpoint) => !specPatterns.some((pattern) => pattern.test(endpoint)));
  const wronglyMatched = mustReject.filter((endpoint) => specPatterns.some((pattern) => pattern.test(endpoint)));
  line(unmatched.length === 0 && wronglyMatched.length === 0,
    `${schema.name} endpoint patterns compile and match local/example endpoints only -> ${JSON.stringify({ unmatched, wronglyMatched })}`);
}

for (const fixture of fixtures) {
  const item = fixture.json;
  const missingFields = ['status', 'invoked', 'realInvocationEnabled', 'reason', 'humanNextStep', ...deniedBooleans, ...requiredHumanReviewFields]
    .filter((field) => !(field in item));
  line(missingFields.length === 0, `${fixture.name} contains required fields -> ${JSON.stringify(missingFields)}`);

  line(requiredStatuses.includes(item.status), `${fixture.name} uses allowed status "${item.status}"`);
  line(item.invoked === false, `${fixture.name} does not claim invoked:true`);
  line(item.realInvocationEnabled === false, `${fixture.name} does not claim realInvocationEnabled:true`);

  const trueDenied = deniedBooleans.filter((field) => item[field] !== false);
  line(trueDenied.length === 0, `${fixture.name} denies autonomy booleans -> ${JSON.stringify(trueDenied)}`);

  const falseHumanReview = requiredHumanReviewFields.filter((field) => item[field] !== true);
  line(falseHumanReview.length === 0, `${fixture.name} requires human review fields -> ${JSON.stringify(falseHumanReview)}`);

  line(!secretValuePattern.test(fixture.raw), `${fixture.name} contains no likely secret/API key values`);
  line(hasNoSecretFieldValues(item).length === 0, `${fixture.name} contains no forbidden secret value fields`);

  const privatePathHit = /(^|[^A-Za-z0-9_])(source_of_truth\/|memory\/)/i.test(fixture.raw);
  const allowedPrivateExample = fixture.name === 'protected_path_failure.example.json' && /forbidden\/protected path example/i.test(fixture.raw);
  line(!privatePathHit || allowedPrivateExample, `${fixture.name} avoids private paths except protected-path examples`);

  const badEndpoints = hasOnlyExampleEndpoints(item);
  line(badEndpoints.length === 0, `${fixture.name} uses localhost/example endpoints only -> ${JSON.stringify(badEndpoints)}`);

  line(!unsafeHumanStepPattern.test(String(item.humanNextStep || '')),
    `${fixture.name} humanNextStep avoids automatic execution wording`);
}

{
  const combined = [...schemas, ...fixtures].map((item) => item.raw).join('\n');
  line(!secretValuePattern.test(combined), 'schemas/fixtures contain no likely secret or real API key values');
}

{
  const source = fs.readFileSync(adapterPath, 'utf8');
  const forbiddenSourcePatterns = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\baxios\b/,
    /from\s+['"]node:http/,
    /from\s+['"]node:https/,
    /from\s+['"]http/,
    /from\s+['"]https/,
    /\bchild_process\b/,
    /\bspawn\s*\(/,
    /\bexecFile\s*\(/,
    /\bexec\s*\(/
  ];
  const matches = forbiddenSourcePatterns.filter((pattern) => pattern.test(source)).map(String);
  line(matches.length === 0, `adapter source still has no network/client/process caller -> ${JSON.stringify(matches)}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS - OpenHands invocation schemas and fixtures are non-authorizing and local-only.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
