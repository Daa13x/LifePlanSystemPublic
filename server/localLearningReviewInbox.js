import fs from 'node:fs';
import path from 'node:path';
import { validateLocalLearningEvent } from './localLearningEventValidator.js';

export const LOCAL_LEARNING_REVIEW_INBOX_RELATIVE = '.lps/local-learning/review-inbox';

function normalizeRepoRoot(repoRoot) {
  return path.resolve(String(repoRoot || process.cwd()));
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

  const root = normalizeRepoRoot(options.repoRoot);
  const directory = getLocalLearningReviewInboxPath(root);
  if (!isInside(root, directory)) {
    return resultFailure('review inbox path escapes repository root', { errors: ['review inbox path escapes repository root'] });
  }

  const requestedSlug = slugCheck.slug || defaultSlug(event);
  const { base, extension } = splitSlug(requestedSlug);
  if (!base || base === '.' || base.includes('..')) {
    return resultFailure('slug must resolve to a safe filename', { errors: ['slug must resolve to a safe filename'] });
  }

  fs.mkdirSync(directory, { recursive: true });
  const content = `${JSON.stringify(event, null, 2)}\n`;

  for (let index = 1; index <= 1000; index += 1) {
    const suffix = index === 1 ? '' : `-${index}`;
    const absolute = path.resolve(directory, `${base}${suffix}${extension}`);
    if (!isInside(directory, absolute)) {
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
