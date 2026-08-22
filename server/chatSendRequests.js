import crypto from 'node:crypto';

export const CHAT_SEND_STATES = Object.freeze([
  'pending',
  'cancel_requested',
  'completed',
  'cancelled',
  'retryable_error',
  'interrupted'
]);

const TERMINAL_STATES = new Set(['completed', 'cancelled', 'retryable_error', 'interrupted']);

export class ChatSendConflictError extends Error {
  constructor(message, code = 'chat_send_conflict') {
    super(message);
    this.name = 'ChatSendConflictError';
    this.code = code;
    this.statusCode = 409;
  }
}

function parseResult(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function publicRequest(row) {
  if (!row) return null;
  return {
    sessionId: Number(row.session_id),
    key: row.idempotency_key,
    state: row.state,
    userMessageId: Number(row.user_message_id),
    candidateId: row.candidate_id == null ? null : Number(row.candidate_id),
    assistantMessageId: row.assistant_message_id == null ? null : Number(row.assistant_message_id),
    result: parseResult(row.result_json)
  };
}

export function createChatSendCoordinator({ db, transaction, leaseMs = 30000, now = () => Date.now() }) {
  if (!db || typeof transaction !== 'function') throw new Error('Chat send coordinator requires a database and transaction owner.');
  const boundedLeaseMs = Math.max(1000, Math.min(300000, Number(leaseMs) || 30000));
  const requestByKey = db.prepare('SELECT * FROM chat_send_requests WHERE session_id = ? AND idempotency_key = ?');
  const activeForSession = db.prepare("SELECT * FROM chat_send_requests WHERE session_id = ? AND state IN ('pending','cancel_requested') ORDER BY created_at ASC LIMIT 1");

  function leaseExpiry() {
    return new Date(now() + boundedLeaseMs).toISOString();
  }

  function claim({ sessionId, key, requestHash, createUserTurn }) {
    if (!key) {
      return transaction(() => ({ claimed: true, replayed: false, ownerToken: null, request: null, created: createUserTurn() }));
    }
    return transaction(() => {
      const existing = requestByKey.get(sessionId, key);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ChatSendConflictError('This chat-send idempotency key was already used with different content.', 'idempotency_conflict');
        }
        return { claimed: false, replayed: true, ownerToken: null, request: publicRequest(existing), created: null };
      }
      const active = activeForSession.get(sessionId);
      if (active) {
        throw new ChatSendConflictError('A local reply is already active for this chat. Wait for it to finish or cancel it before sending another message.', 'chat_generation_active');
      }
      const ownerToken = crypto.randomUUID();
      const created = createUserTurn();
      db.prepare(`INSERT INTO chat_send_requests
        (session_id, idempotency_key, request_hash, state, user_message_id, candidate_id, owner_token, lease_expires_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`)
        .run(sessionId, key, requestHash, created.messageId, created.candidateId, ownerToken, leaseExpiry());
      return { claimed: true, replayed: false, ownerToken, request: publicRequest(requestByKey.get(sessionId, key)), created };
    });
  }

  function heartbeat({ sessionId, key, ownerToken }) {
    if (!key || !ownerToken) return false;
    const changed = db.prepare(`UPDATE chat_send_requests SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ? AND idempotency_key = ? AND owner_token = ? AND state IN ('pending','cancel_requested')`)
      .run(leaseExpiry(), sessionId, key, ownerToken).changes;
    return changed === 1;
  }

  function settle({ sessionId, key, ownerToken, requestedState, settleTurn }) {
    if (!key) return transaction(() => ({ settled: true, replayed: false, state: requestedState, ...settleTurn(requestedState) }));
    return transaction(() => {
      const current = requestByKey.get(sessionId, key);
      if (!current) throw new ChatSendConflictError('The durable chat-send request no longer exists.', 'request_missing');
      if (TERMINAL_STATES.has(current.state)) {
        return { settled: false, replayed: true, state: current.state, request: publicRequest(current), result: parseResult(current.result_json) };
      }
      if (current.owner_token !== ownerToken) {
        return { settled: false, replayed: true, state: current.state, request: publicRequest(current), result: parseResult(current.result_json) };
      }
      const state = current.state === 'cancel_requested' ? 'cancelled' : requestedState;
      if (!TERMINAL_STATES.has(state)) throw new Error(`Invalid terminal chat-send state: ${state}`);
      const settled = settleTurn(state, publicRequest(current));
      const changed = db.prepare(`UPDATE chat_send_requests
        SET state = ?, assistant_message_id = ?, result_json = ?, error_detail = ?, owner_token = NULL,
            lease_expires_at = NULL, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND idempotency_key = ? AND owner_token = ? AND state IN ('pending','cancel_requested')`)
        .run(state, settled.assistantMessageId, JSON.stringify(settled.result), settled.error || null, sessionId, key, ownerToken).changes;
      if (changed !== 1) throw new ChatSendConflictError('The chat-send request changed before it could be settled.', 'settlement_race');
      return { settled: true, replayed: false, state, request: publicRequest(requestByKey.get(sessionId, key)), ...settled };
    });
  }

  function requestCancel(sessionId) {
    return transaction(() => {
      const active = activeForSession.get(sessionId);
      if (!active) return null;
      if (active.state === 'pending') {
        db.prepare(`UPDATE chat_send_requests SET state = 'cancel_requested', updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ? AND idempotency_key = ? AND state = 'pending'`)
          .run(sessionId, active.idempotency_key);
      }
      return publicRequest(requestByKey.get(sessionId, active.idempotency_key));
    });
  }

  function active(sessionId) {
    return publicRequest(activeForSession.get(sessionId));
  }

  function recoverExpired(settleInterrupted) {
    const expired = db.prepare(`SELECT session_id, idempotency_key FROM chat_send_requests
      WHERE state IN ('pending','cancel_requested') AND lease_expires_at <= ? ORDER BY created_at ASC`)
      .all(new Date(now()).toISOString());
    let recovered = 0;
    for (const candidate of expired) {
      transaction(() => {
        const current = requestByKey.get(candidate.session_id, candidate.idempotency_key);
        if (!current || !['pending', 'cancel_requested'].includes(current.state) || Date.parse(current.lease_expires_at) > now()) return;
        const state = current.state === 'cancel_requested' ? 'cancelled' : 'interrupted';
        const settled = settleInterrupted(state, publicRequest(current));
        const changed = db.prepare(`UPDATE chat_send_requests
          SET state = ?, assistant_message_id = ?, result_json = ?, error_detail = ?, owner_token = NULL,
              lease_expires_at = NULL, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ? AND idempotency_key = ? AND state = ? AND lease_expires_at = ?`)
          .run(state, settled.assistantMessageId, JSON.stringify(settled.result), settled.error || null,
            current.session_id, current.idempotency_key, current.state, current.lease_expires_at).changes;
        if (changed !== 1) throw new ChatSendConflictError('Expired chat-send recovery lost its compare-and-swap.', 'recovery_race');
        recovered += 1;
      });
    }
    return recovered;
  }

  return { claim, heartbeat, settle, requestCancel, active, recoverExpired, leaseMs: boundedLeaseMs };
}
