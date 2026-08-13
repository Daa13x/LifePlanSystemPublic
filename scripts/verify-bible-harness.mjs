import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bibleRoot = path.join(root, 'docs', 'bibles');
const fail = (message) => { throw new Error(`LPS Bible harness failed: ${message}`); };
const requiredHeadings = ['## Purpose and scope', '## Hard invariants', '## Evidence and failure'];
const prohibitedImports = [
  /\bMostly Armless\b/i,
  /\bSerenity\b/i,
  new RegExp(['sacred', 'law', '32'].join('\\s+'), 'i'),
  /\bReaver Mode\b/i,
  /\bCaptain\b/i
];

const manifestPath = path.join(bibleRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.executableByDefault !== false) fail('reference material must never become executable prompt text by default');
if (!Array.isArray(manifest.documents) || manifest.documents.length !== 7) fail('manifest must declare the complete seven-document LPS harness');

for (const document of manifest.documents) {
  const file = path.join(bibleRoot, document.path);
  if (!fs.existsSync(file)) fail(`missing declared document: ${document.path}`);
  const text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) fail(`${document.path} has a UTF-8 BOM`);
  if (!/^Version: \d+\.\d+\.\d+$/m.test(text) || !/^Owner: LPS maintainer$/m.test(text)) fail(`${document.path} lacks versioned LPS ownership`);
  if (document.path !== 'personality-workshop.md') {
    for (const heading of requiredHeadings) if (!text.includes(heading)) fail(`${document.path} lacks ${heading}`);
  }
  for (const pattern of prohibitedImports) if (pattern.test(text)) fail(`${document.path} imports protected MA-specific doctrine`);
}

const handbook = fs.readFileSync(path.join(bibleRoot, 'agent-handbooks.md'), 'utf8');
for (const role of ['Orchestrator', 'Coder', 'Writer', 'Life Coach']) {
  if (!handbook.includes(`## ${role}`)) fail(`agent handbook is missing ${role}`);
}

console.log('LPS Bible harness passed: complete, versioned, reference-only, neutral-role, and MA-isolated documentation is enforced.');
