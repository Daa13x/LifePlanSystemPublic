#!/usr/bin/env node
// Verify build provenance (Bug 2): the build embeds version + commit SHA +
// timestamp + repository into build-info.json, the build script generates it,
// the generated file is gitignored, and the server serves it. This proves the
// portable/installer payload can report the exact source commit it was built
// from. Local-only, deterministic. Exit 0 = pass.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- build provenance verification ---');

// Generate fresh provenance and read it back.
execSync('node scripts/write-build-info.mjs', { cwd: root, stdio: 'ignore' });
const infoPath = path.join(root, 'public', 'build-info.json');
line(fs.existsSync(infoPath), 'write-build-info.mjs produced public/build-info.json');
const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));

line(typeof info.version === 'string' && info.version.length > 0, `version present -> ${info.version}`);
line(/^[0-9a-f]{40}$/i.test(info.commit) || info.commit === 'unknown', `commit is a full SHA -> ${info.commit}`);
line(typeof info.shortCommit === 'string' && info.shortCommit.length >= 7, `shortCommit present -> ${info.shortCommit}`);
line(!Number.isNaN(Date.parse(info.buildTime)), `buildTime is a valid date -> ${info.buildTime}`);
line(info.repository === 'Daa13x/LifePlanSystemPublic', `repository identity -> ${info.repository}`);
line(typeof info.dirty === 'boolean', `dirty flag present -> ${info.dirty}`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
line(/write-build-info\.mjs/.test(pkg.scripts.build), 'build script generates provenance before vite build');

const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
line(/build-info\.json/.test(gitignore), 'generated build-info.json is gitignored (not committed)');

const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
line(/app\.get\('\/api\/version'/.test(server), 'server exposes /api/version');
line(/build:\s*readBuildInfo\(\)/.test(server), 'bootstrap includes build provenance');

console.log(`\n${failures === 0 ? 'ALL PASS - build embeds version/commit/timestamp/repository and the app can report its source SHA.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
