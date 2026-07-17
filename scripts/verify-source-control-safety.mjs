import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canUseGitHubToken,
  detectHighConfidenceSecrets,
  isProtectedWorkspacePath,
  parseNullSeparatedPaths,
  parsePorcelainStatus,
  publicationBoundary,
  validateRemoteUrl
} from '../server/sourceControlSafety.js';

const protectedFixtures = [
  '.env',
  'nested/.env.local',
  'nested/.env.secret',
  'nested/data/private.json',
  'project/.claude/settings.json',
  'project/.git/config',
  '.safety-probe/ui-audit.sqlite-wal',
  'runtime/private.sqlite-shm',
  'runtime/private.db-wal',
  'connector/pairing-config.json',
  '.playwright-cli/page.yml',
  'models/brain.gguf',
  'logs/server.log'
];
for (const fixture of protectedFixtures) {
  assert.equal(isProtectedWorkspacePath(fixture), true, `${fixture} must be protected at any depth`);
}
assert.equal(isProtectedWorkspacePath('src/main.jsx'), false);
assert.deepEqual(parseNullSeparatedPaths('src/main.jsx\0nested/.env\0'), ['src/main.jsx', 'nested/.env']);
assert.deepEqual(parseNullSeparatedPaths(' leading.txt\0trailing .txt\0'), [' leading.txt', 'trailing .txt']);

const parsedRename = parsePorcelainStatus('R  safe.txt\0nested/.env.secret\0?? line\nfeed.txt\0');
assert.deepEqual(parsedRename, [
  { status: 'R', path: 'safe.txt', originalPath: 'nested/.env.secret', staged: true, protected: true },
  { status: '??', path: 'line\nfeed.txt', originalPath: '', staged: false, protected: false }
]);

const publicHttps = 'https://github.com/Daa13x/LifePlanSystemPublic.git';
const publicSsh = 'git@github.com:Daa13x/LifePlanSystemPublic.git';
assert.equal(validateRemoteUrl(publicHttps).ok, true);
assert.equal(validateRemoteUrl(publicSsh).ok, true);
assert.equal(validateRemoteUrl('https://huggingface.co/user/models').ok, true);
assert.equal(validateRemoteUrl('https://example.invalid/user/repo.git').ok, false);
assert.equal(validateRemoteUrl('https://token@example.com/user/repo.git').ok, false);
assert.equal(validateRemoteUrl('file:///private/repo').ok, false);

assert.equal(publicationBoundary(publicHttps, { hasPublicPolicy: true }).allowed, true);
assert.equal(publicationBoundary(publicHttps, { hasPublicPolicy: false }).allowed, false);
assert.equal(publicationBoundary('https://github.com/Daa13x/LifePlanSystem.git', { hasPublicPolicy: true }).allowed, false);
assert.equal(publicationBoundary('https://github.com/other/unknown.git', { hasPublicPolicy: true }).allowed, false);

const fakeToken = 'ghp_test_only_not_a_real_token';
assert.equal(canUseGitHubToken(publicHttps), true);
assert.equal(canUseGitHubToken(publicSsh), false);
assert.equal(canUseGitHubToken('https://huggingface.co/user/repo'), false);
assert.equal(canUseGitHubToken('https://example.invalid/user/repo'), false);
const serverSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
assert.match(serverSource, /GIT_ASKPASS_REQUIRE/);
assert.match(serverSource, /LPS_GIT_ASKPASS_TOKEN/);
assert.doesNotMatch(serverSource, /authenticatedGitHubRemoteUrl/);
assert.doesNotMatch(serverSource, /x-access-token:\$\{token\}@/);

assert.deepEqual(detectHighConfidenceSecrets('normal docs and ghp_short_example'), []);
assert.deepEqual(detectHighConfidenceSecrets(`value=ghp_${'A'.repeat(36)}`), ['GitHub token']);
assert.deepEqual(detectHighConfidenceSecrets('-----BEGIN PRIVATE KEY-----'), ['private key']);

const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-source-status-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: probeRoot });
  execFileSync('git', ['config', 'user.name', 'Verifier'], { cwd: probeRoot });
  execFileSync('git', ['config', 'user.email', 'verifier@example.invalid'], { cwd: probeRoot });
  fs.writeFileSync(path.join(probeRoot, 'safe.txt'), 'safe\n');
  execFileSync('git', ['add', 'safe.txt'], { cwd: probeRoot });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: probeRoot });
  fs.mkdirSync(path.join(probeRoot, 'nested'));
  execFileSync('git', ['mv', 'safe.txt', 'nested/.env.secret'], { cwd: probeRoot });
  const unusualName = process.platform === 'win32' ? 'space name.txt' : 'line\nfeed.txt';
  fs.writeFileSync(path.join(probeRoot, unusualName), 'unusual filename\n');
  const rawStatus = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: probeRoot, encoding: 'utf8' });
  const parsedStatus = parsePorcelainStatus(rawStatus);
  assert.equal(parsedStatus.length, 2);
  assert.equal(parsedStatus.find((item) => item.originalPath === 'safe.txt')?.path, 'nested/.env.secret');
  assert.equal(parsedStatus.find((item) => item.originalPath === 'safe.txt')?.protected, true);
  assert.equal(parsedStatus.find((item) => item.path === unusualName)?.status, '??');
} finally {
  fs.rmSync(probeRoot, { recursive: true, force: true });
}

console.log('Source Control safety verification passed.');
