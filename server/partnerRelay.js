import crypto from 'node:crypto';

const DEFAULT_HOST = 'https://relay.mostlyarmless.co.uk';
const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;
const HANDOFF_CLASSIFICATION = 'lps-handoff-pdf/v1';

function asNonEmptyString(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeHost(value) {
  const raw = asNonEmptyString(value, DEFAULT_HOST).replace(/\/+$/, '');
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !loopback) throw new Error('MA relay must use HTTPS outside a local development host.');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('MA relay host must not include a path.');
  return url.origin;
}

function ensureDeviceId(getSetting, setSetting) {
  const existing = asNonEmptyString(getSetting('maRelayDeviceId', ''));
  if (existing) return existing;
  const deviceId = `lps-${crypto.randomUUID()}`;
  setSetting('maRelayDeviceId', deviceId);
  return deviceId;
}

function decodeArtifact(raw) {
  const id = asNonEmptyString(raw?.id);
  const fileName = asNonEmptyString(raw?.fileName);
  const sha256 = asNonEmptyString(raw?.sha256).toLowerCase();
  const classification = asNonEmptyString(raw?.classification);
  if (!/^[a-zA-Z0-9._-]{8,128}$/.test(id)) throw new Error('Relay artifact id is invalid.');
  if (!/^[a-zA-Z0-9._-]{1,160}\.pdf$/i.test(fileName)) throw new Error('Relay artifact filename is invalid.');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Relay artifact hash is invalid.');
  if (classification !== HANDOFF_CLASSIFICATION) throw new Error('Relay artifact classification is not permitted.');
  const bytes = Buffer.from(asNonEmptyString(raw?.pdfBase64), 'base64');
  if (bytes.length < 5 || bytes.length > MAX_ARTIFACT_BYTES || bytes.subarray(0, 4).toString('ascii') !== '%PDF') {
    throw new Error('Relay artifact is not a bounded PDF.');
  }
  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== sha256) throw new Error('Relay artifact hash mismatch.');
  return { id, fileName, sha256, classification, bytes };
}

export function createPartnerRelayClient({ db, getSetting, setSetting }) {
  const insertArtifact = db.prepare(`
    INSERT INTO partner_relay_artifacts (id, sha256, file_name, classification, pdf_bytes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  function status() {
    const enabled = Boolean(getSetting('maRelaySyncEnabled', false));
    const host = normalizeHost(getSetting('maRelayHost', DEFAULT_HOST));
    const cursor = asNonEmptyString(getSetting('maRelayCursor', ''));
    const deviceId = ensureDeviceId(getSetting, setSetting);
    const received = db.prepare("SELECT COUNT(*) AS count FROM partner_relay_artifacts WHERE status = 'received'").get().count;
    return {
      enabled,
      host,
      deviceId,
      paired: Boolean(getSetting('maRelayPairToken', '')),
      cursor,
      received,
      boundary: 'handoffs remain outside Chat and local-model context until explicit review'
    };
  }

  function configure(input = {}) {
    const enabled = Boolean(input.enabled);
    const host = normalizeHost(input.host || getSetting('maRelayHost', DEFAULT_HOST));
    const pairToken = input.pairToken === undefined ? undefined : asNonEmptyString(input.pairToken);
    setSetting('maRelaySyncEnabled', enabled);
    setSetting('maRelayHost', host);
    if (pairToken !== undefined) setSetting('maRelayPairToken', pairToken);
    return status();
  }

  async function sync() {
    const current = status();
    if (!current.enabled) throw new Error('MA relay sync is disabled.');
    const pairToken = asNonEmptyString(getSetting('maRelayPairToken', ''));
    if (!pairToken) throw new Error('MA relay pairing token is required before sync.');

    const url = new URL('/v1/pull', current.host);
    if (current.cursor) url.searchParams.set('cursor', current.cursor);
    const response = await fetch(url, {
      headers: {
        'X-MA-Partner-Token': pairToken,
        'X-MA-Partner-Device': current.deviceId,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`MA relay pull failed (${response.status}).`);
    const packet = await response.json();
    if (!Array.isArray(packet?.artifacts) || !Number.isSafeInteger(packet?.cursor) || packet.cursor < 0) {
      throw new Error('MA relay response contract is invalid.');
    }

    const artifacts = packet.artifacts.map(decodeArtifact);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const artifact of artifacts) {
        insertArtifact.run(artifact.id, artifact.sha256, artifact.fileName, artifact.classification, artifact.bytes);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction not active */ }
      throw error;
    }

    // Delivery is intentionally at-least-once: if this acknowledgement is
    // interrupted LPS receives the same immutable IDs next time and SQLite's
    // primary key makes the retry harmless. The cursor advances only after MA
    // records the receipt.
    const acknowledgement = await fetch(new URL('/v1/ack', current.host), {
      method: 'POST',
      headers: {
        'X-MA-Partner-Token': pairToken,
        'X-MA-Partner-Device': current.deviceId,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        receipts: artifacts.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256, status: 'received' }))
      }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!acknowledgement.ok) throw new Error(`MA relay receipt failed (${acknowledgement.status}).`);
    setSetting('maRelayCursor', String(packet.cursor));

    return { ...status(), pulled: artifacts.length };
  }

  return { configure, status, sync };
}
