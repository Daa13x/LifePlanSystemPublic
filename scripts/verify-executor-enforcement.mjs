#!/usr/bin/env node
// Verify the OpenHands executor's changed-file enforcement REJECTS a real
// violating diff — executor blocker #3.
//
// This exercises the REAL enforcement functions (imported from
// ../server/executorEnforcement.js — the same code server/index.js uses) and,
// for the primary case, a REAL isolated git working tree containing a REAL
// changed file outside allowedPaths. Changed files are gathered exactly as the
// executor gathers them: `git status --porcelain` -> parsePorcelainPaths ->
// enforceChangedFiles.
//
// It does NOT enable OpenHands invocation, call OpenHands, hit the network, read
// secrets, or mutate the main repository. It creates a throwaway git repo in the
// OS temp dir and removes it afterwards. Run:  node scripts/verify-executor-enforcement.mjs
//
// Exit code 0 = all cases behaved as required; non-zero = a case failed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkWorktreeValidationSetup,
  checkExecutorMaxFilesChanged,
  enforceChangedFiles,
  limitExecutorReportText,
  summarizeExecutorCommandResult,
  parsePorcelainPaths,
  validateExecutorBaseBranch,
} from '../server/executorEnforcement.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

// ---------------------------------------------------------------------------
// Part A — REAL isolated git working tree with a REAL changed file.
// ---------------------------------------------------------------------------
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}
// Seed a throwaway repo with the given tracked files already committed, so that
// a NEW file added later to an existing directory is reported individually by
// `git status --porcelain` (git collapses a *fully* untracked directory to
// "dir/"; a tracked directory lists new files by full path). This mirrors the
// realistic case of an edit landing in an existing tree.
function initRepo(dir, trackedFiles) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, ['config', 'user.email', 'verify@example.invalid']); // local-only; never global
  git(dir, ['config', 'user.name', 'Enforcement Verifier']);
  git(dir, ['config', 'core.autocrlf', 'false']);               // avoid CRLF warnings
  for (const [rel, content] of Object.entries(trackedFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed']);
}
function changedFilesOf(dir) {
  // Exactly how the executor gathers changed files (server/index.js): read
  // `git status --porcelain` and parse it with the real parsePorcelainPaths,
  // BEFORE any `git add -N` — the same order enforcement runs in.
  return parsePorcelainPaths(git(dir, ['status', '--porcelain']));
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-exec-reject-'));
try {
  console.log('--- Part A: real isolated git working tree ---');

  // A1. VIOLATING new file outside a narrow allowedPath -> reject, named.
  {
    const dir = path.join(tmpRoot, 'a1');
    initRepo(dir, { 'README.md': '# seed\n', 'docs-forbidden/.keep': '' });
    fs.writeFileSync(path.join(dir, 'docs-forbidden', 'file.md'), 'sneaky change\n');
    const changed = changedFilesOf(dir);
    const request = { allowedPaths: ['docs/allowed'], forbiddenPaths: [], maxFilesChanged: 5 };
    const result = enforceChangedFiles(changed, request);
    line(changed.includes('docs-forbidden/file.md'),
      `A1 real changed file present in git status: ${JSON.stringify(changed)}`);
    line(result.ok === false, `A1 enforceChangedFiles rejected (ok=false): ok=${result.ok}`);
    line(result.violations.some((v) => v.includes('docs-forbidden/file.md') && v.includes('outside allowedPaths')),
      `A1 violation names the offending file: ${JSON.stringify(result.violations)}`);
  }

  // A2. VIOLATING modified TRACKED file outside allowedPath -> reject (proves a
  //     genuine content diff, not just an untracked add).
  {
    const dir = path.join(tmpRoot, 'a2');
    initRepo(dir, { 'README.md': '# seed\n' });
    fs.appendFileSync(path.join(dir, 'README.md'), 'appended line\n');
    const diff = git(dir, ['diff', '--stat']);
    const changed = changedFilesOf(dir);
    const request = { allowedPaths: ['docs/allowed'], forbiddenPaths: [], maxFilesChanged: 5 };
    const result = enforceChangedFiles(changed, request);
    line(diff.includes('README.md'), `A2 real git diff exists for tracked file:${diff.replace(/\n/g, ' ').replace(/\s+/g, ' ').replace(/^ /, ' ').trimEnd()}`);
    line(result.ok === false && result.violations.some((v) => v.startsWith('README.md')),
      `A2 modified tracked file rejected: ${JSON.stringify(result.violations)}`);
  }

  // A3. POSITIVE CONTROL: a real changed file INSIDE allowedPaths -> allowed.
  {
    const dir = path.join(tmpRoot, 'a3');
    initRepo(dir, { 'README.md': '# seed\n', 'docs/.keep': '' });
    fs.writeFileSync(path.join(dir, 'docs', 'file.md'), 'legit doc\n');
    const changed = changedFilesOf(dir);
    const request = { allowedPaths: ['docs'], forbiddenPaths: [], maxFilesChanged: 5 };
    const result = enforceChangedFiles(changed, request);
    line(changed.includes('docs/file.md'), `A3 real allowed change present: ${JSON.stringify(changed)}`);
    line(result.ok === true && result.violations.length === 0,
      `A3 positive control accepted (ok=true, no violations): ok=${result.ok} violations=${JSON.stringify(result.violations)}`);
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`(cleaned up temp repos under ${tmpRoot})`);
}

// ---------------------------------------------------------------------------
// Part B — direct enforceChangedFiles matrix for the enumerated cases and the
// unchanged protected-path denylist. Exercises the same real function without
// needing a separate git repo per case.
// ---------------------------------------------------------------------------
console.log('\n--- Part B: enforceChangedFiles matrix (real function, direct call) ---');
function expectReject(changed, request, mustName, label) {
  const r = enforceChangedFiles(changed, request);
  const ok = r.ok === false && (mustName ? r.violations.some((v) => v.includes(mustName)) : true);
  line(ok, `${label} -> reject: ${JSON.stringify(r.violations)}`);
}
function expectAllow(changed, request, label) {
  const r = enforceChangedFiles(changed, request);
  line(r.ok === true && r.violations.length === 0, `${label} -> allow: ok=${r.ok} violations=${JSON.stringify(r.violations)}`);
}

// Required violating cases (outside allowedPaths).
expectReject(['docs-forbidden/file.md'], { allowedPaths: ['docs/allowed'] }, 'docs-forbidden/file.md', 'B allowed=[docs/allowed] changed=docs-forbidden/file.md');
expectReject(['README.md.x'], { allowedPaths: ['README.md'] }, 'README.md.x', 'B allowed=[README.md] changed=README.md.x');
expectReject(['src/application/file.js'], { allowedPaths: ['src/app'] }, 'src/application/file.js', 'B allowed=[src/app] changed=src/application/file.js');
expectReject(['docs2/file.md'], { allowedPaths: ['docs'] }, 'docs2/file.md', 'B allowed=[docs] changed=docs2/file.md');
expectReject(['../escape/file.md'], { allowedPaths: ['docs'] }, '../escape/file.md', 'B allowed=[docs] changed=../escape/file.md (traversal)');
expectReject(['/etc/passwd'], { allowedPaths: ['docs'] }, '/etc/passwd', 'B allowed=[docs] changed=/etc/passwd (absolute)');

// Protected-path denylist must remain blocked (behaviour unchanged, independent
// of allowedPaths) — proves the extract did not loosen it.
expectReject(['source_of_truth/plan.md'], { allowedPaths: ['source_of_truth'] }, 'touches a protected path', 'B protected source_of_truth/plan.md');
expectReject(['memory/notes.md'], { allowedPaths: ['memory'] }, 'touches a protected path', 'B protected memory/notes.md');
expectReject(['.env'], { allowedPaths: ['.env'] }, 'touches a protected path', 'B protected .env');

// Positive controls (allowed).
expectAllow(['docs/file.md'], { allowedPaths: ['docs'] }, 'B allowed=[docs] changed=docs/file.md');
expectAllow(['README.md'], { allowedPaths: ['README.md'] }, 'B allowed=[README.md] changed=README.md');
expectAllow(['docs/tooling/OPENHANDS_WORKTREE_EXECUTOR.md'], { allowedPaths: ['docs/tooling'] }, 'B allowed=[docs/tooling] changed=docs/tooling/OPENHANDS_WORKTREE_EXECUTOR.md');

// ---------------------------------------------------------------------------
// Part C - base-branch pinning input validation. The server persists this
// normalized base branch at request creation, pins it again at approval and
// confirmation, and uses the resolved commit for `git worktree add -- <commit>`.
// These cases prove malicious values cannot smuggle git flags, revision syntax,
// shell-ish separators, or alternate full refs through the request JSON.
// ---------------------------------------------------------------------------
console.log('\n--- Part C: base-branch validation matrix (pure helper) ---');
function expectBaseAllow(input, expected, label) {
  const r = validateExecutorBaseBranch(input);
  line(r.ok === true && r.baseBranch === expected, `${label} -> allow ${JSON.stringify(r)}`);
}
function expectBaseReject(input, reasonNeedle, label) {
  const r = validateExecutorBaseBranch(input);
  line(r.ok === false && r.reason.includes(reasonNeedle), `${label} -> reject ${JSON.stringify(r)}`);
}

expectBaseAllow('main', 'main', 'C base main');
expectBaseAllow(' main ', 'main', 'C base trims surrounding whitespace');
expectBaseAllow('master', 'master', 'C base master');
expectBaseAllow('origin/main', 'origin/main', 'C base remote branch');
expectBaseAllow('fable/exec-rejection-path-test-2026-07-06', 'fable/exec-rejection-path-test-2026-07-06', 'C base stacked PR branch');
expectBaseAllow('codex/executor_base-1.2', 'codex/executor_base-1.2', 'C base slash underscore dot dash');

expectBaseReject('', 'required', 'C reject empty base');
expectBaseReject('   ', 'required', 'C reject blank base');
expectBaseReject('-main', 'must not start', 'C reject leading dash');
expectBaseReject('--detach', 'must not start', 'C reject option-like flag');
expectBaseReject('main --force', 'whitespace', 'C reject space option smuggling');
expectBaseReject('main\tother', 'whitespace', 'C reject control/whitespace');
expectBaseReject('/main', 'normalized branch name', 'C reject leading slash');
expectBaseReject('main/', 'normalized branch name', 'C reject trailing slash');
expectBaseReject('origin//main', 'normalized branch name', 'C reject double slash');
expectBaseReject('refs/heads/main', 'short branch name', 'C reject full ref');
expectBaseReject('main..evil', 'revision syntax', 'C reject dot-dot revision syntax');
expectBaseReject('main@{1}', 'revision syntax', 'C reject reflog revision syntax');
expectBaseReject('HEAD', 'unsafe ref component', 'C reject HEAD');
expectBaseReject('origin/HEAD', 'unsafe ref component', 'C reject origin/HEAD');
expectBaseReject('.hidden/main', 'unsafe ref component', 'C reject leading-dot component');
expectBaseReject('main.lock', 'unsafe ref component', 'C reject .lock component');
expectBaseReject('main~1', 'unsafe in git refs', 'C reject tilde revision syntax');
expectBaseReject('main;rm', 'ASCII branch-name characters', 'C reject shell-ish separator');

// ---------------------------------------------------------------------------
// Part D - worktree build-dependency setup gate. This proves `npm run build`
// does not pretend to run in a fresh worktree when gitignored dependencies are
// absent, while dependency-free validation remains allowed.
// ---------------------------------------------------------------------------
console.log('\n--- Part D: worktree validation dependency gate (pure helper) ---');
{
  const r = checkWorktreeValidationSetup('node --check server/index.js', () => false, 'win32');
  line(r.ok === true && r.setupGated === false, `D node --check needs no dependency preflight -> ${JSON.stringify(r)}`);
}
{
  const present = new Set(['package.json']);
  const r = checkWorktreeValidationSetup('npm run build', (rel) => present.has(rel), 'win32');
  line(r.ok === false && r.setupGated === true && r.missing.includes('node_modules/') && r.reason.includes('Dependency-gated'),
    `D npm run build setup-gated when worktree deps are missing -> ${JSON.stringify(r)}`);
}
{
  const present = new Set(['package.json', 'node_modules', 'node_modules/.bin/vite.cmd']);
  const r = checkWorktreeValidationSetup('npm run build', (rel) => present.has(rel), 'win32');
  line(r.ok === true && r.setupGated === false, `D npm run build allowed when Windows worktree deps are present -> ${JSON.stringify(r)}`);
}
{
  const present = new Set(['package.json', 'node_modules', 'node_modules/.bin/vite']);
  const r = checkWorktreeValidationSetup('npm run build', (rel) => present.has(rel), 'linux');
  line(r.ok === true && r.setupGated === false, `D npm run build allowed when POSIX worktree deps are present -> ${JSON.stringify(r)}`);
}

// ---------------------------------------------------------------------------
// Part E - executor runtime/file/output limits. These pure checks prove the
// harness can name limit failures without enabling real OpenHands invocation.
// ---------------------------------------------------------------------------
console.log('\n--- Part E: executor runtime/file/output limits (pure helpers) ---');
{
  const r = checkExecutorMaxFilesChanged(0);
  line(r.ok === false && r.reason.includes('must be 1-5'), `E reject maxFilesChanged below limit -> ${JSON.stringify(r)}`);
}
{
  const r = checkExecutorMaxFilesChanged(5);
  line(r.ok === true && r.maxFiles === 5, `E allow maxFilesChanged at upper bound -> ${JSON.stringify(r)}`);
}
{
  const r = checkExecutorMaxFilesChanged(6);
  line(r.ok === false && r.reason.includes('must be 1-5'), `E reject maxFilesChanged above limit -> ${JSON.stringify(r)}`);
}
{
  const r = summarizeExecutorCommandResult({ ok: false, timedOut: true, timeoutMs: 123 }, { label: 'validation', timeoutMs: 123 });
  line(r.limitHit === true && r.limit === 'runtime' && r.reason.includes('runtime limit'), `E runtime timeout is named -> ${JSON.stringify(r)}`);
}
{
  const r = summarizeExecutorCommandResult({ ok: false, outputLimitHit: true, maxBufferBytes: 456 }, { label: 'validation', outputMaxBytes: 456 });
  line(r.limitHit === true && r.limit === 'output' && r.reason.includes('output limit'), `E output cap is named -> ${JSON.stringify(r)}`);
}
{
  const r = limitExecutorReportText('abcdef', 3, 'validation output');
  line(r.truncated === true && r.text === 'abc' && r.reason.includes('truncated'), `E report text truncates clearly -> ${JSON.stringify(r)}`);
}
{
  const r = limitExecutorReportText('abc', 3, 'validation output');
  line(r.truncated === false && r.text === 'abc', `E report text within limit is preserved -> ${JSON.stringify(r)}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS - executor enforcement rejects real violating diffs, accepts allowed changes, rejects unsafe base branches, dependency-gates missing worktree build deps, and reports runtime/file/output limits.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
