import fs from 'node:fs';
import path from 'node:path';
import { buildConsultationReceipt, isConsultationReceiptFresh, effectiveValidatedAdviceHash } from '../server/consultationReceipt.js';

// Acceptance for the browser-consultation receipt (MA-Dev audit delta #1). Proves
// the normalized provenance receipt is built from a validated advice record, that
// a change to the sealed task or prepared evidence makes it stale, and that only
// fresh validated advice can be bound to a run confirmation. Also statically
// confirms the server run snapshot and the UI both go through the freshness gate.
// Pure and local. Exit 0 = pass.

const appRoot = path.resolve(import.meta.dirname, '..');
let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- browser-consultation receipt verification ---');

// ---- building the receipt ----
const advice = { provider: 'ChatGPT', jobId: 42, promptHash: 'p'.repeat(64), answerHash: 'a'.repeat(64), status: 'validated', completedAt: '2026-08-12T10:00:00.000Z' };
const receipt = buildConsultationReceipt({ advice, taskHash: 't'.repeat(64), evidenceHash: 'e'.repeat(64) });
line(receipt.provider === 'ChatGPT', 'the receipt records the provider label');
line(receipt.conversationId === '42', 'the receipt records the browser job/turn id as a string');
line(receipt.answerHash === 'a'.repeat(64) && receipt.promptHash === 'p'.repeat(64), 'the receipt records the prompt and answer hashes');
line(receipt.taskHash === 't'.repeat(64) && receipt.evidenceHash === 'e'.repeat(64), 'the receipt binds the task seal and prepared-evidence hashes');
line(receipt.capturedAt === '2026-08-12T10:00:00.000Z', 'the receipt records the capture timestamp');
line(receipt.terminalState === 'validated', 'the receipt records the terminal state');

// ---- freshness ----
line(isConsultationReceiptFresh(receipt, { taskHash: 't'.repeat(64), evidenceHash: 'e'.repeat(64) }), 'a receipt bound to the current task and evidence is fresh');
line(!isConsultationReceiptFresh(receipt, { taskHash: 't'.repeat(64), evidenceHash: 'X'.repeat(64) }), 'changed prepared evidence makes the receipt stale');
line(!isConsultationReceiptFresh(receipt, { taskHash: 'X'.repeat(64), evidenceHash: 'e'.repeat(64) }), 'a re-sealed task makes the receipt stale');
line(!isConsultationReceiptFresh(null, { taskHash: 't', evidenceHash: 'e' }), 'a missing receipt is never fresh');
line(!isConsultationReceiptFresh({ taskHash: '', evidenceHash: '' }, { taskHash: '', evidenceHash: '' }), 'an empty-hash receipt is never fresh');

// ---- the exact gate the run snapshot uses ----
const freshTask = { taskHash: 't'.repeat(64), preparation: { evidenceHash: 'e'.repeat(64) }, browserAdvice: { ...advice, receipt } };
line(effectiveValidatedAdviceHash(freshTask) === 'a'.repeat(64), 'fresh validated advice binds its answer hash to a run');

const staleEvidenceTask = { taskHash: 't'.repeat(64), preparation: { evidenceHash: 'NEW'.repeat(21) + 'e' }, browserAdvice: { ...advice, receipt } };
line(effectiveValidatedAdviceHash(staleEvidenceTask) === '', 'advice whose prepared evidence changed is NOT bound to a run');

const rejectedTask = { taskHash: 't'.repeat(64), preparation: { evidenceHash: 'e'.repeat(64) }, browserAdvice: { ...advice, status: 'rejected', receipt } };
line(effectiveValidatedAdviceHash(rejectedTask) === '', 'rejected advice is never bound to a run');

const noAdviceTask = { taskHash: 't'.repeat(64), preparation: { evidenceHash: 'e'.repeat(64) }, browserAdvice: null };
line(effectiveValidatedAdviceHash(noAdviceTask) === '', 'a task with no advice binds no advice hash');

const legacyTask = { taskHash: 't'.repeat(64), preparation: { evidenceHash: 'e'.repeat(64) }, browserAdvice: { ...advice, receipt: undefined } };
line(effectiveValidatedAdviceHash(legacyTask) === 'a'.repeat(64), 'validated advice from before receipts (no receipt) keeps its prior behaviour');

// ---- static wiring: server + UI both go through the freshness gate ----
const serverSource = fs.readFileSync(path.join(appRoot, 'server', 'index.js'), 'utf8');
line(/adviceHash:\s*effectiveValidatedAdviceHash\(task\)/.test(serverSource), 'the run snapshot binds advice via effectiveValidatedAdviceHash, not the raw answer hash');
line(/task\.browserAdvice\.receipt\s*=\s*buildConsultationReceipt\(/.test(serverSource), 'validated advice persists a normalized receipt');
const uiSource = fs.readFileSync(path.join(appRoot, 'src', 'main.jsx'), 'utf8');
line(/receipt\.evidenceHash !== \(selectedCodingTask\.preparation\?\.evidenceHash/.test(uiSource), 'the review UI shows the receipt and flags a stale binding');
line(/freshAdvice \? advice\.answerHash : ''/.test(uiSource), 'the UI run proposal drops stale advice instead of sending it');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll browser-consultation receipt checks passed.');
process.exit(failures ? 1 : 0);
