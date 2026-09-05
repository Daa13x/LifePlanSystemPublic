// Pure, bounded reliability helpers for the existing Chat owner. These helpers
// do not execute capabilities or mutate state; server/index.js remains the only
// owner of persistence, action receipts, permissions, and provider dispatch.

import { classifyCloudProviderIntent } from './cloudIntent.js';

export const CHAT_MESSAGE_MAX_CHARS = 20_000;
export const CLOUD_GUIDANCE_MAX_CHARS = 8_000;
export const CHAT_HISTORY_MAX_MESSAGES = 14;
export const CHAT_HISTORY_MAX_CHARS = 10_000;
export const CHAT_CONSULTATION_MAX_RECEIPTS = 5;
export const CHAT_CONSULTATION_MAX_RESPONSE_CHARS = 6_000;

const CLOUD_REFERENCE = /\b(chatgpt|cloud\s+(?:advisor|adviser|consultation|check|response)|consultation\s*#?\s*\d+)\b/i;
const VAGUE_REFERENCE = /\b(?:what(?:'s| is)|explain|describe)\s+(?:this|that)(?:\s+(?:answer|response|message|card|result))?\b/i;

export function classifyConsultationReference(message, { hasCompletedConsultation = false } = {}) {
  const text = String(message || '').trim();
  if (classifyCloudProviderIntent(text).kind) return null;
  const vagueUse = /\b(?:use|remove|clear|stop)\b[^.?!]*\b(?:(?:that|this|its|the)\s+)?(?:answer|response|advice|guidance|result)\b/i.test(text);
  if (!text || (!CLOUD_REFERENCE.test(text) && !(hasCompletedConsultation && (VAGUE_REFERENCE.test(text) || vagueUse)))) return null;
  if (/\b(?:remove|clear|stop|don'?t use|do not use)\b[^.?!]*\b(?:guidance|advice|answer|response)\b/i.test(text)) return 'remove';
  if (/\buse\b[^.?!]*\b(?:answer|response|advice|guidance|result)\b/i.test(text)) return 'use';
  if (/\b(?:what(?:'s| is) (?:this|that)|explain|describe)\b/i.test(text)) return 'describe';
  if (/\b(?:what|which|show|repeat|tell|got|get|said|say|returned|response|answer|message|result)\b/i.test(text)) return 'result';
  return 'describe';
}

export function requestedConsultationId(message) {
  const value = String(message || '').match(/\bconsultation\s*#?\s*(\d+)\b/i)?.[1];
  return value ? Number(value) : null;
}

export function formatConsultationReply(check, kind = 'result') {
  if (!check?.response) return 'No completed cloud consultation response is available in this chat.';
  const provider = String(check.provider || 'Cloud provider');
  const consultationId = Number(check.consultation_id || check.id);
  const model = check.model ? ` using **${check.model}**` : '';
  const response = String(check.response).trim();
  if (kind === 'describe') {
    return `This is the saved result from **${provider} consultation #${consultationId}**${model}. It returned:\n\n${response}`;
  }
  return `**${provider} consultation #${consultationId}**${model} returned:\n\n${response}`;
}

export function formatConsultationContext(check) {
  const response = String(check?.response || '').slice(0, CHAT_CONSULTATION_MAX_RESPONSE_CHARS);
  return [
    `- consultation #${check.consultation_id || check.id}`,
    `provider: ${check.provider || 'unknown'}`,
    `model: ${check.model || 'provider-selected model'}`,
    `status: ${check.status || 'unknown'}`,
    `response: ${response}`
  ].join('\n  ');
}

const FALSE_EXTERNAL_DENIAL = /\b(?:i (?:do not|don'?t|cannot|can'?t) (?:have )?(?:access to|see|read|receive)|no access to)\b[^.?!]*(?:chatgpt|cloud|external (?:message|model|service))/i;
const FALSE_ACTION_CLAIM = /\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:saved|created|updated|deleted|removed|sent|scheduled|completed|added|changed)\b/i;
const FALSE_PROVIDER_IDENTITY = /\b(?:i am|i'm)\s+(?:(?:an?|the)\s+)?(?:google(?:'s)?\s+(?:ai|assistant|gemini)|gemini|chatgpt|openai(?:'s)?\s+(?:ai|assistant)|claude|anthropic(?:'s)?\s+(?:ai|assistant))\b/i;

// Model text is untrusted. A reply cannot override durable receipts or invent a
// provider/action identity. When a contradiction is detected, fail closed to a
// short receipt-grounded answer rather than trying to patch arbitrary prose.
export function enforceAssistantResponseConsistency({
  content,
  userMessage,
  consultation = null,
  route = {},
  actionReceipt = null
}) {
  const text = String(content || '').trim();
  const consultationReference = classifyConsultationReference(userMessage, { hasCompletedConsultation: Boolean(consultation?.response) });
  if (consultation?.response && consultationReference && FALSE_EXTERNAL_DENIAL.test(text)) {
    return { content: formatConsultationReply(consultation, consultationReference === 'describe' ? 'describe' : 'result'), changed: true, reason: 'consultation-receipt-contradiction' };
  }
  if (!actionReceipt && FALSE_ACTION_CLAIM.test(text)) {
    return {
      content: 'I have not changed anything in LifePlanSystem. This reply has no verified action receipt. I can prepare the appropriate reviewed action if you want to apply a change.',
      changed: true,
      reason: 'unverified-action-claim'
    };
  }
  if (FALSE_PROVIDER_IDENTITY.test(text)) {
    const model = String(route.model || '').trim();
    return {
      content: `I am the LifePlanSystem Planner Assistant${model ? `, and this reply used the local **${model}** route` : ', using the recorded local route for this chat'}.`,
      changed: true,
      reason: 'provider-identity-contradiction'
    };
  }
  return { content: text, changed: false, reason: null };
}

export function boundedConversationHistory(messages) {
  const unique = [...(messages || [])].filter((message, index, items) => items.findIndex((candidate) => candidate.id === message.id) === index);
  const pinned = unique.filter((message) => message.pinned).slice(-CHAT_HISTORY_MAX_MESSAGES);
  const pinnedIds = new Set(pinned.map((message) => message.id));
  const recent = unique.filter((message) => !pinnedIds.has(message.id)).slice(-(CHAT_HISTORY_MAX_MESSAGES - pinned.length));
  const candidates = [...pinned, ...recent].sort((left, right) => Number(left.id) - Number(right.id));
  const selected = [];
  let remaining = CHAT_HISTORY_MAX_CHARS;
  // Allocate the character budget to pinned messages first, then the newest
  // ordinary turns. Restore chronological order only after the bounded choice.
  const priority = [...pinned, ...recent.reverse()];
  const boundedById = new Map();
  for (const message of priority) {
    if (!remaining) break;
    const text = String(message.content || '').trim();
    if (!text) continue;
    const excerpt = text.slice(0, remaining);
    remaining -= excerpt.length;
    boundedById.set(message.id, { ...message, content: excerpt });
  }
  for (const message of candidates) if (boundedById.has(message.id)) selected.push(boundedById.get(message.id));
  return selected;
}
