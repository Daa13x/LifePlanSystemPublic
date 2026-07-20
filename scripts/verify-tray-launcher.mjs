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

assert.match(packaging, /LifePlannerTray\.ps1/);
assert.match(packaging, /Start Life Planner\.vbs/);
assert.match(packaging, /life-planner-app\.ico/);
assert.doesNotMatch(packaging, /timeout\s+\/t\s+2/i);

assert.match(installer, /wscript\.exe/i);
assert.match(installer, /Start Life Planner\.vbs/);
assert.match(installer, /life-planner-app\.ico/);

console.log('Tray launcher static verification passed.');
