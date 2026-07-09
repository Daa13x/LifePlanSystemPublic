#!/usr/bin/env node
// Verify runCli working-directory handling.
//
// Proves, using the REAL resolveRunCliCwd (the same function server/index.js
// wires into runCli):
//   1. No cwd supplied        -> defaults to the repo root.
//   2. Caller-provided cwd    -> honoured when inside the repo root
//                                (a real child process observes it).
//   3. Executor worktree wiring: the executor still passes its worktree path
//      through to runCli, and runCli routes every execution through the
//      resolver (no hard-coded cwd remains in its body).
//   4. No escape: cwd values outside the repo root (absolute escapes, ".."
//      traversal, control characters, non-strings) are refused.
//   5. No OpenHands invocation is enabled by any of this.
//
// Local-only: no network, no OpenHands call, no server boot, no repo mutation.
// Exit code 0 = all checks pass; non-zero = a check failed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRunCliCwd } from '../server/runCliCwd.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };
const samePath = (a, b) => path.relative(a, b) === '';

console.log('--- runCli cwd verification ---');

// 1. Default: no cwd -> repo root.
{
  for (const missing of [undefined, null, '', '   ']) {
    const r = resolveRunCliCwd(repoRoot, missing);
    line(r.ok === true && samePath(r.cwd, repoRoot) && r.source === 'default-root',
      `no cwd (${JSON.stringify(missing)}) defaults to root -> ${JSON.stringify(r)}`);
  }
}

// 2. Caller cwd honoured when inside root (absolute and relative forms).
{
  const scriptsAbs = path.join(repoRoot, 'scripts');
  const abs = resolveRunCliCwd(repoRoot, scriptsAbs);
  line(abs.ok === true && samePath(abs.cwd, scriptsAbs) && abs.source === 'caller-cwd',
    `absolute in-root cwd honoured -> ${JSON.stringify(abs)}`);
  const rel = resolveRunCliCwd(repoRoot, 'scripts');
  line(rel.ok === true && samePath(rel.cwd, scriptsAbs),
    `relative in-root cwd resolves against root -> ${JSON.stringify(rel)}`);
  const rootItself = resolveRunCliCwd(repoRoot, repoRoot);
  line(rootItself.ok === true && samePath(rootItself.cwd, repoRoot),
    `root itself is accepted -> ${JSON.stringify(rootItself)}`);
}

// 3. Real child process observes the resolved cwd (the exact shape runCli
//    passes to execFile). Run node -e in the default and a caller cwd.
{
  const probe = (resolution) => execFileSync(
    process.execPath, ['-e', 'process.stdout.write(process.cwd())'],
    { cwd: resolution.cwd, encoding: 'utf8', windowsHide: true });
  const def = probe(resolveRunCliCwd(repoRoot, undefined));
  line(samePath(def, repoRoot), `child process without cwd runs in root -> ${def}`);
  const wt = probe(resolveRunCliCwd(repoRoot, 'scripts'));
  line(samePath(wt, path.join(repoRoot, 'scripts')),
    `child process with caller cwd runs THERE, not in root -> ${wt}`);
  line(!samePath(wt, repoRoot), 'caller-cwd child did not run in the repo root');
}

// 4. Escapes are refused (never executed, never silently retargeted to root).
{
  const cases = [
    [os.tmpdir(), 'absolute path outside root (OS temp)'],
    ['..', '".." traversal to parent'],
    ['../..', '"../.." traversal'],
    ['scripts/../../outside', 'nested traversal escaping root'],
    ['bad	dir', 'control character (tab)'],
    [42, 'non-string value']
  ];
  for (const [value, label] of cases) {
    const r = resolveRunCliCwd(repoRoot, value);
    line(r.ok === false && typeof r.reason === 'string' && r.reason.length > 0 && r.cwd === undefined,
      `${label} refused with reason -> ${JSON.stringify(r)}`);
  }
}

// 5. Wiring in server/index.js: runCli routes through the resolver, keeps no
//    hard-coded cwd, and the executor still hands its worktree path to runCli.
{
  const source = fs.readFileSync(path.join(repoRoot, 'server', 'index.js'), 'utf8');
  const start = source.indexOf('async function runCli');
  const ends = ['\nfunction ', '\nasync function ', '\nconst ']
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((idx) => idx > start);
  const end = ends.length ? Math.min(...ends) : start + 3000;
  const body = start >= 0 ? source.slice(start, end) : '';
  line(body.includes('resolveRunCliCwd(root, options.cwd)'),
    'runCli resolves cwd through resolveRunCliCwd');
  line(!/cwd:\s*root\b/.test(body) && !/cwd:\s*options\.cwd\s*\|\|\s*root/.test(body),
    'runCli body contains no hard-coded or unvalidated cwd fallback');
  line(body.includes('cwd: cwdResolution.cwd'), 'runCli executes with the RESOLVED cwd');
  line(source.includes('cwd: worktreePath'),
    'executor validation still passes its isolated worktree cwd to runCli');
  line(source.includes('const OPENHANDS_EXECUTOR_INVOCATION_ENABLED = false'),
    'OPENHANDS_EXECUTOR_INVOCATION_ENABLED remains false');
}

// 6. The resolver module itself stays pure: no process/network/fs capability.
{
  const helper = fs.readFileSync(path.join(repoRoot, 'server', 'runCliCwd.js'), 'utf8');
  const forbidden = [/child_process/, /\bspawn\s*\(/, /\bexecFile\s*\(/, /\bfetch\s*\(/, /node:http/, /node:fs/];
  const hits = forbidden.filter((p) => p.test(helper)).map(String);
  line(hits.length === 0, `resolver module has no process/network/fs capability -> ${JSON.stringify(hits)}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS - runCli defaults to root, honours in-root caller cwd, and refuses escaping cwd values.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
