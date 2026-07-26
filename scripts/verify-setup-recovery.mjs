#!/usr/bin/env node
// Verify the Setup & Recovery engine using the REAL server/setupRecovery.js
// module against a disposable data directory and a real SQLite database.
//
// Covers: environment detection; backup + manifest validation; tampered-backup
// rejection; staged restore does not touch the live DB; applyPendingRestore swaps
// the DB, keeps a rollback, and is idempotent; an invalid staged backup never
// overwrites live data; legacy data-only migration through the same safe path;
// and no user-data loss. Local-only: no network, no server. Exit 0 = pass.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assessEnvironment,
  createBackup,
  validateBackup,
  listBackups,
  stageRestore,
  readPendingRestore,
  applyPendingRestore,
  detectLegacyData,
  importLegacyAsBackup,
  isSqliteFile
} from '../server/setupRecovery.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-setup-recovery-'));
const dataDir = path.join(probeRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'life-planner.sqlite');
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60 * 1000;
let clock = T0;
const now = () => (clock += MIN); // strictly increasing so backup dir names are unique

function writeValue(file, value) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('marker', value);
  db.close();
}
function readValue(file) {
  const db = new DatabaseSync(file);
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get('marker');
  db.close();
  return row?.v ?? null;
}

console.log('--- setup & recovery verification ---');

try {
  // isSqliteFile discriminates a real DB from arbitrary bytes.
  writeValue(dbPath, 'ORIGINAL');
  const textFile = path.join(dataDir, 'notes.txt');
  fs.writeFileSync(textFile, 'not a database');
  line(isSqliteFile(dbPath), 'isSqliteFile accepts a real SQLite database');
  line(!isSqliteFile(textFile), 'isSqliteFile rejects a non-database file');

  // Detection: existing, usable DB => not first run, ready.
  const assessment = assessEnvironment({ dbPath, now: now() });
  line(assessment.firstRun === false && assessment.ready === true, 'assessEnvironment reports a ready, non-first-run app');
  line(assessment.checks.some((c) => c.id === 'database' && c.ok), 'database check passes for a valid DB');

  // Backup + validation.
  const backup = createBackup({ dbPath, label: 'manual', now: now() });
  line(fs.existsSync(path.join(backup.dir, 'manifest.json')), 'createBackup writes a manifest');
  line(backup.manifest.recoveryScope?.kind === 'sqlite-database-snapshot' && backup.manifest.recoveryScope.tables.length > 0, 'backup manifest lists included SQLite tables');
  line(backup.manifest.recoveryScope?.credentialHandling?.includes('DPAPI') && backup.manifest.recoveryScope.excluded.includes('logs'), 'backup manifest truthfully records DPAPI credential handling and excluded local files');
  line(validateBackup(backup.dir).ok, 'a fresh backup validates');
  line(listBackups(dbPath).length >= 1, 'listBackups returns the new backup');

  // Tampered backup fails validation and cannot be staged.
  const tampered = createBackup({ dbPath, label: 'tamper', now: now() });
  fs.appendFileSync(path.join(tampered.dir, 'life-planner.sqlite'), Buffer.from([0]));
  line(!validateBackup(tampered.dir).ok, 'a tampered backup fails validation (hash mismatch)');
  let stageThrew = false;
  try { stageRestore({ dbPath, backupDir: tampered.dir, now: now() }); } catch { stageThrew = true; }
  line(stageThrew, 'staging an invalid backup is refused');

  // Manifest entries and restore locations are boundaries, not caller input.
  const traversal = createBackup({ dbPath, label: 'traversal', now: now() });
  const traversalManifest = JSON.parse(fs.readFileSync(path.join(traversal.dir, 'manifest.json'), 'utf8'));
  traversalManifest.files[0].name = '../outside.sqlite';
  fs.writeFileSync(path.join(traversal.dir, 'manifest.json'), JSON.stringify(traversalManifest));
  line(!validateBackup(traversal.dir).ok, 'a traversal manifest entry is rejected');
  const schemaMismatch = createBackup({ dbPath, label: 'schema-mismatch', now: now() });
  const schemaManifest = JSON.parse(fs.readFileSync(path.join(schemaMismatch.dir, 'manifest.json'), 'utf8'));
  schemaManifest.schemaVersion += 1;
  fs.writeFileSync(path.join(schemaMismatch.dir, 'manifest.json'), JSON.stringify(schemaManifest));
  line(!validateBackup(schemaMismatch.dir).ok, 'an incompatible schema version is rejected');
  let outsideThrew = false;
  try { stageRestore({ dbPath, backupDir: probeRoot, now: now() }); } catch { outsideThrew = true; }
  line(outsideThrew, 'a restore path outside the approved backup boundary is rejected');

  // Drift the live DB, then stage a restore of the ORIGINAL backup.
  writeValue(dbPath, 'CHANGED');
  const marker = stageRestore({ dbPath, backupDir: backup.dir, confirmationId: 'c1', idempotencyKey: 'restore-1', now: now() });
  line(Boolean(marker) && Boolean(readPendingRestore(dbPath)), 'stageRestore writes a pending-restore marker');
  line(readPendingRestore(dbPath).state === 'prepared' && !fs.readdirSync(dataDir).some((name) => name.startsWith('.pending-restore')), 'restore state is atomically published without a temporary marker');
  let duplicateThrew = false;
  try { stageRestore({ dbPath, backupDir: backup.dir, now: now() }); } catch { duplicateThrew = true; }
  line(duplicateThrew, 'a duplicate restore cannot replace an existing pending operation');
  line(readValue(dbPath) === 'CHANGED', 'staging does NOT touch the live database');
  line(assessEnvironment({ dbPath, now: now() }).pendingRestore === true, 'assessEnvironment reports the pending restore');

  // Apply the staged restore (the "next startup" swap).
  const applied = applyPendingRestore({ dbPath, now: now() });
  line(applied.applied === true, 'applyPendingRestore applies the staged restore');
  line(readValue(dbPath) === 'ORIGINAL', 'the live database is restored to the backup contents');
  line(applied.rollbackDir && readValue(path.join(applied.rollbackDir, 'life-planner.sqlite')) === 'CHANGED', 'a rollback copy of the pre-restore database is kept');
  line(readPendingRestore(dbPath) === null, 'the marker is cleared after applying');

  // Idempotent: re-running finds no marker and does nothing.
  line(applyPendingRestore({ dbPath, now: now() }).applied === false, 'applyPendingRestore is a no-op once the marker is cleared');

  // Resume the durable mid-swap state a process could leave after moving the
  // live database aside but before installing the validated replacement.
  writeValue(dbPath, 'INTERRUPTED');
  const interruptedRollback = path.join(dataDir, 'interrupted-rollback');
  fs.mkdirSync(interruptedRollback);
  fs.renameSync(dbPath, path.join(interruptedRollback, 'life-planner.sqlite'));
  fs.writeFileSync(path.join(dataDir, 'pending-restore.json'), JSON.stringify({ formatVersion: 1, state: 'live-moved-aside', backupDir: backup.dir, databaseFile: 'life-planner.sqlite', rollbackDir: interruptedRollback, requestedAt: '2026-01-01T00:00:00.000Z' }));
  const resumed = applyPendingRestore({ dbPath, now: now() });
  line(resumed.applied === true && readValue(dbPath) === 'ORIGINAL', 'an interrupted live-moved-aside restore resumes safely on the next startup');

  // An invalid staged backup must never overwrite live data.
  writeValue(dbPath, 'KEEP');
  fs.writeFileSync(path.join(dataDir, 'pending-restore.json'), JSON.stringify({ backupDir: path.join(dataDir, 'does-not-exist'), databaseFile: 'life-planner.sqlite', requestedAt: '2026-01-01T00:00:00.000Z' }));
  const badApply = applyPendingRestore({ dbPath, now: now() });
  line(badApply.applied === false && badApply.reason === 'invalid-backup', 'an invalid staged backup is rejected at apply time');
  line(readValue(dbPath) === 'KEEP', 'live data is untouched when the staged backup is invalid');
  line(fs.existsSync(path.join(dataDir, 'pending-restore.json.failed')), 'the invalid marker is retired to a .failed file');

  // Legacy data-only migration through the same safe, hashed, staged path.
  const legacyDir = path.join(probeRoot, 'legacy-data');
  fs.mkdirSync(legacyDir, { recursive: true });
  writeValue(path.join(legacyDir, 'life-planner.sqlite'), 'LEGACY');
  line(detectLegacyData({ legacyDataDir: legacyDir }).detected, 'detectLegacyData finds a legacy database');
  line(assessEnvironment({ dbPath, legacyDataDir: legacyDir, now: now() }).legacyDetected === true, 'assessEnvironment surfaces a legacy install');
  const legacyBackup = importLegacyAsBackup({ dbPath, legacyDataDir: legacyDir, now: now() });
  line(validateBackup(legacyBackup.dir).ok, 'imported legacy backup validates');
  stageRestore({ dbPath, backupDir: legacyBackup.dir, confirmationId: 'c2', idempotencyKey: 'legacy-1', now: now() });
  const legacyApplied = applyPendingRestore({ dbPath, now: now() });
  line(legacyApplied.applied === true && readValue(dbPath) === 'LEGACY', 'legacy data-only migration applies through the staged restore path');

  // No user-data loss: the restored/migrated DB is a real DB with the expected row.
  line(isSqliteFile(dbPath) && readValue(dbPath) === 'LEGACY', 'final database is valid with the expected data (no loss)');
} finally {
  fs.rmSync(probeRoot, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll setup & recovery checks passed.');
process.exit(failures ? 1 : 0);
