#!/usr/bin/env node
// Verify the local mutation guard (Origin/Host-validated per-runtime CSRF token)
// decisions using the REAL server/mutationGuard.js module the server imports.
// Local-only: no network, no server, no DB. Exit 0 = pass.

import { isMutation, hostAllowed, originAllowed, evaluateMutationGuard } from '../server/mutationGuard.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };
const PORT = 4177;

console.log('--- mutation guard verification ---');

// Safe methods are never blocked and never require a token.
for (const method of ['GET', 'HEAD', 'OPTIONS']) {
  const guard = evaluateMutationGuard({ method, host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, port: PORT });
  line(!guard.blocked && !guard.requiresToken, `${method} is open and token-free`);
}

// Same-origin mutations from the app require a token but are not blocked.
{
  const guard = evaluateMutationGuard({ method: 'POST', host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, port: PORT });
  line(!guard.blocked && guard.requiresToken, 'same-origin 127.0.0.1 POST requires a token');
}
{
  const guard = evaluateMutationGuard({ method: 'PATCH', host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, port: PORT });
  line(!guard.blocked && guard.requiresToken, 'same-origin localhost PATCH requires a token');
}

// Cross-origin Origin is blocked outright (no token check even reached).
{
  const guard = evaluateMutationGuard({ method: 'POST', host: `127.0.0.1:${PORT}`, origin: 'https://evil.example', port: PORT });
  line(guard.blocked && !guard.requiresToken, 'cross-origin POST is blocked');
}

// Sec-Fetch-Site: an explicit cross-site request is rejected when present, even
// with an otherwise-valid host/origin; same-origin/none/absent are allowed on.
{
  const guard = evaluateMutationGuard({ method: 'POST', host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, secFetchSite: 'cross-site', port: PORT });
  line(guard.blocked && !guard.requiresToken, 'Sec-Fetch-Site: cross-site is rejected');
}
{
  const guard = evaluateMutationGuard({ method: 'POST', host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, secFetchSite: 'same-origin', port: PORT });
  line(!guard.blocked && guard.requiresToken, 'Sec-Fetch-Site: same-origin still requires a token, not blocked');
}
{
  const guard = evaluateMutationGuard({ method: 'POST', host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, secFetchSite: 'none', port: PORT });
  line(!guard.blocked && guard.requiresToken, 'Sec-Fetch-Site: none is allowed on (still needs a token)');
}

// Any loopback origin/host is "this machine"; the port is NOT pinned so the dev
// proxy (Vite 5173 -> API 4177) and the packaged same-origin app both work.
line(originAllowed('http://127.0.0.1:9999'), 'a loopback origin on any port is allowed');
line(hostAllowed('127.0.0.1:9999'), 'a loopback host on any port is allowed');
line(originAllowed(`http://localhost:${PORT}`), 'a localhost origin is allowed');
line(hostAllowed('127.0.0.1'), 'a loopback host without a port is allowed');
line(hostAllowed('[::1]:4177'), 'an IPv6 loopback host is allowed');

// Regression guard: in development the frontend is served by Vite on 5173 and
// proxied to the API on 4177, so the API sees Origin http://127.0.0.1:5173. This
// previously 403'd every mutation (Chat send "did nothing"); it must be allowed.
{
  const guard = evaluateMutationGuard({ method: 'POST', host: `127.0.0.1:${PORT}`, origin: 'http://127.0.0.1:5173' });
  line(!guard.blocked && guard.requiresToken, 'dev cross-port origin (5173 -> API 4177) is allowed and still needs a token');
}

// Non-loopback origins/hosts are still rejected outright.
{
  const guard = evaluateMutationGuard({ method: 'DELETE', host: 'evil.example', origin: '' });
  line(guard.blocked, 'DELETE with a foreign Host is blocked');
}
line(!originAllowed('https://evil.example'), 'a non-loopback origin is rejected');
line(!hostAllowed('evil.example'), 'a non-loopback host is rejected');
line(!hostAllowed('evil.example:4177'), 'a non-loopback host on the app port is still rejected');
line(!hostAllowed(''), 'empty host is rejected');

// A missing Origin is tolerated (some app webviews omit it); the Host still
// constrains it and the token is still required.
{
  const guard = evaluateMutationGuard({ method: 'POST', host: `127.0.0.1:${PORT}`, origin: '', port: PORT });
  line(!guard.blocked && guard.requiresToken, 'same-host POST with no Origin still requires a token, not blocked');
}

// Authenticated connector requests bypass the CSRF guard (own timing-safe token).
{
  const guard = evaluateMutationGuard({ method: 'POST', host: `127.0.0.1:${PORT}`, origin: 'chrome-extension://abc', port: PORT, isConnector: true });
  line(!guard.blocked && !guard.requiresToken, 'authenticated connector POST bypasses the CSRF guard');
}

// An UNauthenticated request that merely claims an extension origin is still blocked.
{
  const guard = evaluateMutationGuard({ method: 'POST', host: `127.0.0.1:${PORT}`, origin: 'chrome-extension://abc', port: PORT, isConnector: false });
  line(guard.blocked, 'unauthenticated extension-origin POST is blocked');
}

line(isMutation('post') && isMutation('DELETE') && !isMutation('get'), 'isMutation is case-insensitive and safe-method aware');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll mutation-guard checks passed.');
process.exit(failures ? 1 : 0);
