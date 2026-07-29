import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deterministic, local-only Knowledge retrieval. This is deliberately
// structured-search first: no embeddings, network calls, or hidden database
// dump. Every returned item includes human-readable provenance.

const MAX_ITEMS = 10;
const MAX_CHARS = 4200;
const STOP = new Set(['what', 'does', 'about', 'have', 'that', 'this', 'with', 'from', 'your', 'know', 'said', 'tell', 'life', 'planner', 'user']);
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

function words(value) {
  const raw = String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((word) => !STOP.has(word)) || [];
  return [...new Set(raw.flatMap((word) => word.length > 4 && word.endsWith('s') ? [word, word.slice(0, -1)] : [word]))];
}

function dateValue(value) { const time = Date.parse(value || ''); return Number.isFinite(time) ? time : 0; }
function snippet(value, limit = 700) { const text = String(value || '').trim(); return text.length > limit ? `${text.slice(0, limit)}…` : text; }

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
      source: item.source || 'local Knowledge', provenance: item.evidence || '', record: item
    });
  }
  if (includeCandidates) for (const candidate of db.prepare("SELECT * FROM memory_candidates WHERE status IN ('candidate','deferred','temporary')").all()) {
    records.push({
      canonicalId: `candidate:${candidate.id}`, category: candidate.type || 'memory candidate', title: candidate.title,
      text: `${candidate.title}\n${candidate.body}`, timestamp: candidate.created_at, updatedAt: candidate.reviewed_at || candidate.created_at,
      sensitivity: 'personal', chatReadable: true, chatProposable: false, state: candidate.status === 'temporary' ? 'temporary' : 'pending',
      source: candidate.source || 'chat', provenance: candidate.evidence || `Chat message ${candidate.source_message_id || 'unknown'}`, record: candidate
    });
  }
  for (const project of db.prepare("SELECT * FROM projects WHERE status NOT IN ('done','completed','archived')").all()) {
    records.push({ canonicalId: `project:${project.id}`, category: 'project', title: project.name, text: `${project.name}\n${project.next_action || ''}\n${project.evidence || ''}`,
      timestamp: project.created_at, updatedAt: project.updated_at || project.created_at, sensitivity: 'personal', chatReadable: true, chatProposable: false, state: 'approved', source: project.source || 'Workboard', provenance: project.evidence || '', record: project });
  }
  for (const message of db.prepare(`SELECT m.*, s.title AS session_title,
    EXISTS(SELECT 1 FROM chat_cloud_checks cc
      WHERE cc.status = 'blocked' AND (cc.user_message_id = m.id OR cc.assistant_message_id = m.id)) AS cloud_egress_blocked
    FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id
    WHERE s.deleted = 0 AND m.role='user' ORDER BY m.created_at DESC LIMIT 200`).all()) {
    if (message.cloud_egress_blocked || SENSITIVE_CHAT_HISTORY.test(String(message.content || ''))) continue;
    records.push({ canonicalId: `chat:${message.id}`, category: 'conversation history', title: message.session_title || 'Chat', text: message.content,
      timestamp: message.created_at, updatedAt: message.created_at, sensitivity: 'personal', chatReadable: true, chatProposable: true, state: 'historical', source: 'saved Chat', provenance: `Conversation: ${message.session_title || 'Chat'}`, record: message });
  }
  for (const file of safeRepositoryKnowledge(repoRoot)) {
    records.push({
      canonicalId: `repository:${file.relative}`, category: 'repository knowledge', title: path.basename(file.relative), text: file.text,
      timestamp: file.updatedAt, updatedAt: file.updatedAt, sensitivity: 'public', chatReadable: true, chatProposable: false, state: 'reference',
      source: 'bundled GitHub knowledge base', provenance: `Repository document: ${file.relative}`, record: { path: file.relative }
    });
  }
  for (const file of safePrivateRepositoryKnowledge(repoRoot)) {
    records.push({
      canonicalId: `private-repository:${file.relative}`, category: 'repository knowledge', title: path.basename(file.relative), text: file.text,
      timestamp: file.updatedAt, updatedAt: file.updatedAt, sensitivity: 'personal', chatReadable: true, chatProposable: false, state: 'reference',
      source: 'local private repository', provenance: `Private repository document: ${file.relative}`, record: { path: file.relative }
    });
  }
  return records;
}

export function personalKnowledgeCoverage(db, { dbPath = '', userDataPath = '', repoRoot = '' } = {}) {
  const count = (sql, params = []) => Number(db.prepare(sql).get(...params)?.count || 0);
  const registry = sourceRegistry(db, { repoRoot });
  const retrievableByCategory = Object.fromEntries([...new Set(registry.map((record) => record.category))]
    .sort()
    .map((category) => [category, registry.filter((record) => record.category === category).length]));
  return {
    resolvedDatabasePath: dbPath || null,
    resolvedUserDataPath: userDataPath || null,
    sourceAdapters: ['knowledge_items', 'projects', 'chat_messages:user', 'bundled_github_knowledge', 'safe_private_repository_files'],
    unavailableCategories: ['attachments (paths only; no persisted extracted text)', 'settings (runtime configuration and secrets excluded)', 'roadmap_items (product implementation roadmap, not confirmed personal context)', 'protected, secret, binary, and oversized private repository files'],
    counts: {
      activeKnowledge: count("SELECT COUNT(*) count FROM knowledge_items WHERE status IN ('active','stable','stale','blocked')"),
      pendingKnowledge: count("SELECT COUNT(*) count FROM knowledge_items WHERE status = 'pending review'"),
      pendingCandidates: count("SELECT COUNT(*) count FROM memory_candidates WHERE status IN ('candidate','deferred','temporary')"),
      rejectedCandidates: count("SELECT COUNT(*) count FROM memory_candidates WHERE status IN ('denied','rejected')"),
      activeProjects: count("SELECT COUNT(*) count FROM projects WHERE status NOT IN ('done','completed','archived')"),
      userChatMessages: count("SELECT COUNT(*) count FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE s.deleted=0 AND m.role='user'"),
      assistantChatMessagesExcluded: count("SELECT COUNT(*) count FROM chat_messages WHERE role='assistant'"),
      archivedOrSupersededKnowledgeExcluded: count("SELECT COUNT(*) count FROM knowledge_items WHERE status IN ('archived','deprecated','superseded')"),
      indexedFileRecords: count("SELECT COUNT(*) count FROM knowledge_items WHERE lower(type) IN ('file','document','attachment')")
    },
    retrievableByCategory,
    totalRetrievable: registry.length,
    refreshedAt: new Date().toISOString()
  };
}

function score(record, queryWords, rawQuery, now = Date.now()) {
  const haystack = `${record.category}\n${record.title}\n${record.text}`.toLowerCase();
  const matches = queryWords.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
  const broad = /what do you know|about me|about myself|tell me (?:something )?about (?:myself|me)|profile|preferences|health|goals|projects|decisions|tasks|overdue|what am i (?:currently )?working on/i.test(rawQuery);
  if (!matches && !broad) return -Infinity;
  const recency = Math.max(0, 1 - ((now - dateValue(record.updatedAt)) / (365 * 86400000)));
  return matches * 10 + (record.state === 'approved' ? 4 : record.state === 'pending' ? 1 : 0) + recency;
}

export function retrieveLocalKnowledge(db, query, options = {}) {
  const queryWords = words(query);
  const disabled = new Set(options.disabledCategories || []);
  const exactQuery = String(query || '').trim().toLowerCase();
  const rows = sourceRegistry(db, options).filter((record) => record.chatReadable
    && !disabled.has(record.category)
    // The just-saved user prompt must not be recycled as evidence for itself.
    && !(record.category === 'conversation history' && String(record.text || '').trim().toLowerCase() === exactQuery));
  const ranked = rows.map((record) => ({ ...record, score: score(record, queryWords, String(query || '')) })).filter((record) => Number.isFinite(record.score)).sort((a, b) => b.score - a.score || dateValue(b.updatedAt) - dateValue(a.updatedAt));
  let remaining = options.budget || MAX_CHARS;
  const items = [];
  for (const record of ranked) {
    if (items.length >= (options.limit || MAX_ITEMS) || remaining < 100) break;
    const body = snippet(record.text, Math.min(700, remaining));
    remaining -= body.length;
    items.push({ ...record, body, whySelected: queryWords.filter((word) => `${record.title} ${record.text}`.toLowerCase().includes(word)).join(', ') || 'requested personal overview' });
  }
  return { items, scanned: rows.length, contextBudget: options.budget || MAX_CHARS };
}

export function isLocalKnowledgeQuestion(message) {
  return /what do you know about(?:\s+me)?(?:\s+|$)|tell me (?:something )?about (?:myself|me)|are you going to.*(?:tell|say).*(?:about myself|about me)|what.*(health|condition|preference|goal|project|decision|task|appointment|blocker|risk|plan|file|pending|candidate|review)|what have i told you|what does .+ mean|what am i working on|what did i say|why did we make|what (?:plans?|decisions?|files?) have i|remind me what i decided|saved (memory|information)|previously|(?:github|repository|repo|knowledge base|documentation).*(?:say|contain|about|have|mean)|(?:what|which).*(?:github|repository|repo|knowledge base|documentation)/i.test(String(message || '').toLowerCase());
}

export function answerLocalKnowledgeQuestion(db, message, options = {}) {
  const includeCandidates = /\b(pending|candidate|review)\b/i.test(String(message || ''));
  const result = retrieveLocalKnowledge(db, message, { ...options, includeCandidates });
  if (!result.items.length) return { content: 'I searched the active LPS records available to Chat, but I did not find a matching saved record.', sources: [] };
  const grouped = new Map();
  for (const item of result.items) {
    const label = item.category === 'current state' ? 'Profile' : item.category === 'rule' ? 'Preferences and rules' : item.category === 'conversation history' ? 'Previously in Chat' : item.category;
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(item);
  }
  const lines = [/what do you know about me|about me/i.test(message) ? '### What I know from saved local information' : '### Relevant saved local information', ''];
  for (const [label, items] of grouped) {
    lines.push(`**${label}**`);
    for (const item of items) lines.push(`- ${item.body.replace(/\s+/g, ' ')}  \n  _Source: ${item.title} · ${item.state} · updated ${item.updatedAt || 'unknown'}_`);
    lines.push('');
  }
  const conflicts = result.items.filter((item) => item.state === 'pending');
  if (conflicts.length) lines.push('_Pending items are not treated as approved facts; review them in Knowledge before relying on them._');
  return { content: lines.join('\n').trim(), sources: result.items.map((item) => ({ sourceId: item.canonicalId, title: item.title, category: item.category, updatedAt: item.updatedAt, state: item.state, whySelected: item.whySelected, source: item.source, provenance: item.provenance })) };
}
