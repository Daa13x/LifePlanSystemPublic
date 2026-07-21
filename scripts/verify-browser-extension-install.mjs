import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeProfileArgument, probeChromeExtension } from '../server/browserExtensionInstall.js';

const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-extension-install-'));
try {
  const userDataRoot = path.join(probeRoot, 'Chrome', 'User Data');
  const profilePath = path.join(userDataRoot, 'Profile 2');
  const currentPath = path.join(probeRoot, 'current', 'lps-browser-agent');
  fs.mkdirSync(profilePath, { recursive: true });
  fs.mkdirSync(currentPath, { recursive: true });
  fs.writeFileSync(path.join(userDataRoot, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 2', info_cache: { 'Profile 2': {} } } }));
  fs.writeFileSync(path.join(currentPath, 'manifest.json'), JSON.stringify({ name: 'Life Planner Browser Agent', version: '0.2.0' }));
  fs.writeFileSync(path.join(currentPath, 'background.js'), '');
  fs.writeFileSync(path.join(profilePath, 'Secure Preferences'), JSON.stringify({
    extensions: { settings: { exact: { state: 1, path: currentPath, manifest: { name: 'Life Planner Browser Agent' } } } }
  }));

  let result = probeChromeExtension({ userDataRoot, extensionPath: currentPath });
  assert.equal(result.installedInChrome, true);
  assert.equal(result.chromeLoaded, true);
  assert.equal(result.exactPathMatch, true);
  assert.equal(result.detectedProfilePath, profilePath);
  assert.equal(chromeProfileArgument(userDataRoot, profilePath), '--profile-directory=Profile 2');

  const stalePath = path.join(probeRoot, 'stale', 'lps-browser-agent');
  fs.mkdirSync(stalePath, { recursive: true });
  fs.writeFileSync(path.join(stalePath, 'manifest.json'), JSON.stringify({ name: 'Life Planner Browser Agent', version: '0.1.0' }));
  fs.writeFileSync(path.join(stalePath, 'background.js'), '');
  fs.writeFileSync(path.join(profilePath, 'Secure Preferences'), JSON.stringify({
    extensions: { settings: { stale: { state: 0, path: stalePath, manifest: { name: 'Life Planner Browser Agent' } } } }
  }));
  result = probeChromeExtension({ userDataRoot, extensionPath: currentPath });
  assert.equal(result.installedInChrome, true);
  assert.equal(result.chromeLoaded, false);
  assert.equal(result.exactPathMatch, false);
  assert.equal(result.currentContentMatch, false);
  assert.deepEqual(result.otherBrowserAgentPaths, [stalePath]);

  const serverSource = fs.readFileSync(path.join(process.cwd(), 'server', 'index.js'), 'utf8');
  assert.match(serverSource, /probeChromeExtension/);
  assert.match(serverSource, /detectedProfilePath/);
  assert.match(serverSource, /folderOpened/);
  assert.match(serverSource, /manualChromeStepRequired/);
  assert.doesNotMatch(serverSource, /--load-extension/);
  console.log('Browser extension installation verification passed.');
} finally {
  fs.rmSync(probeRoot, { recursive: true, force: true });
}
