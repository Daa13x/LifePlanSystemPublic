import assert from 'node:assert/strict';
import { guardEgressFiles } from '../server/egressGuard.js';

const guarded = guardEgressFiles([
  { path: '.env', content: 'TOKEN=sk-ABCDEFGHIJKLMNOPQRSTUVWX' },
  { path: 'src/example.js', content: 'const token = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";' },
  { path: 'src/clean.js', content: 'export const value = 1;' }
]);
assert.equal(guarded.files.some((file) => file.path === '.env'), false, 'deny-listed .env is omitted before any outbound packet');
assert.equal(guarded.files.map((file) => file.content).join('\n').includes('sk-ABCDEFGHIJKLMNOPQRSTUVWX'), false, 'token literal is never present in packet bytes');
assert.ok(guarded.redactionCount >= 1, 'redaction is recorded');
assert.ok(guarded.sha256 && guarded.bytes >= 0, 'exact egress evidence is recorded');
console.log('Egress guard verification passed.');
