// Pure decision logic for the local mutation guard: an Origin/Host-validated
// per-runtime CSRF token. No IO here so it can be unit-tested directly against
// the same code the server runs (see scripts/verify-mutation-csrf.mjs).
//
// The app serves a same-origin SPA on 127.0.0.1 only. A state-changing request
// must (a) not be an explicit cross-site request, (b) target this app's own
// local host, and (c) originate from this app's own origin, after which the
// caller must also present the per-runtime CSRF token as a custom header (the
// token comparison lives in server/index.js, which holds the secret). Safe
// methods (GET/HEAD/OPTIONS) are never touched; they must never mutate.
// Browser-extension connector requests are cross-origin by design and
// authenticate with their own timing-safe token, so they bypass this guard.

export const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export function isMutation(method) {
  return MUTATION_METHODS.has(String(method || '').toUpperCase());
}

export function hostAllowed(hostHeader, port) {
  if (!hostHeader) return false;
  const [host, hostPort] = String(hostHeader).split(':');
  return LOCAL_HOSTS.has(host) && hostPort === String(port);
}

export function originAllowed(originHeader, port) {
  // A missing Origin is allowed here: same-origin navigations and some app
  // webviews omit it, and the Host check still constrains the request. A PRESENT
  // Origin must be this app's own localhost origin on the expected port.
  if (!originHeader) return true;
  let url;
  try {
    url = new URL(originHeader);
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(url.hostname) && url.port === String(port);
}

// Decide whether a request must be blocked outright and, if allowed, whether it
// still needs the per-runtime CSRF token. The token comparison itself is done by
// the caller (it holds the secret and uses a constant-time compare).
export function evaluateMutationGuard({ method, host, origin, secFetchSite, port, isConnector = false }) {
  if (!isMutation(method)) return { blocked: false, requiresToken: false, reason: '' };
  if (isConnector) return { blocked: false, requiresToken: false, reason: '' };
  // Fetch-metadata: an explicitly cross-site request is never legitimate for a
  // local same-origin app, so reject it before any other check when present.
  if (String(secFetchSite || '').toLowerCase() === 'cross-site') {
    return { blocked: true, requiresToken: false, reason: 'Request rejected: cross-site requests are not permitted.' };
  }
  if (!hostAllowed(host, port)) {
    return { blocked: true, requiresToken: false, reason: 'Request rejected: mutations must target the local Life Planner host.' };
  }
  if (!originAllowed(origin, port)) {
    return { blocked: true, requiresToken: false, reason: 'Request rejected: mutations must originate from the local Life Planner app.' };
  }
  return { blocked: false, requiresToken: true, reason: '' };
}
