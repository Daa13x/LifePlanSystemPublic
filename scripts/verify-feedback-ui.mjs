import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring check for the continuous-feedback UI (uncle-feedback item 5,
// slice 2). Asserts the real client/server contract: a low-friction capture
// control on chat replies and a review queue, both hitting the real endpoints,
// with the "never changes behaviour automatically" boundary made explicit.

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ui = read('src/main.jsx');
const navigation = read('src/navigation.js');
const server = read('server/index.js');

// A Feedback tab in System, wired and refresh-persistent via the hash router.
assert.match(navigation, /\{ id: 'feedback', label: 'Feedback' \}/, 'navigation registers the Feedback tab');
assert.match(ui, /route\.tab === 'feedback' && <FeedbackReview[^>]*refreshSignal=\{refreshSignal\}/, 'System renders FeedbackReview for the feedback tab');

// Capture control on assistant replies.
assert.match(ui, /function FeedbackControl\(/, 'FeedbackControl component exists');
assert.match(ui, /<MessageVoice text=\{body\} \/><FeedbackControl message=\{message\} \/>/, 'the capture control sits on assistant replies');
assert.match(ui, /api\('\/api\/feedback', \{ method: 'POST', body: JSON\.stringify\(\{ sentiment: chosen, surface: 'chat:reply', runId: String\(message\.id\)/, 'captured feedback posts sentiment + attribution (surface + run id)');
// It must never disrupt the chat, but a failed send must be honest and retryable.
const control = ui.slice(ui.indexOf('function FeedbackControl'), ui.indexOf('function FeedbackReview'));
assert.match(control, /catch \{ setMode\('error'\); \}/, 'a failed capture enters an explicit error state');
assert.match(control, /Feedback was not sent\.[\s\S]*Retry/, 'a failed capture exposes a retry without disrupting the conversation');

// Review queue: reads the queue, shows consolidation proposals, and triages.
assert.match(ui, /function FeedbackReview\(/, 'FeedbackReview component exists');
assert.match(ui, /api\('\/api\/feedback'\)/, 'the review view reads the feedback queue');
assert.match(ui, /await proposeFeedbackTriage\(item\.id, status\)/, 'review proposes feedback triage through the governed feedback.propose_triage action, not a raw PATCH');
assert.match(ui, /await confirmFeedbackTriage\(pending\)/, 'review applies feedback triage only after an explicit confirm step');
const reviewStart = ui.indexOf('function FeedbackReview');
const reviewEnd = ui.indexOf('\nfunction CompletedWorkboard', reviewStart);
assert.ok(reviewStart >= 0 && reviewEnd > reviewStart, 'FeedbackReview has a bounded source slice');
const review = ui.slice(reviewStart, reviewEnd);
assert.match(review, /proposeConsolidation/, 'the review surfaces recurring-theme consolidation proposals');
assert.match(review, /never changes prompts, rules, memory, or behaviour automatically/, 'the review states feedback never changes behaviour on its own');
assert.match(review, /local only/, 'sensitive feedback is marked local-only in the queue');
assert.match(review, /Boolean\(item\.actionable\).*Route to Quality review/s, 'only actionable feedback exposes the Quality routing control');
assert.match(review, /applied\.failureEventId/, 'routing reports the exact observed Quality destination');

// The server endpoints the UI depends on exist.
assert.match(server, /app\.post\('\/api\/feedback'/, 'the feedback capture endpoint exists');
assert.match(server, /app\.get\('\/api\/feedback'/, 'the feedback queue endpoint exists');
assert.match(server, /app\.patch\('\/api\/feedback\/:id'/, 'the feedback triage endpoint exists');
assert.match(server, /INSERT INTO failure_events[\s\S]*'user-correction', 'observed', 'user-feedback'/, 'routing creates only an observed Quality failure for later human review');

console.log('Continuous-feedback UI wiring verification passed.');
