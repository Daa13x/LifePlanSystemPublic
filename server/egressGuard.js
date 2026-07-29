import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET_PATTERNS = [
  ['token', /(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})/g],
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g]
];
const DENIED = [/(^|\/)\.env[^/]*$/i, /\.(pem|key|pfx|sqlite|db)$/i, /(^|\/)id_rsa[^/]*$/i, /(^|\/)secrets\//i, /(^|\/)credentials[^/]*$/i];
const entropy = (value) => {
  const counts = new Map([...value].map((c) => [c, (counts.get(c) || 0) + 1]));
  return [...counts.values()].reduce((sum, count) => sum - (count / value.length) * Math.log2(count / value.length), 0);
};
export function isDeniedEgressPath(rel, extra = []) {
  const normalized = String(rel).replaceAll('\\', '/');
  return [...DENIED, ...extra].some((pattern) => pattern.test(normalized));
}
export function loadLpsIgnore(root) {
  try { return fs.readFileSync(path.join(root, '.lpsignore'), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean); } catch { return []; }
}
export function guardEgressFile(file, { extraDenied = [] } = {}) {
  if (isDeniedEgressPath(file.path, extraDenied)) return { omitted: true, reason: 'redacted', path: file.path };
  let text = file.content;
  let matches = 0;
  for (const [reason, pattern] of SECRET_PATTERNS) text = text.replace(pattern, (value) => { matches += 1; return `«REDACTED:${reason}»`; });
  text = text.replace(/(['"`])([^'"`\r\n]{24,})\1/g, (whole, quote, value) => {
    if (entropy(value) >= 4.2) { matches += 1; return `${quote}«REDACTED:high-entropy»${quote}`; }
    return whole;
  });
  return matches >= 3 ? { omitted: true, reason: 'redacted', path: file.path, redactions: matches } : { file: { ...file, content: text }, redactions: matches };
}
export function guardEgressFiles(files, options = {}) {
  const safe = [], omissions = []; let redactions = 0;
  for (const file of files) { const result = guardEgressFile(file, options); redactions += result.redactions || 0; if (result.file) safe.push(result.file); else omissions.push({ path: result.path, reason: result.reason }); }
  const bytes = Buffer.byteLength(safe.map((file) => file.content).join(''));
  return { files: safe, omissions, redactions, redactionCount: redactions, bytes, sha256: crypto.createHash('sha256').update(safe.map((file) => `${file.path}\0${file.content}`).join('\n')).digest('hex') };
}
