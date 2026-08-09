import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { answerLocalKnowledgeQuestion, personalKnowledgeCoverage, retrieveLocalKnowledge, sourceRegistry } from '../server/localKnowledge.js';

const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-personal-coverage-'));
const priorPrivateRepository = process.env.LIFE_PLANNER_PRIVATE_REPO;
const emptyPrivateRepository = path.join(probe, 'empty-private-repository');
fs.mkdirSync(emptyPrivateRepository, { recursive: true });
process.env.LIFE_PLANNER_PRIVATE_REPO = emptyPrivateRepository;
const dbPath = path.join(probe, 'restored-copy', 'life-planner.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
process.env.LIFE_PLANNER_DB = dbPath;
const { db, migrate } = await import('../server/db.js');

try {
  migrate();
  db.exec('DELETE FROM chat_messages; DELETE FROM chat_sessions; DELETE FROM memory_candidates; DELETE FROM knowledge_items; DELETE FROM projects; DELETE FROM settings;');
  const insertKnowledge = db.prepare(`INSERT INTO knowledge_items (type, title, body, source, status, evidence, owner, next_action, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'user', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  const insertCandidate = db.prepare(`INSERT INTO memory_candidates (type, title, body, source, evidence, status) VALUES (?, ?, ?, 'chat', 'fixture', ?)`);
  const insertProject = db.prepare(`INSERT INTO projects (name, status, owner, source, evidence, next_action) VALUES (?, ?, 'user', 'manual', 'fixture', ?)`);

  insertKnowledge.run('profile', 'Coverage profile', 'A saved profile fact for the coverage verifier.', 'manual', 'active', 'fixture', 'Keep current.');
  insertKnowledge.run('preference', 'Coverage preference', 'The user prefers concise weekly reviews.', 'manual', 'stable', 'fixture', 'Use concise reviews.');
  insertKnowledge.run('goal', 'Coverage goal', 'Complete the local coverage audit.', 'manual', 'active', 'fixture', 'Verify it.');
  insertKnowledge.run('task', 'Coverage task', 'Check the personal knowledge registry.', 'manual', 'active', 'fixture', 'Run the verifier.');
  insertKnowledge.run('document', 'Coverage file', 'Imported document text is retained as a reviewed Knowledge record.', 'import', 'active', 'fixture', 'Review source.');
  const oldId = insertKnowledge.run('preference', 'Replaced preference', 'The old value must not be shown.', 'manual', 'superseded', 'fixture', '').lastInsertRowid;
  const newId = insertKnowledge.run('preference', 'Current preference', 'The current corrected value is shown.', 'manual', 'active', 'fixture', '').lastInsertRowid;
  insertKnowledge.run('profile', 'Deleted profile', 'This archived value must not be shown.', 'manual', 'archived', 'fixture', '');
  insertCandidate.run('preference', 'Pending preference', 'This is awaiting review.', 'candidate');
  insertCandidate.run('preference', 'Rejected preference', 'This must never become a fact.', 'denied');
  insertProject.run('Coverage project', 'active', 'Review current project information.');
  const sessionId = db.prepare(`INSERT INTO chat_sessions (title) VALUES ('Saved coverage chat')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)`)
    .run(sessionId, 'The user previously said the coverage topic matters.', sessionId, 'Assistant-only claim must not be a personal fact.');

  const records = sourceRegistry(db);
  const ids = new Set(records.map((record) => record.canonicalId));
  assert.ok(ids.has(`knowledge:${newId}`), 'current corrected Knowledge is registered');
  assert.ok(!ids.has(`knowledge:${oldId}`), 'superseded Knowledge is excluded');
  assert.ok(!records.some((record) => /Pending preference|Rejected preference|Deleted profile|Assistant-only claim/.test(record.text)), 'pending, rejected, archived and assistant content are excluded');
  assert.ok(records.some((record) => record.category === 'project'), 'current projects are registered');
  assert.ok(records.some((record) => record.category === 'conversation history'), 'saved user Chat is registered');
  assert.ok(records.some((record) => record.category === 'document'), 'persisted extracted document Knowledge is registered');
  assert.equal(new Set(records.map((record) => record.canonicalId)).size, records.length, 'registry has no duplicate source IDs');

  const broad = answerLocalKnowledgeQuestion(db, 'Tell me something about myself.');
  assert.match(broad.content, /Coverage profile|Coverage preference/);
  const exactObservedWording = answerLocalKnowledgeQuestion(db, 'tell me something about me');
  assert.match(exactObservedWording.content, /Coverage profile|Coverage preference/, 'the observed real-app wording routes to local retrieval');
  assert.ok(broad.sources.every((source) => source.sourceId && source.provenance !== undefined), 'answers retain stable source provenance');
  const projects = answerLocalKnowledgeQuestion(db, 'What am I currently working on?');
  assert.match(projects.content, /Coverage project|Coverage task/);
  const files = answerLocalKnowledgeQuestion(db, 'What files have I saved about this?');
  assert.match(files.content, /Coverage file/);
  const pending = answerLocalKnowledgeQuestion(db, 'What pending memory candidates should I review?');
  assert.match(pending.content, /Pending preference/);
  assert.match(pending.content, /pending/i);
  const noResult = answerLocalKnowledgeQuestion(db, 'What did I say about unfindable zephyr-lattice?');
  assert.match(noResult.content, /searched the relevant saved local records/i);
  assert.doesNotMatch(noResult.content, /do not have access/i);
  const disabled = retrieveLocalKnowledge(db, 'Coverage preference', { disabledCategories: ['preference'] });
  assert.ok(!disabled.items.some((item) => item.category === 'preference'), 'disabled category cannot leak records');

  const repositoryRoot = path.join(probe, 'repository');
  const repositoryDoc = path.join(repositoryRoot, 'LifePlanSystem_Public_Sanitized', 'docs', 'MEMORY_ARCHITECTURE.md');
  fs.mkdirSync(path.dirname(repositoryDoc), { recursive: true });
  fs.writeFileSync(repositoryDoc, '# Memory Architecture\n\nThe bundled GitHub knowledge base is available to local Chat retrieval.');
  const repositoryAnswer = answerLocalKnowledgeQuestion(db, 'What does the GitHub knowledge base say about memory architecture?', { repoRoot: repositoryRoot });
  assert.match(repositoryAnswer.content, /bundled GitHub knowledge base/i);
  assert.ok(repositoryAnswer.sources.some((source) => source.category === 'repository knowledge' && /MEMORY_ARCHITECTURE/.test(source.provenance)), 'repository knowledge carries file provenance');

  const privateRepository = path.join(probe, 'private-repository');
  fs.mkdirSync(privateRepository, { recursive: true });
  fs.writeFileSync(path.join(privateRepository, 'career-profile.md'), '# Career profile\n\nAlex has practical frontend engineering and local AI application experience.');
  process.env.LIFE_PLANNER_PRIVATE_REPO = privateRepository;
  const careerContext = retrieveLocalKnowledge(db, 'What job should I do based on my career profile?', { repoRoot: repositoryRoot, limit: 6 });
  assert.ok(careerContext.items.some((item) => item.source === 'local private repository' && /career-profile/.test(item.provenance)), 'a matching private-repository file remains available alongside saved personal records');

  const diagnostic = personalKnowledgeCoverage(db, { dbPath, userDataPath: path.dirname(dbPath), repoRoot: repositoryRoot });
  assert.equal(diagnostic.resolvedDatabasePath, dbPath);
  assert.equal(diagnostic.resolvedUserDataPath, path.dirname(dbPath));
  assert.ok(diagnostic.counts.activeKnowledge >= 6 && diagnostic.counts.pendingCandidates === 1);
  assert.equal(diagnostic.counts.privateRepositoryFiles, 1, 'private repository coverage is observable without exposing file contents');
  assert.equal(diagnostic.counts.assistantChatMessagesExcluded, 1);
  assert.ok(diagnostic.sourceAdapters.includes('knowledge_items'));
  assert.ok(diagnostic.sourceAdapters.includes('bundled_github_knowledge'));
  assert.ok(diagnostic.unavailableCategories.some((category) => category.startsWith('settings')));
  assert.ok(!JSON.stringify(diagnostic).includes('Assistant-only claim'), 'diagnostic contains counts only');
  console.log('Personal knowledge coverage verification passed.');
} finally {
  db.close();
  if (priorPrivateRepository === undefined) delete process.env.LIFE_PLANNER_PRIVATE_REPO;
  else process.env.LIFE_PLANNER_PRIVATE_REPO = priorPrivateRepository;
  fs.rmSync(probe, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
