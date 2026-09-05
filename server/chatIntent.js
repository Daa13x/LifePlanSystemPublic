// Pure chat routing + memory-gating helpers. No DB / IO here so they can be
// unit-tested directly (see scripts/verify-chat-behavior.mjs).
//
// classifyChatIntent decides whether an ordinary conversational reply is wanted
// (the default) or whether the user explicitly asked for structured local data
// (system status, active model, Workboard projects, or blocked items). Only the
// explicit-data intents are allowed to surface internal status; everything else
// stays conversational.

import { explicitChatCommandIntent } from './chatCommands.js';

export function classifyChatIntent(message) {
  const lower = String(message || '').toLowerCase();
  const commandIntent = explicitChatCommandIntent(message);
  if (commandIntent) return commandIntent;

  const asksList = /\b(list|show|display|name|give me|what are|which are|tell me|how many)\b/.test(lower);
  const asksWhat = /\b(what|which|show|display|tell me|list|how many|any)\b/.test(lower);

  if (/\bwhat(?:'s| is)?\s+(?:the )?(?:current )?date\b|\bwhat day is it\b|\btoday'?s date\b/.test(lower)) return 'current_date';
  if (/\bwhat(?:'s| is)?\s+(?:the )?(?:current )?time\b|\bwhat time is it\b/.test(lower)) return 'current_time';
  if (/\b(?:live|latest|today'?s)\s+news\b|\bdo you have live news\b/.test(lower)) return 'live_news';
  if (/\bwhere (?:are|is) (?:my )?(?:memories|memory) stored(?: locally)?\b|\bwhere do you store (?:my )?(?:memories|memory)\b/.test(lower)) return 'memory_storage';
  if (/\b(?:show|display|what(?:'s| is)|read|check)\s+(?:my\s+)?(?:plan\s+for\s+)?today\b/.test(lower)
    || /\bwhat (?:tasks?|have i got|do i have)\b[^.?!]*\btoday\b/.test(lower)) return 'planner_today';
  if (/\b(?:show|list|display|what are)\b[^.?!]*\b(?:recent|latest)\s+(?:local\s+)?runs?\b/.test(lower)) return 'recent_runs';

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
  if (/\b(?:router|routing|action\s+audit|recent\s+actions?|browser\s+(?:health|status)|cloud\s+controller|action\s+registry)\b/.test(lower)
      && /\b(?:show|check|inspect|report|status|health|diagnostic|current|recent|what|is|are)\b/.test(lower)) return 'system_status';

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

// Maps conversational/explicit command intent onto the existing universal
// action registry. This is an adapter, not a second command owner: schemas,
// permissions, risk, auditing, data access and execution all remain in
// chatCapabilities.js/actionRegistry.js.
export function capabilityRequestForChatIntent(intent) {
  return ({
    system_status: { actionId: 'system.status', args: {} },
    model_query: { actionId: 'system.models', args: { limit: 25 } },
    recent_runs: { actionId: 'system.runs', args: { limit: 8 } },
    workboard_list: { actionId: 'workboard.list', args: { view: 'projects', limit: 25 } },
    blocked_query: { actionId: 'workboard.list', args: { view: 'blocked', limit: 25 } },
    planner_today: { actionId: 'planner.today', args: {} }
  })[intent] || null;
}

function personalityTraitStrength(profile, id) {
  const trait = Array.isArray(profile?.traits) ? profile.traits.find((item) => item?.id === id) : null;
  const strength = Number(trait?.strength);
  return Number.isFinite(strength) ? Math.max(0, Math.min(10, strength)) : 0;
}

function readPlan(actionId, args, replyKind, reason, { verification = false, subject = null } = {}) {
  return Object.freeze({
    kind: 'capability',
    actionId,
    args: Object.freeze({ ...args }),
    replyKind,
    reason,
    verification,
    subject
  });
}

// Personality changes the preference for a small set of already-registered
// local reads; it never creates authority or capability. This policy runs only
// after explicit commands and ordinary natural-language intents have had first
// refusal. It returns at most ONE read, keeping inquisitiveness bounded by the
// practical/resource-conscious traits and leaving every permission check in the
// universal action registry.
export function selectPersonalityCapabilityPlan(message, profile) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const inquisitive = personalityTraitStrength(profile, 'inquisitive');
  const sceptical = personalityTraitStrength(profile, 'sceptical');
  const practical = personalityTraitStrength(profile, 'practical');
  const resourceConscious = personalityTraitStrength(profile, 'resource-conscious');

  // Consequential requests remain owned by the existing proposal/confirmation
  // adapters. A strong personality may prefer an action; it may not authorise it.
  if (/^(?:please\s+)?(?:add|create|delete|remove|change|update|mark|defer|send|publish|buy|book|order)\b/i.test(text)) return null;
  if (/^(?:hi|hello|hey|hiya|howdy|yo|thanks|thank you|ok|okay)[\s,.!?]*$/i.test(text)) return null;

  const boundedReadPreference = inquisitive >= 7.5 && practical >= 6 && resourceConscious >= 5;
  if (boundedReadPreference
      && /\bwhat (?:am i|are we) (?:supposed|meant) to (?:be )?(?:doing|work(?:ing)? on)\b[^.?!]*\btoday\b/i.test(text)) {
    return readPlan('planner.today', {}, 'today', 'Current Today evidence can answer this directly.');
  }
  if (boundedReadPreference
      && /\bwhy did (?:the )?(?:last|latest|that) (?:run|job|execution) (?:fail|break|stop)\b/i.test(text)) {
    return readPlan('system.runs', { limit: 1 }, 'last_run_failure', 'The smallest relevant check is the latest local run.');
  }
  if (boundedReadPreference
      && /\b(?:how far along is|what(?:'s| is) the progress (?:of|on)|how is)\b[^.?!]*\b(?:this|the|my|our)?\s*project\b/i.test(text)) {
    return readPlan('workboard.list', { view: 'projects', limit: 8 }, 'project_progress', 'Current Workboard projects are the smallest available progress evidence.');
  }

  if (sceptical >= 7.5) {
    const completedTask = text.match(/^(?:i(?:'m| am) sure\s+)?(.{1,120}?)\s+(?:is|was|has been)\s+(?:already\s+)?(?:completed|done|finished)[.!?]*$/i);
    if (completedTask && /\btask\b/i.test(completedTask[1])) {
      const rawSubject = completedTask[1].replace(/^(?:that|the)\s+task\s*/i, '').trim();
      return readPlan('planner.today', {}, 'task_completion_claim', 'Planner state can check the completion claim without changing it.', {
        verification: true,
        subject: rawSubject && !/^(?:that|the)\s+task$/i.test(completedTask[1]) ? rawSubject : null
      });
    }

    if (/\b(?:i(?:'m| am) sure|definitely|certainly|already)\b[^.?!]*\b(?:finished|completed|implemented|done)\b/i.test(text)) {
      const subject = /\bpersonality\b/i.test(text) ? 'personality' : 'implementation';
      return readPlan('knowledge.search', { query: subject, scope: 'approved', limit: 5 }, 'completion_claim', 'A confident completion claim should be checked against approved local evidence once.', { verification: true, subject });
    }

    if (/\b(?:model|ai|llm)\b[^.?!]*\b(?:definitely|certainly|must have)\b[^.?!]*\b(?:caused|triggered)\b[^.?!]*\b(?:crash|bsod|shutdown|restart)\b/i.test(text)
        || /\b(?:model|ai|llm)\b[^.?!]*\b(?:caused|triggered)\b[^.?!]*\b(?:crash|bsod|shutdown|restart)\b[^.?!]*(?:right|correct)\??$/i.test(text)) {
      return Object.freeze({
        kind: 'uncertainty',
        actionId: null,
        args: Object.freeze({}),
        replyKind: 'unsupported_causal_claim',
        reason: 'No registered Chat read exposes Windows crash evidence, so agreement would invent certainty.',
        verification: false,
        subject: 'crash cause'
      });
    }
  }

  return null;
}

function compactEvidenceList(items, format) {
  return items.slice(0, 5).map((item) => `- ${format(item)}`).join('\n');
}

// Converts the bounded result of the selected EXISTING action into the same
// conversational turn. It deliberately distinguishes evidence from proof.
export function formatPersonalityCapabilityReply(plan, data = {}) {
  if (plan?.replyKind === 'unsupported_causal_claim') {
    return "That is possible, but it is not established. I do not have an authorised crash-diagnostic read in Chat, so I cannot honestly say the model caused the crash without Windows event or dump evidence.";
  }
  if (plan?.replyKind === 'today') {
    const tasks = Array.isArray(data.visible) ? data.visible : [];
    return tasks.length
      ? `I checked Today. Your current focus is:\n\n${compactEvidenceList(tasks, (task) => `${task.title}${task.active_step ? ` — ${task.active_step}` : ''}${task.blocked ? ' (blocked)' : ''}`)}`
      : 'I checked Today. Nothing is currently scheduled there.';
  }
  if (plan?.replyKind === 'last_run_failure') {
    const latest = Array.isArray(data.runs) ? data.runs[0] : null;
    if (!latest) return "I checked the recent local runs, but there is no run record available, so I cannot establish what failed or why.";
    const failed = /fail|error|blocked|crash|invalid/i.test(String(latest.status || ''));
    const detail = String(latest.detail || '').trim();
    if (!failed) return `I checked the latest local run: **${latest.title}** is recorded as **${latest.status}**. That does not support the premise that the last run failed.`;
    return detail
      ? `I checked the latest local run. **${latest.title}** is **${latest.status}**. The recorded reason is: ${detail}`
      : `I checked the latest local run. **${latest.title}** is **${latest.status}**, but its bounded run record contains no failure reason, so I can verify the status but not honestly explain why.`;
  }
  if (plan?.replyKind === 'project_progress') {
    const projects = Array.isArray(data.records) ? data.records : [];
    if (!projects.length) return 'I checked the Workboard, but there is no active project record available to establish progress.';
    return `I checked the current Workboard projects:\n\n${compactEvidenceList(projects, (project) => `${project.title}${project.status ? ` — ${project.status}` : ''}`)}\n\nThere is no verified completion percentage in this read, so I will not invent one.`;
  }
  if (plan?.replyKind === 'completion_claim') {
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return `I checked approved local Knowledge for **${plan.subject || 'that work'}**, but found no sufficient evidence to verify the completion claim.`;
    return `I checked approved local Knowledge before agreeing. I found:\n\n${compactEvidenceList(items, (item) => `${item.title}${item.provenance?.status ? ` — ${item.provenance.status}` : ''}`)}\n\nThose records are relevant evidence, but their presence alone is not proof that every part of the work is complete.`;
  }
  if (plan?.replyKind === 'task_completion_claim') {
    const completed = Array.isArray(data.recently_completed) ? data.recently_completed : [];
    if (!plan.subject) {
      return completed.length
        ? `I checked Planner history, but “that task” is ambiguous. Recent completed tasks include:\n\n${compactEvidenceList(completed, (task) => task.title)}\n\nTell me which one you mean before I treat the claim as established.`
        : 'I checked Planner history, but “that task” is ambiguous and there is no recent completed task record to verify it.';
    }
    const subject = plan.subject.toLowerCase();
    const match = completed.find((task) => String(task.title || '').toLowerCase().includes(subject) || subject.includes(String(task.title || '').toLowerCase()));
    return match
      ? `I checked Planner history. **${match.title}** is recorded as **${match.status}**.`
      : `I checked Planner history, but I could not find a recent completed task matching **${plan.subject}**, so I cannot verify that claim.`;
  }
  throw new Error(`Unsupported personality capability reply: ${plan?.replyKind || '<missing>'}`);
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
