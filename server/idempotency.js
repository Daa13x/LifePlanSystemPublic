import crypto from 'node:crypto';

// Request idempotency for retry-unsafe multi-row mutations. A client that never
// sees a response (dropped connection, proxy timeout) will retry; without a dedup
// key that retry re-runs the whole write and duplicates rows. Callers pass a
// stable key (X-LPS-Idempotency-Key header or a body field) and the runner below
// records the first result so an identical retry replays it instead of writing
// again — and, crucially, records the key IN THE SAME TRANSACTION as the writes,
// so a failed write leaves no key and a genuine retry can still succeed.

// A key is client-chosen provenance: constrain it to a sane charset/length so it
// can be trusted as a table key and echoed in errors. 8-200 chars.
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

export function normalizeIdempotencyKey(value) {
  const key = String(value ?? '').trim();
  if (!key || !KEY_PATTERN.test(key)) return null;
  return key;
}

// Stable stringify: sort object keys recursively so two payloads that differ only
// in property order hash identically. Arrays keep their order (order is meaning).
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function hashRequest(payload) {
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}

// Reusing a key with a materially different request is a client bug, not a retry;
// surface it as a conflict rather than silently replaying the wrong result.
export class IdempotencyConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdempotencyConflictError';
    this.statusCode = 409;
  }
}

// Run `execute` at most once per (route, key). `execute()` performs the writes
// WITHOUT opening its own transaction (this runner owns the single transaction)
// and returns { statusCode, body }. `transaction(fn)` is injected so this module
// stays decoupled from a specific database handle. Returns { replayed, statusCode,
// body }: replayed=true means the stored first result was returned and no new
// write happened. With no key, it runs once transactionally with no dedup record
// (backward-compatible with callers that do not send a key).
export function runIdempotent({ db, transaction, route, key, requestHash, execute }) {
  if (!key) {
    const result = transaction(execute);
    return { replayed: false, ...result };
  }
  return transaction(() => {
    const existing = db
      .prepare('SELECT request_hash, status_code, response_json FROM request_idempotency WHERE route = ? AND idempotency_key = ?')
      .get(route, key);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new IdempotencyConflictError('This idempotency key was already used with a different request.');
      }
      return { replayed: true, statusCode: existing.status_code, body: JSON.parse(existing.response_json) };
    }
    const result = execute();
    db.prepare(
      'INSERT INTO request_idempotency (idempotency_key, route, request_hash, status_code, response_json) VALUES (?, ?, ?, ?, ?)'
    ).run(key, route, requestHash, result.statusCode, JSON.stringify(result.body));
    return { replayed: false, ...result };
  });
}
