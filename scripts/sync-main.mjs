import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mode = process.argv[2] || '--verify';
const validModes = new Set(['--prepare', '--verify', '--pre-commit', '--pre-push', '--publish']);
const approvedRepositories = new Set(['Daa13x/LifePlanSystem', 'Daa13x/LifePlanSystemPublic']);

if (!validModes.has(mode)) {
  console.error(`Unknown sync mode: ${mode}`);
  process.exit(2);
}

function git(args, { allowFailure = false } = {}) {
  try {
    return String(execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    })).trim();
  } catch (error) {
    if (allowFailure) return null;
    const stderr = String(error.stderr || '').trim();
    const stdout = String(error.stdout || '').trim();
    throw new Error(stderr || stdout || error.message || `git ${args.join(' ')} failed`);
  }
}

function fail(message) {
  throw new Error(`LPS sync guard blocked this operation: ${message}`);
}

function repositoryIdentity(remoteUrl) {
  const value = String(remoteUrl || '').trim().replace(/\\/g, '/');
  const match = value.match(/(?:github\.com[/:])([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : '';
}

function ensureRepository() {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') fail('this folder is not a Git working tree.');
  const branch = git(['branch', '--show-current']);
  if (branch !== 'main') fail(`the active branch is '${branch || '(detached)'}', not 'main'. Preserve the work and return to main before continuing.`);

  const originUrl = git(['remote', 'get-url', 'origin']);
  const repository = repositoryIdentity(originUrl);
  if (!approvedRepositories.has(repository)) fail(`origin resolves to '${repository || originUrl}', not an approved LifePlanSystem repository.`);

  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true });
  if (upstream !== 'origin/main') fail(`main must track origin/main; current upstream is '${upstream || '(none)'}'. Run: git branch --set-upstream-to=origin/main main`);

  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']) {
    const markerPath = git(['rev-parse', '--git-path', marker]);
    const resolved = path.isAbsolute(markerPath) ? markerPath : path.resolve(root, markerPath);
    if (fs.existsSync(resolved)) fail(`a Git operation is still in progress (${marker}). Finish or abort it before continuing.`);
  }

  return { repository };
}

function fetchMain() {
  git(['fetch', '--prune', 'origin', 'main']);
  if (!git(['rev-parse', '--verify', 'refs/remotes/origin/main'], { allowFailure: true })) {
    fail('origin/main does not exist after fetch.');
  }
}

function divergence() {
  const raw = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD']);
  const [behindText, aheadText] = raw.split(/\s+/);
  const behind = Number(behindText);
  const ahead = Number(aheadText);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) fail(`could not parse divergence count '${raw}'.`);
  return { behind, ahead };
}

function workingTreeChanges() {
  return git(['status', '--porcelain=v1', '--untracked-files=all']);
}

function requireClean(context) {
  const changes = workingTreeChanges();
  if (changes) fail(`${context} requires a clean working tree. Preserve or finish these changes first:\n${changes}`);
}

function statePath() {
  const gitPath = git(['rev-parse', '--git-path', 'lps-sync-state.json']);
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(root, gitPath);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(repository, reason) {
  const head = git(['rev-parse', 'HEAD']);
  const originHead = git(['rev-parse', 'origin/main']);
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({
    repository,
    branch: 'main',
    head,
    originHead,
    reason,
    checkedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
}

function requirePreparedState(repository) {
  const state = readState();
  if (!state) fail('no sync preparation receipt exists. Run npm run sync:prepare before editing.');
  const head = git(['rev-parse', 'HEAD']);
  const originHead = git(['rev-parse', 'origin/main']);
  if (state.repository !== repository || state.branch !== 'main') fail('the sync preparation receipt belongs to a different repository or branch. Run npm run sync:prepare.');
  if (state.head !== head || state.originHead !== originHead) fail('HEAD or origin/main changed after the last sync preparation. Run npm run sync:prepare again before committing.');
}

function requireExactSync() {
  const { behind, ahead } = divergence();
  if (behind !== 0 || ahead !== 0) fail(`main is not synchronized with origin/main (behind ${behind}, ahead ${ahead}).`);
  const head = git(['rev-parse', 'HEAD']);
  const originHead = git(['rev-parse', 'origin/main']);
  if (head !== originHead) fail('HEAD and origin/main do not resolve to the same commit.');
  return head;
}

try {
  const { repository } = ensureRepository();

  if (mode === '--prepare') {
    requireClean('sync preparation');
    fetchMain();
    let { behind, ahead } = divergence();
    if (behind > 0 && ahead > 0) fail(`main has diverged from origin/main (behind ${behind}, ahead ${ahead}). Do not merge, rebase, reset, or force-push automatically; preserve the work and reconcile deliberately.`);
    if (ahead > 0) fail(`local main has ${ahead} unpushed commit(s). Publish them with npm run sync:publish before starting more work.`);
    if (behind > 0) {
      git(['pull', '--ff-only', 'origin', 'main']);
      fetchMain();
      ({ behind, ahead } = divergence());
    }
    requireClean('sync preparation');
    const head = requireExactSync();
    writeState(repository, 'prepare');
    console.log(`LPS sync preparation passed: ${repository} main@${head.slice(0, 12)} is clean and exactly matches origin/main.`);
  }

  if (mode === '--pre-commit') {
    fetchMain();
    const { behind, ahead } = divergence();
    if (behind > 0 || ahead > 0) fail(`commit base is stale or prior commits are still unpublished (behind ${behind}, ahead ${ahead}). Preserve current changes, restore exact sync, then reapply or continue.`);
    requirePreparedState(repository);
    console.log('LPS pre-commit sync guard passed: commit base still matches origin/main and no earlier commit is waiting to be pushed.');
  }

  if (mode === '--pre-push') {
    fetchMain();
    const { behind, ahead } = divergence();
    if (behind > 0) fail(`origin/main advanced before this push (behind ${behind}, ahead ${ahead}). The push is blocked; never force-push. Reconcile from current origin/main first.`);
    if (ahead === 0) console.log('LPS pre-push sync guard: main already matches origin/main.');
    else console.log(`LPS pre-push sync guard passed: ${ahead} local commit(s) can be fast-forwarded to origin/main.`);
  }

  if (mode === '--publish') {
    requireClean('publishing');
    fetchMain();
    const { behind, ahead } = divergence();
    if (behind > 0) fail(`cannot publish because origin/main advanced (behind ${behind}, ahead ${ahead}). Never force-push; reconcile safely first.`);
    if (ahead > 0) git(['push', 'origin', 'HEAD:main']);
    fetchMain();
    requireClean('publish verification');
    const head = requireExactSync();
    writeState(repository, 'publish');
    console.log(`LPS publish passed: local main and origin/main are both ${head}.`);
  }

  if (mode === '--verify') {
    requireClean('sync verification');
    fetchMain();
    const head = requireExactSync();
    writeState(repository, 'verify');
    console.log(`LPS sync verification passed: clean main and origin/main both resolve to ${head}.`);
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
