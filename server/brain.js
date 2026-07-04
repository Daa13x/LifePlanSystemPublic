import fs from 'node:fs';
import path from 'node:path';
import { getSetting } from './db.js';

// Safe read-only access to the private LifePlanSystem brain folder.
// The brain root is never hardcoded: it comes from the LIFE_PLANNER_BRAIN_ROOT
// environment variable or the brainRootPath setting (stored in the local
// SQLite database under data/, which is gitignored and commit-protected).
// Only the allowlisted files below are ever read, each under a character
// budget, and nothing under the brain root is ever written.

export const BRAIN_ALLOWLIST = [
  { path: 'rules/LIS_RULES.md', label: 'handoff/rules', maxChars: 1800 },
  { path: 'Life_Intelligence_System_Handoff-CURRENT.md', label: 'handoff/rules', maxChars: 1800 },
  { path: 'source_of_truth/decision_rules.md', label: 'source-of-truth', maxChars: 2400 },
  { path: 'source_of_truth/open_questions.md', label: 'open question', maxChars: 1600 },
  { path: 'source_of_truth/memory/INBOX.md', label: 'memory candidate', maxChars: 1600 },
  { path: 'docs/ACTIVE_TODO.md', label: 'todo', maxChars: 1600 },
  { path: 'docs/ACTIVE_SESSION_STATE.md', label: 'handoff/rules', maxChars: 1600 }
];

// Sum of the per-file caps: every allowlisted file can contribute its full
// excerpt. The loop still guards the total in case caps grow later.
const TOTAL_CHAR_BUDGET = BRAIN_ALLOWLIST.reduce((sum, entry) => sum + entry.maxChars, 0);
const BLOCKED_EXTENSIONS = ['.env', '.sqlite', '.sqlite3', '.db', '.log', '.key', '.pem'];

export function brainRoot() {
  const fromEnv = String(process.env.LIFE_PLANNER_BRAIN_ROOT || '').trim();
  if (fromEnv) return fromEnv;
  return String(getSetting('brainRootPath', '') || '').trim();
}

// Resolves an allowlisted relative path under the brain root and refuses
// anything that escapes it, is absolute, hits a hidden folder, or looks like
// a secret/database file. Belt-and-braces: callers only pass allowlist
// entries, but the confinement holds even if that changes.
export function safeBrainPath(root, relativePath) {
  const raw = String(relativePath || '').trim();
  if (!raw || raw.includes('\0')) throw new Error('Invalid brain path.');
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')) {
    throw new Error('Brain paths must be relative to the brain root.');
  }
  const normalized = raw.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '')) throw new Error('Brain path must stay inside the brain root.');
  if (parts.some((part) => part.startsWith('.'))) throw new Error('Hidden files/folders are not readable as brain context.');
  const lower = normalized.toLowerCase();
  if (BLOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext))) throw new Error('This file type is not readable as brain context.');
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, normalized);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (!absolute.startsWith(rootWithSep)) throw new Error('Brain path must stay inside the brain root.');
  return { normalized, absolute };
}

export function isAllowlistedBrainFile(relativePath) {
  const normalized = String(relativePath || '').trim().replaceAll('\\', '/');
  return BRAIN_ALLOWLIST.some((entry) => entry.path === normalized);
}

export function brainStatus() {
  const root = brainRoot();
  if (!root) {
    return { configured: false, root: '', rootExists: false, files: BRAIN_ALLOWLIST.map((entry) => ({ path: entry.path, label: entry.label, found: false })) };
  }
  const rootExists = fs.existsSync(root) && fs.statSync(root).isDirectory();
  const files = BRAIN_ALLOWLIST.map((entry) => {
    let found = false;
    if (rootExists) {
      try {
        const target = safeBrainPath(root, entry.path);
        found = fs.existsSync(target.absolute) && fs.statSync(target.absolute).isFile();
      } catch {
        found = false;
      }
    }
    return { path: entry.path, label: entry.label, found };
  });
  return { configured: true, root, rootExists, files };
}

// Reads the allowlisted brain files into labelled, size-capped excerpts.
// Missing files are reported, never fatal.
export function loadBrainContext() {
  const status = brainStatus();
  const result = {
    configured: status.configured,
    rootExists: status.rootExists,
    files: [],
    missing: [],
    skipped: [],
    usedChars: 0
  };
  if (!status.configured || !status.rootExists) return result;

  let remaining = TOTAL_CHAR_BUDGET;
  for (const entry of BRAIN_ALLOWLIST) {
    if (remaining <= 0) {
      result.skipped.push(entry.path);
      continue;
    }
    let target;
    try {
      target = safeBrainPath(status.root, entry.path);
    } catch {
      result.missing.push(entry.path);
      continue;
    }
    if (!fs.existsSync(target.absolute) || !fs.statSync(target.absolute).isFile()) {
      result.missing.push(entry.path);
      continue;
    }
    let raw = '';
    try {
      raw = fs.readFileSync(target.absolute, 'utf8');
    } catch {
      result.missing.push(entry.path);
      continue;
    }
    const cap = Math.min(entry.maxChars, remaining);
    const excerpt = raw.slice(0, cap);
    remaining -= excerpt.length;
    result.usedChars += excerpt.length;
    result.files.push({
      path: entry.path,
      label: entry.label,
      excerpt,
      truncated: excerpt.length < raw.length
    });
  }
  return result;
}
