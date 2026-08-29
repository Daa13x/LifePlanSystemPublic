// Setup & Recovery engine. All durable recovery state is kept beside the
// application database so it can be resolved before SQLite opens on startup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const PENDING_MARKER = 'pending-restore.json';
const RESTORE_LOG = 'restore-log.json';
const BACKUP_FORMAT_VERSION = 1;
const APPLICATION_ID = 'LifePlanSystemPublic';

function iso(ms) { return new Date(ms).toISOString(); }
function stamp(ms) { return iso(ms).replace(/[:.]/g, '-'); }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function dataDir(dbPath) { return path.dirname(path.resolve(dbPath)); }
function backupsDir(dbPath) { return path.join(dataDir(dbPath), 'backups'); }
function markerPath(dbPath) { return path.join(dataDir(dbPath), PENDING_MARKER); }
function isWithin(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}
function assertWithin(root, candidate, label = 'Path') {
  const resolved = path.resolve(candidate);
  if (!isWithin(root, resolved)) throw new Error(`${label} is outside the approved application-data boundary.`);
  return resolved;
}
function assertExistingRegularWithin(root, file, label = 'File') {
  const resolved = assertWithin(root, file, label);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file inside the approved data directory.`);
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(resolved);
  if (!isWithin(realRoot, realFile)) throw new Error(`${label} escapes the approved application-data boundary.`);
  return resolved;
}
function safeName(value) {
  const name = String(value || '');
  return Boolean(name) && name === path.basename(name) && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}
function atomicWrite(file, value) {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true });
  const temp = path.join(parent, `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}
function atomicJson(file, value) { atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`); }
function moveIfPresent(from, to) {
  if (fs.existsSync(from)) fs.renameSync(from, to);
}
function removeIfPresent(file) {
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}
function sqliteDetails(file) {
  if (!isSqliteFile(file)) return { ok: false, error: 'Database file is missing, truncated, or not SQLite.' };
  let db;
  const transientSidecars = [`${file}-wal`, `${file}-shm`].filter((sidecar) => !fs.existsSync(sidecar));
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const valid = integrity.length === 1 && String(Object.values(integrity[0])[0]).toLowerCase() === 'ok';
    const schemaVersion = Number(Object.values(db.prepare('PRAGMA schema_version').get() || {})[0] || 0);
    return valid ? { ok: true, schemaVersion } : { ok: false, error: 'SQLite integrity check did not report ok.' };
  } catch {
    return { ok: false, error: 'Database could not be opened safely for integrity validation.' };
  } finally {
    try { db?.close(); } catch { /* nothing to close */ }
    // Opening a copied WAL-mode database for a read-only integrity check can
    // create empty sidecars on Windows. They are verifier artifacts, not part
    // of the backup format, so remove only the ones this check created.
    for (const sidecar of transientSidecars) removeIfPresent(sidecar);
  }
}

function databaseSnapshotScope(file) {
  let db;
  const transientSidecars = [`${file}-wal`, `${file}-shm`].filter((sidecar) => !fs.existsSync(sidecar));
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => {
        const identifier = `"${String(name).replaceAll('"', '""')}"`;
        return { name, rows: Number(db.prepare(`SELECT COUNT(*) AS count FROM ${identifier}`).get().count) };
      });
    return {
      kind: 'sqlite-database-snapshot',
      tables,
      excluded: ['temporary files', 'logs', 'models', 'browser profiles'],
      credentialHandling: 'Settings remain inside the database snapshot. Credential values are Windows DPAPI-protected and can only be decrypted by the same Windows user.'
    };
  } catch {
    throw new Error('Backup database tables could not be enumerated safely.');
  } finally {
    try { db?.close(); } catch { /* nothing to close */ }
    for (const sidecar of transientSidecars) removeIfPresent(sidecar);
  }
}

export function isSqliteFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(16);
      return fs.readSync(fd, header, 0, 16, 0) === 16 && header.equals(SQLITE_MAGIC);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

export function assessEnvironment({ dbPath, modelAssigned = false, runtimePresent = true, legacyDataDir = null, now = Date.now() }) {
  const root = dataDir(dbPath);
  let dataDirWritable = false;
  if (fs.existsSync(root)) {
    try {
      const probe = path.join(root, `.write-probe-${crypto.randomBytes(4).toString('hex')}`);
      atomicWrite(probe, 'ok');
      removeIfPresent(probe);
      dataDirWritable = true;
    } catch { dataDirWritable = false; }
  }
  const dbExists = fs.existsSync(dbPath);
  const dbCheck = dbExists ? sqliteDetails(dbPath) : { ok: false };
  const legacyDetected = Boolean(legacyDataDir && detectLegacyData({ legacyDataDir }).detected);
  const pending = readPendingRestore(dbPath);
  const checks = [
    { id: 'data-directory', required: true, ok: dataDirWritable, detail: dataDirWritable ? 'The application data directory is writable.' : 'The application data directory is missing or not writable.' },
    { id: 'database', required: true, ok: !dbExists || dbCheck.ok, detail: !dbExists ? 'No database exists yet; this is a first run.' : dbCheck.ok ? 'Application database passed SQLite integrity validation.' : 'Application database needs attention before it can be used safely.' },
    { id: 'local-model', required: false, ok: Boolean(modelAssigned), detail: modelAssigned ? 'A local model is assigned.' : 'No local model is assigned yet.' },
    { id: 'local-runtime', required: false, ok: Boolean(runtimePresent), detail: runtimePresent ? 'Local runtime is available.' : 'Local runtime is not configured.' },
    { id: 'legacy-install', required: false, ok: !legacyDetected, detail: legacyDetected ? 'A previous application data set is available for migration.' : 'No legacy installation data was detected.' },
    { id: 'pending-restore', required: false, ok: !pending, detail: pending ? pending.invalid ? 'A recovery marker is unreadable and needs attention.' : 'A restore is staged and will finish during the next restart.' : 'No restore is pending.' }
  ];
  const missingRequired = checks.filter((check) => check.required && !check.ok).map((check) => check.id);
  return { firstRun: !dbExists, ready: missingRequired.length === 0 && !pending?.invalid, missingRequired, legacyDetected, pendingRestore: Boolean(pending), checks, generatedAt: iso(now) };
}

export function createBackup({ dbPath, sources = null, label = 'manual', provenance = null, now = Date.now() }) {
  const root = dataDir(dbPath);
  const backupRoot = backupsDir(dbPath);
  fs.mkdirSync(backupRoot, { recursive: true });
  const requested = sources || [dbPath];
  const files = requested.map((file) => assertExistingRegularWithin(root, file, 'Backup source'));
  const databaseName = path.basename(dbPath);
  if (!files.some((file) => path.basename(file) === databaseName)) throw new Error('A backup must include the application database file.');
  if (!safeName(label)) throw new Error('Backup label is invalid.');
  const name = `${label}-${stamp(now)}`;
  const destination = assertWithin(backupRoot, path.join(backupRoot, name), 'Backup destination');
  if (fs.existsSync(destination)) throw new Error('A backup with this identifier already exists.');
  const staging = assertWithin(backupRoot, path.join(backupRoot, `.${name}.${crypto.randomBytes(6).toString('hex')}.staging`), 'Backup staging directory');
  fs.mkdirSync(staging, { recursive: true });
  try {
    const manifestFiles = [];
    for (const file of files) {
      const namePart = path.basename(file);
      if (!safeName(namePart)) throw new Error('Backup file name is invalid.');
      const copy = path.join(staging, namePart);
      fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(copy, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      manifestFiles.push({ name: namePart, sha256: sha256File(copy), size: fs.statSync(copy).size });
    }
    const database = sqliteDetails(path.join(staging, databaseName));
    if (!database.ok) throw new Error(`Refusing to back up an invalid database: ${database.error}`);
    const recoveryScope = databaseSnapshotScope(path.join(staging, databaseName));
    const manifest = { formatVersion: BACKUP_FORMAT_VERSION, application: APPLICATION_ID, createdAt: iso(now), label, databaseFile: databaseName, schemaVersion: database.schemaVersion, recoveryScope, provenance: provenance || null, files: manifestFiles };
    atomicJson(path.join(staging, 'manifest.json'), manifest);
    const validation = validateBackup(staging);
    if (!validation.ok) throw new Error(`Backup validation failed: ${validation.errors.join('; ')}`);
    fs.renameSync(staging, destination);
    return { dir: destination, manifest };
  } catch (error) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function listBackups(dbPath) {
  const root = backupsDir(dbPath);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'manifest.json')))
    .flatMap((dir) => { const result = validateBackup(dir); return result.ok ? [{ dir, name: path.basename(dir), manifest: result.manifest }] : []; })
    .sort((a, b) => String(b.manifest.createdAt).localeCompare(String(a.manifest.createdAt)));
}

export function validateBackup(dir) {
  const errors = [];
  let root;
  try { root = fs.realpathSync(dir); } catch { return { ok: false, errors: ['Backup directory is missing.'] }; }
  const manifestPath = path.join(root, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return { ok: false, errors: ['Backup manifest is missing or invalid JSON.'] }; }
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION || manifest.application !== APPLICATION_ID) errors.push('Backup format is not compatible with this application.');
  if (!safeName(manifest.databaseFile)) errors.push('Backup database file name is invalid.');
  if (!Array.isArray(manifest.files) || !manifest.files.length) errors.push('Backup manifest contains no files.');
  const seen = new Set();
  for (const entry of manifest.files || []) {
    if (!safeName(entry?.name) || seen.has(entry.name)) { errors.push('Backup manifest contains an unsafe or duplicate file name.'); continue; }
    seen.add(entry.name);
    const file = path.join(root, entry.name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(root, fs.realpathSync(file))) throw new Error('unsafe');
      if (stat.size !== entry.size) errors.push(`Size mismatch: ${entry.name}`);
      if (sha256File(file) !== entry.sha256) errors.push(`Hash mismatch: ${entry.name}`);
    } catch { errors.push(`Missing or unsafe file: ${entry.name}`); }
  }
  const expected = new Set(['manifest.json', ...seen]);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (!expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) errors.push(`Unexpected or unsafe backup entry: ${entry.name}`);
  const dbFile = path.join(root, String(manifest.databaseFile || ''));
  const database = safeName(manifest.databaseFile) && seen.has(manifest.databaseFile) ? sqliteDetails(dbFile) : { ok: false, error: 'Database is not declared in the backup manifest.' };
  if (!database.ok) errors.push(database.error || 'Backup database failed validation.');
  if (database.ok && Number.isFinite(manifest.schemaVersion) && database.schemaVersion !== manifest.schemaVersion) errors.push('Backup database schema version does not match its manifest.');
  if (manifest.recoveryScope !== undefined) {
    if (manifest.recoveryScope?.kind !== 'sqlite-database-snapshot' || !Array.isArray(manifest.recoveryScope.tables) || !Array.isArray(manifest.recoveryScope.excluded) || typeof manifest.recoveryScope.credentialHandling !== 'string') {
      errors.push('Backup recovery scope is invalid.');
    } else if (database.ok) {
      try {
        const currentScope = databaseSnapshotScope(dbFile);
        if (JSON.stringify(currentScope.tables) !== JSON.stringify(manifest.recoveryScope.tables)) errors.push('Backup table counts do not match its manifest.');
      } catch { errors.push('Backup table counts could not be verified.'); }
    }
  }
  return { ok: errors.length === 0, errors, manifest };
}

function writeMarker(dbPath, marker) { atomicJson(markerPath(dbPath), marker); }
function updateMarker(dbPath, marker, state, extra = {}) { const next = { ...marker, ...extra, state, updatedAt: iso(Date.now()) }; writeMarker(dbPath, next); return next; }
function retireMarker(dbPath, suffix, marker) { const target = `${markerPath(dbPath)}.${suffix}`; atomicJson(target, marker); removeIfPresent(markerPath(dbPath)); return target; }

export function stageRestore({ dbPath, backupDir, confirmationId = null, idempotencyKey = null, now = Date.now() }) {
  const root = dataDir(dbPath);
  const approvedBackups = backupsDir(dbPath);
  const resolvedBackup = assertWithin(approvedBackups, backupDir, 'Restore backup');
  const validation = validateBackup(resolvedBackup);
  if (!validation.ok) throw new Error(`Refusing to stage an invalid backup: ${validation.errors.join('; ')}`);
  if (fs.existsSync(markerPath(dbPath))) throw new Error('A restore is already staged and must finish or be recovered before another restore can start.');
  assertWithin(root, dbPath, 'Database path');
  const marker = { formatVersion: BACKUP_FORMAT_VERSION, state: 'prepared', backupDir: resolvedBackup, databaseFile: validation.manifest.databaseFile, requestedAt: iso(now), confirmationId, idempotencyKey };
  writeMarker(dbPath, marker);
  return marker;
}

export function readPendingRestore(dbPath) {
  const file = markerPath(dbPath);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { invalid: true, state: 'failed', error: 'Recovery marker is not an object.' };
  } catch { return { invalid: true, state: 'failed', error: 'Recovery marker could not be read.' }; }
}

export function clearPendingRestore(dbPath) { removeIfPresent(markerPath(dbPath)); }

export function applyPendingRestore({ dbPath, now = Date.now() }) {
  const root = dataDir(dbPath);
  let marker = readPendingRestore(dbPath);
  if (!marker) return { applied: false, reason: 'no-pending-restore' };
  if (marker.invalid) return { applied: false, reason: 'invalid-marker', failedMarker: retireMarker(dbPath, 'failed', marker) };
  let validation;
  try {
    assertWithin(backupsDir(dbPath), marker.backupDir, 'Restore backup');
    validation = validateBackup(marker.backupDir);
  } catch (error) { validation = { ok: false, errors: [error.message] }; }
  if (!validation.ok || !safeName(marker.databaseFile) || marker.databaseFile !== validation.manifest?.databaseFile) {
    return { applied: false, reason: 'invalid-backup', errors: validation.errors || ['Restore marker is invalid.'], failedMarker: retireMarker(dbPath, 'failed', { ...marker, state: 'failed', errors: validation.errors || [] }) };
  }
  const sourceDb = path.join(marker.backupDir, marker.databaseFile);
  // Tracks whether the ORIGINAL live database is known for certain to no
  // longer be sitting at dbPath -- either because this run just moved it, or
  // because a prior run already did so before crashing (liveDbPresent is
  // false but marker.rollbackDir is already recorded). The catch handler
  // below must never delete/overwrite dbPath while this is false: doing so
  // would risk destroying a still-live, never-moved original database.
  let liveMovedAside = false;
  try {
    if (marker.state === 'prepared' || marker.state === 'validated') {
      marker = updateMarker(dbPath, marker, 'validated');
      const liveDbPresent = fs.existsSync(dbPath);
      if (liveDbPresent || marker.rollbackDir) {
        // The rollback location is decided and PERSISTED to the marker
        // BEFORE the live database is renamed, not after. Recording it only
        // after the rename left a real crash window: if the process died
        // between the rename and the marker update, the marker still said
        // 'validated' with no rollbackDir, the live database was already
        // gone from dbPath, and a resume would silently treat this as "no
        // live database to preserve" (rollbackDir: null) -- orphaning the
        // user's original database with no recorded path back to it. Persist
        // first, so a crash at any point after this leaves a marker that
        // still knows exactly where the original database is (or is about
        // to go), and `liveDbPresent` on resume tells us whether the rename
        // itself still needs to happen or already happened before the crash.
        if (liveDbPresent) assertExistingRegularWithin(root, dbPath, 'Live database');
        const rollbackDir = marker.rollbackDir || path.join(backupsDir(dbPath), `pre-restore-rollback-${stamp(now)}`);
        if (!marker.rollbackDir) {
          fs.mkdirSync(rollbackDir, { recursive: true });
          marker = updateMarker(dbPath, marker, 'validated', { rollbackDir });
        }
        const rollbackDb = path.join(rollbackDir, path.basename(dbPath));
        if (liveDbPresent) {
          if (fs.existsSync(rollbackDb)) throw new Error(`Rollback path is already occupied: ${rollbackDb}`);
          // Checkpoint the live database's own WAL into its main file before
          // moving it, so the rename below carries a self-contained database
          // rather than leaving committed data behind in a sidecar that a
          // crash between the two separate renames (main file, then -wal/
          // -shm) could otherwise strand at the old path.
          let liveDbHandle;
          try {
            liveDbHandle = new DatabaseSync(dbPath);
            liveDbHandle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          } finally { try { liveDbHandle?.close(); } catch { /* the rename below still captures whatever is on disk */ } }
          fs.renameSync(dbPath, rollbackDb);
          liveMovedAside = true;
          for (const suffix of ['-wal', '-shm']) moveIfPresent(`${dbPath}${suffix}`, `${rollbackDb}${suffix}`);
        } else {
          liveMovedAside = true; // a prior run already completed the rename before crashing
        }
        marker = updateMarker(dbPath, marker, 'live-moved-aside', { rollbackDir });
      } else marker = updateMarker(dbPath, marker, 'live-moved-aside', { rollbackDir: null });
    } else if (marker.state === 'live-moved-aside' || marker.state === 'replacement-installed') {
      // Resuming past the rename step also means the original is already
      // moved aside -- otherwise the marker could not have reached this
      // state (see the transitions above, both of which set it beforehand).
      liveMovedAside = true;
    }
    if (marker.state === 'live-moved-aside' || marker.state === 'replacement-installed') {
      if (marker.state === 'live-moved-aside' && marker.rollbackDir) {
        // The old database is closed at this point. Consolidate its WAL before
        // manifesting it, so the rollback artifact is a standalone database
        // rather than a main file whose latest data still lives in a sidecar.
        // This must run on every resume that reaches this state -- not only
        // the run that performed the rename -- otherwise a crash right after
        // the marker advances to 'live-moved-aside' (before this completes)
        // would permanently skip it, since the branch above that used to
        // guard it only runs once per marker state.
        const rollbackDb = path.join(marker.rollbackDir, path.basename(dbPath));
        if (!fs.existsSync(rollbackDb)) throw new Error(`Rollback copy is missing at ${rollbackDb}; refusing to continue without a verified original-database backup.`);
        if (!fs.existsSync(path.join(marker.rollbackDir, 'manifest.json'))) {
          let rollbackDbHandle;
          try {
            rollbackDbHandle = new DatabaseSync(rollbackDb);
            rollbackDbHandle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          } finally { try { rollbackDbHandle?.close(); } catch { /* preserve rollback for recovery */ } }
          removeIfPresent(`${rollbackDb}-wal`);
          removeIfPresent(`${rollbackDb}-shm`);
          const rollbackCheck = sqliteDetails(rollbackDb);
          if (!rollbackCheck.ok) throw new Error(`Rollback copy could not be validated: ${rollbackCheck.error}`);
          atomicJson(path.join(marker.rollbackDir, 'manifest.json'), { formatVersion: BACKUP_FORMAT_VERSION, application: APPLICATION_ID, createdAt: iso(now), label: 'pre-restore-rollback', databaseFile: path.basename(dbPath), schemaVersion: rollbackCheck.schemaVersion, recoveryScope: databaseSnapshotScope(rollbackDb), provenance: { restoreBackup: path.basename(marker.backupDir) }, files: [{ name: path.basename(dbPath), sha256: sha256File(rollbackDb), size: fs.statSync(rollbackDb).size }] });
        }
      }
      if (marker.state === 'live-moved-aside') {
        const replacement = `${dbPath}.restore-${crypto.randomBytes(6).toString('hex')}.tmp`;
        fs.copyFileSync(sourceDb, replacement, fs.constants.COPYFILE_EXCL);
        const fd = fs.openSync(replacement, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(replacement, dbPath);
        marker = updateMarker(dbPath, marker, 'replacement-installed');
      }
      const installed = sqliteDetails(dbPath);
      if (!installed.ok) throw new Error(installed.error);
      marker = updateMarker(dbPath, marker, 'verified');
    }
    const logPath = path.join(root, RESTORE_LOG);
    const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
    log.push({ appliedAt: iso(now), backupDir: path.basename(marker.backupDir), rollbackDir: marker.rollbackDir ? path.basename(marker.rollbackDir) : null, confirmationId: marker.confirmationId, idempotencyKey: marker.idempotencyKey, state: 'completed' });
    atomicJson(logPath, log);
    updateMarker(dbPath, marker, 'completed');
    clearPendingRestore(dbPath);
    return { applied: true, backupDir: marker.backupDir, rollbackDir: marker.rollbackDir || null };
  } catch (error) {
    let rolledBack = false;
    // Only ever restore from rollbackDb into dbPath once liveMovedAside is
    // known true. Persisting rollbackDir to the marker before the rename (the
    // fix above) means a rename that itself throws (e.g. a stray file/dir
    // already occupying rollbackDb) would otherwise be indistinguishable here
    // from a rename that succeeded -- and blindly restoring in that case
    // would delete the still-untouched, still-live original database.
    const rollbackDb = liveMovedAside && marker.rollbackDir ? path.join(marker.rollbackDir, path.basename(dbPath)) : null;
    try {
      if (rollbackDb && fs.existsSync(rollbackDb)) {
        removeIfPresent(dbPath);
        removeIfPresent(`${dbPath}-wal`);
        removeIfPresent(`${dbPath}-shm`);
        fs.renameSync(rollbackDb, dbPath);
        for (const suffix of ['-wal', '-shm']) moveIfPresent(`${rollbackDb}${suffix}`, `${dbPath}${suffix}`);
        rolledBack = true;
      }
    } catch { /* preserve the marker for manual recovery */ }
    const failed = { ...marker, state: rolledBack ? 'rolled-back' : 'rollback-required', error: String(error.message || error), failedAt: iso(now) };
    const failedMarker = retireMarker(dbPath, 'failed', failed);
    return { applied: false, reason: rolledBack ? 'rolled-back' : 'rollback-required', error: failed.error, failedMarker };
  }
}

export function detectLegacyData({ legacyDataDir }) {
  if (!legacyDataDir || !fs.existsSync(legacyDataDir)) return { detected: false };
  const candidate = path.join(legacyDataDir, 'life-planner.sqlite');
  return { detected: fs.existsSync(candidate) && sqliteDetails(candidate).ok, databaseFile: fs.existsSync(candidate) ? candidate : null };
}

export function importLegacyAsBackup({ dbPath, legacyDataDir, now = Date.now() }) {
  const legacy = detectLegacyData({ legacyDataDir });
  if (!legacy.detected) throw new Error('No valid legacy database was found to migrate.');
  const root = dataDir(dbPath);
  const tempDir = fs.mkdtempSync(path.join(root, 'legacy-import-'));
  const tempDb = path.join(tempDir, path.basename(dbPath));
  fs.copyFileSync(legacy.databaseFile, tempDb);
  try { return createBackup({ dbPath, sources: [tempDb], label: 'legacy-migrate', provenance: { importedFromLegacy: true }, now }); }
  finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}
