import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PRIMARY_NAVIGATION,
  SECTION_TABS,
  approvalDestination,
  routeFor,
  routeFromHash,
  routeFromLocation
} from '../src/navigation.js';

assert.deepEqual(PRIMARY_NAVIGATION.map((entry) => entry.label), ['Chat', 'Knowledge', 'System', 'Workboard']);
assert.deepEqual(SECTION_TABS.workboard.map((entry) => entry.label), ['Overview', 'Today', 'Projects', 'Cards', 'Roadmap', 'Review', 'Completed']);
assert.deepEqual(SECTION_TABS.knowledge.map((entry) => entry.label), ['Memory', 'Candidates', 'Sources & Source Control', 'Rules', 'Calibration']);
assert.deepEqual(SECTION_TABS.system.map((entry) => entry.label), ['Status', 'Setup & Recovery', 'Repository', 'Browser', 'Tools', 'Runs', 'Feedback']);

const expectedRoutes = [
  ['/planner', {}, { section: 'workboard', tab: 'overview' }],
  ['/projects', {}, { section: 'workboard', tab: 'projects' }],
  ['/dev-roadmap', {}, { section: 'workboard', tab: 'roadmap' }],
  ['/approvals', {}, { section: 'workboard', tab: 'review' }],
  ['/approvals', { search: '?domain=memory' }, { section: 'knowledge', tab: 'candidates' }],
  ['/memory', {}, { section: 'knowledge', tab: 'memory' }],
  ['/source', {}, { section: 'knowledge', tab: 'sources' }],
  ['/calibration', {}, { section: 'knowledge', tab: 'calibration' }],
  ['/repository', {}, { section: 'system', tab: 'repository' }],
  ['/browser', {}, { section: 'system', tab: 'browser' }],
  ['/tooling', {}, { section: 'system', tab: 'tools' }]
];

for (const [path, options, expected] of expectedRoutes) {
  const actual = routeFromLocation(path, options.search || '');
  assert.deepEqual({ section: actual.section, tab: actual.tab }, expected, `${path} must retain a compatible destination`);
}

assert.equal(routeFor('chat'), '#chat');
assert.equal(routeFor('chat', null, 42), '#chat/42');
assert.equal(routeFor('workboard', 'overview'), '#workboard');
assert.equal(routeFor('workboard', 'today'), '#workboard/today');
assert.deepEqual(routeFromHash('#workboard/today'), { section: 'workboard', tab: 'today', sessionId: null, legacy: false });
assert.equal(routeFor('workboard', 'cards'), '#workboard/cards');
assert.deepEqual(routeFromHash('#workboard/cards'), { section: 'workboard', tab: 'cards', sessionId: null, legacy: false });
assert.equal(routeFor('knowledge', 'candidates'), '#knowledge/candidates');
assert.equal(routeFor('system', 'setup'), '#system/setup');
assert.equal(routeFor('system', 'tools'), '#system/tools');
assert.equal(routeFor('settings'), '#settings');
assert.deepEqual(routeFromHash('#chat/42'), { section: 'chat', tab: null, sessionId: '42', legacy: false });
assert.deepEqual(routeFromHash('#knowledge/candidates'), { section: 'knowledge', tab: 'candidates', sessionId: null, legacy: false });
assert.deepEqual(routeFromHash('#settings'), { section: 'settings', tab: null, sessionId: null, legacy: false });
assert.deepEqual(routeFromLocation('/', '', '#workboard/projects'), { section: 'workboard', tab: 'projects', sessionId: null, legacy: false });
assert.deepEqual(routeFromLocation('/', '', ''), { section: 'chat', tab: null, sessionId: null, legacy: true });
assert.deepEqual(routeFromHash('#not-a-screen'), { section: 'chat', tab: null, sessionId: null, legacy: true });
assert.deepEqual(approvalDestination({ action_type: 'update_memory' }), { section: 'knowledge', tab: 'candidates' });
assert.deepEqual(approvalDestination({ action_type: 'update_project' }), { section: 'workboard', tab: 'review' });

const [appSource, styles] = await Promise.all([
  readFile(new URL('../src/main.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
]);
assert.match(appSource, /<nav className="navigation-menu" aria-label="Main navigation">/, 'primary navigation must have an accessible label');
assert.match(appSource, /aria-label=\{`\$\{preview\?\.label\} pages`\}/, 'secondary navigation must identify the previewed section');
assert.match(appSource, /aria-current=\{route\.section === entry\.id \? 'page' : undefined\}/, 'active primary navigation must be announced');
assert.match(appSource, /aria-label="Open Settings"/, 'Settings must be an accessible top-bar control, not a sidebar destination');
assert.match(appSource, /window\.addEventListener\('hashchange', onPopState\)/, 'hash back/forward navigation must update the screen');
assert.match(appSource, /navigate\('chat', null, session\.id\)/, 'chat sessions must have stable deep links');
assert.match(appSource, /api\(`\/api\/chat\/sessions\/\$\{selectedSession\}\/cancel`/, 'Chat must expose cancellation for a running local generation');
assert.match(appSource, /operational approvals awaiting review/, 'Workboard badge must derive an operational approval count');
assert.match(appSource, /memory candidates awaiting review/, 'Knowledge badge must describe candidate count');
assert.match(appSource, /<CompletedWorkboard/, 'completed view must use existing source records');
assert.match(appSource, /api\('\/api\/items\?all=1'\)/, 'completed planner records must be read from the existing API');
assert.match(styles, /@media \(max-width: 760px\)/, 'narrow-screen layout must be defined');
assert.match(styles, /\.navigation-menu \{ max-width: 100%; \}/, 'narrow primary navigation must remain within the viewport');
assert.match(styles, /\.nav-subpages \{[\s\S]*left: 0;[\s\S]*top: calc\(100% \+ 6px\);/, 'narrow secondary navigation must remain within the viewport');
assert.match(styles, /\.icon-button\.active/, 'active Settings state must have a visible style');

console.log('Navigation consolidation verification passed.');
