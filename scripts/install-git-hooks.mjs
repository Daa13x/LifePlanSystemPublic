import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceHook = path.join(root, '.githooks', 'commit-msg');
const gitDir = path.join(root, '.git');

if (!fs.existsSync(gitDir)) {
  console.log('Git hook setup skipped: this package is not running from a Git checkout.');
  process.exit(0);
}

if (!fs.existsSync(sourceHook)) {
  throw new Error(`Required ownership guard hook is missing: ${sourceHook}`);
}

const hooksDir = path.join(gitDir, 'hooks');
const installedHook = path.join(hooksDir, 'commit-msg');
fs.mkdirSync(hooksDir, { recursive: true });
fs.copyFileSync(sourceHook, installedHook);
try {
  fs.chmodSync(installedHook, 0o755);
} catch {
  // Git for Windows can execute the shebang hook without POSIX mode changes.
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

console.log(`Git ownership guard installed: ${installedHook}`);
