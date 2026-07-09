#!/usr/bin/env node
// Verify the current OpenHands stop boundary remains non-authorizing.
//
// Local-only source checks: no server boot, no network, no OpenHands call, and
// no filesystem writes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));

let failures = 0;
const line = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

function listJsonFiles(relDir) {
  const fullDir = path.join(repoRoot, relDir);
  return fs.readdirSync(fullDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ name, raw: read(path.join(relDir, name)) }));
}

function countMatrixRows(raw) {
  return raw.split(/\r?\n/)
    .filter((lineText) => lineText.startsWith('| '))
    .filter((lineText) => !lineText.startsWith('| Gate ') && !lineText.startsWith('| ---'));
}

console.log('--- OpenHands stop-boundary verification ---');

const serverIndex = read('server/index.js');
line(serverIndex.includes('const OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false'),
  'OPENHANDS_EXECUTOR_INVOCATION_ENABLED remains explicitly false');
line(!/OPENHANDS_EXECUTOR_INVOCATION_ENABLED\s*=\s*true/.test(serverIndex),
  'no true assignment for OPENHANDS_EXECUTOR_INVOCATION_ENABLED');

const adapter = read('server/openhandsInvocationAdapter.js');
const adapterForbidden = [
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['axios', /\baxios\b/],
  ['node:http import', /from\s+['"]node:http|import\s+['"]node:http/],
  ['node:https import', /from\s+['"]node:https|import\s+['"]node:https/],
  ['http module import', /from\s+['"]http['"]|import\s+['"]http['"]/],
  ['https module import', /from\s+['"]https['"]|import\s+['"]https['"]/],
  ['child_process', /\bchild_process\b/],
  ['spawn', /\bspawn\s*\(/],
  ['exec', /\bexec\s*\(/],
  ['execFile', /\bexecFile\s*\(/],
  ['shell option', /\bshell\s*:/]
];
const adapterHits = adapterForbidden
  .filter(([, pattern]) => pattern.test(adapter))
  .map(([name]) => name);
line(adapterHits.length === 0, `adapter has no network/model/process/shell caller -> ${JSON.stringify(adapterHits)}`);

const uiFiles = ['src/main.jsx'].filter(exists);
const uiForbidden = /\b(Invoke|Run|Execute|Generate|Send)\s+(?:real\s+)?OpenHands\b|\bOpenHands\s+(?:Invoke|Run|Execute|Generate)\b/i;
const uiHits = uiFiles
  .flatMap((rel) => read(rel).split(/\r?\n/)
    .map((lineText, index) => ({ rel, line: index + 1, text: lineText, hit: uiForbidden.exec(lineText)?.[0] }))
    .filter((item) => item.hit)
    .filter((item) => !/\bdoes\s+not\b|\bnot\s+invoke\b|\bnever\s+invokes\b/i.test(item.text))
    .map((item) => ({ rel: item.rel, line: item.line, hit: item.hit })));
line(uiHits.length === 0, `obvious UI files contain no OpenHands invoke/run controls -> ${JSON.stringify(uiHits)}`);

const autonomyTrue = /"(?:invoked|realInvocationEnabled|patchApproved|commitAllowed|pushAllowed|mergeAllowed|branchDeletionAllowed|resetAllowed|stashPopAllowed|mainMasterWriteAllowed|privateMemoryAccessAllowed|dependencyProvisioningAllowed)"\s*:\s*true/;
const fixtures = listJsonFiles('docs/tooling/openhands_invocation_examples');
const fixtureHits = fixtures.filter((item) => autonomyTrue.test(item.raw)).map((item) => item.name);
line(fixtureHits.length === 0, `fixtures remain non-authorizing -> ${JSON.stringify(fixtureHits)}`);

const schemas = listJsonFiles('docs/tooling/openhands_invocation_schemas');
const schemaHits = schemas.filter((item) => autonomyTrue.test(item.raw)).map((item) => item.name);
line(schemaHits.length === 0, `schemas do not authorize autonomous execution -> ${JSON.stringify(schemaHits)}`);

const matrix = read('docs/tooling/OPENHANDS_INVOCATION_SAFETY_MATRIX.md');
const matrixRows = countMatrixRows(matrix);
const matrixNonNo = matrixRows.filter((row) => !/\|\s*No\s*\|\s*$/.test(row));
line(matrixRows.length > 0 && matrixNonNo.length === 0,
  `safety matrix denies auto-approval on every row -> ${JSON.stringify(matrixNonNo)}`);
line(/runCli cwd containment/i.test(matrix),
  'safety matrix covers runCli cwd containment');

line(exists('scripts/verify-runcli-cwd.mjs') && read('package.json').includes('"verify:runcli-cwd"'),
  'runCli cwd verification exists and is wired');

const docsIndex = exists('docs/tooling/OPENHANDS_INVOCATION_DOCS_INDEX.md')
  ? read('docs/tooling/OPENHANDS_INVOCATION_DOCS_INDEX.md')
  : '';
line(/future/i.test(docsIndex) && /explicit approval/i.test(docsIndex) && /design review/i.test(docsIndex),
  'docs index keeps real invocation as a future explicit design-review milestone');

console.log(`\n${failures === 0 ? 'ALL PASS - OpenHands stop boundary remains disabled and non-authorizing.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
