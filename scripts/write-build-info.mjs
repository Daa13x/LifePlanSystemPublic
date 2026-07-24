#!/usr/bin/env node
// Emit build provenance to public/build-info.json (copied into dist/ by Vite and
// therefore into the portable bundle + installer payload). The server serves it
// and the UI shows it, so the installed app can report the exact source commit
// it was built from. In CI, GITHUB_SHA is authoritative.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function git(args, fallback = '') {
  try { return execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return fallback; }
}

const commit = process.env.GITHUB_SHA || git('rev-parse HEAD', 'unknown');
const dirty = process.env.GITHUB_SHA ? false : git('status --porcelain') !== '';
const info = {
  version: pkg.version,
  commit,
  shortCommit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 12) : 'unknown',
  buildTime: new Date().toISOString(),
  repository: 'Daa13x/LifePlanSystemPublic',
  dirty
};

const outDir = path.join(root, 'public');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('build-info:', JSON.stringify(info));
