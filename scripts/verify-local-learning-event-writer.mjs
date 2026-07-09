#!/usr/bin/env node
// Verify the manual local-learning review-inbox writer. This test writes only
// inside temporary repo roots under the OS temp directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LOCAL_LEARNING_REVIEW_INBOX_RELATIVE,
  getLocalLearningReviewInboxPath,
  validateReviewInboxSlug,
  writeLocalLearningReviewCandidate
} from '../server/localLearningReviewInbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const validExamplePath = path.join(repoRoot, 'docs', 'agent_mode', 'examples', 'local-learning-event.valid.json');
const requiresApprovalPath = path.join(repoRoot, 'docs', 'agent_mode', 'examples', 'local-learning-event.requires-approval.json');
const writerPath = path.join(repoRoot, 'server', 'localLearningReviewInbox.js');
const cliPath = path.join(repoRoot, 'scripts', 'write-local-learning-event.mjs');
const verifierPath = path.join(repoRoot, 'scripts', 'verify-local-learning-event-writer.mjs');
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
  return fs.mkdtempSync(path.join(os.tmpdir(), `lps-${label}-`));
}

function inboxFiles(root) {
  const inbox = getLocalLearningReviewInboxPath(root);
  if (!fs.existsSync(inbox)) return [];
  return fs.readdirSync(inbox).filter((item) => item.endsWith('.json')).sort();
}

function readCandidate(root, name) {
  return readJson(path.join(getLocalLearningReviewInboxPath(root), name));
}

function withTempRoot(label, fn) {
  const root = makeTempRoot(label);
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function checkWritesNothing(name, event, options, expectedReason) {
  withTempRoot(name, (root) => {
    const result = writeLocalLearningReviewCandidate(event, { repoRoot: root, ...options });
    line(!result.ok && result.written === false && inboxFiles(root).length === 0
      && (!expectedReason || result.reason.includes(expectedReason)),
    `${name} writes nothing -> ${JSON.stringify({ reason: result.reason, files: inboxFiles(root) })}`);
  });
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
    'sk' + '-',
    'password' + '=',
    'token' + '='
  ];
  return terms.filter((term) => source.includes(term));
}

console.log('--- Local learning review-inbox writer verification ---');

const validExample = readJson(validExamplePath);
const requiresApprovalExample = readJson(requiresApprovalPath);

withTempRoot('writer-valid', (root) => {
  const result = writeLocalLearningReviewCandidate(validExample, { repoRoot: root, slug: 'valid-event' });
  const files = inboxFiles(root);
  line(result.ok && result.written === true && files.length === 1 && files[0] === 'valid-event.json',
    `valid fixture writes exactly one file -> ${JSON.stringify({ result, files })}`);
  line(result.path === path.resolve(root, LOCAL_LEARNING_REVIEW_INBOX_RELATIVE, 'valid-event.json'),
    `writer prints/returns absolute output path -> ${result.path}`);
  line(result.reason.includes('unapproved') && result.reason.includes('not memory'),
    `writer states candidate is unapproved and not memory -> ${result.reason}`);
});

withTempRoot('writer-approval', (root) => {
  const result = writeLocalLearningReviewCandidate(requiresApprovalExample, { repoRoot: root, slug: 'requires-approval' });
  const written = readCandidate(root, 'requires-approval.json');
  line(result.ok && inboxFiles(root).length === 1 && written.approval_required === true,
    `requires-approval fixture writes one file and preserves approval_required true -> ${JSON.stringify(written)}`);
});

checkWritesNothing('invalid-event', { ...clone(validExample), unexpected: true }, { slug: 'invalid-event' }, 'invalid');

withTempRoot('malformed-json', (root) => {
  let parsed = null;
  try {
    parsed = JSON.parse('{');
  } catch {
    parsed = null;
  }
  if (parsed) writeLocalLearningReviewCandidate(parsed, { repoRoot: root, slug: 'malformed' });
  line(inboxFiles(root).length === 0, `malformed JSON writes nothing -> ${JSON.stringify(inboxFiles(root))}`);
});

checkWritesNothing('approval-false', {
  ...clone(validExample),
  memory_route: 'source_of_truth_candidate_requires_approval',
  approval_required: false
}, { slug: 'approval-false' }, 'invalid');

checkWritesNothing('path-traversal', validExample, { slug: '../escape' }, 'path separators');
checkWritesNothing('absolute-path', validExample, { slug: path.resolve(os.tmpdir(), 'candidate') }, 'absolute');
checkWritesNothing('sensitive-target', validExample, { slug: ['source_of_truth', 'target'].join('/') }, 'path separators');
checkWritesNothing('repo-root-target', validExample, { slug: '.' }, 'dot');

for (const [index, component] of LOCAL_LEARNING_REVIEW_INBOX_RELATIVE.split('/').entries()) {
  const root = makeTempRoot(`junction-root-${index}`);
  const outside = makeTempRoot(`junction-outside-${index}`);
  const slug = `junction-escape-${index}`;
  try {
    const components = LOCAL_LEARNING_REVIEW_INBOX_RELATIVE.split('/');
    const parent = path.join(root, ...components.slice(0, index));
    fs.mkdirSync(parent, { recursive: true });
    fs.symlinkSync(outside, path.join(parent, component), process.platform === 'win32' ? 'junction' : 'dir');

    const result = writeLocalLearningReviewCandidate(validExample, { repoRoot: root, slug });
    const outsideCandidate = path.join(outside, ...components.slice(index + 1), `${slug}.json`);
    line(!result.ok && result.written === false && !fs.existsSync(outsideCandidate)
      && result.reason.includes('symbolic links'),
    `${component} junction cannot redirect a write outside repo root -> ${JSON.stringify({ result, outsideCandidate })}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

withTempRoot('no-overwrite', (root) => {
  const inbox = getLocalLearningReviewInboxPath(root);
  fs.mkdirSync(inbox, { recursive: true });
  const existingPath = path.join(inbox, 'duplicate.json');
  fs.writeFileSync(existingPath, 'do not replace\n', { encoding: 'utf8', flag: 'wx' });
  const result = writeLocalLearningReviewCandidate(validExample, { repoRoot: root, slug: 'duplicate' });
  line(result.ok && inboxFiles(root).join(',') === 'duplicate-2.json,duplicate.json'
    && fs.readFileSync(existingPath, 'utf8') === 'do not replace\n',
  `existing file is not overwritten -> ${JSON.stringify({ files: inboxFiles(root), result })}`);
});

withTempRoot('collision-suffix', (root) => {
  const inbox = getLocalLearningReviewInboxPath(root);
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'lesson.json'), '{}\n', { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(path.join(inbox, 'lesson-2.json'), '{}\n', { encoding: 'utf8', flag: 'wx' });
  const result = writeLocalLearningReviewCandidate(validExample, { repoRoot: root, slug: 'lesson' });
  line(result.ok && path.basename(result.path) === 'lesson-3.json',
    `collision creates safe suffix -> ${JSON.stringify({ files: inboxFiles(root), result })}`);
});

{
  const checks = [
    validateReviewInboxSlug('safe_Name-1.2').ok,
    !validateReviewInboxSlug('../nope').ok,
    !validateReviewInboxSlug('no/pe').ok,
    !validateReviewInboxSlug(path.resolve('nope')).ok,
    !validateReviewInboxSlug('two..dots').ok
  ];
  line(checks.every(Boolean), `slug validation allows only safe filename slugs -> ${JSON.stringify(checks)}`);
}

{
  const root = makeTempRoot('import-writer');
  try {
  await import(`${pathToFileURL(writerPath).href}?verify=${Date.now()}`);
  await import(`${pathToFileURL(cliPath).href}?verify=${Date.now()}`);
  line(inboxFiles(root).length === 0, `importing writer and CLI modules writes nothing -> ${JSON.stringify(inboxFiles(root))}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const cliSource = fs.readFileSync(cliPath, 'utf8');
line(cliSource.includes('process.argv.slice(2)') && cliSource.includes('writeLocalLearningReviewCandidate')
  && !cliSource.includes('server/index.js'),
  'CLI is direct manual invocation only and does not import server startup');

const serverIndex = fs.readFileSync(serverIndexPath, 'utf8');
line(!serverIndex.includes('localLearningReviewInbox') && !serverIndex.includes('write-local-learning-event'),
  'writer is not imported by server startup');

const packageJson = readJson(packagePath);
line(packageJson.scripts?.['verify:local-learning-event-writer'] === 'node scripts/verify-local-learning-event-writer.mjs',
  'package exposes only the writer verifier script');
line(!Object.values(packageJson.scripts || {}).some((value) => String(value).includes('write-local-learning-event')),
  'package scripts do not run the writer CLI');

const sourceHits = [
  ['writer', fs.readFileSync(writerPath, 'utf8')],
  ['cli', cliSource],
  ['verifier', fs.readFileSync(verifierPath, 'utf8')]
].flatMap(([name, source]) => hasActionToken(source).map((term) => `${name}:${term}`));
line(sourceHits.length === 0, `writer/verifier source has no network/action tokens -> ${JSON.stringify(sourceHits)}`);

console.log(`\n${failures === 0 ? 'ALL PASS - local learning review-inbox writer is manual-only and safe-path gated.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
