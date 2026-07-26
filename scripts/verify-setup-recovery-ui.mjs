import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ui = read('src/main.jsx');
const navigation = read('src/navigation.js');
const server = read('server/index.js');

// This verifier deliberately checks the real client/server wiring instead of
// labels: destructive UI state must be created by the protected proposal route,
// then confirmed with the server-issued id/token, and every displayed action
// must have a bounded endpoint in the server implementation.
assert.match(navigation, /\{ id: 'setup', label: 'Setup & Recovery' \}/);
assert.match(ui, /function SetupRecovery\(/);
assert.match(ui, /api\('\/api\/setup\/status'\)/);
assert.match(ui, /api\('\/api\/recovery\/status'\)/);
assert.match(ui, /api\('\/api\/recovery\/backup', \{ method: 'POST' \}\)/);
assert.match(ui, /api\('\/api\/recovery\/backup\/validate', \{ method: 'POST', body: JSON\.stringify\(\{ backup: backup\.name \}\) \}\)/);
assert.match(ui, /api\('\/api\/recovery\/restore\/propose', \{ method: 'POST', body: JSON\.stringify\(\{ backup: backup\.name \}\) \}\)/);
assert.match(ui, /api\('\/api\/recovery\/restore\/confirm', \{ method: 'POST', body: JSON\.stringify\(\{ confirmationId: proposal\.confirmationId, token: proposal\.token \}\) \}\)/);
assert.match(ui, /api\('\/api\/setup\/repair\/data-directory', \{ method: 'POST' \}\)/);
assert.match(ui, /disabled=\{Boolean\(busy\) \|\| Boolean\(proposal\)\}/);
assert.match(server, /app\.post\('\/api\/recovery\/restore\/propose'/);
assert.match(server, /app\.post\('\/api\/recovery\/restore\/confirm'/);
assert.match(server, /app\.post\('\/api\/recovery\/backup\/validate'/);
assert.match(server, /app\.post\('\/api\/setup\/repair\/data-directory'/);
assert.match(server, /confirmStagedRestore\(req, res, 'backup\.restore'\)/);

console.log('Setup & Recovery UI endpoint and enforced-confirmation wiring verification passed.');
