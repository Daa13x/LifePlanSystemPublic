import fs from 'node:fs';
import path from 'node:path';
import { validateLocalLearningEvent } from './localLearningEventValidator.js';

export const LOCAL_LEARNING_REVIEW_INBOX_RELATIVE = '.lps/local-learning/review-inbox';
const REVIEW_INBOX_SEGMENTS = LOCAL_LEARNING_REVIEW_INBOX_RELATIVE.split('/');

function normalizeRepoRoot(repoRoot) {
  return path.resolve(String(repoRoot || process.cwd()));
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resultFailure(reason) {
  return {
    ok: false,
    readOnly: true,
    inboxExists: null,
    relativeInboxPath: LOCAL_LEARNING_REVIEW_INBOX_RELATIVE,
    candidateCount: 0,
    candidates: [],
    reason,
    errors: [reason]
  };
}

function resultSuccess(inboxExists, candidates, reason) {
  return {
    ok: true,
    readOnly: true,
    inboxExists,
    relativeInboxPath: LOCAL_LEARNING_REVIEW_INBOX_RELATIVE,
    candidateCount: candidates.length,
    candidates,
    reason,
    errors: []
  };
}

function resolveExistingDirectory(root, directory, label) {
  try {
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink()) {
      return { ok: false, reason: `${label} must not contain symbolic links or junctions` };
    }
    if (!stats.isDirectory()) {
      return { ok: false, reason: `${label} component must be a directory` };
    }

    const resolved = fs.realpathSync(directory);
    if (!isInside(root, resolved)) {
      return { ok: false, reason: `${label} escapes repository root` };
    }
    return { ok: true, directory: resolved, reason: '' };
  } catch (error) {
    return { ok: false, reason: `${label} could not be resolved: ${error.message}` };
  }
}

function resolveReviewInboxForRead(repoRoot) {
  let root;
  try {
    root = fs.realpathSync(normalizeRepoRoot(repoRoot));
    if (!fs.statSync(root).isDirectory()) {
      return { ok: false, reason: 'repository root must be an existing directory' };
    }
  } catch (error) {
    return { ok: false, reason: `repository root could not be resolved: ${error.message}` };
  }

  let current = root;
  for (const segment of REVIEW_INBOX_SEGMENTS) {
    const next = path.join(current, segment);
    let stats;
    try {
      stats = fs.lstatSync(next);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { ok: true, root, inboxExists: false, directory: '', reason: 'review inbox does not exist' };
      }
      return { ok: false, reason: `review inbox path could not be read: ${error.message}` };
    }

    if (stats.isSymbolicLink()) {
      return { ok: false, reason: 'review inbox path must not contain symbolic links or junctions' };
    }
    if (!stats.isDirectory()) {
      return { ok: false, reason: 'review inbox path component must be a directory' };
    }

    const checked = resolveExistingDirectory(root, next, 'review inbox path');
    if (!checked.ok) return checked;
    current = checked.directory;
  }

  return { ok: true, root, inboxExists: true, directory: current, reason: '' };
}

function candidateResult(root, absolute, filename, event, errors) {
  const valid = errors.length === 0;
  return {
    filename,
    relativePath: path.relative(root, absolute).replaceAll('\\', '/'),
    status: valid ? 'valid' : 'invalid',
    valid,
    errors,
    task_type: typeof event?.task_type === 'string' ? event.task_type : null,
    memory_route: typeof event?.memory_route === 'string' ? event.memory_route : null,
    approval_required: typeof event?.approval_required === 'boolean' ? event.approval_required : null
  };
}

function readCandidate(root, directory, filename) {
  const absolute = path.resolve(directory, filename);
  if (!isInside(directory, absolute)) {
    return { ok: false, reason: 'candidate path escapes review inbox' };
  }

  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    return { ok: false, reason: `candidate could not be inspected: ${error.message}` };
  }

  if (stats.isSymbolicLink()) {
    return { ok: false, reason: 'candidate path must not be a symbolic link or junction' };
  }
  if (!stats.isFile()) {
    return { ok: true, candidate: candidateResult(root, absolute, filename, null, ['candidate must be a regular file']) };
  }

  let resolved;
  try {
    resolved = fs.realpathSync(absolute);
  } catch (error) {
    return { ok: false, reason: `candidate path could not be resolved: ${error.message}` };
  }
  if (!isInside(directory, resolved)) {
    return { ok: false, reason: 'candidate path escapes review inbox' };
  }

  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    return { ok: false, reason: `candidate could not be read: ${error.message}` };
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch (error) {
    return {
      ok: true,
      candidate: candidateResult(root, resolved, filename, null, [`malformed JSON: ${error.message}`])
    };
  }

  const validation = validateLocalLearningEvent(event);
  return {
    ok: true,
    candidate: candidateResult(root, resolved, filename, event, [...validation.errors])
  };
}

export function listLocalLearningReviewCandidates(options = {}) {
  const inbox = resolveReviewInboxForRead(options.repoRoot);
  if (!inbox.ok) return resultFailure(inbox.reason);
  if (!inbox.inboxExists) return resultSuccess(false, [], inbox.reason);

  const checkedInbox = resolveExistingDirectory(inbox.root, inbox.directory, 'review inbox path');
  if (!checkedInbox.ok) return resultFailure(checkedInbox.reason);

  let names;
  try {
    names = fs.readdirSync(checkedInbox.directory, { encoding: 'utf8' })
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  } catch (error) {
    return resultFailure(`review inbox could not be listed: ${error.message}`);
  }

  const candidates = [];
  for (const name of names) {
    const currentInbox = resolveExistingDirectory(inbox.root, checkedInbox.directory, 'review inbox path');
    if (!currentInbox.ok) return resultFailure(currentInbox.reason);

    const read = readCandidate(inbox.root, currentInbox.directory, name);
    if (!read.ok) return resultFailure(read.reason);
    candidates.push(read.candidate);
  }

  return resultSuccess(true, candidates, `${candidates.length} review candidate(s) listed`);
}
