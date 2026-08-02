import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  cloudMainWritePreflight,
  evaluateGitAuthority,
  repositoryIdentity
} from '../server/gitAuthorityPolicy.js';

const repository = 'https://github.com/Daa13x/LifePlanSystemPublic.git';
const commit = '0123456789abcdef0123456789abcdef01234567';
const taskId = 'LPS-NATIVE-20260723-ACCEPTANCE';

assert.equal(repositoryIdentity(repository), 'daa13x/lifeplansystempublic');
assert.equal(cloudMainWritePreflight('main').allowed, true);
assert.equal(cloudMainWritePreflight('feature/test').allowed, false);

const cloudBranch = evaluateGitAuthority({
  operation: 'branch_worktree', executionType: 'cloud', repository, activeBranch: 'main'
});
assert.equal(cloudBranch.allowed, false);

const localUnverified = evaluateGitAuthority({
  operation: 'detached_worktree', executionType: 'local', modelProvider: 'local-openai-compatible',
  modelId: 'local-coder', inferenceEndpoint: 'http://127.0.0.1:8080',
  localInferenceVerified: false, branchCreator: 'lifeplansystem-native-coding-controller',
  repository, startingCommit: commit, startingBranch: 'main', activeBranch: 'main',
  worktreeClean: true, taskId, taskCardValid: true, allowedPaths: ['src/'],
  protectedPathHits: []
});
assert.equal(localUnverified.allowed, false);
assert.equal(localUnverified.receipt.executionType, 'cloud');

const localVerified = evaluateGitAuthority({
  operation: 'detached_worktree', executionType: 'local', modelProvider: 'llama.cpp',
  modelId: 'planner-coder', inferenceEndpoint: 'http://127.0.0.1:8080',
  localInferenceVerified: true, branchCreator: 'lifeplansystem-native-coding-controller',
  repository, startingCommit: commit, startingBranch: 'main', activeBranch: 'main',
  worktreeClean: true, taskId, taskCardValid: true, allowedPaths: ['src/'],
  protectedPathHits: []
});
assert.equal(localVerified.allowed, true);
assert.equal(localVerified.receipt.permissions.createDetachedWorktree, true);
assert.equal(localVerified.receipt.permissions.createBranch, false);
assert.equal(localVerified.receipt.permissions.createBranchBackedWorktree, false);
assert.equal(localVerified.receipt.permissions.pushBranch, false);

for (const operation of ['create_branch', 'branch_worktree', 'switch_branch', 'delegate_branch']) {
  const denied = evaluateGitAuthority({
    operation, executionType: 'local', modelProvider: 'llama.cpp', modelId: 'planner-coder',
    inferenceEndpoint: 'http://127.0.0.1:8080', localInferenceVerified: true,
    branchCreator: 'lifeplansystem-native-coding-controller', repository,
    startingCommit: commit, startingBranch: 'main', activeBranch: 'main', worktreeClean: true,
    taskId, taskCardValid: true, allowedPaths: ['src/'], protectedPathHits: []
  });
  assert.equal(denied.allowed, false, `${operation} must stay disabled for local models`);
  assert.equal(denied.receipt.permissions.createBranch, false);
  assert.equal(denied.receipt.permissions.createBranchBackedWorktree, false);
}

const localPush = evaluateGitAuthority({
  operation: 'push', executionType: 'local', modelProvider: 'llama.cpp', modelId: 'planner-coder',
  inferenceEndpoint: 'http://127.0.0.1:8080', localInferenceVerified: true,
  branchCreator: 'lifeplansystem-native-coding-controller'
});
assert.equal(localPush.allowed, false);

const serverSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const nativeWorkerSource = fs.readFileSync(new URL('../server/nativeCodingWorker.js', import.meta.url), 'utf8');
assert.match(serverSource, /\['worktree', 'add', '--detach', worktreePath/,
  'legacy executor must create detached worktrees');
assert.match(nativeWorkerSource, /\['worktree', 'add', '--detach', worktree/,
  'native worker must create detached worktrees');
assert.doesNotMatch(`${serverSource}\n${nativeWorkerSource}`, /\['worktree', 'add', '-b'/,
  'model executors must never create branch-backed worktrees');

console.log('Git authority policy verification passed.');
