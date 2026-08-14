#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCapabilityRegistry, NEUTRAL_ACTION_NAMES } from '../server/chatCapabilities.js';

const root = new URL('../', import.meta.url);
const ui = await readFile(new URL('src/main.jsx', root), 'utf8');
const server = await readFile(new URL('server/index.js', root), 'utf8');
const start = ui.indexOf('function ContextPicker(');
const end = ui.indexOf('\nfunction candidateDetails(', start);
assert.ok(start >= 0 && end > start, 'ContextPicker source slice exists');
const picker = ui.slice(start, end);

assert.match(ui, /function invokeAction\(name, args\)/, 'UI has one action invocation adapter');
assert.match(ui, /\/api\/actions\/\$\{encodeURIComponent\(name\)\}\/invoke/, 'UI adapter uses the neutral action gateway');
assert.match(ui, /\['success', 'needs_confirmation', 'needs_approval'\]\.includes\(result\.status\)/, 'UI handles structured non-success outcomes before reading action data');
assert.match(ui, /result\.error\?\.message \|\| `Action \$\{name\} did not complete/, 'UI surfaces the registry error instead of an undefined-data failure');
const neutralCalls = [...ui.matchAll(/invokeAction\('([^']+)'/g)].map((match) => match[1]);
assert.deepEqual([...new Set(neutralCalls)].sort(), [...NEUTRAL_ACTION_NAMES].sort(), 'only the bounded Context Picker read actions use the neutral gateway');
assert.match(ui, /invokeLegacyCapability\('workboard\.propose_create'/, 'existing Workboard proposals remain on the legacy proposal/confirmation lane');

const searchControls = [...picker.matchAll(/<(?:input|select)\b[^>]*\bonChange=\{\(e\) => onSearch\([^>]+>/g)].map((match) => match[0]);
assert.equal(searchControls.length, 3, 'the bounded Context Picker slice has three search controls');
for (const control of searchControls) {
  assert.match(control, /data-action-id="(?:knowledge\.search|workboard\.list)"/, `mapped search control: ${control}`);
  assert.match(control, /data-control-id="chat\.context-picker\.[a-z-]+"/, `stable source-control identifier: ${control}`);
}
assert.equal(searchControls.filter((control) => control.includes('data-action-id="knowledge.search"')).length, 2, 'query and scope map to knowledge.search');
assert.equal(searchControls.filter((control) => control.includes('data-action-id="workboard.list"')).length, 1, 'Workboard view maps to workboard.list');
const toolbarTriggers = ui.split(/\r?\n/).filter((line) => line.includes('data-action-id=') && line.includes('openPicker('));
assert.equal(toolbarTriggers.length, 2, 'the two toolbar controls that immediately search are mapped');
assert.ok(toolbarTriggers.some((line) => line.includes('openPicker(\'knowledge\')') && line.includes('data-control-id="chat.context-toolbar.open-knowledge"')), 'Attach Knowledge trigger maps to knowledge.search');
assert.ok(toolbarTriggers.some((line) => line.includes('openPicker(\'workboard\')') && line.includes('data-control-id="chat.context-toolbar.open-workboard"')), 'Use Workboard trigger maps to workboard.list');

const registry = createCapabilityRegistry({});
const manifest = Object.fromEntries(registry.listActions().map((action) => [action.id, action]));
assert.deepEqual(Object.keys(manifest).sort(), [...NEUTRAL_ACTION_NAMES].sort(), 'neutral catalog contains exactly the declared initial slice');
for (const actionId of ['knowledge.search', 'workboard.list']) {
  assert.ok(manifest[actionId], `${actionId} is registered`);
  assert.ok(manifest[actionId].sourceControls.length > 0, `${actionId} declares its source controls`);
  assert.equal(manifest[actionId].risk, 'READ_ONLY', `${actionId} remains read-only`);
  assert.equal(manifest[actionId].confirmation, 'none', `${actionId} requires no write confirmation`);
}
for (const control of searchControls) {
  const actionId = control.match(/data-action-id="([^"]+)"/)[1];
  assert.ok(manifest[actionId], `${actionId} does not orphan the visible control`);
}
const mappedControls = ui.split(/\r?\n/).filter((line) => line.includes('data-action-id=') && line.includes('data-control-id='));
assert.equal(mappedControls.length, 5, 'the bounded slice has exactly five mapped trigger/search controls');
const controlMappings = mappedControls.map((control) => ({
  actionId: control.match(/data-action-id="([^"]+)"/)[1],
  controlId: control.match(/data-control-id="([^"]+)"/)[1]
}));
for (const [actionId, action] of Object.entries(manifest)) {
  assert.deepEqual(
    action.sourceControls.slice().sort(),
    controlMappings.filter((mapping) => mapping.actionId === actionId).map((mapping) => mapping.controlId).sort(),
    `${actionId} metadata and visible control IDs match bidirectionally`
  );
}

assert.match(server, /app\.get\('\/api\/actions',[^\n]+capabilityRegistry\.listActions\(\)/, 'server lists only the neutral action slice');
assert.match(server, /app\.get\('\/api\/actions\/:id'/, 'server inspects one neutral action');
assert.match(server, /app\.post\('\/api\/actions\/:id\/invoke'/, 'server invokes one neutral action');
assert.match(server, /capabilityRegistry\.execute\(req\.params\.id, req\.body\?\.args, \{ caller: 'human-ui' \}\)/, 'HTTP route assigns its trusted caller instead of accepting body scopes');

console.log('Action registry UI mapping and neutral-gateway wiring verification passed.');
