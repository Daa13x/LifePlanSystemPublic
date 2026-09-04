import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-personality-'));
process.env.LIFE_PLANNER_DB = path.join(tempDir, 'personality.sqlite');

try {
  const personality = await import('../server/personality.js');
  const { db, migrate } = await import('../server/db.js');
  const { resolveAgentMode } = await import('../server/agentMode.js');

  migrate();
  // Allow the startup seed scheduled by personality.js to run before the test closes the DB.
  await new Promise((resolve) => setImmediate(resolve));
  const profile = personality.ensurePersonalityProfile();

  assert.equal(profile.id, 'lps-core-v1');
  assert.equal(profile.traits.find((trait) => trait.id === 'inquisitive')?.strength, 10);
  assert.equal(profile.traits.find((trait) => trait.id === 'sceptical')?.strength, 9.5);
  assert.ok(profile.lowTraits.includes('sycophancy'));
  assert.ok(profile.boundaries.some((item) => /hard governance/i.test(item)));

  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get(personality.PERSONALITY_SETTING_KEY);
  assert.ok(stored, 'personality profile should be durable in SQLite settings');
  assert.equal(JSON.parse(stored.value).id, 'lps-core-v1');

  const rendered = personality.renderCurrentPersonalitySystemPrompt();
  assert.match(rendered, /inquisitive: 10\/10/i);
  assert.match(rendered, /sceptical: 9\.5\/10/i);
  assert.match(rendered, /Sceptical does not mean argumentative/i);
  assert.match(rendered, /governance, safety, privacy, permission and tool rules always override personality/i);

  const mode = resolveAgentMode('help me think through this');
  assert.match(mode.instruction, /LifePlanSystem personality:/);
  assert.match(mode.instruction, /Curious enough to investigate; sceptical enough to verify/i);

  db.close();
  console.log('Personality profile verification passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
