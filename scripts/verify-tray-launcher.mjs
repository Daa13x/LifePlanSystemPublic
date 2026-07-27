import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const tray = read('scripts/windows/LifePlannerTray.ps1');
const packaging = read('scripts/package-portable.ps1');
const installer = read('installer/LifePlannerPortable.iss');

assert.match(tray, /System\.Windows\.Forms\.NotifyIcon/);
assert.match(tray, /Pause environment/);
assert.match(tray, /Resume environment/);
assert.match(tray, /Exit environment/);
assert.match(tray, /life-planner-app\.ico/);
assert.match(tray, /System\.Threading\.Mutex/);
assert.match(tray, /CreateNoWindow|WindowStyle Hidden/);
assert.match(tray, /\/api\/health/);
assert.match(tray, /taskkill\.exe \/PID \$processId \/T \/F/);
assert.match(tray, /RedirectStandardOutput/);
assert.match(tray, /RedirectStandardError/);
assert.match(tray, /Stop-LifePlannerServer\s*\n\s*throw \$failureMessage/);
assert.match(tray, /Ensure-LocalModelRuntime/);
assert.match(tray, /Life Planner restarted/);
assert.match(tray, /Start-LifePlannerServer\s*\n\s*\$notifyIcon\.ShowBalloonTip/);

assert.match(packaging, /LifePlannerTray\.ps1/);
assert.match(packaging, /Start Life Planner\.vbs/);
assert.match(packaging, /life-planner-app\.ico/);
assert.match(packaging, /Install-LlamaRuntime\.ps1/);
assert.doesNotMatch(packaging, /timeout\s+\/t\s+2/i);

assert.match(installer, /wscript\.exe/i);
assert.match(installer, /Start Life Planner\.vbs/);
assert.match(installer, /life-planner-app\.ico/);
// Optional runtime/browser downloads must NOT be executed during setup. Running
// elevated network-download scripts during install triggers Defender/SmartScreen
// prompts; the tray/app ensures the local model runtime on first launch under
// the user token (Ensure-LocalModelRuntime, above). See verify-installer-safety.mjs.
assert.doesNotMatch(installer, /Filename:[^\n]*Install Local Model Runtime\.cmd/i);
assert.doesNotMatch(installer, /Filename:[^\n]*Install Playwright Chromium\.cmd/i);
// The post-install app launch must drop to the original (non-elevated) user.
assert.match(installer, /postinstall[^\n]*runasoriginaluser/i);

console.log('Tray launcher static verification passed.');
