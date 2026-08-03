import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const hookNames = ['commit-msg', 'pre-commit', 'pre-push'];

function git(args) {
  return String(execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })).trim();
}

try {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    console.log('Git hook setup skipped: this package is not running from a Git checkout.');
    process.exit(0);
  }
} catch {
  console.log('Git hook setup skipped: this package is not running from a Git checkout.');
  process.exit(0);
}

for (const hookName of hookNames) {
  const sourceHook = path.join(root, '.githooks', hookName);
  if (!fs.existsSync(sourceHook)) {
    throw new Error(`Required LifePlanSystem Git guard hook is missing: ${sourceHook}`);
  }
}

// --git-path resolves both ordinary checkouts and linked Git worktrees.
const hooksPath = git(['rev-parse', '--git-path', 'hooks']);
const hooksDir = path.isAbsolute(hooksPath) ? hooksPath : path.resolve(root, hooksPath);
fs.mkdirSync(hooksDir, { recursive: true });

const installed = [];
for (const hookName of hookNames) {
  const sourceHook = path.join(root, '.githooks', hookName);
  const installedHook = path.join(hooksDir, hookName);
  fs.copyFileSync(sourceHook, installedHook);
  try {
    fs.chmodSync(installedHook, 0o755);
  } catch {
    // Git for Windows can execute the shebang hook without POSIX mode changes.
  }
  installed.push(installedHook);
}

try {
  execFileSync('git', ['config', '--local', '--unset-all', 'core.hooksPath'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
} catch {
  // No custom hooksPath was configured, which is already the desired state.
}

console.log(`LifePlanSystem Git guards installed:\n${installed.map((item) => `- ${item}`).join('\n')}`);
