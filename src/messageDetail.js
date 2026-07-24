// Pure helpers for assistant-reply detail display. No React / DOM imports here
// so they can be unit-tested directly (see scripts/verify-legacy-message-display.mjs).

export const RESPONSE_DETAIL_MODES = ['clean', 'detailed', 'developer'];

export function normalizeDetailMode(value) {
  return RESPONSE_DETAIL_MODES.includes(value) ? value : 'clean';
}

export function parseMessageMetadata(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// True when a message carries usable structured metadata. Empty objects count
// as "missing" so those rows fall through to the legacy-text parser.
export function hasStructuredMetadata(metadata) {
  return Boolean(metadata) && typeof metadata === 'object' && Object.keys(metadata).length > 0;
}

// Rows for a NEW message (structured metadata). Curated fields for
// clean/detailed; the full local-runtime diagnostics are added in developer.
export function buildDetailRows(metadata, mode) {
  const rows = [];
  const governance = metadata.memoryGovernance || {};

  const contextFiles = Array.isArray(metadata.contextFiles) ? metadata.contextFiles : [];
  rows.push(['Attached context', contextFiles.length ? contextFiles.join(', ') : 'None attached']);
  rows.push([
    'Memory action',
    governance.created
      ? `Candidate created${governance.type ? ` (${governance.type})` : ''} — pending your review`
      : 'No memory candidate created'
  ]);
  rows.push(['Runtime / provider', metadata.runtime || 'unknown']);
  if (metadata.fallback) {
    rows.push([
      'Fallback',
      metadata.fallback === 'unavailable'
        ? 'Setup-gated fallback — no local model answered'
        : 'Runtime-error fallback'
    ]);
  }

  if (mode === 'developer') {
    if (metadata.model) rows.push(['Model', metadata.model]);
    if (metadata.endpointType) rows.push(['Endpoint type', metadata.endpointType]);
    if (metadata.endpoint) rows.push(['Endpoint', metadata.endpoint]);
    if (governance.candidateId) rows.push(['Candidate id', String(governance.candidateId)]);
    if (typeof metadata.timingMs === 'number') rows.push(['Response time', `${metadata.timingMs} ms`]);
    if (metadata.tokens) {
      const t = metadata.tokens;
      const parts = [];
      if (t.promptTokens != null) parts.push(`${t.promptTokens} prompt`);
      if (t.completionTokens != null) parts.push(`${t.completionTokens} completion`);
      if (t.totalTokens != null) parts.push(`${t.totalTokens} total`);
      if (parts.length) rows.push(['Tokens', parts.join(' · ')]);
    }
    if (metadata.error) rows.push(['Error', metadata.error]);
    if (metadata.generatedAt) rows.push(['Generated at', metadata.generatedAt]);
  }

  return rows;
}

// --- Legacy compatibility (display-only) -----------------------------------
//
// Older assistant rows were stored before structured metadata existed: the
// diagnostic trailer was concatenated onto the answer body, e.g.
//
//   <answer>
//
//   Memory governance: I saved your note as a candidate for review ...
//
//   Files in context: a.md, b.md. Source files are context only; ...
//
//   Runtime: unavailable.
//
// parseLegacyAssistantMessage() separates that trailer for DISPLAY only. It
// never rewrites the stored row, and it fails safe (returns null -> show the
// original message verbatim) whenever the structure is at all uncertain.

// Each recognised diagnostic paragraph starts, at character 0, with one of
// these labels. A "strong" label is one the legacy generator always emitted,
// so its presence is what confirms a trailer is really a diagnostic block and
// not ordinary prose that merely mentions "runtime" or "source".
const LEGACY_MARKERS = [
  { field: 'memoryGovernanceText', strong: true, re: /^Memory governance:\s*(.+)$/i },
  { field: 'runtime', strong: true, re: /^Runtime:\s*(.+?)\.?\s*$/i },
  { field: 'contextText', strong: false, re: /^Files in context:\s*(.+)$/i },
  { field: 'source', strong: false, re: /^Source:\s*(.+)$/i },
  { field: 'knowledge', strong: false, re: /^Knowledge attached:\s*(.+)$/i },
  { field: 'workboard', strong: false, re: /^Workboard state:\s*(.+)$/i },
  { field: 'model', strong: false, re: /^Model:\s*(.+?)\.?\s*$/i },
  { field: 'endpoint', strong: false, re: /^Endpoint:\s*(.+?)\.?\s*$/i },
  { field: 'fallback', strong: false, re: /^Fallback:\s*(.+)$/i }
];

const MAX_LEGACY_PARAGRAPH_LENGTH = 600; // diagnostic lines are short one-liners
const MAX_LEGACY_TRAILER_PARAGRAPHS = 6; // legacy blocks are governance..runtime

function matchLegacyParagraph(paragraph) {
  const text = paragraph.trim();
  // A diagnostic line is a single short line. Requiring a single physical line
  // keeps multi-line prose that happens to start with a label out of scope.
  if (!text || text.includes('\n') || text.length > MAX_LEGACY_PARAGRAPH_LENGTH) return null;
  for (const marker of LEGACY_MARKERS) {
    const found = text.match(marker.re);
    if (found) return { field: marker.field, strong: marker.strong, value: found[1].trim() };
  }
  return null;
}

export function parseLegacyAssistantMessage(content) {
  const raw = String(content ?? '');
  if (!raw.trim()) return null;

  const paragraphs = raw.split(/\n{2,}/);
  if (paragraphs.length < 2) return null; // nothing separable from the answer

  // Walk backwards, collecting the contiguous run of trailing diagnostic
  // paragraphs. Stop at the first paragraph that is not a diagnostic line, so
  // the natural answer (and any middle paragraph) is never examined.
  const trailer = [];
  let boundary = paragraphs.length;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const matched = matchLegacyParagraph(paragraphs[i]);
    if (!matched) break;
    trailer.unshift(matched);
    boundary = i;
  }

  if (!trailer.length) return null;
  if (trailer.length > MAX_LEGACY_TRAILER_PARAGRAPHS) return null;

  // Confidence gates — any failure means "uncertain", so show the original.
  const hasStrongAnchor = trailer.some((entry) => entry.strong);
  if (!hasStrongAnchor) return null;

  // The legacy generator never repeated a field. A duplicate means we have
  // wandered into genuine answer text (e.g. an answer line that itself starts
  // with "Runtime:") — bail rather than risk hiding real content.
  const seen = new Set();
  for (const entry of trailer) {
    if (seen.has(entry.field)) return null;
    seen.add(entry.field);
  }

  const answer = paragraphs.slice(0, boundary).join('\n\n').trim();
  if (!answer) return null; // never leave an empty answer

  const legacy = { legacy: true };
  for (const entry of trailer) legacy[entry.field] = entry.value;

  return {
    answer,
    legacy,
    trailer: paragraphs.slice(boundary).join('\n\n')
  };
}

// Rows for a recognised LEGACY trailer, mirroring buildDetailRows so both feed
// the same Details panel. Curated fields for detailed; everything safely
// recognised for developer.
export function buildLegacyDetailRows(legacy, mode) {
  const rows = [];

  if (legacy.contextText) rows.push(['Attached context', legacy.contextText]);
  if (legacy.memoryGovernanceText) {
    const created = /\bas a candidate\b/i.test(legacy.memoryGovernanceText);
    rows.push(['Memory action', created ? 'Candidate created — pending your review' : 'No memory candidate created']);
  }
  if (legacy.source) rows.push(['Source', legacy.source]);
  if (legacy.knowledge) rows.push(['Knowledge attached', legacy.knowledge]);
  if (legacy.workboard) rows.push(['Workboard state', legacy.workboard]);
  if (legacy.runtime) rows.push(['Runtime / provider', legacy.runtime]);
  if (legacy.fallback) rows.push(['Fallback', legacy.fallback]);

  if (mode === 'developer') {
    if (legacy.model) rows.push(['Model', legacy.model]);
    if (legacy.endpoint) rows.push(['Endpoint', legacy.endpoint]);
    if (legacy.memoryGovernanceText) rows.push(['Memory governance (verbatim)', legacy.memoryGovernanceText]);
    rows.push(['Origin', 'Reconstructed from legacy message text; no stored metadata']);
  }

  return rows;
}
