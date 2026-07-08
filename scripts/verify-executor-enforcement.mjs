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
  enforceChangedFiles,
  parsePorcelainPaths,
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

console.log(`\n${failures === 0 ? 'ALL PASS — executor enforcement rejects real violating diffs and accepts allowed changes.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
