#!/usr/bin/env node
// Verify the durable confirmation + replay-protection foundation using the REAL
// server/confirmations.js module against a disposable on-disk SQLite database.
//
// Covers: raw token absent from the DB; token/state redaction; propose-does-not-
// mutate; wrong token; wrong mutation session; altered stored payload (digest
// mismatch); two simultaneous confirms applying exactly once; cancelled and
// expired rejection; stale before-state rejection (and mandatory revalidation);
// append-only event order; failure after application begins; atomic same-DB
// mutation+settlement; restart while `applying` (interrupted vs idempotency-receipt recovery); migration
// idempotency; reversion; and survival across a simulated restart.
//
// Local-only: no network, no server. Exit 0 = pass.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CONFIRMATION_STATUS,
  canTransition,
  createConfirmationsTable,
  proposeConfirmation,
  confirmAndApply,
  cancelConfirmation,
  revertConfirmation,
  expireStaleConfirmations,
  recoverInterruptedConfirmations,
  getConfirmation,
  getConfirmationEvents,
  redactConfirmation
} from '../server/confirmations.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-confirmations-'));
const dbPath = path.join(probeRoot, 'confirmations.sqlite');
const SESSION = 'session-A';
const OTHER_SESSION = 'session-B';
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60 * 1000;
const events = (db, id) => getConfirmationEvents(db, id).map((event) => event.event);

console.log('--- durable confirmations verification ---');

try {
  let db = new DatabaseSync(dbPath);
  createConfirmationsTable(db);

  // ---- session requirement + propose-does-not-mutate + token storage ----
  let threw = false;
  try { proposeConfirmation(db, { operation: 'op', now: T0 }); } catch { threw = true; }
  line(threw, 'propose without a session id is refused');

  let applied = 0;
  const apply = () => { applied += 1; return 'done'; };
  const proposal = proposeConfirmation(db, {
    operation: 'backup.restore', target: 'db', beforeState: { rows: 10 }, afterState: { rows: 10 },
    reason: 'restore', origin: 'recovery', sessionId: SESSION, requiresRevalidation: false, ttlMs: 10 * MIN, now: T0
  });
  line(proposal.status === CONFIRMATION_STATUS.AWAITING, 'propose creates an awaiting confirmation');
  line(typeof proposal.token === 'string' && /^[a-f0-9]{64}$/.test(proposal.token), 'propose returns a 64-hex raw token');
  line(applied === 0, 'propose does NOT run the apply side effect');

  const cols = db.prepare("PRAGMA table_info('confirmations')").all().map((c) => c.name);
  line(!cols.includes('token') && cols.includes('token_hash'), 'DB stores token_hash, not a raw token column');
  const storedRow = db.prepare('SELECT * FROM confirmations WHERE id = ?').get(proposal.id);
  line(!Object.values(storedRow).includes(proposal.token), 'raw token value is absent from the stored row');
  line(/^[a-f0-9]{64}$/.test(storedRow.token_hash) && storedRow.token_hash !== proposal.token, 'token_hash is a SHA-256, not the raw token');

  // ---- redaction of returned / logged objects ----
  const pub = getConfirmation(db, proposal.id);
  line(!('token' in pub) && !('tokenHash' in pub) && !('token_hash' in pub), 'public confirmation omits token and token_hash');
  const red = redactConfirmation({ token: 'raw', token_hash: 'h', id: 'x' });
  line(!('token' in red) && !('token_hash' in red), 'redactConfirmation strips token and token_hash');

  // ---- wrong token / wrong session ----
  {
    const r = await confirmAndApply(db, { id: proposal.id, token: 'wrong', sessionId: SESSION }, apply, { now: T0 + MIN });
    line(!r.ok && r.code === 'bad_token' && applied === 0, 'wrong token is rejected, no apply');
  }
  {
    const r = await confirmAndApply(db, { id: proposal.id, token: proposal.token, sessionId: OTHER_SESSION }, apply, { now: T0 + MIN });
    line(!r.ok && r.code === 'wrong_session' && applied === 0, 'a different mutation session is rejected');
  }

  // ---- correct confirm applies once + append-only event order + replay ----
  {
    const r = await confirmAndApply(db, { id: proposal.id, token: proposal.token, sessionId: SESSION }, apply, { now: T0 + MIN });
    line(r.ok && applied === 1 && r.confirmation.status === CONFIRMATION_STATUS.APPLIED, 'correct token+session applies exactly once');
    line(JSON.stringify(events(db, proposal.id)) === JSON.stringify(['created', 'confirmed', 'applying', 'applied']), 'events are append-only in order: created, confirmed, applying, applied');
  }
  {
    const r = await confirmAndApply(db, { id: proposal.id, token: proposal.token, sessionId: SESSION }, apply, { now: T0 + 2 * MIN });
    line(!r.ok && r.code === 'bad_status' && applied === 1, 'replay of an applied confirmation does not re-apply');
  }

  // ---- altered stored payload => digest mismatch rejected ----
  {
    const t = proposeConfirmation(db, { operation: 'op', reason: 'orig', sessionId: SESSION, requiresRevalidation: false, ttlMs: 10 * MIN, now: T0 });
    db.prepare('UPDATE confirmations SET reason = ? WHERE id = ?').run('tampered', t.id);
    const r = await confirmAndApply(db, { id: t.id, token: t.token, sessionId: SESSION }, apply, { now: T0 + MIN });
    line(!r.ok && r.code === 'tampered', 'altered stored payload (digest mismatch) is rejected');
  }

  // ---- mandatory revalidation + stale before-state ----
  {
    const d = proposeConfirmation(db, { operation: 'migration.apply', beforeState: { schema: 1 }, sessionId: SESSION, ttlMs: 10 * MIN, now: T0 });
    const missing = await confirmAndApply(db, { id: d.id, token: d.token, sessionId: SESSION }, apply, { now: T0 + MIN });
    line(!missing.ok && missing.code === 'revalidation_required', 'destructive confirm without revalidate is refused');
    let ran = 0;
    const stale = await confirmAndApply(db, { id: d.id, token: d.token, sessionId: SESSION }, () => { ran += 1; }, { now: T0 + MIN, revalidate: () => ({ schema: 2 }) });
    line(!stale.ok && stale.code === 'stale' && ran === 0, 'stale before-state (drifted target) is rejected, no apply');
    line(getConfirmation(db, d.id).status === CONFIRMATION_STATUS.AWAITING, 'stale confirmation is not consumed');
    const ok = await confirmAndApply(db, { id: d.id, token: d.token, sessionId: SESSION }, () => 'ok', { now: T0 + MIN, revalidate: () => ({ schema: 1 }) });
    line(ok.ok, 'matching revalidated before-state allows the apply');
  }

  // ---- expiry + cancel ----
  {
    const e = proposeConfirmation(db, { operation: 'op', sessionId: SESSION, requiresRevalidation: false, ttlMs: 5 * MIN, now: T0 });
    const r = await confirmAndApply(db, { id: e.id, token: e.token, sessionId: SESSION }, apply, { now: T0 + 6 * MIN });
    line(!r.ok && r.code === 'expired' && getConfirmation(db, e.id).status === CONFIRMATION_STATUS.EXPIRED, 'expired confirmation is rejected');
  }
  {
    const c = proposeConfirmation(db, { operation: 'op', sessionId: SESSION, requiresRevalidation: false, ttlMs: 10 * MIN, now: T0 });
    line(cancelConfirmation(db, c.id, { now: T0 }) === true, 'cancel moves awaiting -> cancelled');
    const r = await confirmAndApply(db, { id: c.id, token: c.token, sessionId: SESSION }, apply, { now: T0 + MIN });
    line(!r.ok && r.code === 'bad_status', 'a cancelled confirmation cannot be applied');
  }

  // ---- failure after application begins ----
  {
    const f = proposeConfirmation(db, { operation: 'op', sessionId: SESSION, requiresRevalidation: false, ttlMs: 10 * MIN, now: T0 });
    const r = await confirmAndApply(db, { id: f.id, token: f.token, sessionId: SESSION }, () => { throw new Error('disk full'); }, { now: T0 + MIN });
    line(!r.ok && r.code === 'apply_failed' && getConfirmation(db, f.id).status === CONFIRMATION_STATUS.FAILED, 'apply failure marks the confirmation failed');
    line(JSON.stringify(events(db, f.id)) === JSON.stringify(['created', 'confirmed', 'applying', 'failed']), 'failure event follows applying in order');
    const retry = await confirmAndApply(db, { id: f.id, token: f.token, sessionId: SESSION }, () => 'ok', { now: T0 + 2 * MIN });
    line(!retry.ok && retry.code === 'bad_status', 'a failed confirmation is not silently retried');
  }

  // ---- same-database mutation + final receipt are one transaction ----
  {
    db.exec(`
      CREATE TABLE transactional_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TRIGGER reject_applied_settlement
      BEFORE UPDATE OF status ON confirmations
      WHEN NEW.status = 'applied'
      BEGIN
        SELECT RAISE(ABORT, 'settlement rejected');
      END;
    `);
    const atomic = proposeConfirmation(db, { operation: 'same-db.write', sessionId: SESSION, requiresRevalidation: false, ttlMs: 10 * MIN, now: T0 });
    const failed = await confirmAndApply(
      db,
      { id: atomic.id, token: atomic.token, sessionId: SESSION },
      () => db.prepare('INSERT INTO transactional_targets (value) VALUES (?)').run('must roll back'),
      { now: T0 + MIN, transactionalApply: true }
    );
    line(!failed.ok && failed.code === 'apply_failed', 'transactional settlement failure is reported');
    line(db.prepare('SELECT COUNT(*) AS count FROM transactional_targets').get().count === 0, 'transactional settlement failure rolls back the target mutation');
    line(getConfirmation(db, atomic.id).status === CONFIRMATION_STATUS.FAILED, 'rolled-back transactional apply settles as failed');
    db.exec('DROP TRIGGER reject_applied_settlement');

    const success = proposeConfirmation(db, { operation: 'same-db.write', sessionId: SESSION, requiresRevalidation: false, ttlMs: 10 * MIN, now: T0 });
    const settledResult = await confirmAndApply(
      db,
      { id: success.id, token: success.token, sessionId: SESSION },
      () => db.prepare('INSERT INTO transactional_targets (value) VALUES (?)').run('committed').lastInsertRowid,
      { now: T0 + MIN, transactionalApply: true }
    );
    line(settledResult.ok && db.prepare('SELECT COUNT(*) AS count FROM transactional_targets').get().count === 1, 'transactional apply commits the target mutation and applied receipt together');
    line(getConfirmation(db, success.id).status === CONFIRMATION_STATUS.APPLIED, 'successful transactional apply has an applied receipt');
  }

  // ---- two simultaneous confirms => exactly one application ----
  {
    const c = proposeConfirmation(db, { operation: 'op', beforeState: { v: 1 }, sessionId: SESSION, ttlMs: 10 * MIN, now: T0 });
    let count = 0;
    const slowApply = async () => { count += 1; await Promise.resolve(); };
    const reval = async () => { await Promise.resolve(); return { v: 1 }; };
    const [r1, r2] = await Promise.all([
      confirmAndApply(db, { id: c.id, token: c.token, sessionId: SESSION }, slowApply, { now: T0 + MIN, revalidate: reval }),
      confirmAndApply(db, { id: c.id, token: c.token, sessionId: SESSION }, slowApply, { now: T0 + MIN, revalidate: reval })
    ]);
    const oks = [r1, r2].filter((r) => r.ok).length;
    line(oks === 1 && count === 1, 'two simultaneous confirms apply exactly once');
    line([r1, r2].some((r) => !r.ok && r.code === 'already_claimed'), 'the losing concurrent confirm is refused as already_claimed');
  }

  // ---- migration idempotency: success records a receipt ----
  {
    const m = proposeConfirmation(db, { operation: 'migration.apply', sessionId: SESSION, requiresRevalidation: false, idempotencyKey: 'mig-success', ttlMs: 10 * MIN, now: T0 });
    const r = await confirmAndApply(db, { id: m.id, token: m.token, sessionId: SESSION }, () => 'ok', { now: T0 + MIN });
    line(r.ok, 'migration confirm applies');
    const receipt = db.prepare('SELECT key FROM idempotency_receipts WHERE key = ?').get('mig-success');
    line(Boolean(receipt), 'a successful idempotent confirm records a receipt');
  }

  // ---- restart while `applying`: interrupted (no receipt) vs applied (receipt) ----
  const crash = (op, key) => {
    const c = proposeConfirmation(db, { operation: op, sessionId: SESSION, requiresRevalidation: false, idempotencyKey: key, ttlMs: 30 * MIN, now: T0 });
    // Simulate a committed claim followed by a process crash mid-apply.
    db.prepare('UPDATE confirmations SET status = ?, confirmed_at = ? WHERE id = ?').run('applying', new Date(T0).toISOString(), c.id);
    db.prepare("INSERT INTO confirmation_events (confirmation_id, event, at, detail) VALUES (?, 'applying', ?, 'simulated crash')").run(c.id, new Date(T0).toISOString());
    return c;
  };
  const interrupted = crash('recovery.replace', null);
  const settled = crash('migration.apply', 'mig-recovered');
  db.prepare("INSERT INTO idempotency_receipts (key, confirmation_id, at, detail) VALUES ('mig-recovered', ?, ?, 'external op done')").run(settled.id, new Date(T0).toISOString());
  const recovery = recoverInterruptedConfirmations(db, { now: T0 + MIN });
  line(recovery.interrupted === 1 && getConfirmation(db, interrupted.id).status === CONFIRMATION_STATUS.INTERRUPTED, 'an applying confirmation with no receipt becomes interrupted (requires review)');
  line(recovery.applied === 1 && getConfirmation(db, settled.id).status === CONFIRMATION_STATUS.APPLIED, 'an applying confirmation with an idempotency receipt settles as applied');

  // ---- reversion event handling ----
  {
    const a = proposeConfirmation(db, { operation: 'op', sessionId: SESSION, requiresRevalidation: false, ttlMs: 10 * MIN, now: T0 });
    await confirmAndApply(db, { id: a.id, token: a.token, sessionId: SESSION }, () => 'ok', { now: T0 + MIN });
    line(revertConfirmation(db, a.id, { now: T0 + 2 * MIN, detail: 'rolled back' }) === true, 'an applied confirmation can be reverted');
    line(getConfirmation(db, a.id).status === CONFIRMATION_STATUS.REVERTED, 'status becomes reverted');
    line(events(db, a.id).at(-1) === 'reverted', 'reversion appends a reverted event');
    line(revertConfirmation(db, proposal.id, { now: T0 + 3 * MIN }) === false || getConfirmation(db, proposal.id).status === CONFIRMATION_STATUS.REVERTED, 'revert only applies from an applied state');
  }

  // ---- lifecycle graph is explicit ----
  line(canTransition('awaiting_confirmation', 'applying') && !canTransition('applied', 'applying') && !canTransition('cancelled', 'applied'), 'transition graph rejects illegal moves');

  // ---- expiry sweep ----
  {
    proposeConfirmation(db, { operation: 'op', sessionId: SESSION, requiresRevalidation: false, ttlMs: 1 * MIN, now: T0 });
    line(expireStaleConfirmations(db, { now: T0 + 5 * MIN }) >= 1, 'expireStaleConfirmations sweeps past-due awaiting confirmations');
  }

  // ---- survival across a real close + reopen ----
  const survivor = proposeConfirmation(db, { operation: 'op', sessionId: SESSION, requiresRevalidation: false, ttlMs: 30 * MIN, now: T0 });
  const survivorToken = survivor.token;
  db.close();
  db = new DatabaseSync(dbPath);
  line(getConfirmation(db, survivor.id)?.status === CONFIRMATION_STATUS.AWAITING, 'a confirmation survives a restart (close + reopen)');
  {
    let ran = 0;
    const r = await confirmAndApply(db, { id: survivor.id, token: survivorToken, sessionId: SESSION }, () => { ran += 1; }, { now: T0 + MIN });
    line(r.ok && ran === 1, 'a confirmation proposed before restart applies after restart');
  }
  db.close();
} finally {
  fs.rmSync(probeRoot, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll durable-confirmation checks passed.');
process.exit(failures ? 1 : 0);
