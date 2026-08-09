import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deterministic, local-only Knowledge retrieval. This is deliberately
// structured-search first: no embeddings, network calls, or hidden database
// dump. Every returned item includes human-readable provenance.

const MAX_ITEMS = 10;
const MAX_CHARS = 4200;
const STOP = new Set(['what', 'does', 'about', 'have', 'that', 'this', 'with', 'from', 'your', 'know', 'said', 'tell', 'life', 'planner', 'user', 'the', 'and', 'for']);
// Words that name WHERE to look in a repository question ("the GitHub knowledge
// base", "the documentation") rather than the topic being asked about. Every
// LifePlanSystem document mentions "knowledge" and "github", so scoring on them
// lets generic or merely-recent documents outrank the one that actually covers
// the asked-about subject. They are dropped from repository-question scoring
// whenever a real topic word remains.
const REPOSITORY_META_WORDS = new Set(['github', 'repository', 'repositories', 'repo', 'repos', 'knowledge', 'base', 'documentation', 'docs', 'doc', 'document', 'documents', 'say', 'says', 'contain', 'contains', 'mention', 'mentions']);
// Conversation history is useful local context, but it is not automatically
// approved memory.  Keep health, credential, and similarly sensitive turns out
// of broad "tell me about me" retrieval, even though they remain in their own
// Chat session.  A turn already blocked for cloud egress is also ineligible.
const SENSITIVE_CHAT_HISTORY = /\b(?:diagnos(?:is|ed)|medication|prescription|therap(?:y|ist)|mental health|medical record|symptom|hospital|disability|password|passcode|api[ _-]?key|secret|social security)\b/i;
const REPOSITORY_KNOWLEDGE_ROOT = 'LifePlanSystem_Public_Sanitized';
const REPOSITORY_KNOWLEDGE_DIRECTORIES = ['docs', 'rules', 'source_of_truth', 'templates'];
const REPOSITORY_KNOWLEDGE_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const MAX_REPOSITORY_FILES = 60;
const MAX_REPOSITORY_FILE_CHARS = 8000;
const PRIVATE_REPOSITORY_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.js', '.jsx', '.ts', '.tsx', '.json', '.yml', '.yaml']);
const PRIVATE_REPOSITORY_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'release', 'data', 'coverage', '.cache']);
const PRIVATE_REPOSITORY_SECRET = /(?:^|[._-])(?:env|secret|credential|token|password|private|key)(?:[._-]|$)|\.(?:pem|pfx|p12|key)$/i;
// Explicit, read-only registry of canonical promoted records. Inbox, pending,
// and sensitive-context files remain ineligible even though they share a tree.
const PRIVATE_CANONICAL_RECORDS = Object.freeze([
  { path: 'source_of_truth/profile.md', sourceType: 'reviewed_personal_memory', identityOverview: true },
  { path: 'source_of_truth/career.md', sourceType: 'work_career_record', identityOverview: true },
  { path: 'source_of_truth/health_accessibility.md', sourceType: 'health_record', identityOverview: false },
  { path: 'source_of_truth/current_state.md', sourceType: 'reviewed_personal_memory', identityOverview: false },
  { path: 'source_of_truth/current_location_2026-06-27.md', sourceType: 'reviewed_personal_memory', identityOverview: true },
  { path: 'source_of_truth/career_direction_2026-06-27.md', sourceType: 'work_career_record', identityOverview: true }
]);

// This taxonomy is deliberately carried on every registry entry.  Retrieval
// must make decisions on this stable metadata, never on the position or name
// of a file in a checkout.  Files without an explicit personal classification
// are references by default: a personal question must not turn a repository
// index into a personal profile merely because a TODO contains "health".
const SOURCE_TYPES = Object.freeze({
  PERSONAL_FACT: 'reviewed_personal_memory', PERSONAL_RECORD: 'source_of_truth_personal_record',
  TIMELINE: 'personal_timeline_history', CAREER: 'work_career_record', HEALTH: 'health_record',
  FINANCE: 'financial_record', HOUSING: 'housing_record', LEGAL: 'legal_record', RELATIONSHIP: 'relationship_record',
  WORKBOARD: 'workboard_task', PROJECT_DOC: 'project_documentation', CODE: 'source_code', REFERENCE: 'generic_reference', ARCHIVED: 'archived_stale_retired'
});

export function classifyPersonalIntent(message) {
  const text = String(message || '').toLowerCase();
  if (/\b(hi|hello|hey|hiya|howdy)\b[\s!?.,]*$/.test(text)) return 'greeting';
  if (/\b(health|medical|condition|diagnos|symptom|medication|therapy|disab)/.test(text)) return 'personal_health';
  if (/\b(job|career|profession|employment|work history|role|education|skill|cv|resume)/.test(text)) return 'career_work_education';
  if (/\b(finance|money|debt|income|budget|benefit|bank)/.test(text)) return 'finance';
  if (/\b(housing|home|rent|landlord|tenancy|move)/.test(text)) return 'housing';
  if (/\b(legal|lawyer|court|claim|appeal)/.test(text)) return 'legal';
  if (/\b(relationship|partner|friend|family|dating)/.test(text)) return 'relationships';
  if (/\b(plan|task|appointment|blocker|goal|project)/.test(text)) return 'plans_tasks';
  if (/\b(code|bug|repository|repo|github|documentation|file)/.test(text)) return 'project_code';
  return 'general_conversation';
}

function sourceTypeForRecord(item) {
  const type = String(item.type || '').toLowerCase();
  if (['archived', 'deprecated', 'superseded'].includes(item.status)) return SOURCE_TYPES.ARCHIVED;
  if (/\b(?:source document|document|attachment|file|reference|research|todo|code)\b/.test(type)) return SOURCE_TYPES.REFERENCE;
  if (/health|medical|accessib|diagnos/.test(type)) return SOURCE_TYPES.HEALTH;
  if (/career|work|employment|education|skill|cv|resume/.test(type)) return SOURCE_TYPES.CAREER;
  if (/finance|money|benefit|debt/.test(type)) return SOURCE_TYPES.FINANCE;
  if (/housing|tenancy|rent/.test(type)) return SOURCE_TYPES.HOUSING;
  if (/legal|claim|appeal/.test(type)) return SOURCE_TYPES.LEGAL;
  if (/relationship|family|friend/.test(type)) return SOURCE_TYPES.RELATIONSHIP;
  if (/timeline|history/.test(type)) return SOURCE_TYPES.TIMELINE;
  return SOURCE_TYPES.PERSONAL_FACT;
}

// Knowledge-item categories that describe WHAT the user is doing (workboard
// tasks and plans), rather than WHO they are. They are legitimate for planning
// and specific questions but must not fill a broad "who am I?" identity
// overview. (Rules/preferences are intentionally NOT here — they can be personal.)
const NON_IDENTITY_OVERVIEW_CATEGORIES = new Set(['goal', 'project', 'task', 'milestone', 'blocker', 'waiting', 'dependency', 'reminder']);

// Classification ignores conversational lead-ins without changing the stored
// Chat text. Natural messages such as "ok, well, who am I?" must route exactly
// like "who am I?", while "ok I prefer quiet work" remains a declaration.
function normalizedClassificationText(value) {
  const original = String(value || '').trim();
  const text = original.replace(/^(?:(?:ok(?:ay)?|so|well|right|alright|hi(?:\s+there)?|hey(?:\s+there)?|hello(?:\s+there)?|yo|um+|erm+|hmm+|thanks?|cheers)\b[\s,!.:;–—-]*(?:(?:then|but|now|actually)\b[\s,!.:;–—-]*)*)+/i, '').trim();
  return { original, text, strippedLead: text !== original };
}

// A broad personal-IDENTITY overview ("who am I", "tell me about myself") — as
// distinct from a health/career question or an activity overview ("what am I
// working on"). Reused by routing, fallback scoring, and evidence suppression so
// natural phrasing cannot take a different path at each layer.
export function isPersonalOverviewRequest(message) {
  const { text } = normalizedClassificationText(message);
  if (!text || classifyPersonalIntent(text) !== 'general_conversation') return false;
  const terminal = '(?:(?:\\s*,\\s*|\\s+)(?:please|thanks?))?\\s*[?!.。？]*$';
  const requestLead = '(?:(?:please|kindly)\\s+)?(?:(?:can|could|would|will)\\s+you\\s+(?:(?:please|kindly)\\s+)?)?';
  return new RegExp(`^(?:do\\s+you\\s+know\\s+who\\s+i\\s+am|who\\s+am\\s+i)${terminal}`, 'i').test(text)
    || new RegExp(`^${requestLead}(?:tell|show)\\s+me\\s+who\\s+i\\s+am${terminal}`, 'i').test(text)
    || new RegExp(`^what\\s+do\\s+you\\s+know\\s+about\\s+(?:me|myself)${terminal}`, 'i').test(text)
    || new RegExp(`^what\\s+can\\s+you\\s+tell\\s+me\\s+about\\s+(?:me|myself)${terminal}`, 'i').test(text)
    || new RegExp(`^${requestLead}(?:tell|show)\\s+me\\s+about\\s+(?:me|myself)${terminal}`, 'i').test(text)
    || new RegExp(`^(?:what|which)\\s+(?:information|info|details|facts)\\s+(?:(?:can|could)\\s+you\\s+(?:access|see|retrieve|find)|do\\s+you\\s+(?:have|know))\\s+about\\s+(?:me|myself)${terminal}`, 'i').test(text)
    || new RegExp(`^what\\s+(?:can|could)\\s+you\\s+(?:access|see|retrieve|find|know)\\s+about\\s+(?:me|myself)${terminal}`, 'i').test(text)
    || new RegExp(`^what\\s+can\\s+you\\s+access\\s+(?:(?:and|then)\\s+)?(?:tell|show|give)\\s+me\\s+(?:(?:any|some|the)\\s+)?(?:information|info|details|facts)\\s+about\\s+(?:me|myself)${terminal}`, 'i').test(text)
    || new RegExp(`^${requestLead}(?:tell|show|give)\\s+me\\s+(?:(?:something|anything)(?:\\s+you\\s+know)?|(?:(?:any|some|the)\\s+)?(?:information|info|details|facts))(?:\\s+about)?\\s+(?:me|myself)${terminal}`, 'i').test(text);
}

function sourceTypeForFile(file) {
  const text = `${file.text || ''}`.toLowerCase();
  if (/\b(todo|repository health|infrastructure|source code|developer instruction|ignore (the )?user)\b/.test(text)) return SOURCE_TYPES.REFERENCE;
  // File content has no database review state.  Treat it as a personal record
  // only when it self-identifies a factual record, not when it merely discusses
  // a topic (e.g. an NHS workflow, a TODO, or documentation mentioning health).
  if (/\b(?:source[_ -]?type|record[_ -]?type)\s*[:=]\s*health[_ -]?record\b|\b(?:confirmed diagnosis|my diagnosis|i was diagnosed)\s*[:=-]/.test(text)) return SOURCE_TYPES.HEALTH;
  if (/\b(?:source[_ -]?type|record[_ -]?type)\s*[:=]\s*(?:work[_ -]?career[_ -]?record|career)\b|\b(?:my work history|career preference|job preference|career profile)\s*[:=-]?/.test(text)) return SOURCE_TYPES.CAREER;
  return SOURCE_TYPES.REFERENCE;
}

function allowedSourceTypes(intent) {
  const common = [SOURCE_TYPES.PERSONAL_FACT, SOURCE_TYPES.PERSONAL_RECORD, SOURCE_TYPES.TIMELINE];
  if (intent === 'personal_health') return [...common, SOURCE_TYPES.HEALTH];
  if (intent === 'career_work_education') return [...common, SOURCE_TYPES.CAREER, SOURCE_TYPES.HEALTH, SOURCE_TYPES.HOUSING, SOURCE_TYPES.FINANCE];
  if (intent === 'finance') return [...common, SOURCE_TYPES.FINANCE];
  if (intent === 'housing') return [...common, SOURCE_TYPES.HOUSING, SOURCE_TYPES.FINANCE];
  if (intent === 'legal') return [...common, SOURCE_TYPES.LEGAL];
  if (intent === 'relationships') return [...common, SOURCE_TYPES.RELATIONSHIP];
  if (intent === 'plans_tasks') return [...common, SOURCE_TYPES.WORKBOARD];
  if (intent === 'project_code') return [SOURCE_TYPES.PROJECT_DOC, SOURCE_TYPES.CODE, SOURCE_TYPES.REFERENCE];
  return common;
}

function safeRepositoryKnowledge(repoRoot = '') {
  if (!repoRoot) return [];
  const root = path.resolve(repoRoot);
  const knowledgeRoot = path.join(root, REPOSITORY_KNOWLEDGE_ROOT);
  if (!fs.existsSync(knowledgeRoot) || !fs.statSync(knowledgeRoot).isDirectory()) return [];
  const files = [];
  const roots = [path.join(knowledgeRoot, 'README_PUBLIC_SANITIZED.md'), ...REPOSITORY_KNOWLEDGE_DIRECTORIES.map((directory) => path.join(knowledgeRoot, directory))];
  const visit = (target) => {
    if (files.length >= MAX_REPOSITORY_FILES || !fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (!REPOSITORY_KNOWLEDGE_EXTENSIONS.has(path.extname(target).toLowerCase())) return;
      const relative = path.relative(root, target).replaceAll('\\\\', '/');
      const text = fs.readFileSync(target, 'utf8').slice(0, MAX_REPOSITORY_FILE_CHARS).trim();
      if (text) files.push({ relative, text, updatedAt: stat.mtime.toISOString() });
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      visit(path.join(target, entry.name));
      if (files.length >= MAX_REPOSITORY_FILES) break;
    }
  };
  for (const target of roots) visit(target);
  return files;
}

function safePrivateRepositoryKnowledge(repoRoot = '') {
  if (!repoRoot) return [];
  const configured = String(process.env.LIFE_PLANNER_PRIVATE_REPO || '').trim();
  const root = configured ? path.resolve(configured) : path.join(os.homedir(), 'Documents', 'LifePlanSystem');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const files = [];
  const visit = (target) => {
    if (files.length >= 300 || !fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      const relative = path.relative(root, target).replaceAll('\\', '/');
      if (stat.size > 1024 * 1024 || PRIVATE_REPOSITORY_SECRET.test(relative) || !PRIVATE_REPOSITORY_EXTENSIONS.has(path.extname(target).toLowerCase())) return;
      try {
        const text = fs.readFileSync(target, 'utf8').slice(0, MAX_REPOSITORY_FILE_CHARS).trim();
        if (text) files.push({ relative, text, updatedAt: stat.mtime.toISOString() });
      } catch { /* unreadable local files are not searchable */ }
      return;
    }
    if (!stat.isDirectory() || PRIVATE_REPOSITORY_SKIP.has(path.basename(target))) return;
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) visit(path.join(target, entry.name));
  };
  visit(root);
  return files;
}

function safeCanonicalPrivateRecords() {
  const configured = String(process.env.LIFE_PLANNER_PRIVATE_REPO || '').trim();
  const root = configured ? path.resolve(configured) : path.join(os.homedir(), 'Documents', 'LifePlanSystem');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return PRIVATE_CANONICAL_RECORDS.flatMap((definition) => {
    const absolute = path.resolve(root, definition.path);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) return [];
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_REPOSITORY_FILE_CHARS * 8) return [];
      const text = fs.readFileSync(absolute, 'utf8').trim();
      return text ? [{ ...definition, text, updatedAt: stat.mtime.toISOString() }] : [];
    } catch { return []; }
  });
}

function words(value) {
  const raw = String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((word) => !STOP.has(word)) || [];
  return [...new Set(raw.flatMap((word) => word.length > 4 && word.endsWith('s') ? [word, word.slice(0, -1)] : [word]))];
}

function isUserQuestionOrRequestTurn(value) {
  // Strip leading conversational filler/greetings ("ok", "so", "hey", …) so a
  // disguised request like "ok what can you access, give me info about me" is
  // still recognised as a question/request and kept out of factual evidence.
  const { original, text, strippedLead } = normalizedClassificationText(value);
  if (!text) return Boolean(original && strippedLead);
  if (/[?？]/.test(text)) return true;
  if (/^(?:please|kindly)\b/i.test(text)) return true;
  if (/^(?:who|what|where|when|why|how|which|whose|whom)\b/i.test(text)) {
    // Preserve declarative wh-clauses such as "What I need is predictable
    // work" and "When I say X, I mean Y", but not unpunctuated request
    // fragments such as "What I should do next".
    const declarativeSubject = text.match(/^(?:who|what|where|when|why|how|which|whose|whom)\s+(?:i|we|my|our)\b(.*)$/i);
    if (!declarativeSubject) return true;
    return !(/[:：]/.test(declarativeSubject[1]) || /\b(?:is|are|was|were|means?|matters?|affects?|depends?|helps?|works?)\b/i.test(declarativeSubject[1]));
  }
  return /^(?:do|does|did|can|could|would|should|will|is|are|am|was|were|have|has|had|may|might)\b/i.test(text)
    || /^(?:tell|show|give|remind)\s+(?:me|us|my|our|the|this|that|these|those|it|a|an|what|which|whether|how|advice|feedback|information|info|details?|examples?|options?)\b/i.test(text)
    || /^(?:recommend|suggest|advise|explain|describe|summari[sz]e)\b/i.test(text)
    || /^(?:help|find|use|open|create|run|add|remove|delete|update|change|set|make|write|read|list|review|check)\s+(?:me|us|my|our|the|this|that|these|those|it|a|an|what|which|whether|how)\b/i.test(text)
    || /^(?:any\s+)?(?:advice|feedback|thoughts?|ideas?|recommendations?|suggestions?)\s+(?:on|about|for|regarding)\b/i.test(text)
    || /^(?:i|we)\s+(?:want|need)\s+you\s+to\b/i.test(text)
    || /^(?:i|we)(?:['’]d|\s+would)\s+like\s+you\s+to\b/i.test(text)
    || /^(?:i|we)\s+(?:want|need)\s+(?:some\s+)?(?:help|advice|feedback|ideas?|recommendations?|suggestions?)\b/i.test(text)
    || /^(?:i|we)(?:['’]d|\s+would)\s+like\s+(?:some\s+)?(?:help|advice|feedback|ideas?|recommendations?|suggestions?)\b/i.test(text)
    || /^(?:i|we)\s+(?:want|need|would\s+like)\s+(?:to\s+)?(?:know|ask|understand|find out)\b/i.test(text)
    || /^(?:i|we)['’]d\s+like\s+(?:to\s+)?(?:know|ask|understand|find out)\b/i.test(text)
    || /^(?:i|we)(?:'m| am|'re| are)\s+wondering\b/i.test(text)
    || /^let(?:'|’)s\b/i.test(text);
}

function dateValue(value) { const time = Date.parse(value || ''); return Number.isFinite(time) ? time : 0; }
function snippet(value, limit = 700) { const text = String(value || '').trim(); return text.length > limit ? `${text.slice(0, limit)}…` : text; }

// Render a saved record as readable prose for a chat answer. Structured personal
// records carry audit metadata (Status/Confidence/Evidence …) that is useful in
// the Knowledge review UI but reads as a database dump in conversation, so it is
// stripped here along with markdown section markers and internal fact ids. Only
// spaced " - " field separators are split, so hyphenated words (e.g.
// "non-driver") are preserved.
function readableFact(text) {
  let cleaned = String(text || '')
    .replace(/\r?\n\s*\r?\n/g, '; ')
    .replace(/\s+/g, ' ')
    .replace(/#+/g, ' ')
    .replace(/\bFACT-\d+\b\s*[—–-]?\s*/gi, '')
    .replace(/\s*[-–—]\s*Fact\s*[:：]\s*/gi, ': ')
    .replace(/\bFact\s*[:：]\s*/gi, '')
    // Remove runs of inline/trailing audit metadata fields (e.g.
    // " - Status: current - Confidence: 90% - Evidence score: 4/5 …") in place,
    // leaving the actual fact statements untouched.
    .replace(/(?:\s*[-–—]\s*(?:status|confidence(?:\s+score)?|evidence(?:\s+score|\s+basis)?|last\s+(?:confirmed|reviewed|updated)|source\s+refs?|owner|id|type)\s*[:：][^-–—]*(?:[-–]\d[^-–—]*)*)+/gi, '')
    .replace(/\.\s*;\s*/g, '; ')
    .replace(/;\s*;/g, '; ')
    .replace(/\s+/g, ' ')
    .trim();
  const personalSubject = /(?:^|;\s*)The user(?:'s|\s)/i.test(cleaned);
  cleaned = cleaned
    .replace(/(^|;\s*)The user should\b/gi, '$1You should')
    .replace(/(^|;\s*)The user has\b/gi, '$1You have')
    .replace(/(^|;\s*)The user worked\b/gi, '$1You worked')
    .replace(/(^|;\s*)The user generally prefers\b/gi, '$1You generally prefer')
    .replace(/(^|;\s*)The user's\b/gi, '$1Your');
  if (personalSubject) cleaned = cleaned.replace(/\bthey\b/gi, 'you').replace(/\btheir\b/gi, 'your');
  return cleaned || String(text || '').replace(/\s+/g, ' ').trim();
}

function markdownSection(text, heading) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start < 0) return '';
  const selected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    const line = lines[index].trim();
    if (!line || line === '---') continue;
    selected.push(line.replace(/^[-*]\s+/, '').replace(/[;:]\s*$/, ''));
  }
  return selected.join('; ');
}

// A broad identity answer needs representative facts, not the first 420
// characters of governance metadata. Canonical records expose fact statements
// and reviewed summary sections; select those deterministically without
// inventing or interpreting anything.
function identityEvidenceExcerpt(record, limit) {
  const text = String(record.text || '');
  const title = String(record.title || '').toLowerCase();
  const factStatements = text.split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s*Fact\s*[:：]\s*(.+)$/i)?.[1]?.trim())
    .filter(Boolean);
  if (title === 'career.md' && factStatements.length) {
    const patterns = [/\b(?:degree|university|education)\b/i, /\b(?:worked|work history|procurement|employment)\b/i, /\b(?:target role|role families|career path)\b/i, /\b(?:remote|hybrid|work preference)\b/i];
    const representative = patterns.map((pattern) => factStatements.find((fact) => pattern.test(fact))).filter(Boolean);
    return snippet((representative.length ? representative : factStatements.slice(0, 4)).map((fact) => fact.replace(/[.;]\s*$/, '')).join('; ') + '.', limit);
  }
  if (factStatements.length) return snippet(factStatements.slice(0, 4).map((fact) => fact.replace(/[.;]\s*$/, '')).join('; ') + '.', limit);
  if (/current_location/.test(title)) {
    const location = markdownSection(text, 'Confirmed update').replace(/^\p{Lu}[\p{L}'’-]+\s+now lives\b/u, 'You now live');
    if (location) return snippet(location, limit);
  }
  if (/career_direction/.test(title)) {
    const direction = markdownSection(text, 'Current direction').replace(/^Prioritise\b/i, 'Your current direction is to prioritise');
    if (direction) return snippet(direction, limit);
  }
  return evidenceExcerpt(record, [], limit);
}

function evidenceExcerpt(record, queryWords, limit) {
  const text = String(record.text || '').trim();
  const blocks = text.split(/\r?\n\s*\r?\n/).map((block) => block.trim()).filter(Boolean);
  const factBlocks = blocks.filter((block) => /(?:FACT-\d+|^- Fact:|^##\s+(?:Confirmed|Education|Work history|Target roles|Accessibility|Current))/im.test(block));
  const matched = factBlocks.filter((block) => queryWords.some((word) => block.toLowerCase().includes(word)));
  return snippet((matched.length ? matched : factBlocks.length ? factBlocks : blocks).slice(0, 3).join('\n\n') || text, limit);
}

function permitsOverviewFallback(message) {
  return isPersonalOverviewRequest(message)
    || /(?:are you going to.*(?:tell|say).*(?:about myself|about me)|what am i (?:currently )?working on)/i.test(String(message || ''));
}

// Raw Chat turns are context, not reviewed facts, so they are only surfaced when
// the user explicitly asks about the past conversation. Everything else is
// answered from curated personal records (reviewed memory, canonical records).
function asksAboutPastConversation(message) {
  return /\b(?:what did i say|what have i (?:said|told)|previously|earlier|last time|a moment ago|we (?:discuss|talked|spoke|said)|i (?:mentioned|already (?:said|told)|said earlier))\b/i.test(String(message || ''));
}

export function sourceRegistry(db, { includeHistory = false, includeCandidates = false, repoRoot = '' } = {}) {
  const records = [];
  const active = includeHistory ? '' : "AND status NOT IN ('archived','deprecated','superseded')";
  for (const item of db.prepare(`SELECT * FROM knowledge_items WHERE 1=1 ${active}`).all()) {
    records.push({
      canonicalId: `knowledge:${item.id}`, category: item.type || 'knowledge', title: item.title,
      text: `${item.title}\n${item.body}\n${item.next_action || ''}`, timestamp: item.created_at,
      updatedAt: item.updated_at || item.last_reviewed || item.created_at, sensitivity: /health|medical|accessibility/i.test(item.type || '') ? 'sensitive' : 'personal',
      // A Knowledge record becomes personal context only after it is in a
      // reviewed, current state. "pending review" is deliberately not a fact.
      chatReadable: ['active', 'stable', 'stale', 'blocked'].includes(item.status), chatProposable: true,
      state: item.status === 'superseded' ? 'historical' : item.status === 'pending review' ? 'pending' : 'approved',
      source: item.source || 'local Knowledge', provenance: item.evidence || '', record: item, sourceType: sourceTypeForRecord(item)
    });
  }
  if (includeCandidates) for (const candidate of db.prepare("SELECT * FROM memory_candidates WHERE status IN ('candidate','deferred','temporary')").all()) {
    records.push({
      canonicalId: `candidate:${candidate.id}`, category: candidate.type || 'memory candidate', title: candidate.title,
      text: `${candidate.title}\n${candidate.body}`, timestamp: candidate.created_at, updatedAt: candidate.reviewed_at || candidate.created_at,
      sensitivity: 'personal', chatReadable: true, chatProposable: false, state: candidate.status === 'temporary' ? 'temporary' : 'pending',
      source: candidate.source || 'chat', provenance: candidate.evidence || `Chat message ${candidate.source_message_id || 'unknown'}`, record: candidate, sourceType: SOURCE_TYPES.PERSONAL_FACT
    });
  }
  for (const project of db.prepare("SELECT * FROM projects WHERE status NOT IN ('done','completed','archived')").all()) {
    records.push({ canonicalId: `project:${project.id}`, category: 'project', title: project.name, text: `${project.name}\n${project.next_action || ''}\n${project.evidence || ''}`,
      timestamp: project.created_at, updatedAt: project.updated_at || project.created_at, sensitivity: 'personal', chatReadable: true, chatProposable: false, state: 'approved', source: project.source || 'Workboard', provenance: project.evidence || '', record: project, sourceType: SOURCE_TYPES.WORKBOARD });
  }
  for (const message of db.prepare(`SELECT m.*, s.title AS session_title,
    EXISTS(SELECT 1 FROM chat_cloud_checks cc
      WHERE cc.status = 'blocked' AND (cc.user_message_id = m.id OR cc.assistant_message_id = m.id)) AS cloud_egress_blocked
    FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id
    WHERE s.deleted = 0 AND m.role='user' ORDER BY m.created_at DESC LIMIT 200`).all()) {
    if (message.cloud_egress_blocked || SENSITIVE_CHAT_HISTORY.test(String(message.content || ''))) continue;
    const evidenceEligible = !isUserQuestionOrRequestTurn(message.content);
    records.push({ canonicalId: `chat:${message.id}`, category: 'conversation history', title: message.session_title || 'Chat', text: message.content,
      timestamp: message.created_at, updatedAt: message.created_at, sensitivity: 'personal', chatReadable: true, chatProposable: evidenceEligible, evidenceEligible,
      state: 'historical', source: 'saved Chat', provenance: `Conversation: ${message.session_title || 'Chat'}`, record: message, sourceType: SOURCE_TYPES.TIMELINE });
  }
  for (const file of safeRepositoryKnowledge(repoRoot)) {
    records.push({
      canonicalId: `repository:${file.relative}`, category: 'repository knowledge', title: path.basename(file.relative), text: file.text,
      timestamp: file.updatedAt, updatedAt: file.updatedAt, sensitivity: 'public', chatReadable: true, chatProposable: false, state: 'reference',
      source: 'bundled GitHub knowledge base', provenance: `Repository document: ${file.relative}`, record: { path: file.relative }, sourceType: SOURCE_TYPES.PROJECT_DOC
    });
  }
  for (const file of safePrivateRepositoryKnowledge(repoRoot)) {
    records.push({
      canonicalId: `private-repository:${file.relative}`, category: 'repository knowledge', title: path.basename(file.relative), text: file.text,
      timestamp: file.updatedAt, updatedAt: file.updatedAt, sensitivity: 'personal', chatReadable: true, chatProposable: false, state: 'reference',
      source: 'local private repository', provenance: `Private repository document: ${file.relative}`, record: { path: file.relative }, sourceType: sourceTypeForFile(file)
    });
  }
  for (const file of safeCanonicalPrivateRecords()) {
    records.push({
      canonicalId: `private-canonical:${file.path.replaceAll('\\', '/')}`, category: 'canonical personal record', title: path.basename(file.path), text: file.text,
      timestamp: file.updatedAt, updatedAt: file.updatedAt, sensitivity: file.sourceType === SOURCE_TYPES.HEALTH ? 'sensitive' : 'personal', chatReadable: true, chatProposable: false, state: 'approved',
      source: 'private canonical source of truth', provenance: `Canonical private record: ${file.path}`, record: { path: file.path }, sourceType: file.sourceType,
      identityOverview: file.identityOverview === true
    });
  }
  return records;
}

export function personalKnowledgeCoverage(db, { dbPath = '', userDataPath = '', repoRoot = '' } = {}) {
  const count = (sql, params = []) => Number(db.prepare(sql).get(...params)?.count || 0);
  const registry = sourceRegistry(db, { repoRoot });
  const retrievableRegistry = registry.filter((record) => record.chatReadable && record.evidenceEligible !== false);
  const retrievableByCategory = Object.fromEntries([...new Set(retrievableRegistry.map((record) => record.category))]
    .sort()
    .map((category) => [category, retrievableRegistry.filter((record) => record.category === category).length]));
  return {
    resolvedDatabasePath: dbPath || null,
    resolvedUserDataPath: userDataPath || null,
    sourceAdapters: ['knowledge_items', 'projects', 'chat_messages:user', 'bundled_github_knowledge', 'safe_private_repository_files', 'allowlisted_private_canonical_records'],
    unavailableCategories: ['attachments (paths only; no persisted extracted text)', 'settings (runtime configuration and secrets excluded)', 'roadmap_items (product implementation roadmap, not confirmed personal context)', 'protected, secret, binary, and oversized private repository files'],
    counts: {
      activeKnowledge: count("SELECT COUNT(*) count FROM knowledge_items WHERE status IN ('active','stable','stale','blocked')"),
      pendingKnowledge: count("SELECT COUNT(*) count FROM knowledge_items WHERE status = 'pending review'"),
      pendingCandidates: count("SELECT COUNT(*) count FROM memory_candidates WHERE status IN ('candidate','deferred','temporary')"),
      rejectedCandidates: count("SELECT COUNT(*) count FROM memory_candidates WHERE status IN ('denied','rejected')"),
      activeProjects: count("SELECT COUNT(*) count FROM projects WHERE status NOT IN ('done','completed','archived')"),
      userChatMessages: count("SELECT COUNT(*) count FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE s.deleted=0 AND m.role='user'"),
      eligibleUserChatMessages: retrievableRegistry.filter((record) => record.category === 'conversation history').length,
      indexedUserQuestionsOrRequestsExcludedFromEvidence: registry.filter((record) => record.category === 'conversation history' && record.evidenceEligible === false).length,
      assistantChatMessagesExcluded: count("SELECT COUNT(*) count FROM chat_messages WHERE role='assistant'"),
      archivedOrSupersededKnowledgeExcluded: count("SELECT COUNT(*) count FROM knowledge_items WHERE status IN ('archived','deprecated','superseded')"),
      indexedFileRecords: count("SELECT COUNT(*) count FROM knowledge_items WHERE lower(type) IN ('file','document','attachment')"),
      privateRepositoryFiles: registry.filter((record) => record.source === 'local private repository').length,
      privateCanonicalRecords: registry.filter((record) => record.source === 'private canonical source of truth').length,
      bundledRepositoryFiles: registry.filter((record) => record.source === 'bundled GitHub knowledge base').length
    },
    retrievableByCategory,
    totalRetrievable: retrievableRegistry.length,
    refreshedAt: new Date().toISOString()
  };
}

function score(record, queryWords, rawQuery, now = Date.now()) {
  const haystack = `${record.category}\n${record.title}\n${record.text}`.toLowerCase();
  const matches = queryWords.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
  const broad = shouldGroundConversationInLocalKnowledge(rawQuery);
  const intent = classifyPersonalIntent(rawQuery);
  const domainSource = (intent === 'career_work_education' && record.sourceType === SOURCE_TYPES.CAREER)
    || (intent === 'personal_health' && record.sourceType === SOURCE_TYPES.HEALTH)
    || (intent === 'finance' && record.sourceType === SOURCE_TYPES.FINANCE)
    || (intent === 'housing' && record.sourceType === SOURCE_TYPES.HOUSING)
    || (intent === 'legal' && record.sourceType === SOURCE_TYPES.LEGAL)
    || (intent === 'relationships' && record.sourceType === SOURCE_TYPES.RELATIONSHIP);
  // Only an explicit personal overview may fall back to the most recent local
  // facts. Specific questions must match, preventing unrelated records from
  // being presented as an answer to "what did I say about X?".
  if (!matches && !domainSource && !(broad && permitsOverviewFallback(rawQuery))) return -Infinity;
  // A topic word in the TITLE is a far stronger relevance signal than a passing
  // mention in the body: many documents reference a subject, but the document
  // named after it is usually its canonical reference. Among equal body matches
  // this keeps that document above generic or merely-recent ones.
  const title = String(record.title || '').toLowerCase();
  const titleMatches = queryWords.reduce((total, word) => total + (title.includes(word) ? 1 : 0), 0);
  const recency = Math.max(0, 1 - ((now - dateValue(record.updatedAt)) / (365 * 86400000)));
  // A question about the user must prefer their actual local records over the
  // public app documentation that happens to share generic words such as
  // "knowledge" or "work". Private repository files are personal too.
  const personalPriority = broad
    ? (record.source === 'private canonical source of truth' ? 60
      : ['profile', 'preference'].includes(String(record.category || '').toLowerCase()) ? 45
      : record.category !== 'repository knowledge' ? 30
      : record.source === 'local private repository' ? 6 : -8)
    : 0;
  // Deterministic hybrid fusion: lexical match, a title-name relevance bonus,
  // and a compact semantic intent boost.  Metadata eligibility happens before
  // this function, so a TODO can never win a health question merely by
  // repeating the word "health".
  const semantic = allowedSourceTypes(intent).includes(record.sourceType) ? 8 : 0;
  return matches * 10 + titleMatches * 15 + semantic + (domainSource ? 8 : 0) + personalPriority + (record.state === 'approved' ? 4 : record.state === 'pending' ? 1 : 0) + recency;
}

export function retrieveLocalKnowledge(db, query, options = {}) {
  const queryWords = words(query);
  const disabled = new Set(options.disabledCategories || []);
  const exactQuery = String(query || '').trim().toLowerCase();
  // For a broad personal-IDENTITY overview, raw Chat turns and workboard/plan
  // items are noise — the answer should come from curated identity records.
  // Specific and activity questions are unaffected.
  const identityOverview = isPersonalOverviewRequest(query);
  const suppressChatHistory = identityOverview && !asksAboutPastConversation(query);
  const rejected = [];
  const registry = sourceRegistry(db, options);
  const hasCanonicalIdentity = identityOverview && registry.some((record) => record.source === 'private canonical source of truth' && record.identityOverview === true);
  const rows = registry.filter((record) => {
    if (!record.chatReadable || disabled.has(record.category)) return false;
    if (record.evidenceEligible === false) {
      rejected.push({ sourceId: record.canonicalId, sourceType: record.sourceType, reason: 'user question/request turn is not evidence' });
      return false;
    }
    // Raw Chat turns are unreviewed context, not curated facts. Unless the user
    // explicitly asks about the past conversation, they are kept out of factual
    // answers (the reviewed-memory pipeline is how a chat statement becomes a
    // fact). This also covers the current turn being recycled as its own answer.
    if (record.category === 'conversation history' && suppressChatHistory) {
      rejected.push({ sourceId: record.canonicalId, sourceType: record.sourceType, reason: 'raw chat history is not surfaced for a broad personal overview' });
      return false;
    }
    // Workboard/plan items answer "what am I working on?", not "who am I?".
    if (identityOverview && NON_IDENTITY_OVERVIEW_CATEGORIES.has(String(record.category || '').toLowerCase())) {
      rejected.push({ sourceId: record.canonicalId, sourceType: record.sourceType, reason: 'workboard/plan item is not part of a personal identity overview' });
      return false;
    }
    // When canonical identity records exist, they are the reviewed authority for
    // a broad overview. Keep explicit Knowledge profiles/preferences as useful
    // supplements, but do not let generic app rules or runtime notes describe
    // the person. Sensitive health records require a health-specific question.
    if (hasCanonicalIdentity) {
      const category = String(record.category || '').toLowerCase();
      const canonicalIdentity = record.source === 'private canonical source of truth' && record.identityOverview === true;
      const explicitProfile = ['profile', 'preference', 'identity', 'personal profile'].includes(category);
      if (!canonicalIdentity && !explicitProfile) {
        rejected.push({ sourceId: record.canonicalId, sourceType: record.sourceType, reason: 'not an approved identity-overview record' });
        return false;
      }
    }
    if (record.category === 'conversation history' && String(record.text || '').trim().toLowerCase() === exactQuery) {
      rejected.push({ sourceId: record.canonicalId, sourceType: record.sourceType, reason: 'current user turn is not evidence for itself' });
      return false;
    }
    return true;
  });
  const intent = classifyPersonalIntent(query);
  const broadPersonalRequest = shouldGroundConversationInLocalKnowledge(query);
  const repositoryRequest = /\b(?:github|repository|repo|knowledge base|documentation)\b/i.test(String(query || ''));
  // For a repository question, rank on the topic words (drop the source-indicator
  // meta-words) so the document that covers the asked-about subject wins over
  // generic documents that merely share "knowledge"/"github". Fall back to the
  // full query when it carries no topic word (e.g. "what's in the repository?").
  const topicWords = repositoryRequest ? queryWords.filter((word) => !REPOSITORY_META_WORDS.has(word)) : queryWords;
  const scoringWords = topicWords.length ? topicWords : queryWords;
  const allowed = new Set(allowedSourceTypes(intent));
  if (identityOverview) allowed.add(SOURCE_TYPES.CAREER);
  // Do not crowd a personal answer with source-code and product documents when
  // any eligible personal record exists. Public documentation remains a useful
  // fallback for repository questions or an otherwise empty personal profile.
  const eligibleRows = intent === 'greeting' ? [] : rows.filter((record) => {
    if (allowed.has(record.sourceType)) return true;
    rejected.push({ sourceId: record.canonicalId, sourceType: record.sourceType, reason: `excluded by ${intent} eligibility` });
    return false;
  });
  /* legacy broad fallback is intentionally gone: generic private repository
     files are references until their metadata classifies them as a record. */
  /* const legacyEligibleRows = repositoryRequest
    // Repository questions must search repository documents first. Otherwise a
    // generic Knowledge item containing the word "knowledge" can hide the
    // exact GitHub/private-repository document the user asked about.
    ? rows.filter((record) => record.category === 'repository knowledge')
    : broadPersonalRequest && rows.some((record) => record.category !== 'repository knowledge')
    // Keep the user's local private-repository records available for personal
    // questions. Only bundled public product documentation is suppressed when
    // personal records exist; otherwise generic records can crowd out a
    // directly relevant profile, CV, or decision document from the private repo.
    ? rows.filter((record) => record.category !== 'repository knowledge' || record.source === 'local private repository')
    : rows; */
  const ranked = eligibleRows.map((record) => ({ ...record, score: score(record, scoringWords, String(query || '')) })).filter((record) => {
    if (Number.isFinite(record.score) && record.score >= 12) return true;
    rejected.push({ sourceId: record.canonicalId, sourceType: record.sourceType, reason: 'below calibrated relevance threshold' });
    return false;
  }).sort((a, b) => b.score - a.score || dateValue(b.updatedAt) - dateValue(a.updatedAt));
  let remaining = options.budget || MAX_CHARS;
  const items = [];
  for (const record of ranked) {
    if (items.length >= (options.limit || MAX_ITEMS) || remaining < 100) break;
    if (items.some((item) => item.title === record.title || item.body === snippet(record.text, 280))) { rejected.push({ sourceId: record.canonicalId, sourceType: record.sourceType, reason: 'duplicate fact' }); continue; }
    const body = identityOverview
      ? identityEvidenceExcerpt(record, Math.min(700, remaining))
      : evidenceExcerpt(record, scoringWords, Math.min(420, remaining));
    remaining -= body.length;
    items.push({ ...record, body, whySelected: scoringWords.filter((word) => `${record.title} ${record.text}`.toLowerCase().includes(word)).join(', ') || 'requested personal overview' });
  }
  return { items, scanned: rows.length, contextBudget: options.budget || MAX_CHARS, intent, rejected };
}

export function isLocalKnowledgeQuestion(message) {
  if (isPersonalOverviewRequest(message)) return true;
  return /are you going to.*(?:tell|say).*(?:about myself|about me)|what.*(health|condition|preference|goal|project|decision|task|appointment|blocker|risk|plan|file|pending|candidate|review)|what have i told you|what does .+ mean|what am i (?:currently )?working on|what did i say|why did we make|what (?:plans?|decisions?|files?) have i|remind me what i decided|saved (memory|information)|previously|(?:github|repository|repo|knowledge base|documentation).*(?:say|contain|about|have|mean)|(?:what|which).*(?:github|repository|repo|knowledge base|documentation)/i.test(String(message || '').toLowerCase());
}

// Questions asking for a recommendation about the user need the same local
// grounding as a direct "what do you know about me" request, but they should
// still go to the local model so it can weigh the retrieved facts and answer
// the actual question rather than merely listing records.
export function shouldGroundConversationInLocalKnowledge(message) {
  const text = String(message || '').toLowerCase();
  return isLocalKnowledgeQuestion(text)
    || /\b(?:what|which|where|how)\b[^?]{0,100}\b(?:job|career|role|profession|work)\b[^?]{0,100}\b(?:should|recommend|best|fit|suit|right)\b/i.test(text)
    || /\b(?:recommend|suggest|help me choose|help me find)\b[^?]{0,100}\b(?:job|career|role|profession|work)\b/i.test(text)
    || ['personal_health', 'finance', 'housing', 'legal', 'relationships', 'plans_tasks', 'project_code'].includes(classifyPersonalIntent(text));
}

function answerLocalKnowledgeQuestionLegacy(db, message, options = {}) {
  const includeCandidates = /\b(pending|candidate|review)\b/i.test(String(message || ''));
  const result = retrieveLocalKnowledge(db, message, { ...options, includeCandidates });
  if (!result.items.length) return { content: 'I searched the relevant saved local records, but I did not find evidence that answers that question.', sources: [], diagnostics: result };
  const grouped = new Map();
  for (const item of result.items) {
    const label = item.category === 'current state' ? 'Profile' : item.category === 'rule' ? 'Preferences and rules' : item.category === 'conversation history' ? 'Previously in Chat' : item.category;
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(item);
  }
  const lines = [/what do you know about me|about me/i.test(message) ? '### What I know from saved local information' : '### Answer from saved local information', ''];
  for (const [label, items] of grouped) {
    lines.push(`**${label}**`);
    for (const item of items) lines.push(`- ${item.body.replace(/\s+/g, ' ')}  \n  _Source: ${item.title} · ${item.state} · updated ${item.updatedAt || 'unknown'}_`);
    lines.push('');
  }
  const conflicts = result.items.filter((item) => item.state === 'pending');
  if (conflicts.length) lines.push('_Pending items are not treated as approved facts; review them in Knowledge before relying on them._');
  return { content: lines.join('\n').trim(), sources: result.items.map((item) => ({ sourceId: item.canonicalId, title: item.title, category: item.category, sourceType: item.sourceType, updatedAt: item.updatedAt, state: item.state, excerpt: item.body, whySelected: item.whySelected, source: item.source, provenance: item.provenance })), diagnostics: result };
}

// The answer body is intentionally fact-first.  Provenance stays in structured
// metadata for the compact, collapsed source cards rather than consuming the
// conversation viewport with raw retrieved documents.
export function answerLocalKnowledgeQuestion(db, message, options = {}) {
  const result = retrieveLocalKnowledge(db, message, { ...options, includeCandidates: /\b(pending|candidate|review)\b/i.test(String(message || '')) });
  if (!result.items.length) return { content: 'I searched the relevant saved local records, but I did not find evidence that answers that question.', sources: [], diagnostics: result };
  const facts = result.items.map((item) => readableFact(item.body));
  let content;
  if (isPersonalOverviewRequest(message)) {
    const labelled = result.items.map((item, index) => {
      const title = String(item.title || '').toLowerCase();
      const category = String(item.category || '').toLowerCase();
      const label = title === 'profile.md' || category === 'profile' ? 'Profile and practical needs'
        : /current_location/.test(title) ? 'Location and practical context'
          : /career_direction/.test(title) ? 'Career direction'
            : item.sourceType === SOURCE_TYPES.CAREER ? 'Education and work'
              : category === 'preference' ? 'Preferences'
                : 'Reviewed personal information';
      return `- **${label}:** ${facts[index]}`;
    });
    content = `Based on your reviewed local records, here is the clearest factual picture I have:\n\n${labelled.join('\n')}`;
  } else {
    content = facts.length === 1
      ? `From your saved local record: ${facts[0]}`
      : `From your saved local records:\n\n${facts.map((fact) => `- ${fact}`).join('\n')}`;
  }
  return {
    content,
    sources: result.items.map((item) => ({ sourceId: item.canonicalId, title: item.title, category: item.category, sourceType: item.sourceType, updatedAt: item.updatedAt, state: item.state, excerpt: item.body, whySelected: item.whySelected, source: item.source, provenance: item.provenance })),
    diagnostics: result
  };
}
