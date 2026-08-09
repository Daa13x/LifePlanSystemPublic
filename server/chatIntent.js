// Pure chat routing + memory-gating helpers. No DB / IO here so they can be
// unit-tested directly (see scripts/verify-chat-behavior.mjs).
//
// classifyChatIntent decides whether an ordinary conversational reply is wanted
// (the default) or whether the user explicitly asked for structured local data
// (system status, active model, Workboard projects, or blocked items). Only the
// explicit-data intents are allowed to surface internal status; everything else
// stays conversational.

export function classifyChatIntent(message) {
  const lower = String(message || '').toLowerCase();

  const asksList = /\b(list|show|display|name|give me|what are|which are|tell me|how many)\b/.test(lower);
  const asksWhat = /\b(what|which|show|display|tell me|list|how many|any)\b/.test(lower);

  if (/\bwhat(?:'s| is)?\s+(?:the )?(?:current )?date\b|\bwhat day is it\b|\btoday'?s date\b/.test(lower)) return 'current_date';
  if (/\bwhat(?:'s| is)?\s+(?:the )?(?:current )?time\b|\bwhat time is it\b/.test(lower)) return 'current_time';
  if (/\b(?:live|latest|today'?s)\s+news\b|\bdo you have live news\b/.test(lower)) return 'live_news';
  if (/\bwhere (?:are|is) (?:my )?(?:memories|memory) stored(?: locally)?\b|\bwhere do you store (?:my )?(?:memories|memory)\b/.test(lower)) return 'memory_storage';

  // Active model.
  if (/\b(which|what)\s+model\b/.test(lower)
    || /\bmodel\s+(is\s+)?(active|running|loaded|assigned|configured|in use)\b/.test(lower)
    || /\b(active|current|assigned)\s+model\b/.test(lower)) {
    return 'model_query';
  }

  // System status / health.
  if (/\bsystem\s+status\b/.test(lower)
    || /\b(show|display|current|overall|full)\b[^.?!]*\bstatus\b/.test(lower)
    || /\bstatus\s+(report|overview|of the system|check)\b/.test(lower)
    || /\b(health|diagnostic|diagnostics)\s+(check|status|report|overview)\b/.test(lower)) {
    return 'system_status';
  }

  // Blocked items.
  if (/\bblock(ed|er|ers)\b/.test(lower) && asksWhat) {
    return 'blocked_query';
  }

  // Workboard projects.
  if ((/\bworkboard\b/.test(lower) || /\bprojects?\b/.test(lower)) && asksList) {
    return 'workboard_list';
  }

  return 'conversation';
}

// Decide whether a chat message should become a review-only memory candidate.
// Default is NO. A candidate is only proposed when the user explicitly asks to
// remember/save it, or the text carries a durable signal (preference, decision,
// rule/constraint, recurring pattern/risk/failure mode, or stated goal).
// Greetings, connectivity/"can you speak" checks, and casual chatter never
// create candidates. Returns { create, reason }.
export function shouldCreateMemoryCandidate(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  if (text.length < 12) return { create: false, reason: 'too short / low-signal' };

  // Explicit terminology and naming conventions are durable preferences. They
  // are still only review candidates; this merely prevents them being lost in
  // conversational phrasing such as “when I say X, I mean Y”.
  if (/\bwhen\s+i\s+say\s+.+?\s+i\s+mean\s+.+/i.test(text)
    || /\bremember\s+that\s+.+?\s+means?\s+.+/i.test(text)
    || /\bcall\s+.+?\s+.+/i.test(text)
    || /\bfrom\s+now\s+on\s+(?:use|call)\s+.+?\s+(?:for|as)\s+.+/i.test(text)) {
    return { create: true, reason: 'explicit terminology preference' };
  }

  // 1. Explicit save intent — always honour it.
  if (/\b(remember|memori[sz]e|save (this|that|it)|store (this|that|it)|keep (this|that|it) in mind|note (this|that|it) down|make a note|don'?t forget|for the record|sync (this|that|it) to memory)\b/.test(lower)) {
    return { create: true, reason: 'explicit save request' };
  }

  // 2. Greetings / connectivity / "can you speak" checks — never a candidate.
  if (/^(hi|hello|hey|yo|hiya|howdy|hola|sup|test|testing|ping|ok|okay|thanks|thank you|cool|nice)\b[\s.,!?]*$/.test(lower)) {
    return { create: false, reason: 'greeting / acknowledgement' };
  }
  if (text.length < 90 && /\b(are you (working|there|online|up|alive|ok)|can you (hear|speak|talk|respond|reply)|do you work|say something|see you (speak|respond|talk)|want to see you (speak|respond|talk)|just testing|is this working)\b/.test(lower)) {
    return { create: false, reason: 'connectivity / speech check' };
  }

  // 3. Durable preference / stance.
  if (/\bi\s+(prefer|always|never|really (like|hate)|don'?t want|do not want|would rather|refuse to|insist on|need to always|want you to always|want you to never)\b/.test(lower)) {
    return { create: true, reason: 'stated preference' };
  }

  // 4. Decision / rule / constraint / recurring pattern / risk / goal.
  if (/\b(decided|decision|we will|from now on|going forward|policy|rule|constraint|deadline|due (on|by|date)|every (day|week|month|time)|recurring|pattern|risk|fails? when|always (breaks|fails)|keeps? (failing|happening|breaking)|my goal|our goal|the plan is)\b/.test(lower)) {
    return { create: true, reason: 'durable fact / decision / pattern' };
  }

  return { create: false, reason: 'no durable long-term signal' };
}
