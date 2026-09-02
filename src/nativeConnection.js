function parsedHttpUrl(value, label) {
  const input = String(value || '').trim().replace(/\/+$/, '');
  if (!input) throw new Error(`${label} is required.`);
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error(`${label} must be a complete http:// or https:// address.`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} must use http:// or https://.`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain a username or password.`);
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) throw new Error(`${label} must contain only the server origin, without a path, query, or fragment.`);
  return parsed;
}

export function isPrivateNetworkHost(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return /^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/i.test(host);
  }
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function normalizeNativeServerUrl(value) {
  const parsed = parsedHttpUrl(value, 'LifePlanSystem server address');
  if (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('A hosted LifePlanSystem server must use HTTPS. Plain HTTP is allowed only for the USB/loopback connection.');
  }
  return parsed.origin;
}

export function normalizeSyncBaseUrl(value) {
  const parsed = parsedHttpUrl(value, 'Desktop sync address');
  if (parsed.protocol === 'http:' && !isPrivateNetworkHost(parsed.hostname)) {
    throw new Error('A plain-HTTP sync address must be a local/private-network host. Use HTTPS for any public address.');
  }
  return parsed.origin;
}

export const PHONE_SYNC_SERVICE = 'lifeplansystem-phone-sync';
export const PHONE_SYNC_PROTOCOL_VERSION = 1;

function syncError(message, code, status = null) {
  return Object.assign(new Error(message), { code, status });
}

async function syncResponseBody(response) {
  try { return await response.json(); } catch { return null; }
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function pairingCredential(value) {
  const token = String(value || '').trim();
  if (!token) throw syncError('Pairing code is required.', 'SYNC_PAIRING_REQUIRED');
  return token;
}

// Authenticated identity is the pairing handshake. A phone saves an endpoint
// only after the address has proved it is a compatible LPS sync bridge and
// the supplied credential belongs to that bridge. The stable IDs are data,
// not secrets; the pairing credential remains confined to app-private state.
export async function verifySyncServer({ baseUrl, pairingToken, fetchImpl = fetch, timeoutMs = 4000 }) {
  const endpoint = normalizeSyncBaseUrl(baseUrl);
  const token = pairingCredential(pairingToken);
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `${endpoint}/identity`, {
      headers: { 'X-LPS-Pairing-Token': token }
    }, timeoutMs);
  } catch (error) {
    if (error?.name === 'AbortError') throw syncError('Desktop did not respond in time.', 'SYNC_UNREACHABLE');
    throw syncError('Desktop could not be reached.', 'SYNC_UNREACHABLE');
  }
  const body = await syncResponseBody(response);
  if (!response.ok) {
    const message = body?.error || `Desktop rejected the pairing request (${response.status}).`;
    throw syncError(message, response.status === 401 ? 'SYNC_AUTH_FAILED' : 'SYNC_PAIRING_FAILED', response.status);
  }
  if (body?.ok !== true || body.service !== PHONE_SYNC_SERVICE || body.protocolVersion !== PHONE_SYNC_PROTOCOL_VERSION) {
    throw syncError('That address is not a compatible LifePlanSystem phone-sync service.', 'SYNC_INCOMPATIBLE');
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(body.serverId || '')) || !/^[A-Za-z0-9:_-]{1,128}$/.test(String(body.userId || ''))) {
    throw syncError('The LifePlanSystem PC returned an invalid identity.', 'SYNC_INVALID_IDENTITY');
  }
  return {
    baseUrl: endpoint,
    serverId: String(body.serverId),
    userId: String(body.userId),
    protocolVersion: body.protocolVersion
  };
}

export async function exchangeSyncChanges({ baseUrl, pairingToken, payload, fetchImpl = fetch, timeoutMs = 15000 }) {
  const endpoint = normalizeSyncBaseUrl(baseUrl);
  const token = pairingCredential(pairingToken);
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `${endpoint}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LPS-Pairing-Token': token },
      body: JSON.stringify(payload)
    }, timeoutMs);
  } catch (error) {
    if (error?.name === 'AbortError') throw syncError('Desktop did not respond in time.', 'SYNC_UNREACHABLE');
    throw syncError('Desktop could not be reached.', 'SYNC_UNREACHABLE');
  }
  const body = await syncResponseBody(response);
  if (!response.ok) {
    const message = body?.error || `Desktop rejected the sync request (${response.status}).`;
    throw syncError(message, response.status === 401 ? 'SYNC_AUTH_FAILED' : 'SYNC_EXCHANGE_FAILED', response.status);
  }
  if (body?.ok !== true) throw syncError('Desktop returned an invalid sync response.', 'SYNC_INVALID_RESPONSE');
  return body;
}

// Decide whether entering another address is merely the same PC at a new LAN
// address or a real ownership switch. The latter must be explicit because
// carrying one person's planner/outbox into another person's PC would leak
// data. Legacy installations without an identity may adopt only the exact
// endpoint they already stored; any other endpoint requires replacement.
export function planSyncPairingTransition(current, candidate, { replaceExisting = false } = {}) {
  const hasCurrentPairing = Boolean(current?.baseUrl && current?.pairingToken);
  if (!hasCurrentPairing) return { mode: 'initial', clearSyncedPlanner: false, preserveProgress: false };
  if (current.serverId && current.serverId === candidate.serverId) {
    return { mode: 'same-server', clearSyncedPlanner: false, preserveProgress: true };
  }
  if (!current.serverId) {
    let currentEndpoint = '';
    try { currentEndpoint = normalizeSyncBaseUrl(current.baseUrl); } catch { /* unsafe legacy value cannot be adopted */ }
    if (currentEndpoint === candidate.baseUrl) return { mode: 'legacy-adopt', clearSyncedPlanner: false, preserveProgress: true };
  }
  if (!replaceExisting) {
    throw syncError(
      'This phone is paired with a different LifePlanSystem PC. Replacing it must explicitly clear this phone\'s synced Planner data first.',
      'SYNC_REPLACEMENT_REQUIRED'
    );
  }
  return { mode: 'replace-server', clearSyncedPlanner: true, preserveProgress: false };
}
