// The runtime-info owner captures loaded provenance once; on-disk package
// identity is evidence for restart, never a replacement for the loaded identity.
import fs from 'node:fs';
import path from 'node:path';
import { StructuredFailureError } from './failureContract.js';

export function runtimeFailure(errorCode, stage, message) {
  return new StructuredFailureError({ errorCode, message, subsystem: 'runtime', stage,
    operation: 'startup', reason: errorCode.toLowerCase(), failedStage: stage,
    retryable: false, userActionRequired: true, persistentChanges: [] });
}

export function resolveRuntimePaths({ appRoot = path.resolve(import.meta.dirname, '..'), cwd = process.cwd(), database = process.env.LIFE_PLANNER_DB } = {}) {
  const root = path.resolve(cwd);
  const packaged = fs.existsSync(path.join(appRoot, '..', 'node', 'node.exe'));
  const expectedDatabase = path.join(appRoot, 'data', 'life-planner.sqlite');
  const dbPath = path.resolve(database || path.join(root, 'data', 'life-planner.sqlite'));
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (packaged && (!same(root, path.resolve(appRoot)) || !same(dbPath, expectedDatabase))) {
    throw runtimeFailure('RUNTIME_PATH_MISMATCH', 'database.resolve', 'Packaged startup refused an unexpected working directory or database override. No database was opened or created. Use the normal installed shortcut.');
  }
  return { root, dbPath, packaged };
}

export function readPackageIdentity(root) {
  let build = { source: 'unavailable', version: null, commit: 'unknown', shortCommit: 'unknown', buildTime: null, repository: 'Daa13x/LifePlanSystemPublic', dirty: null };
  for (const folder of ['dist', 'public']) {
    try { build = { source: 'embedded', ...JSON.parse(fs.readFileSync(path.join(root, folder, 'build-info.json'), 'utf8')) }; break; } catch { /* unavailable is not latest */ }
  }
  let frontendAssetBuildId = 'unbuilt';
  try { frontendAssetBuildId = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8').match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] || 'unknown'; } catch { /* source checkout */ }
  return { build, frontendAssetBuildId };
}

export function captureRuntimeIdentity({ root, dbPath, packaged = false, launchId = process.env.LPS_LAUNCH_ID || null }) {
  const loaded = readPackageIdentity(root);
  const signature = JSON.stringify(loaded);
  const normalized = root.replace(/\\/g, '/').toLowerCase();
  const identity = { ...loaded, runtimeMode: packaged ? normalized.includes('/programs/life planner/app') ? 'installed' : 'portable' : 'development',
    serverRoot: root, database: { basename: path.basename(dbPath), directory: path.basename(path.dirname(dbPath)), path: dbPath },
    process: { pid: process.pid, executable: process.execPath, startedAt: new Date().toISOString(), launchId } };
  return () => {
    const disk = readPackageIdentity(root);
    return { ...identity, packageChanged: JSON.stringify(disk) !== signature, diskBuild: disk.build };
  };
}
