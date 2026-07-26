// Deterministic, local-only Knowledge retrieval. This is deliberately
// structured-search first: no embeddings, network calls, or hidden database
// dump. Every returned item includes human-readable provenance.

const MAX_ITEMS = 10;
const MAX_CHARS = 4200;
const STOP = new Set(['what', 'does', 'about', 'have', 'that', 'this', 'with', 'from', 'your', 'know', 'said', 'tell', 'life', 'planner', 'user']);

function words(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((word) => !STOP.has(word)) || [])];
}

function dateValue(value) { const time = Date.parse(value || ''); return Number.isFinite(time) ? time : 0; }
function snippet(value, limit = 700) { const text = String(value || '').trim(); return text.length > limit ? `${text.slice(0, limit)}…` : text; }

export function sourceRegistry(db, { includeHistory = false, includeCandidates = true } = {}) {
  const records = [];
  const active = includeHistory ? '' : "AND status NOT IN ('archived','deprecated','superseded')";
  for (const item of db.prepare(`SELECT * FROM knowledge_items WHERE 1=1 ${active}`).all()) {
    records.push({
      canonicalId: `knowledge:${item.id}`, category: item.type || 'knowledge', title: item.title,
      text: `${item.title}\n${item.body}\n${item.next_action || ''}`, timestamp: item.created_at,
      updatedAt: item.updated_at || item.last_reviewed || item.created_at, sensitivity: /health|medical|accessibility/i.test(item.type || '') ? 'sensitive' : 'personal',
      chatReadable: ['active', 'stable', 'pending review', 'stale'].includes(item.status), chatProposable: true,
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
  for (const message of db.prepare("SELECT m.*, s.title AS session_title FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE s.deleted = 0 AND m.role='user' ORDER BY m.created_at DESC LIMIT 200").all()) {
    records.push({ canonicalId: `chat:${message.id}`, category: 'conversation history', title: message.session_title || 'Chat', text: message.content,
      timestamp: message.created_at, updatedAt: message.created_at, sensitivity: 'personal', chatReadable: true, chatProposable: true, state: 'historical', source: 'saved Chat', provenance: `Conversation: ${message.session_title || 'Chat'}`, record: message });
  }
  return records;
}

function score(record, queryWords, rawQuery, now = Date.now()) {
  const haystack = `${record.title}\n${record.text}`.toLowerCase();
  const matches = queryWords.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
  const broad = /what do you know|about me|profile|preferences|health|goals|projects|decisions|tasks|overdue|previously/i.test(rawQuery);
  if (!matches && !broad) return -Infinity;
  const recency = Math.max(0, 1 - ((now - dateValue(record.updatedAt)) / (365 * 86400000)));
  return matches * 10 + (record.state === 'approved' ? 4 : record.state === 'pending' ? 1 : 0) + recency;
}

export function retrieveLocalKnowledge(db, query, options = {}) {
  const queryWords = words(query);
  const disabled = new Set(options.disabledCategories || []);
  const rows = sourceRegistry(db, options).filter((record) => record.chatReadable && !disabled.has(record.category));
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
  return /what do you know about me|tell me (?:something )?about myself|are you going to.*(?:tell|say).*(?:about myself|about me)|what.*(health|condition|preference|goal|project|decision|task|appointment)|what have i told you|what does .+ mean|what am i working on|what did i say|why did we make|saved (memory|information)|previously/i.test(String(message || '').toLowerCase());
}

export function answerLocalKnowledgeQuestion(db, message) {
  const result = retrieveLocalKnowledge(db, message);
  if (!result.items.length) return { content: 'I could not find relevant authorised local information for that question.', sources: [] };
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
  return { content: lines.join('\n').trim(), sources: result.items.map((item) => ({ title: item.title, category: item.category, updatedAt: item.updatedAt, state: item.state, whySelected: item.whySelected, source: item.source, provenance: item.provenance })) };
}
