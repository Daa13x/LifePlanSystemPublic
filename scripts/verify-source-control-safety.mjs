import assert from 'node:assert/strict';
import {
  authenticatedGitHubRemoteUrl,
  canUseGitHubToken,
  isProtectedWorkspacePath,
  parseNullSeparatedPaths,
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
  'models/brain.gguf',
  'logs/server.log'
];
for (const fixture of protectedFixtures) {
  assert.equal(isProtectedWorkspacePath(fixture), true, `${fixture} must be protected at any depth`);
}
assert.equal(isProtectedWorkspacePath('src/main.jsx'), false);
assert.deepEqual(parseNullSeparatedPaths('src/main.jsx\0nested/.env\0'), ['src/main.jsx', 'nested/.env']);

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
assert.match(authenticatedGitHubRemoteUrl(publicHttps, fakeToken), /^https:\/\/x-access-token:ghp_test_only_not_a_real_token@github\.com\//);
assert.equal(authenticatedGitHubRemoteUrl('https://example.invalid/user/repo', fakeToken), 'https://example.invalid/user/repo');

console.log('Source Control safety verification passed.');
