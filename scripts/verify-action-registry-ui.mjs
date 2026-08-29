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
assert.match(ui, /function SetupRecovery\(\{ boot, selectedSession, setNotice, refreshSignal \}\)/, 'Setup & Recovery receives only the trusted session context needed by the neutral gateway');
assert.match(ui, /invokeNeutralAction\('navigation\.settings', \{\}, selectedSession\)/, 'Setup diagnostics uses the shared neutral navigation adapter');
const neutralCalls = [...ui.matchAll(/invokeAction\('([^']+)'/g)].map((match) => match[1]);
// planner.refresh and coding.propose_task have no Chat surface (both are the
// Planner page's own controls, not Chat-driven capabilities), so they are
// invoked directly through App-owned functions closing over the module-level
// invokeNeutralAction adapter -- the same established pattern SetupRecovery
// uses for navigation.settings above -- rather than through Chat's local
// invokeAction.
const CHAT_ADAPTER_EXEMPT_ACTIONS = ['planner.refresh', 'coding.propose_task'];
assert.deepEqual([...new Set(neutralCalls)].sort(), NEUTRAL_ACTION_NAMES.filter((name) => !CHAT_ADAPTER_EXEMPT_ACTIONS.includes(name)).sort(), 'every Chat-reachable neutral action uses the bounded Context Picker / Workboard proposal / system / navigation adapter');
assert.match(ui, /invokeNeutralAction\('planner\.refresh', \{\}, selectedSession\)/, 'the Planner page Refresh Workboard control uses the shared neutral action adapter directly, matching the SetupRecovery navigation pattern');
assert.match(ui, /invokeNeutralAction\('coding\.propose_task', draft, selectedSession\)/, 'the Planner page coding-task propose control uses the shared neutral action adapter directly');
const runPlannerRefreshStart = ui.indexOf('async function runPlannerRefresh(');
const runPlannerRefreshEnd = ui.indexOf('\n  }', runPlannerRefreshStart) + '\n  }'.length;
assert.ok(runPlannerRefreshStart >= 0 && runPlannerRefreshEnd > runPlannerRefreshStart, 'the Refresh Workboard adapter has a bounded source slice');
const runPlannerRefreshFunction = ui.slice(runPlannerRefreshStart, runPlannerRefreshEnd);
assert.doesNotMatch(runPlannerRefreshFunction, /\/api\/planner\/refresh/, 'the Refresh Workboard button no longer calls the direct HTTP route from the client');
const codingWorkQueueStart = ui.indexOf('function CodingWorkQueue(');
const codingWorkQueueEnd = ui.indexOf('function Planner(', codingWorkQueueStart);
assert.ok(codingWorkQueueStart >= 0 && codingWorkQueueEnd > codingWorkQueueStart, 'CodingWorkQueue has a bounded source slice');
const codingWorkQueueFunction = ui.slice(codingWorkQueueStart, codingWorkQueueEnd);
assert.doesNotMatch(codingWorkQueueFunction, /\/api\/source\/coding\/tasks'/, 'the coding-task seal control no longer calls the direct one-shot HTTP route from the client');
assert.match(codingWorkQueueFunction, /confirmCodingTask\(pending\)/, 'confirming a sealed coding task submits only the durable confirmation identifier and token, not a raw task payload');
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
assert.match(ui, /useEffect\(\(\) => \{\s*loadContext\(\);\s*loadContextRecords\(\);\s*loadConnection\(\);\s*loadCloudChecks\(\);\s*setProposal\(null\);\s*historySearchRequestRef\.current \+= 1;\s*setHistorySearchBusy\(false\);\s*setHistoryResults\(\[\]\);\s*pickerSearchRequestRef\.current \+= 1;\s*pickerPreviewRequestRef\.current \+= 1;\s*setPicker\(null\);\s*\}, \[selectedSession\]\);/s, 'changing chat sessions invalidates history search and clears an in-flight context preview');
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
assert.match(ui, /invokeAction\('system\.status', \{\}\)/, 'Chat system-status check uses the neutral action gateway');
assert.match(ui, /invokeAction\('system\.models', \{ limit: 5 \}\)/, 'Chat model check uses the neutral action gateway');
assert.match(ui, /invokeAction\('system\.runs', \{ limit: 5 \}\)/, 'Chat recent-runs check uses the neutral action gateway');
assert.match(ui, /invokeAction\('conversation\.search', \{ query, limit: 8 \}\)/, 'explicit Chat history search uses the neutral action gateway');
assert.match(ui, /invokeAction\('planner\.today', \{\}\)/, 'Daily Planner check uses the neutral action gateway');
assert.match(ui, /invokeAction\('project\.propose_create', \{ title: projectProposeForm\.title, body: projectProposeForm\.body, next_action: projectProposeForm\.next_action \}\)/, 'Workboard card create preview uses the neutral action gateway');

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
assert.equal(manifest['system.status'].risk, 'READ_ONLY', 'system.status remains read-only');
assert.equal(manifest['system.status'].confirmation, 'none', 'system.status requires no confirmation');
for (const actionId of ['system.models', 'system.runs']) {
  assert.equal(manifest[actionId].risk, 'READ_ONLY', `${actionId} remains read-only`);
  assert.equal(manifest[actionId].confirmation, 'none', `${actionId} requires no confirmation`);
}
assert.equal(manifest['conversation.search'].risk, 'SENSITIVE_DATA', 'conversation.search is explicitly classified as sensitive local data');
assert.equal(manifest['conversation.search'].confirmation, 'none', 'explicit read-only conversation search requires no mutation confirmation');
assert.equal(manifest['planner.today'].risk, 'SENSITIVE_DATA', 'Daily Planner detail is explicitly sensitive local data');
assert.equal(manifest['planner.today'].confirmation, 'none', 'Daily Planner read requires no mutation confirmation');
assert.equal(manifest['workboard.read'].risk, 'SENSITIVE_DATA', 'Workboard detail is explicitly classified as sensitive read data');
assert.equal(manifest['workboard.read'].confirmation, 'none', 'the session-scoped Workboard read remains confirmation-free');
assert.equal(manifest['workboard.propose_create'].risk, 'REVERSIBLE_WRITE', 'Workboard create remains a proposal write risk');
assert.equal(manifest['workboard.propose_create'].confirmation, 'user_confirmation', 'Workboard create requires explicit user confirmation');
assert.equal(manifest['workboard.propose_update'].risk, 'REVERSIBLE_WRITE', 'Workboard update remains a proposal write risk');
assert.equal(manifest['workboard.propose_update'].confirmation, 'user_confirmation', 'Workboard update requires explicit user confirmation');
assert.equal(manifest['planner.refresh'].risk, 'GOVERNED_STAGING', 'planner.refresh is classified as a governed-staging write, not a caller-directed proposal');
assert.equal(manifest['planner.refresh'].confirmation, 'none', 'planner.refresh requires no confirmation because it can only stage a hardcoded, separately human-gated approval');
assert.deepEqual(manifest['planner.refresh'].inputSchema, {}, 'planner.refresh takes no caller-supplied arguments');
assert.equal(manifest['coding.propose_task'].risk, 'REVERSIBLE_WRITE', 'coding.propose_task is a caller-directed proposal write, not governed-staging');
assert.equal(manifest['coding.propose_task'].confirmation, 'user_confirmation', 'coding.propose_task requires explicit user confirmation before any task file is sealed');
for (const control of searchControls) {
  const actionId = control.match(/data-action-id="([^"]+)"/)[1];
  assert.ok(manifest[actionId], `${actionId} does not orphan the visible control`);
}
const mappedControls = [...ui.matchAll(/<(?:button|input|select)\b[^>]*\bdata-action-id="[^"]+"[^>]*\bdata-control-id="[^"]+"[^>]*>/g)].map((match) => match[0]);
assert.equal(mappedControls.length, 36, 'the bounded slice has exactly thirty-six mapped trigger/search/preview/proposal/system/history/planner/project/navigation/refresh/coding controls');
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
assert.deepEqual(
  controlMappings.filter((mapping) => mapping.actionId === 'system.status').map((mapping) => mapping.controlId),
  ['chat.connection.system-status-check'],
  'the visible Chat status control maps to the bounded system.status action'
);
assert.deepEqual(controlMappings.filter((mapping) => mapping.actionId === 'system.models').map((mapping) => mapping.controlId), ['chat.connection.system-models-check'], 'the visible model control maps to system.models');
assert.deepEqual(controlMappings.filter((mapping) => mapping.actionId === 'system.runs').map((mapping) => mapping.controlId), ['chat.connection.system-runs-check'], 'the visible recent-runs control maps to system.runs');
assert.deepEqual(controlMappings.filter((mapping) => mapping.actionId === 'conversation.search').map((mapping) => mapping.controlId), ['chat.history-search.submit'], 'the explicit history-search submit control maps to conversation.search');
assert.deepEqual(controlMappings.filter((mapping) => mapping.actionId === 'planner.today').map((mapping) => mapping.controlId), ['chat.connection.planner-today-check'], 'the visible today control maps to planner.today');
assert.deepEqual(controlMappings.filter((mapping) => mapping.actionId === 'navigation.workboard').map((mapping) => mapping.controlId), ['chat.navigation.open-workboard'], 'the visible Open Workboard control maps to the navigation.workboard action');
assert.deepEqual(controlMappings.filter((mapping) => mapping.actionId === 'navigation.system').map((mapping) => mapping.controlId), ['chat.navigation.open-system'], 'the visible Open System control maps to the navigation.system action');
assert.deepEqual(controlMappings.filter((mapping) => mapping.actionId === 'navigation.settings').map((mapping) => mapping.controlId).sort(), ['chat.navigation.open-settings', 'setup-recovery.diagnostics.open-model-settings'], 'Chat and Setup diagnostics map their Settings navigation controls to one action');
assert.deepEqual(controlMappings.filter((mapping) => mapping.actionId === 'navigation.planner').map((mapping) => mapping.controlId), ['chat.navigation.open-planner'], 'the visible Open Today control maps to the navigation.planner action');
assert.deepEqual(controlMappings.filter((mapping) => mapping.actionId === 'planner.refresh').map((mapping) => mapping.controlId), ['planner.refresh-workboard'], 'the visible Refresh Workboard control maps to the planner.refresh action');
assert.deepEqual(controlMappings.filter((mapping) => mapping.actionId === 'coding.propose_task').map((mapping) => mapping.controlId).sort(), ['planner.coding-queue.confirm', 'planner.coding-queue.seal-and-queue'], 'the complete visible coding-task seal/confirm control family has stable identifiers');
assert.deepEqual(
  controlMappings.filter((mapping) => mapping.actionId === 'planner.propose_create').map((mapping) => mapping.controlId).sort(),
  ['chat.planner-proposal.confirm', 'chat.planner-proposal.open', 'chat.planner-proposal.preview'],
  'the complete visible Daily Planner create control family has stable identifiers'
);
assert.deepEqual(
  controlMappings.filter((mapping) => mapping.actionId === 'planner.propose_update').map((mapping) => mapping.controlId).sort(),
  ['chat.planner-status.complete', 'chat.planner-status.defer', 'chat.planner-update.confirm', 'chat.planner-update.open', 'chat.planner-update.preview'],
  'the complete visible Daily Planner update control family has stable identifiers'
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
assert.match(server, /capabilityRegistry\.execute\(req\.params\.id, req\.body\?\.args, \{ caller: 'human-ui', renderer: extractRendererBinding\(req\.body\) \}\)/, 'HTTP route assigns its trusted caller and the trusted renderer binding instead of accepting body scopes');
assert.equal(manifest['navigation.workboard'].risk, 'VIEW_NAVIGATION', 'navigation.workboard is classified as a bounded view-navigation action');
assert.equal(manifest['navigation.workboard'].confirmation, 'none', 'view navigation is a direct reversible effect and requires no confirmation');
assert.equal(manifest['navigation.system'].risk, 'VIEW_NAVIGATION', 'navigation.system is classified as a bounded view-navigation action');
assert.equal(manifest['navigation.system'].confirmation, 'none', 'System view navigation is confirmation-free');
assert.equal(manifest['navigation.settings'].risk, 'VIEW_NAVIGATION', 'navigation.settings is classified as a bounded view-navigation action');
assert.equal(manifest['navigation.settings'].confirmation, 'none', 'Settings navigation is confirmation-free');
assert.equal(manifest['navigation.planner'].risk, 'VIEW_NAVIGATION', 'navigation.planner is classified as a bounded view-navigation action');
assert.equal(manifest['navigation.planner'].confirmation, 'none', 'Daily Planner navigation is confirmation-free');
assert.equal(manifest['planner.propose_create'].risk, 'REVERSIBLE_WRITE', 'planner.propose_create is a proposal write risk, not a view navigation');
assert.equal(manifest['planner.propose_create'].confirmation, 'user_confirmation', 'Daily Planner task creation requires explicit user confirmation');
assert.equal(manifest['planner.propose_update'].risk, 'REVERSIBLE_WRITE', 'planner.propose_update is a proposal write risk');
assert.equal(manifest['planner.propose_update'].confirmation, 'user_confirmation', 'Daily Planner task update requires explicit user confirmation');
assert.match(ui, /invokeAction\('planner\.propose_update', \{ id: form\.id, changes \}\)/, 'the planner Edit/Preview control invokes planner.propose_update with the typed id and bounded changes');
assert.match(ui, /invokeAction\('planner\.propose_update', \{ id: task\.id, changes: \{ status \} \}\)/, 'the Done and Not today controls invoke the same typed planner update action');
const statusProposalStart = ui.indexOf('async function proposePlannerStatus');
const statusProposalEnd = ui.indexOf('\n  async function sendViaJson', statusProposalStart);
const statusProposal = ui.slice(statusProposalStart, statusProposalEnd);
assert.ok(statusProposalStart >= 0 && statusProposalEnd > statusProposalStart, 'the bounded planner status adapter is present');
assert.doesNotMatch(statusProposal, /\/api\/planner\/tasks|method:\s*'PATCH'|method:\s*'POST'/, 'the planner status adapter cannot mutate a task directly');
const plannerConfirmStart = ui.indexOf('async function confirmPlannerProposal');
const plannerConfirmEnd = ui.indexOf('\n  // Open the edit form', plannerConfirmStart);
const plannerConfirm = ui.slice(plannerConfirmStart, plannerConfirmEnd);
assert.ok(plannerConfirmStart >= 0 && plannerConfirmEnd > plannerConfirmStart, 'the bounded Planner confirmation adapter is present');
assert.match(plannerConfirm, /const today = await invokeAction\('planner\.today', \{\}\);\s*setPlannerTodayPreview\(today\.data\)/, 'a successful Planner mutation refreshes the canonical Today preview');
assert.match(plannerConfirm, /catch \{[\s\S]*setPlannerTodayPreview\(null\)/, 'a failed post-mutation refresh clears stale Today data rather than retaining it');
assert.match(ui, /invokeAction\('planner\.propose_create'/, 'the Add planner task control invokes planner.propose_create through the neutral gateway');
assert.match(ui, /\/api\/chat\/sessions\/\$\{selectedSession\}\/planner\/confirm/, 'the planner confirm control submits only to the durable planner confirmation endpoint');
assert.match(server, /app\.post\('\/api\/chat\/sessions\/:id\/planner\/confirm'/, 'the server exposes the durable Daily Planner confirmation endpoint');
assert.match(server, /bindPlannerCreateConfirmation\(sessionId, bindWorkboardConfirmation\(sessionId, result\)\)/, 'the gateway binds the planner create proposal to the durable confirmation owner');
assert.match(ui, /invokeAction\('navigation\.workboard', \{\}\)/, 'the Open Workboard control invokes the navigation action through the neutral gateway');
assert.match(ui, /invokeAction\('navigation\.system', \{\}\)/, 'the Open full System control invokes the navigation action through the neutral gateway');
assert.match(ui, /invokeAction\('navigation\.settings', \{\}\)/, 'the Assign / change control invokes the navigation action through the neutral gateway');
assert.match(ui, /invokeAction\('navigation\.planner', \{\}\)/, 'the Open Today control invokes the navigation action through the neutral gateway');
assert.match(ui, /body\.renderer = binding/, 'navigation invocations carry this window\'s authenticated renderer binding');
assert.match(ui, /if \(!binding\) await registerRenderer\(chatSessionId\)/, 'a navigation invoked during startup establishes its renderer binding on demand');
assert.match(ui, /else await rendererReadyPromise/, 'navigation waits for the authenticated command stream before invoking the server action');
assert.match(server, /bindWorkboardConfirmation\(sessionId, result\)/, 'the gateway binds Workboard create and update previews to the durable confirmation owner');
assert.match(server, /requireSessionScopedAction\(req\.params\.id, sessionId\)/, 'neutral sensitive reads require a real active Chat session before the handler runs');
assert.match(server, /requireSessionScopedAction\(name, sessionId\)/, 'legacy sensitive reads require the same real-session boundary');
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
const statusRendererStart = ui.indexOf('function ChatConnectionBar(');
const statusRendererEnd = ui.indexOf('\nfunction ProposalCard(', statusRendererStart);
const statusRenderer = ui.slice(statusRendererStart, statusRendererEnd);
assert.doesNotMatch(statusRenderer, /capabilities\?\.length\s*\?\?\s*\d+/, 'capability count never falls back to a fabricated registry size');
assert.match(statusRenderer, /connectionState === 'ready'[\s\S]*connection\.capabilities\.length[\s\S]*'Unavailable'[\s\S]*'Checking…'/, 'capability count is shown only from a ready connection, with honest unavailable and checking states');
assert.match(statusRenderer, /<strong role="status" aria-live="polite">\{connectionState/, 'dynamic capability discovery is announced as a polite status update');
assert.match(statusRenderer, /data-action-id="system\.status" data-control-id="chat\.connection\.system-status-check"/, 'system status trigger carries stable registry and control IDs');
assert.match(statusRenderer, /data-action-id="system\.models" data-control-id="chat\.connection\.system-models-check"/, 'system models trigger carries stable registry and control IDs');
assert.match(statusRenderer, /data-action-id="system\.runs" data-control-id="chat\.connection\.system-runs-check"/, 'system runs trigger carries stable registry and control IDs');
assert.match(statusRenderer, /data-action-id="planner\.today" data-control-id="chat\.connection\.planner-today-check"/, 'Daily Planner trigger carries stable registry and control IDs');
assert.match(statusRenderer, /statusPreview\.sqlite\?\.ready/, 'status receipt is rendered from the neutral action result');
assert.match(statusRenderer, /modelsPreview\.models\.map/, 'bounded model summaries are rendered from the neutral action result');
assert.match(statusRenderer, /runsPreview\.runs\.map/, 'bounded run summaries are rendered from the neutral action result');
assert.match(statusRenderer, /plannerPreview\.visible\.map/, 'bounded Daily Planner task titles are rendered from the neutral action result');
assert.doesNotMatch(statusRenderer, /dangerouslySetInnerHTML/, 'system status receipt renders only as React text');
const historyFunctionStart = ui.indexOf('async function searchChatHistory(');
const historyOpenStart = ui.indexOf('function openHistoryResult(', historyFunctionStart);
const historySearchFunction = ui.slice(historyFunctionStart, historyOpenStart);
assert.match(historySearchFunction, /invokeAction\('conversation\.search'/, 'history search invokes only its read action');
assert.doesNotMatch(historySearchFunction, /context-records|memory|candidate|method:\s*['"](?:POST|PATCH|DELETE)['"]/, 'history search cannot attach, promote, or directly mutate');
assert.match(historySearchFunction, /historySearchRequestRef\.current === requestId/, 'late history-search responses cannot replace the current result set');
assert.match(ui, /historySearchRequestRef\.current \+= 1;[\s\S]*setHistoryResults\(\[\]\);[\s\S]*\}, \[selectedSession\]\);/, 'changing sessions invalidates and clears history-search results');
assert.match(ui, /data-action-id="conversation\.search" data-control-id="chat\.history-search\.submit"/, 'history search has stable action/control IDs');
assert.match(ui, /match\.session_title[\s\S]*match\.snippet/, 'bounded history result fields render as React text');

console.log('Action registry UI mapping and neutral-gateway wiring verification passed.');
