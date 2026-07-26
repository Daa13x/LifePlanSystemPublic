// Startup restore bootstrap.
//
// This module runs at import time and MUST be imported before ./db.js so a
// staged database restore is applied to the file before any SQLite connection is
// opened. It deliberately does not import ./db.js (which would open the database)
// and re-derives the database path exactly the way db.js does.
//
// applyPendingRestore is idempotent and keeps a rollback copy, so a crash during
// the swap is safe: the marker persists and the next start finishes the swap.

import path from 'node:path';
import { applyPendingRestore, readPendingRestore } from './setupRecovery.js';

const dbPath = path.resolve(process.env.LIFE_PLANNER_DB || path.join(process.cwd(), 'data', 'life-planner.sqlite'));

if (readPendingRestore(dbPath)) {
  const result = applyPendingRestore({ dbPath });
  if (result.applied) {
    console.log(`Startup restore applied before database open (backup: ${result.backupDir}; rollback: ${result.rollbackDir}).`);
  } else if (['invalid-backup', 'invalid-marker', 'rolled-back'].includes(result.reason)) {
    console.warn(`Staged restore did not replace the live database and was retained as recovery evidence: ${result.reason}.`);
  } else {
    // Do not open SQLite over an ambiguous interrupted swap. The failed marker
    // records the exact recovery state for repair; starting normally here could
    // make an unresolved restore look successful.
    throw new Error(`Setup and Recovery requires human action before startup can continue: ${result.reason || 'unresolved restore'}.`);
  }
}

export const restoreBootstrapDbPath = dbPath;
