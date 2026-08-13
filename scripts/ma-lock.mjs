import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const PROPRIETARY_SIGNATURES = Object.freeze([
  /sacred\s+law\s+32/i,
  /project\s+bible/i,
  /android\s+bible/i,
  /failure\s+bible/i,
  /prompt\s+bible/i,
  /hayley\s+handbook/i,
  /installer\s+rules/i,
  /mostlyarmless\.services/i,
  /serenityselfcontrolservice/i,
  /reguluselevationbridge/i,
  /workboardbrowsercodingloopservice/i,
  /projectlocalcodingloopservice/i
]);

export const ALLOWED_METADATA_PATHS = new Set([
  'docs/architecture/REFERENCE_MATERIAL_BOUNDARY.md',
  'docs/attachments/ATTACHMENT_2026-07-04_MOSTLYARMLESS_CONTEXT.md',
  'scripts/ma-lock.mjs',
  'scripts/verify-ma-lock.mjs',
  'scripts/verify-ma-lock-contract.mjs',
  'scripts/verify-ma-reference-guard.mjs'
]);

const IGNORED_DIRECTORIES = new Set(['.git', '.lps', '.cache', 'node_modules', 'dist', 'release']);
const TEXT_EXTENSIONS = new Set(['.cjs', '.css', '.cs', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.ps1', '.svg', '.ts', '.tsx', '.txt', '.yml', '.yaml']);

export function normalizeRelative(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

export function signatureMatches(text) {
  return PROPRIETARY_SIGNATURES
    .filter((expression) => expression.test(text))
    .map((expression) => expression.source);
}

export function isTextPath(relative) {
  return TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

export function scanText(relative, text) {
  const normalized = normalizeRelative(relative);
  if (ALLOWED_METADATA_PATHS.has(normalized)) return [];
  return signatureMatches(text).map((signature) => `${normalized}: prohibited Mostly Armless signature /${signature}/i`);
}

function walk(root, relative = '') {
  const absolute = path.join(root, relative);
  const found = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) found.push(...walk(root, nextRelative));
    else if (entry.isFile() && isTextPath(nextRelative)) found.push(normalizeRelative(nextRelative));
  }
  return found;
}

export function scanWorkingTree(root) {
  const findings = [];
  for (const relative of walk(root)) {
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    findings.push(...scanText(relative, text));
  }
  return findings;
}

function stagedFiles(root) {
  const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
    cwd: root, encoding: 'utf8', windowsHide: true
  });
  return output.split('\0').filter(Boolean).map(normalizeRelative).filter(isTextPath);
}

export function scanStaged(root) {
  const findings = [];
  for (const relative of stagedFiles(root)) {
    const text = execFileSync('git', ['show', `:${relative}`], { cwd: root, encoding: 'utf8', windowsHide: true });
    findings.push(...scanText(relative, text));
  }
  return findings;
}
