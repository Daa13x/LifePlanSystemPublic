import fs from 'node:fs';
import path from 'node:path';

// Operation-aware workspace path containment for the Repository Explorer and
// every other workspace-relative read, list, preview, and write proposal.
//
// Lexical containment alone (reject `..`, absolute, and UNC paths) is not enough:
// a symbolic link or Windows junction planted inside the workspace can point
// outside it, so a lexically-contained path can still resolve to a file on the
// far side of the boundary. This module adds canonical containment on top of the
// lexical check — the target (or, for a create, its nearest existing parent) is
// realpath-resolved and must remain inside the workspace's own realpath, and a
// symlink/junction leaf is rejected outright.
//
// It is deliberately free of app policy: the optional `isProtected(normalized)`
// predicate is injected so protected/private path rules live with the caller.

function withSeparator(directory) {
  return directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
}

function isContainedIn(rootReal, candidateReal) {
  return candidateReal === rootReal || candidateReal.startsWith(withSeparator(rootReal));
}

// Canonicalize with the platform's native resolver so junctions/symlinks and
// short-name/case differences on Windows collapse to one comparable form.
function canonical(target) {
  return fs.realpathSync.native(target);
}

// Walk upward until an existing path is found. A create targets a path that does
// not exist yet, but its nearest existing parent does and can be canonicalized,
// which is what stops a create from being redirected through a junction parent.
export function nearestExistingParent(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No existing parent was found for the path.');
    current = parent;
  }
  return current;
}

// Lexical containment: reject null bytes, absolute drive/UNC paths, and any `..`
// segment; return the workspace-relative normalized path plus its absolute form.
export function lexicalWorkspacePath(root, relativePath = '') {
  const raw = String(relativePath || '').trim();
  if (!raw || raw.includes('\0')) throw new Error('Invalid path.');
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw new Error('Use a workspace-relative path, not an absolute path.');
  }
  const normalized = raw.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => part === '..')) {
    throw new Error('Path must stay inside the workspace.');
  }
  const absolute = path.resolve(root, normalized);
  const rootWithSeparator = withSeparator(root);
  if (absolute !== root && !absolute.startsWith(rootWithSeparator)) {
    throw new Error('Path must stay inside the workspace.');
  }
  return { normalized, absolute };
}

// Full containment: lexical check, optional protected-path rejection, then
// canonical realpath containment. When the target exists it must not be a
// symbolic link/junction and its realpath must stay inside the workspace; when
// it does not exist (a create) the nearest existing parent's realpath must stay
// inside. `mustExist` and `mustBeFile` gate reads/previews. On success the
// returned `absolute` is the canonical path for existing targets and the lexical
// absolute for not-yet-created ones.
export function resolveWorkspacePath(root, relativePath, options = {}) {
  const { mustExist = false, mustBeFile = false, isProtected } = options;
  const target = lexicalWorkspacePath(root, relativePath);
  if (typeof isProtected === 'function' && isProtected(target.normalized)) {
    throw new Error(`Protected/private path is not accessible: ${target.normalized}`);
  }
  const rootReal = canonical(root);
  if (!fs.existsSync(target.absolute)) {
    if (mustExist) throw new Error('File not found.');
    const parentReal = canonical(nearestExistingParent(target.absolute));
    if (!isContainedIn(rootReal, parentReal)) throw new Error('Path must stay inside the workspace.');
    return { normalized: target.normalized, absolute: target.absolute };
  }
  const stat = fs.lstatSync(target.absolute);
  if (stat.isSymbolicLink()) throw new Error('Path must not traverse a symbolic link or junction.');
  if (mustBeFile && !stat.isFile()) throw new Error('Context must be a regular file, not a link or directory.');
  const resolved = canonical(target.absolute);
  if (!isContainedIn(rootReal, resolved)) throw new Error('Resolved path must stay inside the workspace.');
  return { normalized: target.normalized, absolute: resolved };
}
