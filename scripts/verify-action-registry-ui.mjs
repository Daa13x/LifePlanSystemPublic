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
assert.deepEqual([...new Set(neutralCalls)].sort(), [...NEUTRAL_ACTION_NAMES].sort(), 'only the bounded Context Picker and durable Workboard proposal actions use the neutral gateway');
assert.match(ui, /invokeAction\('knowledge\.read',\s*\{\s*id: rec\.ref_id,\s*kind: rec\.kind === 'knowledge-candidate' \? 'candidate' : 'item'\s*\}\)/s, 'Knowledge preview sends the exact typed item/candidate identity');
assert.match(ui, /invokeAction\('workboard\.read',\s*\{\s*id: rec\.ref_id,\s*type: rec\.entity_type\s*\}\)/s, 'Workboard preview sends the exact typed entity identity');
assert.match(ui, /kind: `workboard-\$\{rec\.identity\.type\}`[\s\S]*entity_type: rec\.identity\.type[\s\S]*ref_id: rec\.identity\.id/, 'Workboard list results preserve the server-provided typed identity');
assert.match(ui, /pickerPreviewRequestRef\.current !== requestId/, 'late Knowledge preview responses cannot replace the current selection');
assert.match(ui, /\/api\/chat\/sessions\/\$\{selectedSession\}\/context-records/, 'Attach remains a separate authoritative context-record write');
const previewFunctionStart = ui.indexOf('async function previewContextRecord(');
const attachFunctionStart = ui.indexOf('async function attachRecord(', previewFunctionStart);
assert.ok(previewFunctionStart >= 0 && attachFunctionStart > previewFunctionStart, 'Context preview function has a bounded source slice');
const previewFunction = ui.slice(previewFunctionStart, attachFunctionStart);
assert.match(previewFunction, /invokeAction\('knowledge\.read'/, 'Knowledge preview invokes only the read action');
assert.match(previewFunction, /invokeAction\('workboard\.read'/, 'Workboard preview invokes only the typed read action');
assert.doesNotMatch(previewFunction, /context-records|attachRecord|onAttach/, 'Knowledge preview cannot attach or write a context record');
const searchFunction = ui.slice(ui.indexOf('async function runPickerSearch('), ui.indexOf('function openPicker('));
assert.match(searchFunction, /pickerPreviewRequestRef\.current \+= 1/, 'every picker search invalidates an in-flight preview');
const closeFunction = ui.slice(ui.indexOf('function closePicker('), previewFunctionStart);
assert.match(closeFunction, /pickerPreviewRequestRef\.current \+= 1/, 'closing the picker invalidates an in-flight preview');
assert.match(ui, /useEffect\(\(\) => \{\s*loadContext\(\);\s*loadContextRecords\(\);\s*loadConnection\(\);\s*loadCloudChecks\(\);\s*setProposal\(null\);\s*pickerSearchRequestRef\.current \+= 1;\s*pickerPreviewRequestRef\.current \+= 1;\s*setPicker\(null\);\s*\}, \[selectedSession\]\);/s, 'changing chat sessions invalidates and clears an in-flight preview');
assert.match(ui, /invokeAction\('workboard\.propose_create'/, 'Workboard create preview uses the neutral action gateway');
assert.doesNotMatch(ui, /invokeLegacyCapability\('workboard\.propose_create'/, 'Workboard create no longer uses the unbound legacy preview lane');
const updateFunctionStart = ui.indexOf('async function submitProposeUpdate(');
const confirmFunctionStart = ui.indexOf('async function confirmProposal(', updateFunctionStart);
assert.ok(updateFunctionStart >= 0 && confirmFunctionStart > updateFunctionStart, 'Workboard update proposal has a bounded UI adapter');
const updateFunction = ui.slice(updateFunctionStart, confirmFunctionStart);
assert.match(updateFunction, /invokeAction\('workboard\.propose_update', \{ type: record\.identity\.type, id: record\.identity\.id, changes \}\)/, 'Workboard update preview sends the typed identity and exact changed fields');
assert.doesNotMatch(updateFunction, /\/api\/items|method:\s*['"]PATCH['"]|context-records|onAttach/, 'previewing a Workboard update cannot write or attach a record');
assert.match(ui, /JSON\.stringify\(\{ confirmationId, token \}\)/, 'confirmation submits only the durable identifier and one-time token');
assert.doesNotMatch(ui, /JSON\.stringify\(\{ proposal \}\)/, 'the UI never resubmits a mutable proposal');

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
assert.deepEqual(Object.keys(manifest).sort(), [...NEUTRAL_ACTION_NAMES].sort(), 'neutral catalog contains exactly the declared bounded slice');
for (const actionId of ['knowledge.search', 'knowledge.read', 'workboard.list']) {
  assert.ok(manifest[actionId], `${actionId} is registered`);
  assert.ok(manifest[actionId].sourceControls.length > 0, `${actionId} declares its source controls`);
  assert.equal(manifest[actionId].risk, 'READ_ONLY', `${actionId} remains read-only`);
  assert.equal(manifest[actionId].confirmation, 'none', `${actionId} requires no write confirmation`);
}
assert.equal(manifest['workboard.read'].risk, 'SENSITIVE_DATA', 'Workboard detail is explicitly classified as sensitive read data');
assert.equal(manifest['workboard.read'].confirmation, 'none', 'the session-scoped Workboard read remains confirmation-free');
assert.equal(manifest['workboard.propose_create'].risk, 'REVERSIBLE_WRITE', 'Workboard create remains a proposal write risk');
assert.equal(manifest['workboard.propose_create'].confirmation, 'user_confirmation', 'Workboard create requires explicit user confirmation');
assert.equal(manifest['workboard.propose_update'].risk, 'REVERSIBLE_WRITE', 'Workboard update remains a proposal write risk');
assert.equal(manifest['workboard.propose_update'].confirmation, 'user_confirmation', 'Workboard update requires explicit user confirmation');
for (const control of searchControls) {
  const actionId = control.match(/data-action-id="([^"]+)"/)[1];
  assert.ok(manifest[actionId], `${actionId} does not orphan the visible control`);
}
const mappedControls = [...ui.matchAll(/<(?:button|input|select)\b[^>]*\bdata-action-id="[^"]+"[^>]*\bdata-control-id="[^"]+"[^>]*>/g)].map((match) => match[0]);
assert.equal(mappedControls.length, 12, 'the bounded slice has exactly twelve mapped trigger/search/preview/proposal controls');
const controlMappings = mappedControls.map((control) => ({
  actionId: control.match(/data-action-id="([^"]+)"/)[1],
  controlId: control.match(/data-control-id="([^"]+)"/)[1]
}));
assert.deepEqual(
  controlMappings.filter((mapping) => mapping.actionId === 'workboard.propose_create').map((mapping) => mapping.controlId).sort(),
  ['chat.workboard-proposal.confirm', 'chat.workboard-proposal.open', 'chat.workboard-proposal.preview'],
  'the complete visible Workboard-create control family has stable identifiers'
);
assert.deepEqual(
  controlMappings.filter((mapping) => mapping.actionId === 'knowledge.read').map((mapping) => mapping.controlId),
  ['chat.context-picker.knowledge-preview'],
  'the explicit Knowledge preview control maps to the read-only action'
);
assert.deepEqual(
  controlMappings.filter((mapping) => mapping.actionId === 'workboard.read').map((mapping) => mapping.controlId),
  ['chat.context-picker.workboard-preview'],
  'the explicit Workboard preview control maps to the typed read-only action'
);
assert.deepEqual(
  controlMappings.filter((mapping) => mapping.actionId === 'workboard.propose_update').map((mapping) => mapping.controlId).sort(),
  ['chat.context-picker.workboard-update', 'chat.workboard-update.confirm'],
  'the complete visible Workboard-update preview/confirm family has stable identifiers'
);
const attachControlStart = picker.indexOf('<button className="picker-row"');
const attachControlEnd = picker.indexOf('</button>', attachControlStart) + '</button>'.length;
const previewControlMarker = picker.indexOf('data-action-id="knowledge.read"');
const previewControlStart = picker.lastIndexOf('<button', previewControlMarker);
const previewControlEnd = picker.indexOf('</button>', previewControlMarker) + '</button>'.length;
const attachControl = picker.slice(attachControlStart, attachControlEnd);
const previewControl = picker.slice(previewControlStart, previewControlEnd);
assert.match(attachControl, /onClick=\{\(\) => onAttach\(rec\)\}/, 'Attach is a distinct record-write control');
assert.doesNotMatch(attachControl, /onPreview/, 'Attach does not invoke Preview');
assert.match(previewControl, /onClick=\{\(\) => onPreview\(rec\)\}/, 'Preview invokes only its read handler');
assert.doesNotMatch(previewControl, /onAttach/, 'Preview does not invoke Attach');
assert.ok(attachControlEnd <= previewControlStart, 'Attach and Preview are separate sibling controls');
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
assert.match(server, /bindWorkboardConfirmation\(sessionId, result\)/, 'the gateway binds Workboard create and update previews to the durable confirmation owner');
assert.match(server, /requireWorkboardReadSession\(req\.params\.id, sessionId\)/, 'neutral Workboard read requires a real active Chat session before the handler runs');
assert.match(server, /requireWorkboardReadSession\(name, sessionId\)/, 'legacy Workboard read requires the same real-session boundary');
assert.match(server, /keys\.length !== 2 \|\| keys\[0\] !== 'confirmationId' \|\| keys\[1\] !== 'token'/, 'the confirmation endpoint rejects replacement payload fields');
assert.match(server, /JSON\.stringify\(liveState\) !== JSON\.stringify\(claimed\.beforeState\)/, 'Workboard update confirmation performs a full-state stale check inside the apply transaction');
assert.match(server, /error\.confirmationCode = 'stale'/, 'a transactional stale race produces a truthful stale receipt');
const previewStart = picker.indexOf('function KnowledgeRecordPreview(');
assert.ok(previewStart >= 0, 'Knowledge preview renderer exists in the bounded picker slice');
const previewRenderer = picker.slice(previewStart);
assert.match(previewRenderer, /record\.title/, 'Knowledge preview renders the title as React text');
assert.match(previewRenderer, /record\.body/, 'Knowledge preview renders the bounded body as React text');
assert.match(previewRenderer, /provenance\.source/, 'Knowledge preview renders provenance');
assert.doesNotMatch(previewRenderer, /dangerouslySetInnerHTML/, 'Knowledge preview never renders record content as HTML');
assert.match(picker, /function WorkboardRecordPreview\(/, 'bounded Workboard preview renderer exists');
const workboardPreviewRenderer = picker.slice(picker.indexOf('function WorkboardRecordPreview('));
assert.match(workboardPreviewRenderer, /record\.identity\?\.type/, 'Workboard preview renders the authoritative entity type');
assert.match(workboardPreviewRenderer, /record\.children\.map/, 'Workboard preview renders bounded linked-item identities');
assert.doesNotMatch(workboardPreviewRenderer, /dangerouslySetInnerHTML/, 'Workboard preview never renders record content as HTML');

console.log('Action registry UI mapping and neutral-gateway wiring verification passed.');
