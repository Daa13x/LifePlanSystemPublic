import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeExtensionEnabled, chromeProfileArgument, probeChromeExtension } from '../server/browserExtensionInstall.js';

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
    extensions: { settings: { exact: {
      path: currentPath,
      manifest: { name: 'Life Planner Browser Agent' },
      disable_reasons: [],
      has_started_service_worker: true,
      service_worker_registration_info: { version: '0.2.0' },
      active_permissions: { api: ['tabs'] }
    } } }
  }));

  let result = probeChromeExtension({ userDataRoot, extensionPath: currentPath });
  assert.equal(result.installedInChrome, true);
  assert.equal(result.chromeLoaded, true);
  assert.equal(result.exactPathMatch, true);
  assert.equal(result.detectedProfilePath, profilePath);
  assert.equal(chromeProfileArgument(userDataRoot, profilePath), '--profile-directory=Profile 2');
  assert.equal(chromeExtensionEnabled({ state: 1 }), true);
  assert.equal(chromeExtensionEnabled({ state: 0 }), false);
  assert.equal(chromeExtensionEnabled({ disable_reasons: [], has_started_service_worker: true }), true);
  assert.equal(chromeExtensionEnabled({ disable_reasons: [1], has_started_service_worker: true }), false);

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
  const extensionRoot = path.join(process.cwd(), 'browser-extension', 'lps-browser-agent');
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  const worker = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');
  assert.equal(manifest.action.default_popup, 'popup.html', 'the connector exposes a visible status/control surface');
  assert.ok(manifest.permissions.includes('alarms'), 'the MV3 worker has an alarm revival path');
  assert.match(worker, /POLL_ALARM/, 'the worker creates an explicit revival alarm');
  assert.match(worker, /lps-browser-agent-status/, 'the popup reads a bounded local status message');
  assert.match(worker, /lastSuccessAt/, 'the popup can distinguish a live bridge from an active extension');
  assert.match(worker, /lastError/, 'the popup receives a bounded recovery diagnostic');
  assert.match(worker, /lps-browser-agent-job-sent/, 'the content automation emits a distinct provider-dispatch observation');
  assert.match(worker, /status:\s*'sent'/, 'the paired background worker records the intermediate dispatch receipt');
  assert.match(worker, /type:\s*JOB_SENT_MESSAGE,\s*jobId:/, 'the serialised page function receives the receipt message type explicitly');
  assert.match(worker, /jobReceipt\?\.claimToken/, 'the dispatch receipt is bound to the claimed browser job lease');
  assert.ok(fs.existsSync(path.join(extensionRoot, 'popup.html')));
  assert.ok(fs.existsSync(path.join(extensionRoot, 'popup.js')));
  assert.match(fs.readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8'), /bridgeReachable/);
  console.log('Browser extension installation verification passed.');
} finally {
  fs.rmSync(probeRoot, { recursive: true, force: true });
}
