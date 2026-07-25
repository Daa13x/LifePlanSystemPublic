// Durable confirmation + replay-protection foundation.
//
// A confirmation is a persisted record of a proposed state-changing operation
// (backup restore, recovery replacement, migration, destructive edit, ...). It
// survives an ordinary restart, is applied at most once, expires if untouched,
// is bound to the mutation session that created it, and rejects a stale proposal
// whose target drifted. The proposal step NEVER mutates anything; only
// confirmAndApply() does, and only after re-reading state and winning an atomic
// status transition.
//
// Hardening:
//   * The raw token is returned exactly once at creation; only its SHA-256 hash
//     is stored, and confirmation compares a hash of the supplied token with a
//     timing-safe comparison.
//   * An immutable payload digest (canonical SHA-256 over operation/target/
//     before/after/reason/origin) is stored and re-checked, so tampered stored
//     data is rejected. confirmAndApply takes ONLY {id, token, sessionId} — never
//     a replacement payload.
//   * session_id is required; a confirmation created by one session cannot be
//     confirmed by another. Internal callers pass an explicit internal session.
//   * Lifecycle events are append-only (confirmation_events); every status change
//     and its event are written in one transaction. The transition graph is
//     explicit and illegal transitions throw.
//   * An `applying` row found after restart becomes `interrupted` (requires
//     review) unless an idempotency receipt proves the external op completed.
//   * Destructive consumers must supply a revalidate() callback; the current
//     before-state is hashed and compared before any apply.
//
// Functions take the sqlite handle first (dependency injection) so they run
// against the app db or a disposable test db, and accept an injectable `now`.
// All timestamps are ISO-8601 UTC.

import crypto from 'node:crypto';

export const CONFIRMATION_STATUS = {
  PROPOSED: 'proposed',
  AWAITING: 'awaiting_confirmation',
  CONFIRMED: 'confirmed',
  APPLYING: 'applying',
  APPLIED: 'applied',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  REVERTED: 'reverted'
};

const STATUS_VALUES = Object.values(CONFIRMATION_STATUS);
const EVENT_VALUES = ['created', 'confirmed', 'applying', 'applied', 'cancelled', 'expired', 'failed', 'interrupted', 'reverted'];

// Explicit, enforced lifecycle graph. Terminal states (applied only to reverted;
// cancelled/expired/failed/interrupted/reverted) have no onward transitions.
const TRANSITIONS = {
  proposed: ['awaiting_confirmation', 'cancelled', 'expired'],
  awaiting_confirmation: ['applying', 'cancelled', 'expired'],
  applying: ['applied', 'failed', 'interrupted'],
  applied: ['reverted'],
  cancelled: [],
  expired: [],
  failed: [],
  interrupted: [],
  reverted: []
};

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

export function createConfirmationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS confirmations (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      session_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      before_state TEXT,
      after_state TEXT,
      before_digest TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT '',
      requires_revalidation INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT,
      status TEXT NOT NULL DEFAULT 'awaiting_confirmation'
        CHECK (status IN ('proposed','awaiting_confirmation','confirmed','applying','applied','cancelled','expired','failed','interrupted','reverted')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT,
      applied_at TEXT,
      cancelled_at TEXT,
      reverted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_confirmations_status ON confirmations(status);
    CREATE INDEX IF NOT EXISTS idx_confirmations_expires ON confirmations(expires_at);
    CREATE INDEX IF NOT EXISTS idx_confirmations_session ON confirmations(session_id);

    CREATE TABLE IF NOT EXISTS confirmation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      confirmation_id TEXT NOT NULL REFERENCES confirmations(id),
      event TEXT NOT NULL
        CHECK (event IN ('created','confirmed','applying','applied','cancelled','expired','failed','interrupted','reverted')),
      at TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_confirmation_events_cid ON confirmation_events(confirmation_id, id);

    CREATE TABLE IF NOT EXISTS idempotency_receipts (
      key TEXT PRIMARY KEY,
      confirmation_id TEXT,
      at TEXT NOT NULL,
      detail TEXT
    );
  `);
}

function secureId() {
  return crypto.randomBytes(16).toString('hex');
}

function secureToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashToken(token) {
  return sha256(`confirmation-token:${token}`);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Deterministic serialization (object keys sorted recursively) so a digest is
// stable regardless of property order.
function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function payloadDigestOf({ operation, target, beforeState, afterState, reason, origin }) {
  return sha256(canonicalJson({ operation, target, beforeState: beforeState ?? null, afterState: afterState ?? null, reason, origin }));
}

function beforeDigestOf(beforeState) {
  return sha256(canonicalJson(beforeState ?? null));
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Full internal row (includes token_hash). Never returned to callers/logs.
function readRow(db, id) {
  return db.prepare('SELECT * FROM confirmations WHERE id = ?').get(id) || null;
}

// Public projection: token_hash removed, JSON columns parsed. This is the only
// shape callers see, so neither the raw token (never stored) nor its hash leaks.
function toPublic(rowValue) {
  if (!rowValue) return null;
  return {
    id: rowValue.id,
    sessionId: rowValue.session_id,
    operation: rowValue.operation,
    target: rowValue.target,
    beforeState: rowValue.before_state ? JSON.parse(rowValue.before_state) : null,
    afterState: rowValue.after_state ? JSON.parse(rowValue.after_state) : null,
    beforeDigest: rowValue.before_digest,
    payloadDigest: rowValue.payload_digest,
    reason: rowValue.reason,
    origin: rowValue.origin,
    requiresRevalidation: Boolean(rowValue.requires_revalidation),
    idempotencyKey: rowValue.idempotency_key,
    status: rowValue.status,
    createdAt: rowValue.created_at,
    expiresAt: rowValue.expires_at,
    confirmedAt: rowValue.confirmed_at,
    appliedAt: rowValue.applied_at,
    cancelledAt: rowValue.cancelled_at,
    revertedAt: rowValue.reverted_at
  };
}

// Defensive redactor for anything that might carry a token/token_hash before it
// is logged or returned. The public projection already excludes both.
export function redactConfirmation(confirmation) {
  if (!confirmation) return null;
  const { token, token_hash: _tokenHash, tokenHash, ...safe } = confirmation;
  return safe;
}

export function getConfirmation(db, id) {
  return toPublic(readRow(db, id));
}

export function listConfirmations(db, { status = null } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM confirmations WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM confirmations ORDER BY created_at DESC').all();
  return rows.map(toPublic);
}

export function getConfirmationEvents(db, id) {
  return db.prepare('SELECT event, at, detail FROM confirmation_events WHERE confirmation_id = ? ORDER BY id ASC').all(id);
}

// Perform a guarded status transition and record its events (and an optional
// idempotency receipt) in a single transaction. Returns true only if the row
// was in `from` and moved to `to`. An illegal graph transition throws.
function transition(db, id, from, to, { events = [], timestamps = {}, receipt = null }) {
  if (!canTransition(from, to)) throw new Error(`Illegal confirmation transition ${from} -> ${to}`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const sets = ['status = ?'];
    const values = [to];
    for (const [column, value] of Object.entries(timestamps)) {
      sets.push(`${column} = ?`);
      values.push(value);
    }
    values.push(id, from);
    const changed = db.prepare(`UPDATE confirmations SET ${sets.join(', ')} WHERE id = ? AND status = ?`).run(...values);
    if (changed.changes !== 1) {
      db.exec('ROLLBACK');
      return false;
    }
    const insertEvent = db.prepare('INSERT INTO confirmation_events (confirmation_id, event, at, detail) VALUES (?, ?, ?, ?)');
    for (const event of events) insertEvent.run(id, event.event, event.at, event.detail ?? null);
    if (receipt) {
      db.prepare('INSERT OR IGNORE INTO idempotency_receipts (key, confirmation_id, at, detail) VALUES (?, ?, ?, ?)')
        .run(receipt.key, id, receipt.at, receipt.detail ?? null);
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  }
}

// Record a proposed operation. Does NOT mutate the target. Returns the public
// confirmation plus the raw token, which appears here and nowhere else — the
// caller must retain it to confirm later.
export function proposeConfirmation(db, {
  operation,
  target = '',
  beforeState = null,
  afterState = null,
  reason = '',
  origin = '',
  sessionId,
  requiresRevalidation = true,
  idempotencyKey = null,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now()
}) {
  if (!operation || typeof operation !== 'string') throw new Error('A confirmation operation is required.');
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('A session id is required (use an explicit internal session id for internal operations).');
  }
  const id = secureId();
  const token = secureToken();
  const createdAt = iso(now);
  const payloadDigest = payloadDigestOf({ operation, target, beforeState, afterState, reason, origin });
  const beforeDigest = beforeDigestOf(beforeState);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO confirmations
        (id, token_hash, session_id, operation, target, before_state, after_state, before_digest, payload_digest,
         reason, origin, requires_revalidation, idempotency_key, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      hashToken(token),
      sessionId,
      operation,
      String(target || ''),
      beforeState == null ? null : JSON.stringify(beforeState),
      afterState == null ? null : JSON.stringify(afterState),
      beforeDigest,
      payloadDigest,
      String(reason || ''),
      String(origin || ''),
      requiresRevalidation ? 1 : 0,
      idempotencyKey,
      CONFIRMATION_STATUS.AWAITING,
      createdAt,
      iso(now + ttlMs)
    );
    db.prepare('INSERT INTO confirmation_events (confirmation_id, event, at, detail) VALUES (?, ?, ?, ?)')
      .run(id, 'created', createdAt, operation);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  }
  return { ...toPublic(readRow(db, id)), token };
}

function reject(code, error) {
  return { ok: false, code, error };
}

// Confirm and apply exactly once. Accepts ONLY {id, token, sessionId} — never a
// replacement payload. Rejects (without applying) when the confirmation is
// missing, not awaiting, expired, from a different session, integrity-broken,
// presented with the wrong token, or (for revalidating consumers) stale. The
// awaiting->applying transition is atomic, so concurrent/duplicated confirms
// apply at most once. On apply failure the confirmation becomes `failed`.
export async function confirmAndApply(db, { id, token, sessionId }, applyFn, { now = Date.now(), revalidate = null } = {}) {
  const current = readRow(db, id);
  if (!current) return reject('not_found', 'Confirmation not found.');

  if (current.status === CONFIRMATION_STATUS.AWAITING && new Date(current.expires_at).getTime() <= now) {
    transition(db, id, CONFIRMATION_STATUS.AWAITING, CONFIRMATION_STATUS.EXPIRED, {
      events: [{ event: 'expired', at: iso(now), detail: 'expired before confirmation' }]
    });
    return reject('expired', 'This confirmation has expired. Propose it again.');
  }
  if (current.status !== CONFIRMATION_STATUS.AWAITING) {
    return reject('bad_status', `This confirmation is ${current.status} and cannot be applied.`);
  }
  // Integrity: the stored payload must still match its immutable digest.
  const recomputed = payloadDigestOf({
    operation: current.operation,
    target: current.target,
    beforeState: current.before_state ? JSON.parse(current.before_state) : null,
    afterState: current.after_state ? JSON.parse(current.after_state) : null,
    reason: current.reason,
    origin: current.origin
  });
  if (!timingSafeEqualHex(recomputed, current.payload_digest)) {
    return reject('tampered', 'Confirmation integrity check failed.');
  }
  // Session binding: only the creating session may confirm.
  if (!sessionId || typeof sessionId !== 'string' || sessionId !== current.session_id) {
    return reject('wrong_session', 'This confirmation belongs to a different session.');
  }
  // Token: compare hashes, timing-safe.
  if (!timingSafeEqualHex(hashToken(String(token || '')), current.token_hash)) {
    return reject('bad_token', 'Confirmation could not be verified.');
  }
  // Destructive consumers must revalidate the live target before applying.
  if (current.requires_revalidation) {
    if (typeof revalidate !== 'function') {
      return reject('revalidation_required', 'This confirmation requires revalidation of the live target before applying.');
    }
    const currentBefore = await revalidate(toPublic(current));
    if (!timingSafeEqualHex(beforeDigestOf(currentBefore), current.before_digest)) {
      return reject('stale', 'The target changed after this confirmation was created. Review it again.');
    }
  }

  // Atomic claim: awaiting -> applying (records confirmed + applying events).
  const claimed = transition(db, id, CONFIRMATION_STATUS.AWAITING, CONFIRMATION_STATUS.APPLYING, {
    timestamps: { confirmed_at: iso(now) },
    events: [
      { event: 'confirmed', at: iso(now), detail: null },
      { event: 'applying', at: iso(now), detail: null }
    ]
  });
  if (!claimed) return reject('already_claimed', 'This confirmation is already being applied.');

  try {
    const result = typeof applyFn === 'function' ? await applyFn(toPublic(current)) : null;
    transition(db, id, CONFIRMATION_STATUS.APPLYING, CONFIRMATION_STATUS.APPLIED, {
      timestamps: { applied_at: iso(now) },
      events: [{ event: 'applied', at: iso(now), detail: null }],
      receipt: current.idempotency_key ? { key: current.idempotency_key, at: iso(now), detail: 'applied' } : null
    });
    return { ok: true, confirmation: getConfirmation(db, id), result };
  } catch (error) {
    transition(db, id, CONFIRMATION_STATUS.APPLYING, CONFIRMATION_STATUS.FAILED, {
      events: [{ event: 'failed', at: iso(now), detail: String(error?.message || error) }]
    });
    return reject('apply_failed', String(error?.message || error));
  }
}

// Cancel a confirmation that has not yet been claimed. Returns true if it moved.
export function cancelConfirmation(db, id, { now = Date.now() } = {}) {
  return transition(db, id, CONFIRMATION_STATUS.AWAITING, CONFIRMATION_STATUS.CANCELLED, {
    timestamps: { cancelled_at: iso(now) },
    events: [{ event: 'cancelled', at: iso(now), detail: null }]
  });
}

// Record a reversion of an already-applied confirmation.
export function revertConfirmation(db, id, { now = Date.now(), detail = null } = {}) {
  return transition(db, id, CONFIRMATION_STATUS.APPLIED, CONFIRMATION_STATUS.REVERTED, {
    timestamps: { reverted_at: iso(now) },
    events: [{ event: 'reverted', at: iso(now), detail }]
  });
}

// Move past-due awaiting confirmations to expired. Returns the count moved.
export function expireStaleConfirmations(db, { now = Date.now() } = {}) {
  const due = db.prepare('SELECT id FROM confirmations WHERE status = ? AND expires_at <= ?')
    .all(CONFIRMATION_STATUS.AWAITING, iso(now));
  let moved = 0;
  for (const rowValue of due) {
    if (transition(db, rowValue.id, CONFIRMATION_STATUS.AWAITING, CONFIRMATION_STATUS.EXPIRED, {
      events: [{ event: 'expired', at: iso(now), detail: 'expired by sweep' }]
    })) moved += 1;
  }
  return moved;
}

// Restart safety: a confirmation left `applying` when the process died is NEVER
// re-applied automatically. It becomes `interrupted` (requires human review),
// unless an idempotency receipt proves its external op already completed, in
// which case it is settled as `applied`.
export function recoverInterruptedConfirmations(db, { now = Date.now() } = {}) {
  const rows = db.prepare('SELECT id, idempotency_key FROM confirmations WHERE status = ?').all(CONFIRMATION_STATUS.APPLYING);
  const result = { applied: 0, interrupted: 0 };
  for (const rowValue of rows) {
    const receipt = rowValue.idempotency_key
      ? db.prepare('SELECT key FROM idempotency_receipts WHERE key = ?').get(rowValue.idempotency_key)
      : null;
    if (receipt) {
      transition(db, rowValue.id, CONFIRMATION_STATUS.APPLYING, CONFIRMATION_STATUS.APPLIED, {
        timestamps: { applied_at: iso(now) },
        events: [{ event: 'applied', at: iso(now), detail: 'recovered via idempotency receipt' }]
      });
      result.applied += 1;
    } else {
      transition(db, rowValue.id, CONFIRMATION_STATUS.APPLYING, CONFIRMATION_STATUS.INTERRUPTED, {
        events: [{ event: 'interrupted', at: iso(now), detail: 'applying interrupted by restart; requires review' }]
      });
      result.interrupted += 1;
    }
  }
  return result;
}
