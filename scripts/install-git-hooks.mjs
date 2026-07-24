import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const hook = path.join(root, '.githooks', 'commit-msg');

if (!fs.existsSync(path.join(root, '.git'))) {
  console.log('Git hook setup skipped: this package is not running from a Git checkout.');
  process.exit(0);
}

if (!fs.existsSync(hook)) {
  throw new Error(`Required ownership guard hook is missing: ${hook}`);
}

execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

console.log('Git ownership guard installed: core.hooksPath=.githooks');
