import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const portableRoot = path.resolve(process.argv[2] || 'release/LifePlannerPortable');
const required = [
  'Start Life Planner.cmd',
  'Start Life Planner.vbs',
  'LifePlannerTray.ps1',
  'life-planner-app.ico',
  'Install Playwright Chromium.cmd',
  'node/node.exe',
  'app/dist/index.html',
  'app/server/index.js',
  'app/node_modules/express/package.json',
  'app/node_modules/playwright-core/lib/serverRegistry.js',
  'app/node_modules/@rollup/rollup-win32-x64-msvc/package.json',
  'app/node_modules/@babel/compat-data/data/corejs2-built-ins.json',
  'app/scripts/build-installer.ps1',
  'app/scripts/package-portable.ps1',
  'app/scripts/windows/LifePlannerTray.ps1',
  'app/installer/LifePlannerPortable.iss',
  'app/installer/assets/life-planner-app.ico',
  'app/src/main.jsx',
  'app/index.html',
  'app/vite.config.js'
];

for (const relative of required) {
  assert.ok(fs.existsSync(path.join(portableRoot, relative)), `Required portable file is missing: ${relative}`);
}

const forbidden = [
  'app/data',
  'app/.env',
  'app/.git',
  'app/.claude',
  'app/browser-extension/lps-browser-agent/pairing-config.json'
];
for (const relative of forbidden) {
  assert.ok(!fs.existsSync(path.join(portableRoot, relative)), `Private path leaked into portable package: ${relative}`);
}

const manifestPath = path.join(portableRoot, 'PACKAGED_FILES.txt');
assert.ok(fs.existsSync(manifestPath), 'PACKAGED_FILES.txt is missing.');
const manifest = fs.readFileSync(manifestPath, 'utf8');
assert.doesNotMatch(manifest, /(^|\/)pairing-config\.json$/im);
assert.doesNotMatch(manifest, /(^|\/)\.env$/im);
assert.doesNotMatch(manifest, /(^|\/)data\/life-planner\.sqlite$/im);

const buildScript = fs.readFileSync(path.join(portableRoot, 'app/scripts/build-installer.ps1'), 'utf8');
const packageScript = fs.readFileSync(path.join(portableRoot, 'app/scripts/package-portable.ps1'), 'utf8');
const trayScript = fs.readFileSync(path.join(portableRoot, 'LifePlannerTray.ps1'), 'utf8');
const vbsLauncher = fs.readFileSync(path.join(portableRoot, 'Start Life Planner.vbs'), 'utf8');
assert.match(buildScript, /Start-Process[\s\S]*-Wait[\s\S]*ExitCode/);
assert.match(packageScript, /bundledNodeRoot/);
assert.match(packageScript, /npmCommand/);
assert.match(packageScript, /LifePlannerTray\.ps1/);
assert.doesNotMatch(packageScript, /timeout\s+\/t\s+2/i);
assert.match(trayScript, /System\.Windows\.Forms\.NotifyIcon/);
assert.match(trayScript, /Pause environment/);
assert.match(trayScript, /Resume environment/);
assert.match(trayScript, /Exit environment/);
assert.match(vbsLauncher, /WindowStyle Hidden/);

console.log(`Portable package verification passed: ${portableRoot}`);
