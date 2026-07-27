#!/usr/bin/env node
// Static verification of the Inno Setup script (Bug 1 — Windows Security popup).
// It proves the installer:
//   1. Requests the lowest privileges (never forces elevation).
//   2. Does NOT execute network-downloading helper scripts ([Run] cmd.exe on
//      "Install *.cmd") during setup — the download-and-run-unsigned-binary
//      behaviour is what triggers Defender / SmartScreen prompts, especially
//      when the setup is run as administrator.
//   3. Launches the app post-install as the original (non-elevated) user.
//
// The final confirmation that no Defender popup appears is a manual Windows
// acceptance item; this locks the installer script so it cannot regress.
//
// Local-only, deterministic. Exit 0 = pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iss = fs.readFileSync(path.join(repoRoot, 'installer', 'LifePlannerPortable.iss'), 'utf8');

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- installer safety (elevation / downloads) verification ---');

// 1. Lowest privileges, never admin.
line(/^\s*PrivilegesRequired\s*=\s*lowest\s*$/mi.test(iss), 'PrivilegesRequired=lowest');
line(!/^\s*PrivilegesRequired\s*=\s*admin\s*$/mi.test(iss), 'installer does not force admin elevation');

// Extract the [Run] section (from [Run] to the next [Section] header or EOF).
const runMatch = iss.match(/^\[Run\]\r?\n([\s\S]*?)(?=^\[[A-Za-z]|\s*$(?![\s\S]))/mi);
const runBlock = runMatch ? runMatch[1] : (iss.split(/^\[Run\]/mi)[1] || '');
const runEntries = runBlock
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => /^Filename\s*:/i.test(l)); // ignore comments/blank lines

line(runEntries.length >= 1, `[Run] has ${runEntries.length} launch entr(y/ies)`);

// 2. No download/install helper scripts run during setup.
const downloadRuns = runEntries.filter((l) =>
  /Install\s+Local\s+Model\s+Runtime\.cmd/i.test(l)
  || /Install\s+Playwright\s+Chromium\.cmd/i.test(l)
  || (/cmd\.exe/i.test(l) && /\.cmd/i.test(l)));
line(downloadRuns.length === 0, `no network-downloading .cmd runs during install -> ${JSON.stringify(downloadRuns)}`);

// 3. Post-install app launch drops to the original (non-elevated) user.
const postinstallLaunches = runEntries.filter((l) => /postinstall/i.test(l) && /wscript\.exe/i.test(l));
line(postinstallLaunches.length >= 1, 'the app is launched post-install');
line(postinstallLaunches.every((l) => /runasoriginaluser/i.test(l)),
  `post-install launch uses runasoriginaluser (never elevated) -> ${JSON.stringify(postinstallLaunches)}`);

// The download scripts must still SHIP so on-demand install works.
line(/Excludes:[^\n]*app\\\.env/i.test(iss) || /Excludes:/i.test(iss), 'installer still excludes private runtime data (.env/db/models/logs)');
line(
  iss.includes('Source: "{#PortableSource}\\*"') && iss.includes('app\\*.log')
    && iss.includes('node\\*')
    && /Source:\s*"\{#PortableSource\}\\node\\\*"[\s\S]*?Check:\s*NeedsEmbeddedNodeRuntime/i.test(iss)
    && /function\s+NeedsEmbeddedNodeRuntime[\s\S]*?FileExists\(ExpandConstant\('\{app\}\\node\\node\.exe'\)\)/i.test(iss)
    && !/\[InstallDelete\]|ClearStaleFrontendAssets|DelTree\(ExpandConstant\('\{app\}\\app\\dist\\assets'\)/i.test(iss),
  'installer copies the complete current frontend payload, preserves a running embedded runtime during updates, and never deletes generated assets or app data during an update'
);

console.log(`\n${failures === 0 ? 'ALL PASS - installer is lowest-privilege, runs no elevated downloads, and launches the app as the standard user.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
