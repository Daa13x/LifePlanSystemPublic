const ROLE_DEFINITIONS = Object.freeze({
  orchestrator: Object.freeze({
    label: 'Orchestrator',
    instruction: 'Frame the outcome, dependencies, and next safe action. Keep the work bounded and preserve stated constraints.'
  }),
  coder: Object.freeze({
    label: 'Coder',
    instruction: 'Be evidence-led and implementation-specific. Distinguish inspected fact, proposed change, and required validation. Do not claim edits, tests, or Git actions without a receipt.'
  }),
  writer: Object.freeze({
    label: 'Writer',
    instruction: 'Produce clear, audience-appropriate prose. Preserve the user\'s meaning, distinguish fact from draft, and avoid invented sources.'
  }),
  life_coach: Object.freeze({
    label: 'Life Coach',
    instruction: 'Offer practical, non-judgmental choices that preserve the user\'s agency. Do not diagnose, shame, or impersonate a clinician.'
  })
});

const EXPLICIT_MODE = /(?:^|\s)(?:@|\/mode\s+)(orchestrator|coder|writer|life(?:[- ]?coach)?)(?=\s|$|[,:.!?])/i;

function normalise(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function inferredRole(text) {
  const codingOutcome = /\b(?:fix|build|implement|debug|refactor|test|validate|ship|release)\b/.test(text);
  const engineeringSubject = /\b(?:code|repo(?:sitory)?|file|function|api|database|schema|test|build|installer|bug|error|javascript|typescript|node|sql|git)\b/.test(text);
  if (codingOutcome && engineeringSubject) return 'coder';

  const writingOutcome = /\b(?:draft|rewrite|edit|summari[sz]e|outline|write|word|copy|email|letter|document)\b/.test(text);
  if (writingOutcome) return 'writer';

  const personalOutcome = /\b(?:overwhelmed|stuck|burnt out|burned out|habit|routine|motivat(?:e|ion)|prioriti[sz]e|procrastinat|plan my day|low energy)\b/.test(text);
  if (personalOutcome) return 'life_coach';

  return 'orchestrator';
}

export function resolveAgentMode(userMessage) {
  const text = normalise(userMessage);
  const explicit = text.match(EXPLICIT_MODE);
  const id = explicit
    ? (explicit[1].startsWith('life') ? 'life_coach' : explicit[1])
    : inferredRole(text);
  const role = ROLE_DEFINITIONS[id] || ROLE_DEFINITIONS.orchestrator;
  return Object.freeze({ id, label: role.label, source: explicit ? 'explicit' : 'inferred', instruction: role.instruction });
}

export const AGENT_MODE_IDS = Object.freeze(Object.keys(ROLE_DEFINITIONS));
