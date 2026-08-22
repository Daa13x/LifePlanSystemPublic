import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring check for the unified Quality review UI. It must surface the
// failure taxonomy and cost-routing engines read-only, triage failures through
// the real endpoint, and make the "changes nothing automatically" boundary
// explicit.

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ui = read('src/main.jsx');
const navigation = read('src/navigation.js');
const server = read('server/index.js');

assert.match(navigation, /\{ id: 'quality', label: 'Quality' \}/, 'navigation registers the Quality tab');
assert.match(ui, /route\.tab === 'quality' && <QualityReview[^>]*refreshSignal=\{refreshSignal\}/, 'System renders QualityReview for the quality tab');
assert.match(ui, /function QualityReview\(/, 'QualityReview component exists');

const quStart = ui.indexOf('function QualityReview');
const quEnd = ui.indexOf('\nfunction ', quStart + 1);
const slice = ui.slice(quStart, quEnd > quStart ? quEnd : quStart + 6000);
assert.match(slice, /api\('\/api\/failures'\)/, 'the quality view reads the failures queue');
assert.match(slice, /api\('\/api\/routing\/summary'\)/, 'the quality view reads the routing summary');
assert.match(slice, /api\(`\/api\/failures\/\$\{id\}`, \{ method: 'PATCH', body: JSON\.stringify\(\{ status \}\) \}\)/, 'failures are triaged through the real endpoint');
assert.match(slice, /confirmed/, 'a failure can be confirmed');
assert.match(slice, /proposals/, 'confirmation-gated remediation proposals are surfaced');
assert.doesNotMatch(slice, /triage\(item\.id, 'converted'\)|Mark converted/, 'the UI cannot directly mark a failure converted without evaluation evidence');
assert.match(slice, /api\(`\/api\/failures\/\$\{item\.id\}\/evaluations`/, 'the Quality UI persists an evaluation through the failure-bound endpoint');
assert.match(slice, /\(failures\.categories \|\| \[\]\)\.map/, 'the evaluation form requires every server-owned failure category');
assert.match(slice, /regressionRef: draft\.regressionRef, before, after/, 'the evaluation submits a bounded reference and complete before/after maps');
assert.match(slice, /did not pass:[^`]*\$\{result\.evaluation\.reason\}/, 'a failed evaluation reason remains visible for review');
assert.match(slice, /Recorded evaluations \(\{item\.evaluations\.length\}\)/, 'persisted evaluation history is rendered after reload');
assert.match(slice, /JSON\.stringify\(evaluation\.before\)[^\n]*JSON\.stringify\(evaluation\.after\)/, 'reviewers can inspect the persisted complete before/after snapshots');
assert.match(slice, /changes nothing|never change|changes nothing automatically|A single failure changes nothing/, 'the boundary (no automatic change) is stated');
assert.match(slice, /successRate/, 'routing evidence shows measured success rate');
assert.doesNotMatch(slice, /\.sort\(/, 'the quality view does not re-order server data');

// The endpoints it depends on exist.
assert.match(server, /app\.get\('\/api\/failures'/, 'failures endpoint exists');
assert.match(server, /app\.patch\('\/api\/failures\/:id'/, 'failures triage endpoint exists');
assert.match(server, /app\.post\('\/api\/failures\/:id\/evaluations'/, 'failure-bound evaluation endpoint exists');
assert.match(server, /app\.get\('\/api\/routing\/summary'/, 'routing summary endpoint exists');

console.log('Quality review UI wiring verification passed.');
