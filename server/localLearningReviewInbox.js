import fs from 'node:fs';
import path from 'node:path';
import { validateLocalLearningEvent } from './localLearningEventValidator.js';

export const LOCAL_LEARNING_REVIEW_INBOX_RELATIVE = '.lps/local-learning/review-inbox';
const LOCAL_LEARNING_REVIEW_INBOX_SEGMENTS = LOCAL_LEARNING_REVIEW_INBOX_RELATIVE.split('/');

function normalizeRepoRoot(repoRoot) {
  return path.resolve(String(repoRoot || process.cwd()));
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function directoryFailure(reason) {
  return { ok: false, root: '', directory: '', reason };
}

function resolveContainedDirectory(root, directory) {
  try {
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink()) {
      return directoryFailure('review inbox path must not contain symbolic links or junctions');
    }
    if (!stats.isDirectory()) {
      return directoryFailure('review inbox path component must be a directory');
    }

    const resolved = fs.realpathSync(directory);
    if (!isInside(root, resolved)) {
      return directoryFailure('review inbox path escapes repository root');
    }
    return { ok: true, root, directory: resolved, reason: '' };
  } catch (error) {
    return directoryFailure(`review inbox path could not be resolved: ${error.message}`);
  }
}

function prepareReviewInboxDirectory(repoRoot) {
  let root;
  try {
    root = fs.realpathSync(normalizeRepoRoot(repoRoot));
    if (!fs.statSync(root).isDirectory()) {
      return directoryFailure('repository root must be an existing directory');
    }
  } catch (error) {
    return directoryFailure(`repository root could not be resolved: ${error.message}`);
  }

  let current = root;
  for (const segment of LOCAL_LEARNING_REVIEW_INBOX_SEGMENTS) {
    const parent = resolveContainedDirectory(root, current);
    if (!parent.ok) return parent;
    current = parent.directory;

    const next = path.join(current, segment);
    try {
      fs.mkdirSync(next, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return directoryFailure(`review inbox path could not be created: ${error.message}`);
      }
    }

    const checked = resolveContainedDirectory(root, next);
    if (!checked.ok) return checked;
    current = checked.directory;
  }

  return { ok: true, root, directory: current, reason: '' };
}

export function getLocalLearningReviewInboxPath(repoRoot = process.cwd()) {
  const root = normalizeRepoRoot(repoRoot);
  return path.resolve(root, LOCAL_LEARNING_REVIEW_INBOX_RELATIVE);
}

export function validateReviewInboxSlug(value) {
  if (value === undefined || value === null) {
    return { ok: true, slug: '', reason: '' };
  }
  if (typeof value !== 'string') {
    return { ok: false, slug: '', reason: 'slug must be a string when provided' };
  }
  const slug = value.trim();
  if (!slug) {
    return { ok: false, slug: '', reason: 'slug must not be empty when provided' };
  }
  if (slug.length > 100) {
    return { ok: false, slug, reason: 'slug must be 100 characters or fewer' };
  }
  if (path.isAbsolute(slug) || /^[A-Za-z]:/.test(slug)) {
    return { ok: false, slug, reason: 'slug must be a filename, not an absolute path' };
  }
  if (slug.includes('/') || slug.includes('\\')) {
    return { ok: false, slug, reason: 'slug must not contain path separators' };
  }
  if (slug.includes('..') || slug === '.') {
    return { ok: false, slug, reason: 'slug must not contain dot-dot or be a dot path' };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) {
    return { ok: false, slug, reason: 'slug must use only A-Z, a-z, 0-9, dot, underscore, and dash' };
  }
  return { ok: true, slug, reason: '' };
}

function defaultSlug(event) {
  const task = String(event?.task_type || 'local-learning')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'local-learning';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${task}-${stamp}`;
}

function splitSlug(slug) {
  const withName = slug || 'local-learning';
  if (withName.toLowerCase().endsWith('.json')) {
    const base = withName.slice(0, -5);
    return { base, extension: '.json' };
  }
  return { base: withName, extension: '.json' };
}

function resultFailure(reason, extra = {}) {
  return {
    ok: false,
    written: false,
    path: '',
    relativePath: '',
    reason,
    ...extra
  };
}

export function writeLocalLearningReviewCandidate(event, options = {}) {
  const validation = validateLocalLearningEvent(event);
  if (!validation.ok) {
    return resultFailure('local-learning event is invalid', { errors: [...validation.errors] });
  }

  const slugCheck = validateReviewInboxSlug(options.slug);
  if (!slugCheck.ok) {
    return resultFailure(slugCheck.reason, { errors: [slugCheck.reason] });
  }

  const requestedSlug = slugCheck.slug || defaultSlug(event);
  const { base, extension } = splitSlug(requestedSlug);
  if (!base || base === '.' || base.includes('..')) {
    return resultFailure('slug must resolve to a safe filename', { errors: ['slug must resolve to a safe filename'] });
  }

  const prepared = prepareReviewInboxDirectory(options.repoRoot);
  if (!prepared.ok) {
    return resultFailure(prepared.reason, { errors: [prepared.reason] });
  }
  const { root, directory } = prepared;
  const content = `${JSON.stringify(event, null, 2)}\n`;

  for (let index = 1; index <= 1000; index += 1) {
    const suffix = index === 1 ? '' : `-${index}`;
    const checked = resolveContainedDirectory(root, directory);
    if (!checked.ok) {
      return resultFailure(checked.reason, { errors: [checked.reason] });
    }
    const absolute = path.resolve(checked.directory, `${base}${suffix}${extension}`);
    if (!isInside(checked.directory, absolute)) {
      return resultFailure('candidate path escapes review inbox', { errors: ['candidate path escapes review inbox'] });
    }
    try {
      fs.writeFileSync(absolute, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return {
        ok: true,
        written: true,
        path: absolute,
        relativePath: path.relative(root, absolute).replaceAll('\\', '/'),
        reason: 'wrote unapproved local-learning review candidate; this is not memory'
      };
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      return resultFailure(`failed to write review candidate: ${error.message}`, { errors: [error.message] });
    }
  }

  return resultFailure('could not find a non-conflicting review candidate filename', {
    errors: ['could not find a non-conflicting review candidate filename']
  });
}
