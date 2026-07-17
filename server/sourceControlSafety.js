import path from 'node:path';

const PROTECTED_DIRECTORY_SEGMENTS = new Set([
  '.git',
  '.cache',
  '.claude',
  '.lps',
  'data',
  'dist',
  'node_modules',
  'release'
]);
const PROTECTED_FILE_NAMES = new Set(['.env', '.env.local', '.env.production']);
const PROTECTED_EXTENSIONS = ['.sqlite', '.sqlite3', '.db', '.gguf', '.safetensors', '.onnx', '.log'];
const APPROVED_GIT_HOSTS = new Set(['github.com', 'huggingface.co']);

export function normalizeWorkspacePath(filePath = '') {
  return String(filePath)
    .trim()
    .replace(/^"|"$/g, '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .toLowerCase();
}

export function isProtectedWorkspacePath(filePath = '') {
  const normalized = normalizeWorkspacePath(filePath);
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  const fileName = segments.at(-1) || '';
  return segments.some((segment) => PROTECTED_DIRECTORY_SEGMENTS.has(segment))
    || PROTECTED_FILE_NAMES.has(fileName)
    || fileName.startsWith('.env.')
    || PROTECTED_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

export function parseNullSeparatedPaths(output = '') {
  return String(output).split('\0').filter((item) => item.length > 0);
}

export function parsePorcelainStatus(output = '') {
  const records = parseNullSeparatedPaths(output);
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 3) continue;
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    const renamed = code.includes('R') || code.includes('C');
    const originalPath = renamed ? records[index += 1] || '' : '';
    files.push({
      status: code.trim() || '??',
      path: filePath,
      originalPath,
      staged: code[0] !== ' ' && code[0] !== '?',
      protected: isProtectedWorkspacePath(filePath) || isProtectedWorkspacePath(originalPath)
    });
  }
  return files;
}

const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  { kind: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { kind: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { kind: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
];

export function detectHighConfidenceSecrets(text = '') {
  return HIGH_CONFIDENCE_SECRET_PATTERNS
    .filter(({ pattern }) => pattern.test(String(text)))
    .map(({ kind }) => kind);
}

export function parseGitRemoteUrl(value = '') {
  const remoteUrl = String(value || '').trim();
  if (!remoteUrl || remoteUrl.startsWith('-') || /[\0\n\r]/.test(remoteUrl)) return null;

  const scpMatch = remoteUrl.match(/^git@([A-Za-z0-9.-]+):([^/\s]+)\/(.+?)(?:\.git)?$/i);
  if (scpMatch) {
    return {
      raw: remoteUrl,
      protocol: 'ssh',
      host: scpMatch[1].toLowerCase(),
      owner: scpMatch[2],
      repo: scpMatch[3].replace(/\.git$/i, '')
    };
  }

  try {
    const parsed = new URL(remoteUrl);
    if (!['https:', 'ssh:'].includes(parsed.protocol)) return null;
    if (parsed.protocol === 'https:' && (parsed.username || parsed.password)) return null;
    const parts = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return {
      raw: remoteUrl,
      protocol: parsed.protocol.slice(0, -1),
      host: parsed.hostname.toLowerCase(),
      owner: parts[0],
      repo: parts.slice(1).join('/')
    };
  } catch {
    return null;
  }
}

export function validateRemoteUrl(value = '') {
  const remote = parseGitRemoteUrl(value);
  if (!remote) return { ok: false, reason: 'Use an HTTPS or SSH repository URL without embedded credentials.' };
  if (!APPROVED_GIT_HOSTS.has(remote.host)) {
    return { ok: false, reason: `Remote host "${remote.host}" is not approved. Use github.com or huggingface.co.` };
  }
  return { ok: true, remote };
}

export function publicationBoundary(remoteUrl, { hasPublicPolicy = false } = {}) {
  const validation = validateRemoteUrl(remoteUrl);
  if (!validation.ok) return { allowed: false, reason: validation.reason, repository: '' };
  const { remote } = validation;
  const repository = `${remote.owner}/${remote.repo}`;
  if (remote.host !== 'github.com') {
    return { allowed: false, reason: 'Publishing source changes is limited to the public GitHub application repository.', repository };
  }
  if (remote.repo.toLowerCase() !== 'lifeplansystempublic' || !hasPublicPolicy) {
    return {
      allowed: false,
      reason: 'Publishing is blocked because this checkout is not verified as LifePlanSystemPublic.',
      repository
    };
  }
  return { allowed: true, reason: 'Verified public application repository.', repository };
}

export function canUseGitHubToken(remoteUrl) {
  const remote = parseGitRemoteUrl(remoteUrl);
  return Boolean(remote && remote.protocol === 'https' && remote.host === 'github.com');
}

export function publicPolicyMarkerPath(repoRoot) {
  return path.join(repoRoot, 'SANITISATION_POLICY.md');
}
