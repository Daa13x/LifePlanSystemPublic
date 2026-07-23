import assert from 'node:assert/strict';
import {
  cloudMainWritePreflight,
  evaluateGitAuthority,
  generatedLocalBranch,
  repositoryIdentity
} from '../server/gitAuthorityPolicy.js';

const repository = 'https://github.com/Daa13x/LifePlanSystemPublic.git';
const commit = '0123456789abcdef0123456789abcdef01234567';
const taskId = 'LPS-NATIVE-20260723-ACCEPTANCE';
const branch = generatedLocalBranch({ taskId, namespace: 'agent' });

assert.equal(repositoryIdentity(repository), 'daa13x/lifeplansystempublic');
assert.equal(cloudMainWritePreflight('main').allowed, true);
assert.equal(cloudMainWritePreflight('feature/test').allowed, false);

const cloudBranch = evaluateGitAuthority({
  operation: 'branch_worktree', executionType: 'cloud', repository, activeBranch: 'main'
});
assert.equal(cloudBranch.allowed, false);

const localUnverified = evaluateGitAuthority({
  operation: 'branch_worktree', executionType: 'local', modelProvider: 'local-openai-compatible',
  modelId: 'local-coder', inferenceEndpoint: 'http://127.0.0.1:8080',
  localInferenceVerified: false, branchCreator: 'lifeplansystem-native-coding-controller',
  repository, startingCommit: commit, startingBranch: 'main', activeBranch: 'main',
  worktreeClean: true, taskId, taskCardValid: true, allowedPaths: ['src/'],
  protectedPathHits: [], targetBranch: branch
});
assert.equal(localUnverified.allowed, false);
assert.equal(localUnverified.receipt.executionType, 'cloud');

const localVerified = evaluateGitAuthority({
  operation: 'branch_worktree', executionType: 'local', modelProvider: 'llama.cpp',
  modelId: 'planner-coder', inferenceEndpoint: 'http://127.0.0.1:8080',
  localInferenceVerified: true, branchCreator: 'lifeplansystem-native-coding-controller',
  repository, startingCommit: commit, startingBranch: 'main', activeBranch: 'main',
  worktreeClean: true, taskId, taskCardValid: true, allowedPaths: ['src/'],
  protectedPathHits: [], targetBranch: branch
});
assert.equal(localVerified.allowed, true);
assert.equal(localVerified.receipt.permissions.createBranchBackedWorktree, true);
assert.equal(localVerified.receipt.permissions.pushBranch, false);

const localPush = evaluateGitAuthority({
  operation: 'push', executionType: 'local', modelProvider: 'llama.cpp', modelId: 'planner-coder',
  inferenceEndpoint: 'http://127.0.0.1:8080', localInferenceVerified: true,
  branchCreator: 'lifeplansystem-native-coding-controller'
});
assert.equal(localPush.allowed, false);

console.log('Git authority policy verification passed.');
