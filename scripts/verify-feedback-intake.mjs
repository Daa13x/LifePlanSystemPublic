#!/usr/bin/env node
// Verify the pure feedback-intake rules using the REAL server/feedbackIntake.js
// module. Local-only: no network, server, or DB. Exit 0 = pass.

import {
  FEEDBACK_SENTIMENTS,
  isActionableSentiment,
  themeKey,
  normalizeFeedback,
  summarizeThemes
} from '../server/feedbackIntake.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- feedback intake verification ---');

// Controlled vocabulary of sentiments.
line(FEEDBACK_SENTIMENTS.length === 6 && ['useful', 'wrong', 'broken', 'incomplete'].every((s) => FEEDBACK_SENTIMENTS.includes(s)), 'the six feedback sentiments are defined');
line(isActionableSentiment('broken') && isActionableSentiment('wrong') && !isActionableSentiment('useful') && !isActionableSentiment('unnecessary'), 'problem sentiments are actionable; praise and design notes are not');

// Validation: sentiment is required and controlled; metadata is optional.
{
  let threw = false;
  try { normalizeFeedback({ sentiment: 'meh' }); } catch { threw = true; }
  line(threw, 'an invalid sentiment is rejected');
  const r = normalizeFeedback({ sentiment: 'WRONG', surface: 'chat', note: 'The answer cited the wrong project', runId: 'msg-42', provider: 'local', appVersion: '1.0.0' });
  line(r.sentiment === 'wrong' && r.surface === 'chat' && r.runId === 'msg-42' && r.actionable === true, 'a valid item is normalised and marked actionable with its attribution intact');
  line(typeof r.themeKey === 'string' && r.themeKey.includes('wrong') && r.themeKey.includes('chat'), 'a theme key is derived from sentiment + surface + note');
}

// Sensitive feedback is flagged so the caller keeps it under the memory boundary.
{
  const r = normalizeFeedback({ sentiment: 'wrong', surface: 'chat', note: 'It exposed my medication list' });
  line(r.sensitive === true, 'a note about a sensitive topic is flagged sensitive');
  const explicit = normalizeFeedback({ sentiment: 'confusing', surface: 'planner', sensitive: true });
  line(explicit.sensitive === true, 'an explicit sensitive flag is honoured');
  const plain = normalizeFeedback({ sentiment: 'confusing', surface: 'planner', note: 'The button label was unclear' });
  line(plain.sensitive === false, 'ordinary feedback is not marked sensitive');
}

// Theme keys collapse similar reports and separate different ones.
{
  const a = themeKey({ sentiment: 'broken', surface: 'planner', note: 'The Today tab crashed on load' });
  const b = themeKey({ sentiment: 'broken', surface: 'planner', note: 'Today tab crashed when loading' });
  const c = themeKey({ sentiment: 'broken', surface: 'chat', note: 'The Today tab crashed on load' });
  line(a === b, 'reworded reports about the same surface collapse to one theme');
  line(a !== c, 'the same words on a different surface are a different theme');
}

// Repeated, actionable, non-sensitive themes are PROPOSED for consolidation.
{
  const rows = [
    { id: 1, sentiment: 'broken', surface: 'planner', note: 'Today tab crashed', sensitive: 0 },
    { id: 2, sentiment: 'broken', surface: 'planner', note: 'today tab crashed again', sensitive: 0 },
    { id: 3, sentiment: 'useful', surface: 'chat', note: 'great answer', sensitive: 0 },
    { id: 4, sentiment: 'wrong', surface: 'chat', note: 'leaked my medication', sensitive: 1 },
    { id: 5, sentiment: 'wrong', surface: 'chat', note: 'leaked my medication once more', sensitive: 1 }
  ];
  const themes = summarizeThemes(rows, { recurringThreshold: 2 });
  const crash = themes.find((t) => t.surface === 'planner' && t.sentiment === 'broken');
  line(crash && crash.count === 2 && crash.proposeConsolidation === true, 'a repeated actionable theme is proposed for consolidation');
  const praise = themes.find((t) => t.sentiment === 'useful');
  line(praise && praise.proposeConsolidation === false, 'praise is never proposed as a regression/issue');
  const sensitiveTheme = themes.find((t) => t.sensitive);
  line(sensitiveTheme && sensitiveTheme.proposeConsolidation === false, 'a sensitive theme is never proposed for consolidation, even when repeated');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll feedback-intake checks passed.');
process.exit(failures ? 1 : 0);
