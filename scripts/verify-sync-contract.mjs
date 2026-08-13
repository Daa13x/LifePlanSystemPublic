import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const requiredFiles = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
  'docs/REPOSITORY_SYNC_CONTRACT.md',
  'scripts/sync-main.mjs',
  '.githooks/commit-msg',
  '.githooks/pre-commit',
  '.githooks/pre-push'
];
for (const file of requiredFiles) assert.ok(exists(file), `Missing synchronization contract file: ${file}`);

const packageJson = JSON.parse(read('package.json'));
const scripts = packageJson.scripts || {};
assert.equal(scripts['sync:prepare'], 'node scripts/sync-main.mjs --prepare');
assert.equal(scripts['sync:publish'], 'node scripts/sync-main.mjs --publish');
assert.equal(scripts['sync:verify'], 'node scripts/sync-main.mjs --verify');
assert.match(scripts['policy:agent-start'] || '', /sync:prepare/);
assert.match(scripts['policy:agent-start'] || '', /policy:cloud-main/);
assert.match(scripts['policy:agent-finish'] || '', /sync:publish/);
assert.match(scripts['policy:agent-finish'] || '', /sync:verify/);
assert.match(scripts['verify:runtime-safety'] || '', /verify:sync-contract/);

for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md']) {
  const content = read(file);
  assert.match(content, /npm run policy:agent-start/, `${file} must require synchronized startup.`);
  assert.match(content, /npm run sync:publish/, `${file} must require immediate publication.`);
  assert.match(content, /npm run policy:agent-finish/, `${file} must require final exact verification.`);
  assert.match(content, /force-push/i, `${file} must prohibit force-push recovery.`);
}

const syncGuard = read('scripts/sync-main.mjs');
for (const mode of ['--prepare', '--pre-commit', '--pre-push', '--publish', '--verify']) {
  assert.ok(syncGuard.includes(mode), `Synchronization guard is missing mode ${mode}.`);
}
assert.match(syncGuard, /fetch.*origin.*main/s);
assert.match(syncGuard, /pull.*--ff-only.*origin.*main/s);
assert.match(syncGuard, /push.*origin.*HEAD:main/s);
assert.match(syncGuard, /origin\/main\.\.\.HEAD/);
assert.match(syncGuard, /lps-sync-state\.json/);

const hookInstaller = read('scripts/install-git-hooks.mjs');
for (const hook of ['commit-msg', 'pre-commit', 'pre-push']) {
  assert.ok(hookInstaller.includes(`'${hook}'`), `Hook installer does not install ${hook}.`);
}
assert.match(read('.githooks/pre-commit'), /sync-main\.mjs --pre-commit/);
assert.match(read('.githooks/pre-commit'), /verify-ma-lock\.mjs --staged/);
assert.match(read('.githooks/pre-push'), /sync-main\.mjs --pre-push/);

console.log('LifePlanSystem synchronization contract, model instructions, scripts, and hooks are present and fail-closed.');
