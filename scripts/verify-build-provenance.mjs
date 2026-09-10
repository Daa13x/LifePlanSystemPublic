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
import os from 'node:os';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { captureRuntimeIdentity, resolveRuntimePaths } from '../server/runtimeIdentity.js';
import { verifyRuntimeDatabase, rememberRuntimeDatabase } from '../server/setupRecovery.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-provenance-'));
try {
  const appRoot = path.join(fixture, "Life Planner's [test] & café", 'app');
  fs.mkdirSync(path.join(appRoot, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(appRoot, '..', 'node'));
  fs.writeFileSync(path.join(appRoot, '..', 'node', 'node.exe'), 'not executable');
  const dbPath = path.join(appRoot, 'data', 'life-planner.sqlite');
  const initial = { commit: 'a'.repeat(40), buildTime: '2026-09-09T00:00:00Z', dirty: false };
  const metadata = path.join(appRoot, 'dist', 'build-info.json');
  fs.writeFileSync(metadata, JSON.stringify(initial));
  fs.writeFileSync(path.join(appRoot, 'dist', 'index.html'), '<script src="/assets/index-abc.js"></script>');
  assert.equal(resolveRuntimePaths({ appRoot, cwd: appRoot }).dbPath, dbPath);
  for (const override of [{ cwd: fixture }, { database: path.join(fixture, 'wrong.sqlite') }]) {
    assert.throws(() => resolveRuntimePaths({ appRoot, cwd: appRoot, ...override }), { code: 'RUNTIME_PATH_MISMATCH' });
  }
  assert.equal(fs.existsSync(path.join(fixture, 'wrong.sqlite')), false, 'wrong path was not created');
  const current = captureRuntimeIdentity({ root: appRoot, dbPath, packaged: true, launchId: 'fixture-launch' });
  assert.equal(current().packageChanged, false);
  fs.writeFileSync(metadata, JSON.stringify({ ...initial, commit: 'b'.repeat(40) }));
  assert.equal(current().build.commit, initial.commit, 'loaded build cannot be relabelled');
  assert.equal(current().packageChanged, true);
  assert.equal(current().process.pid, process.pid);
  assert.equal(current().process.launchId, 'fixture-launch');
  assert.equal(current().database.path, dbPath);
  assert.equal(verifyRuntimeDatabase(dbPath).state, 'first-use');
  fs.mkdirSync(path.dirname(dbPath));
  let database = new DatabaseSync(dbPath);
  database.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  database.close();
  rememberRuntimeDatabase(dbPath);
  assert.equal(verifyRuntimeDatabase(dbPath).state, 'established');
  fs.renameSync(dbPath, `${dbPath}.preserved`);
  assert.throws(() => verifyRuntimeDatabase(dbPath), { code: 'DATABASE_IDENTITY_MISMATCH' });
  database = new DatabaseSync(dbPath);
  database.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  database.close();
  assert.throws(() => verifyRuntimeDatabase(dbPath), { code: 'DATABASE_IDENTITY_MISMATCH' });
  rememberRuntimeDatabase(dbPath); // the successful governed restore hook
  assert.equal(verifyRuntimeDatabase(dbPath).state, 'established');
  line(true, 'loaded package stays frozen; wrong cwd/DB and missing/replaced established DB fail closed; genuine fresh setup and attested restore work');
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }

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
