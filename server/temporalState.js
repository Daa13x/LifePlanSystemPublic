// Deterministic current-state projection plus append-only transition ledger.
// This is not a memory authority and never promotes prose.

export const STATE_STATUSES = Object.freeze(['CURRENT', 'SUPERSEDED', 'STALE', 'HISTORICAL', 'UNVERIFIED', 'DISPUTED', 'INVALID']);
export const FRESHNESS_CLASSES = Object.freeze(['STATIC', 'SEMI_STATIC', 'DYNAMIC', 'LIVE']);

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function setCurrentStatePoint(database, {
  key, value, freshnessClass = 'DYNAMIC', source,
  evidenceType = 'runtime_receipt', verificationState = 'verified', confidence = 1,
  validFrom = new Date().toISOString(), validUntil = null, receiptId = null,
  originatingMessageId = null
}) {
  if (!/^[a-z0-9_.-]{3,160}$/.test(String(key || ''))) throw new Error('State point key is invalid.');
  if (!FRESHNESS_CLASSES.includes(freshnessClass)) throw new Error('State freshness class is invalid.');
  if (!String(source || '').trim()) throw new Error('State point source is required.');
  const valueJson = JSON.stringify(value);
  const existing = database.prepare('SELECT * FROM state_points WHERE key = ?').get(key);

  if (existing && existing.value_json === valueJson && existing.status === 'CURRENT') {
    database.prepare(`UPDATE state_points SET freshness_class = ?, source = ?, evidence_type = ?, verification_state = ?, confidence = ?,
      valid_until = ?, last_verified = ?, receipt_id = ?, originating_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?`)
      .run(freshnessClass, source, evidenceType, verificationState, confidence, validUntil, validFrom, receiptId, originatingMessageId, key);
    return getCurrentStatePoint(database, key);
  }

  if (existing?.current_event_id) {
    database.prepare("UPDATE state_events SET status = 'SUPERSEDED' WHERE id = ? AND status = 'CURRENT'").run(existing.current_event_id);
  }
  const eventId = Number(database.prepare(`INSERT INTO state_events
    (point_key, previous_value_json, value_json, status, freshness_class, source, evidence_type, verification_state, confidence, valid_from, valid_until, receipt_id, originating_message_id)
    VALUES (?, ?, ?, 'CURRENT', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(key, existing?.value_json || null, valueJson, freshnessClass, source, evidenceType, verificationState, confidence, validFrom, validUntil, receiptId, originatingMessageId).lastInsertRowid);
  if (existing?.current_event_id) database.prepare('UPDATE state_events SET superseded_by = ? WHERE id = ?').run(eventId, existing.current_event_id);
  database.prepare(`INSERT INTO state_points
    (key, value_json, status, freshness_class, source, evidence_type, verification_state, confidence, valid_from, valid_until, last_verified, current_event_id, receipt_id, originating_message_id)
    VALUES (?, ?, 'CURRENT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, status = 'CURRENT', freshness_class = excluded.freshness_class,
      source = excluded.source, evidence_type = excluded.evidence_type, verification_state = excluded.verification_state,
      confidence = excluded.confidence, valid_from = excluded.valid_from, valid_until = excluded.valid_until,
      last_verified = excluded.last_verified, current_event_id = excluded.current_event_id, receipt_id = excluded.receipt_id,
      originating_message_id = excluded.originating_message_id, updated_at = CURRENT_TIMESTAMP`)
    .run(key, valueJson, freshnessClass, source, evidenceType, verificationState, confidence, validFrom, validUntil, validFrom, eventId, receiptId, originatingMessageId);
  return getCurrentStatePoint(database, key);
}

export function getCurrentStatePoint(database, key, { now = Date.now() } = {}) {
  const item = database.prepare('SELECT * FROM state_points WHERE key = ?').get(key);
  if (!item) return null;
  const ageMs = Math.max(0, now - Date.parse(item.last_verified || item.updated_at));
  const status = item.status === 'CURRENT' && item.freshness_class === 'LIVE' && ageMs > 60_000 ? 'STALE' : item.status;
  return { ...item, value: parseJson(item.value_json), status, ageMs };
}

export function statePointTimeline(database, key) {
  return database.prepare('SELECT * FROM state_events WHERE point_key = ? ORDER BY id ASC').all(key)
    .map((event) => ({ ...event, previousValue: parseJson(event.previous_value_json), value: parseJson(event.value_json) }));
}

export function listCurrentStatePoints(database, { prefix = '', limit = 25, now = Date.now() } = {}) {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 25;
  const rows = prefix
    ? database.prepare('SELECT key FROM state_points WHERE key LIKE ? ORDER BY key LIMIT ?').all(`${prefix}%`, boundedLimit)
    : database.prepare('SELECT key FROM state_points ORDER BY key LIMIT ?').all(boundedLimit);
  return rows.map((item) => getCurrentStatePoint(database, item.key, { now }));
}
