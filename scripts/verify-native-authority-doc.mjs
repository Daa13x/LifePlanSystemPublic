#!/usr/bin/env node
// Verify the Native Host Authority Review documents every required ownership
// area from actual code and does not authorise a rewrite. Local-only. Exit 0.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const doc = fs.readFileSync(path.join(root, 'docs', 'architecture', 'NATIVE_HOST_AUTHORITY_REVIEW.md'), 'utf8');
const lower = doc.toLowerCase();

// Every responsibility the feedback named must be covered.
for (const area of ['process lifecycle', 'local file access', 'secrets', 'native dialogs', 'tray', 'browser control', 'updates', 'backups', 'recovery', 'shutdown']) {
  assert.ok(lower.includes(area), `authority review must cover: ${area}`);
}

// It must name the real layers and cite real code anchors that still exist.
assert.match(doc, /WebViewSecurityPolicy\.IsTrustedMainUri/, 'review cites the trusted-origin gate');
assert.match(doc, /mutationGuard\.js/, 'review cites the server mutation guard');
assert.match(doc, /confirmations\.js/, 'review cites durable confirmations');
assert.match(doc, /ProviderSecretStore\.cs/, 'review cites DPAPI secret storage');
for (const file of ['native/LifePlanSystem.Native/Security/WebViewSecurityPolicy.cs', 'server/index.js', 'native/LifePlanSystem.Native/Recovery/NativeBackupService.cs']) {
  assert.ok(fs.existsSync(path.join(root, file)), `cited source still exists: ${file}`);
}

// It must record the no-duplicated-authority finding and the no-rewrite gate.
assert.match(lower, /no\.?\s*$|is authority duplicated\? no/m, 'review states authority is not duplicated');
assert.match(lower, /no migration or rewrite is authorised/, 'review explicitly does not authorise a migration/rewrite');
assert.match(lower, /react presentation-only|keep \*\*react presentation-only\*\*/, 'review keeps React presentation-only');

console.log('Native host authority review documentation verification passed.');
