#!/usr/bin/env node
// Verify the browser-extension icons (Bug 5):
//   1. Every icon referenced by the manifest (icons + action.default_icon)
//      exists on disk.
//   2. Each PNG's real pixel dimensions match its declared size key.
//   3. The portable packaging includes the extension folder and does NOT strip
//      PNGs, so the icons ship in the portable bundle and the installer payload.
//
// Local-only, deterministic. Exit 0 = pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(repoRoot, 'browser-extension', 'lps-browser-agent');
const manifestPath = path.join(extDir, 'manifest.json');

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

function pngSize(file) {
  const b = fs.readFileSync(file);
  // PNG signature + IHDR: width @16, height @20 (big-endian uint32).
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

console.log('--- browser-extension icon verification ---');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const REQUIRED = ['16', '32', '48', '128'];

// Collect declared icon maps.
const maps = [];
if (manifest.icons) maps.push(['icons', manifest.icons]);
if (manifest.action && manifest.action.default_icon) maps.push(['action.default_icon', manifest.action.default_icon]);
line(maps.length >= 1, `manifest declares an icons map -> ${maps.map((m) => m[0]).join(', ') || 'NONE'}`);

for (const [where, map] of maps) {
  for (const size of REQUIRED) {
    line(Object.prototype.hasOwnProperty.call(map, size), `${where} declares ${size}x${size}`);
    const rel = map[size];
    if (!rel) continue;
    const abs = path.join(extDir, rel);
    const exists = fs.existsSync(abs);
    line(exists, `${where}[${size}] file exists: ${rel}`);
    if (!exists) continue;
    let dim;
    try { dim = pngSize(abs); } catch (e) { line(false, `${rel} is a valid PNG -> ${e.message}`); continue; }
    line(dim.width === Number(size) && dim.height === Number(size), `${rel} is ${size}x${size} (got ${dim.width}x${dim.height})`);
    line(fs.statSync(abs).size > 0, `${rel} is non-empty`);
  }
}

// Packaging: extension folder is copied and PNGs are not stripped.
{
  const pkg = fs.readFileSync(path.join(repoRoot, 'scripts', 'package-portable.ps1'), 'utf8');
  line(/"browser-extension"/.test(pkg), 'package-portable.ps1 copies the browser-extension folder into the portable bundle');
  line(!/\*\.png/i.test(pkg), 'package-portable.ps1 does not strip *.png from the payload');
}

console.log(`\n${failures === 0 ? 'ALL PASS - extension icons exist at correct sizes and ship in the portable/installer payload.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
