import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring check for the local-answerability Chat surface (slice 3). Like
// the other *-ui verifiers this asserts the real client/server contract: the
// decision the server computes is rendered, it is only shown when escalation is
// suggested, it reuses the EXISTING reviewed cloud control, and it never sends.

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ui = read('src/main.jsx');
const server = read('server/index.js');

// The server must actually put the decision on the reply metadata for the UI.
assert.match(server, /localAnswerability: assistant\.answerability \|\| null/, 'server reply metadata carries localAnswerability');

// The Chat renders an escalation hint from that metadata, on assistant messages.
assert.match(ui, /function EscalationHint\(/, 'EscalationHint component exists');
assert.match(ui, /<EscalationHint answerability=\{parseMessageMetadata\(message\.metadata\)\?\.localAnswerability\}/, 'MessageBubble renders EscalationHint from the reply metadata');

// It appears ONLY when the server marked escalation as suggested — the UI never
// re-decides escalation policy itself.
assert.match(ui, /const escalation = answerability\?\.escalation;\s*\n\s*if \(!escalation\?\.suggested\) return null;/, 'the hint only shows when the server suggested escalation');
assert.doesNotMatch(ui.slice(ui.indexOf('function EscalationHint'), ui.indexOf('function SourceCards')), /fetch\(|api\(/, 'the hint never issues its own request (no send path)');

// It must reuse the existing reviewed-cloud control and state approval is required.
assert.match(ui, /Use the Cloud control below to prepare one — nothing is sent until you review the exact prompt and approve it\./, 'the hint points at the existing reviewed cloud control and states nothing is sent without approval');

console.log('Local-answerability Chat UI wiring verification passed.');
