import path from 'node:path';

// Validation-scope preflight (MA-Dev audit delta #3). A sealed coding task
// declares its allowed paths and one operator-selected validation profile. Before
// a run confirmation is offered, this deterministic policy checks that the chosen
// profile actually EXERCISES the kinds of files in scope — a UI change must be
// covered by a production build, a server/runtime change by the runtime-safety
// suite. It never chooses or runs a command and never trusts browser advice; it
// only blocks an under-covered task with a concrete reason so the operator can
// seal a new task with a validation that covers its files.

// What each server-owned validation profile actually executes, reduced to the two
// capabilities the scope policy cares about. Mirrors NATIVE_CODING_VALIDATIONS in
// nativeCodingWorker.js (syntax = diff/syntax only; frontend = production build;
// runtime = runtime-safety suite; project = both).
export const VALIDATION_CAPABILITIES = Object.freeze({
  syntax: Object.freeze({ build: false, runtime: false }),
  frontend: Object.freeze({ build: true, runtime: false }),
  runtime: Object.freeze({ build: false, runtime: true }),
  project: Object.freeze({ build: true, runtime: true })
});

const UI_EXTENSIONS = new Set(['.jsx', '.tsx', '.css', '.scss', '.less', '.html', '.vue', '.svelte']);

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
}

// A path falls in exactly one coverage category. 'ui' = the bundled frontend
// (anything under src/, or a frontend-only extension anywhere); 'server' = the
// Node runtime (server/ or scripts/, or a .mjs module); 'other' = docs, config,
// and plain data files that need no build or runtime check.
export function classifyCodingPath(value) {
  const normalized = normalizePath(value);
  if (!normalized) return 'other';
  const first = normalized.split('/')[0];
  const ext = path.extname(normalized).toLowerCase();
  if (first === 'src' || UI_EXTENSIONS.has(ext)) return 'ui';
  if (first === 'server' || first === 'scripts' || ext === '.mjs') return 'server';
  return 'other';
}

// Assess whether `validation` covers the file types implied by `allowedPaths`.
// Returns { ok, reason, reasons[], categories, required, validation } — required
// is the capability set the scope demands; ok is true only when the profile
// provides every required capability. Pure and deterministic.
export function assessValidationScope({ allowedPaths, validation } = {}) {
  const paths = (Array.isArray(allowedPaths) ? allowedPaths : []).map(normalizePath).filter(Boolean);
  const profile = VALIDATION_CAPABILITIES[validation];
  const categories = { ui: [], server: [], other: [] };
  for (const item of paths) categories[classifyCodingPath(item)].push(item);

  const required = { build: categories.ui.length > 0, runtime: categories.server.length > 0 };
  const reasons = [];

  if (!paths.length) reasons.push('The task declares no allowed paths, so its validation coverage cannot be assessed.');
  if (!profile) reasons.push(`Unknown validation profile "${validation}". Use one of: ${Object.keys(VALIDATION_CAPABILITIES).join(', ')}.`);

  if (profile) {
    if (required.build && !profile.build) {
      reasons.push(`Front-end paths (${categories.ui.slice(0, 3).join(', ')}${categories.ui.length > 3 ? ', …' : ''}) require a production build, but validation "${validation}" does not build. Choose "frontend" or "project".`);
    }
    if (required.runtime && !profile.runtime) {
      reasons.push(`Server/runtime paths (${categories.server.slice(0, 3).join(', ')}${categories.server.length > 3 ? ', …' : ''}) require the runtime-safety suite, but validation "${validation}" does not run it. Choose "runtime" or "project".`);
    }
    if (required.build && required.runtime && !(profile.build && profile.runtime)) {
      reasons.push('This task spans front-end and server paths, so only the "project" validation covers both.');
    }
  }

  const ok = reasons.length === 0;
  return {
    ok,
    reason: ok ? '' : reasons.join(' '),
    reasons,
    categories,
    required,
    validation: validation || null
  };
}
