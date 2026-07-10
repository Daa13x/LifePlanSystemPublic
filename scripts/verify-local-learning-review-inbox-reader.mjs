#!/usr/bin/env node
// Verify the manual read-only local-learning review-inbox reader. Test setup
// writes only inside temporary roots under the OS temp directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_LEARNING_REVIEW_INBOX_RELATIVE as WRITER_REVIEW_INBOX_RELATIVE } from '../server/localLearningReviewInbox.js';
import {
  LOCAL_LEARNING_REVIEW_INBOX_RELATIVE,
  listLocalLearningReviewCandidates
} from '../server/localLearningReviewInboxReader.js';
import { main as listCliMain } from './list-local-learning-review-inbox.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const validExamplePath = path.join(repoRoot, 'docs', 'agent_mode', 'examples', 'local-learning-event.valid.json');
const readerPath = path.join(repoRoot, 'server', 'localLearningReviewInboxReader.js');
const cliPath = path.join(repoRoot, 'scripts', 'list-local-learning-review-inbox.mjs');
const verifierPath = path.join(repoRoot, 'scripts', 'verify-local-learning-review-inbox-reader.mjs');
const serverIndexPath = path.join(repoRoot, 'server', 'index.js');
const packagePath = path.join(repoRoot, 'package.json');

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeTempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lps-reader-${label}-`));
}

function reviewInboxPath(root) {
  return path.resolve(root, LOCAL_LEARNING_REVIEW_INBOX_RELATIVE);
}

function writeCandidate(root, filename, content) {
  const inbox = reviewInboxPath(root);
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, filename), content, { encoding: 'utf8', flag: 'wx' });
}

function withTempRoot(label, fn) {
  const root = makeTempRoot(label);
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCli(root, argv = []) {
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  try {
    process.chdir(root);
    console.log = (...items) => logs.push(items.join(' '));
    console.error = (...items) => errors.push(items.join(' '));
    return { code: listCliMain(argv), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(originalCwd);
  }
}

function hasActionToken(source) {
  const terms = [
    'fe' + 'tch(',
    'ax' + 'ios',
    'child_' + 'process',
    'ex' + 'ec(',
    'sp' + 'awn(',
    'pupp' + 'eteer',
    'play' + 'wright',
    'Open' + 'Hands',
    'sk' + '-',
    'password' + '=',
    'token' + '='
  ];
  return terms.filter((term) => source.includes(term));
}

function mutationTokens(source) {
  const terms = [
    'write' + 'File',
    'append' + 'File',
    'mkdir' + 'Sync',
    'rm' + 'Sync',
    'unlink' + 'Sync',
    'rename' + 'Sync',
    'copy' + 'File',
    'create' + 'WriteStream',
    'writeLocalLearning' + 'ReviewCandidate'
  ];
  return terms.filter((term) => source.includes(term));
}

console.log('--- Local learning review-inbox reader verification ---');

const validExample = readJson(validExamplePath);

line(LOCAL_LEARNING_REVIEW_INBOX_RELATIVE === WRITER_REVIEW_INBOX_RELATIVE,
  `reader and writer use the same fixed inbox path -> ${LOCAL_LEARNING_REVIEW_INBOX_RELATIVE}`);

withTempRoot('missing', (root) => {
  const before = fs.readdirSync(root).sort();
  const result = listLocalLearningReviewCandidates({ repoRoot: root });
  const after = fs.readdirSync(root).sort();
  line(result.ok && result.inboxExists === false && result.candidateCount === 0,
    `missing inbox is an empty success -> ${JSON.stringify(result)}`);
  line(JSON.stringify(before) === JSON.stringify(after),
    `missing inbox read creates nothing -> ${JSON.stringify({ before, after })}`);
});

withTempRoot('empty', (root) => {
  fs.mkdirSync(reviewInboxPath(root), { recursive: true });
  const result = listLocalLearningReviewCandidates({ repoRoot: root });
  line(result.ok && result.inboxExists === true && result.candidateCount === 0,
    `empty inbox lists zero candidates -> ${JSON.stringify(result)}`);
});

withTempRoot('valid', (root) => {
  writeCandidate(root, 'valid-event.json', `${JSON.stringify(validExample, null, 2)}\n`);
  const candidatePath = path.join(reviewInboxPath(root), 'valid-event.json');
  const before = fs.readFileSync(candidatePath, 'utf8');
  const result = listLocalLearningReviewCandidates({ repoRoot: root });
  const after = fs.readFileSync(candidatePath, 'utf8');
  const candidate = result.candidates[0];
  line(result.ok && result.candidateCount === 1 && candidate?.status === 'valid'
    && candidate.filename === 'valid-event.json'
    && candidate.relativePath === '.lps/local-learning/review-inbox/valid-event.json',
  `valid candidate is listed -> ${JSON.stringify(candidate)}`);
  line(candidate?.task_type === validExample.task_type
    && candidate.memory_route === validExample.memory_route
    && candidate.approval_required === validExample.approval_required,
  `valid candidate metadata is returned -> ${JSON.stringify(candidate)}`);
  line(before === after, 'listing does not modify valid candidate content');
});

withTempRoot('malformed', (root) => {
  writeCandidate(root, 'broken.json', '{');
  const result = listLocalLearningReviewCandidates({ repoRoot: root });
  const candidate = result.candidates[0];
  line(result.ok && candidate?.status === 'invalid'
    && candidate.errors.some((error) => error.includes('malformed JSON')),
  `malformed JSON is listed as invalid without throwing -> ${JSON.stringify(candidate)}`);
});

withTempRoot('schema-invalid', (root) => {
  const invalid = {
    ...clone(validExample),
    memory_route: 'source_of_truth_candidate_requires_approval',
    approval_required: false
  };
  writeCandidate(root, 'approval-false.json', `${JSON.stringify(invalid, null, 2)}\n`);
  const result = listLocalLearningReviewCandidates({ repoRoot: root });
  const candidate = result.candidates[0];
  line(result.ok && candidate?.status === 'invalid'
    && candidate.errors.some((error) => error.includes('approval_required must be true'))
    && candidate.memory_route === invalid.memory_route
    && candidate.approval_required === false,
  `schema-invalid event is listed with validation errors -> ${JSON.stringify(candidate)}`);
});

withTempRoot('non-json', (root) => {
  const inbox = reviewInboxPath(root);
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'notes.txt'), 'ignore me\n', { encoding: 'utf8', flag: 'wx' });
  const result = listLocalLearningReviewCandidates({ repoRoot: root });
  line(result.ok && result.candidateCount === 0,
    `non-JSON files are ignored -> ${JSON.stringify(result.candidates)}`);
});

withTempRoot('sorted', (root) => {
  writeCandidate(root, 'z-last.json', `${JSON.stringify(validExample)}\n`);
  writeCandidate(root, 'a-first.json', `${JSON.stringify(validExample)}\n`);
  const result = listLocalLearningReviewCandidates({ repoRoot: root });
  line(result.ok && result.candidates.map((candidate) => candidate.filename).join(',') === 'a-first.json,z-last.json',
    `candidate order is deterministic -> ${JSON.stringify(result.candidates.map((candidate) => candidate.filename))}`);
});

for (const [index, component] of LOCAL_LEARNING_REVIEW_INBOX_RELATIVE.split('/').entries()) {
  const root = makeTempRoot(`junction-root-${index}`);
  const outside = makeTempRoot(`junction-outside-${index}`);
  try {
    const components = LOCAL_LEARNING_REVIEW_INBOX_RELATIVE.split('/');
    const parent = path.join(root, ...components.slice(0, index));
    fs.mkdirSync(parent, { recursive: true });
    fs.symlinkSync(outside, path.join(parent, component), process.platform === 'win32' ? 'junction' : 'dir');
    const result = listLocalLearningReviewCandidates({ repoRoot: root });
    line(!result.ok && result.reason.includes('symbolic links'),
      `${component} junction cannot redirect inbox reads -> ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

{
  const root = makeTempRoot('candidate-junction-root');
  const outside = makeTempRoot('candidate-junction-outside');
  try {
    const inbox = reviewInboxPath(root);
    fs.mkdirSync(inbox, { recursive: true });
    fs.symlinkSync(outside, path.join(inbox, 'linked.json'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = listLocalLearningReviewCandidates({ repoRoot: root });
    line(!result.ok && result.reason.includes('candidate path must not be a symbolic link'),
      `candidate junction cannot redirect file reads -> ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

withTempRoot('cli-empty', (root) => {
  const result = runCli(root);
  line(result.code === 0 && result.logs.some((item) => item.includes('No pending'))
    && fs.readdirSync(root).length === 0,
  `CLI treats missing/empty inbox as success without creating it -> ${JSON.stringify(result)}`);
});

withTempRoot('cli-invalid', (root) => {
  writeCandidate(root, 'broken.json', '{');
  const result = runCli(root);
  line(result.code === 0 && result.logs.some((item) => item.includes('broken.json [invalid]')),
  `CLI reports invalid candidates without failing the list operation -> ${JSON.stringify(result)}`);
});

withTempRoot('cli-control-text', (root) => {
  const event = { ...clone(validExample), task_type: 'line\nbreak' };
  writeCandidate(root, 'control.json', `${JSON.stringify(event)}\n`);
  const result = runCli(root);
  line(result.code === 0 && result.logs.every((item) => !item.includes('\n'))
    && result.logs.some((item) => item.includes('line\\u000abreak')),
  `CLI escapes control characters in displayed metadata -> ${JSON.stringify(result)}`);
});

{
  const root = makeTempRoot('import');
  const originalCwd = process.cwd();
  try {
    process.chdir(root);
    const before = fs.readdirSync(root).sort();
    await import(`${pathToFileURL(readerPath).href}?verify=${Date.now()}`);
    await import(`${pathToFileURL(cliPath).href}?verify=${Date.now()}`);
    const after = fs.readdirSync(root).sort();
    line(JSON.stringify(before) === JSON.stringify(after),
      `importing reader and CLI writes nothing -> ${JSON.stringify({ before, after })}`);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const readerSource = fs.readFileSync(readerPath, 'utf8');
const cliSource = fs.readFileSync(cliPath, 'utf8');
const verifierSource = fs.readFileSync(verifierPath, 'utf8');
const serverIndex = fs.readFileSync(serverIndexPath, 'utf8');
const packageJson = readJson(packagePath);

line(!serverIndex.includes('localLearningReviewInboxReader')
  && !serverIndex.includes('list-local-learning-review-inbox'),
  'reader is not imported by server startup');
line(packageJson.scripts?.['verify:local-learning-review-inbox-reader']
  === 'node scripts/verify-local-learning-review-inbox-reader.mjs',
  'package exposes the reader verifier script');
line(!Object.values(packageJson.scripts || {}).some((value) => String(value).includes('list-local-learning-review-inbox')),
  'package scripts do not run the reader CLI');

const actionHits = [
  ['reader', readerSource],
  ['cli', cliSource],
  ['verifier', verifierSource]
].flatMap(([name, source]) => hasActionToken(source).map((term) => `${name}:${term}`));
line(actionHits.length === 0, `reader files have no forbidden capability tokens -> ${JSON.stringify(actionHits)}`);

const mutationHits = [
  ['reader', readerSource],
  ['cli', cliSource]
].flatMap(([name, source]) => mutationTokens(source).map((term) => `${name}:${term}`));
line(mutationHits.length === 0, `reader and CLI have no write/delete/move APIs -> ${JSON.stringify(mutationHits)}`);

const allowedReaderFsCalls = new Set(['lstatSync', 'realpathSync', 'statSync', 'readFileSync', 'readdirSync']);
const readerFsCalls = [...readerSource.matchAll(/\bfs\.([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]);
line(readerFsCalls.every((call) => allowedReaderFsCalls.has(call)),
  `reader uses read-only filesystem calls -> ${JSON.stringify(readerFsCalls)}`);

console.log(`\n${failures === 0 ? 'ALL PASS - local learning review-inbox reader is manual, read-only, and containment-gated.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
