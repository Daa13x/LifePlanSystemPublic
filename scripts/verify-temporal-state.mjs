import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getCurrentStatePoint, listCurrentStatePoints, setCurrentStatePoint, statePointTimeline } from '../server/temporalState.js';

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE knowledge_items (id INTEGER PRIMARY KEY, title TEXT, body TEXT, status TEXT);
  CREATE TABLE state_points (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'CURRENT', freshness_class TEXT NOT NULL, source TEXT NOT NULL, evidence_type TEXT NOT NULL, verification_state TEXT NOT NULL, confidence REAL NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, last_verified TEXT NOT NULL, current_event_id INTEGER, receipt_id TEXT, originating_message_id INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE state_events (id INTEGER PRIMARY KEY AUTOINCREMENT, point_key TEXT NOT NULL, previous_value_json TEXT, value_json TEXT NOT NULL, status TEXT NOT NULL, freshness_class TEXT NOT NULL, source TEXT NOT NULL, evidence_type TEXT NOT NULL, verification_state TEXT NOT NULL, confidence REAL NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, receipt_id TEXT, originating_message_id INTEGER, superseded_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
database.prepare("INSERT INTO knowledge_items (title, body, status) VALUES ('Old browser note', 'Cloud browser is not configured.', 'active')").run();
setCurrentStatePoint(database, { key: 'capability.cloud_browser.health', value: 'not configured', freshnessClass: 'LIVE', source: 'historical setup receipt', validFrom: '2026-07-01T00:00:00.000Z' });
setCurrentStatePoint(database, { key: 'capability.cloud_browser.health', value: 'working', freshnessClass: 'LIVE', source: 'current browser runtime receipt', validFrom: '2026-09-05T00:00:00.000Z', receiptId: 'browser-job:42' });

const current = getCurrentStatePoint(database, 'capability.cloud_browser.health', { now: Date.parse('2026-09-05T00:00:30.000Z') });
assert.equal(current.value, 'working');
assert.equal(current.status, 'CURRENT');
assert.equal(current.receipt_id, 'browser-job:42');
const timeline = statePointTimeline(database, 'capability.cloud_browser.health');
assert.equal(timeline.length, 2);
assert.equal(timeline[0].status, 'SUPERSEDED');
assert.equal(timeline[0].value, 'not configured');
assert.equal(timeline[1].status, 'CURRENT');
assert.equal(listCurrentStatePoints(database, { prefix: 'capability.' })[0].value, 'working');
assert.equal(database.prepare('SELECT body FROM knowledge_items WHERE id = 1').get().body, 'Cloud browser is not configured.');
assert.equal(getCurrentStatePoint(database, 'capability.cloud_browser.health', { now: Date.parse('2026-09-05T00:02:01.000Z') }).status, 'STALE');
console.log('Temporal state verification passed: current projection wins, history is superseded rather than deleted, and LIVE evidence ages.');
