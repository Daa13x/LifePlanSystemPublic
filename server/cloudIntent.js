// Shared deterministic distinction between a NEW provider invocation and a
// reference to an existing consultation. This module owns no dispatch or
// permissions: the existing reviewed cloud-check endpoints remain authoritative.

const PROVIDERS = Object.freeze({
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  grok: 'Grok'
});

const PROVIDER_PATTERN = '(chatgpt|claude|gemini|grok)';
const DIAGNOSTIC_PATTERN = /\b(?:system\s+status|diagnostic(?:s)?|router|routing|action\s+audit|recent\s+actions?|browser\s+(?:health|status)|cloud\s+controller|action\s+registry|runtime\s+status)\b/i;
const PREVIOUS_RESULT_NEGATION = /\b(?:do\s+not|don'?t|never)\s+(?:return|show|use|repeat)\b[^.?!]{0,100}\b(?:previous|prior|old|existing|historical|last)\b[^.?!]{0,80}\b(?:consultation|response|result|answer)\b/i;
const NEGATED_INVOCATION = new RegExp(`\\b(?:do\\s+not|don'?t|never)\\s+(?:call|ask|consult|open|send|use|check\\s+with)\\b[^.?!]{0,100}\\b${PROVIDER_PATTERN}\\b`, 'i');

function providerIn(text) {
  const match = String(text || '').match(new RegExp(`\\b${PROVIDER_PATTERN}\\b`, 'i'));
  return match ? PROVIDERS[match[1].toLowerCase()] : null;
}

export function classifyCloudProviderIntent(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  const provider = providerIn(text);
  if (!text || !provider) return { kind: null, provider: null };

  if (PREVIOUS_RESULT_NEGATION.test(text) || DIAGNOSTIC_PATTERN.test(text)) {
    return { kind: 'diagnostic', provider };
  }
  if (NEGATED_INVOCATION.test(text)) return { kind: null, provider };

  const newInvocation = [
    new RegExp(`\\b(?:call|ask|consult|check\\s+with)\\s+(?:the\\s+)?${PROVIDER_PATTERN}\\b`, 'i'),
    new RegExp(`\\bopen\\s+(?:the\\s+)?${PROVIDER_PATTERN}\\b[^.?!]{0,240}\\b(?:type|send|ask|tell|have|give)\\b`, 'i'),
    new RegExp(`\\bsend\\b[^.?!]{0,240}\\b(?:to|through|via)\\s+(?:the\\s+)?${PROVIDER_PATTERN}\\b`, 'i'),
    new RegExp(`\\buse\\s+(?:the\\s+)?${PROVIDER_PATTERN}\\b(?![^.?!]{0,100}\\b(?:answer|response|result|advice|guidance|said|returned)\\b)`, 'i')
  ].some((pattern) => pattern.test(text));

  return { kind: newInvocation ? 'invoke' : null, provider };
}

