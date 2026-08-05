// Continuous user-feedback intake — pure, deterministic normalisation and theme
// detection for the feedback capture surface. No DB/IO here so the exact rules
// the server applies are unit-testable.
//
// Principles this encodes on purpose:
//   * Feedback is evidence, never an automatic action: intake only classifies
//     and routes to a review queue. It NEVER changes prompts, rules, memory, or
//     any production behaviour on its own.
//   * Every item is attributable: surface, work item, run, provider, and app
//     version are carried through so a theme can be traced back to real runs.
//   * Sensitive feedback stays local: it is flagged so the caller keeps it under
//     the normal memory-approval boundary and never auto-promotes or sends it.

export const FEEDBACK_SENTIMENTS = ['useful', 'wrong', 'confusing', 'broken', 'unnecessary', 'incomplete'];

// Which sentiments describe a problem worth routing to review. "useful" is
// positive signal; "unnecessary" is a design note; the rest are actionable.
const ACTIONABLE = new Set(['wrong', 'confusing', 'broken', 'incomplete']);

// Topics that must stay on-device under the memory-approval boundary rather than
// being surfaced for consolidation or promotion.
const SENSITIVE = /\b(?:diagnos(?:is|ed)|medication|prescription|therap(?:y|ist)|mental health|medical|symptom|hospital|disabilit|password|passcode|api[ _-]?key|secret|social security|bank account|sort code)\b/i;

const STOP = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'was', 'not', 'but', 'you', 'are', 'its', 'it', 'a', 'an', 'is', 'to', 'of', 'on', 'in', 'when', 'while', 'again', 'once', 'more', 'have', 'had', 'been', 'they', 'them', 'then', 'than']);

export function isActionableSentiment(sentiment) {
  return ACTIONABLE.has(String(sentiment || '').toLowerCase());
}

// Light stemming so reworded reports collapse to the same theme: "crashed" and
// "crashing" -> "crash", "loading" and "loads" -> "load". Deliberately simple
// and deterministic — theme grouping only needs to be stable, not linguistic.
function stem(word) {
  return word.replace(/(ing|ed|ly)$/, '').replace(/s$/, '');
}

function keywords(text) {
  const words = (String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).map(stem).filter((word) => word.length >= 3 && !STOP.has(word));
  return [...new Set(words)].sort();
}

// A stable key grouping feedback about the same thing: the sentiment, the UI
// surface, and the salient note keywords. Two reports about the same broken
// panel collapse to one theme even if the wording differs slightly.
export function themeKey({ sentiment, surface, note } = {}) {
  const parts = [
    String(sentiment || '').toLowerCase().trim(),
    String(surface || '').toLowerCase().trim(),
    keywords(note).slice(0, 6).join('-')
  ];
  return parts.join('|');
}

// Validate and normalise one submitted feedback item. Throws on an invalid
// sentiment (the one required, controlled field); everything else is optional
// metadata that is trimmed and length-bounded.
export function normalizeFeedback(input = {}) {
  const sentiment = String(input.sentiment || '').toLowerCase().trim();
  if (!FEEDBACK_SENTIMENTS.includes(sentiment)) {
    throw new Error(`Feedback sentiment must be one of: ${FEEDBACK_SENTIMENTS.join(', ')}.`);
  }
  const str = (value, max) => String(value ?? '').trim().slice(0, max);
  const note = str(input.note, 2000);
  const surface = str(input.surface, 200);
  const sensitive = Boolean(input.sensitive) || SENSITIVE.test(note) || SENSITIVE.test(surface);
  return {
    sentiment,
    surface,
    workItem: str(input.workItem ?? input.work_item, 200) || null,
    runId: str(input.runId ?? input.run_id, 200) || null,
    provider: str(input.provider, 120) || null,
    appVersion: str(input.appVersion ?? input.app_version, 120) || null,
    note: note || null,
    evidence: str(input.evidence, 4000) || null,
    sensitive,
    actionable: isActionableSentiment(sentiment),
    themeKey: themeKey({ sentiment, surface, note })
  };
}

// Group review-queue feedback by theme and flag recurring, non-sensitive,
// actionable themes as candidates for a consolidated issue or regression test.
// This only PROPOSES; it never creates or changes anything.
export function summarizeThemes(rows = [], { recurringThreshold = 2 } = {}) {
  const groups = new Map();
  for (const rowRaw of Array.isArray(rows) ? rows : []) {
    const key = rowRaw.theme_key || rowRaw.themeKey || themeKey({ sentiment: rowRaw.sentiment, surface: rowRaw.surface, note: rowRaw.note });
    if (!groups.has(key)) {
      groups.set(key, { themeKey: key, sentiment: rowRaw.sentiment, surface: rowRaw.surface || '', count: 0, sensitive: false, actionable: isActionableSentiment(rowRaw.sentiment), ids: [] });
    }
    const group = groups.get(key);
    group.count += 1;
    if (rowRaw.id !== undefined) group.ids.push(rowRaw.id);
    if (rowRaw.sensitive) group.sensitive = true;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    // A consolidation is only proposed for repeated, actionable, non-sensitive
    // themes — and it is a proposal for review, not an automatic action.
    proposeConsolidation: group.actionable && !group.sensitive && group.count >= recurringThreshold
  })).sort((a, b) => b.count - a.count);
}
