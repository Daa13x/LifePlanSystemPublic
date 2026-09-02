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
