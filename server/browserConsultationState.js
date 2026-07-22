// Safeguard 2 — send once, then poll.
//
// One active browser consultation per (task, phase). Dispatch happens exactly
// once; thereafter the recorded job is polled. Pending states are not failures,
// "no reply yet" never redispatches, a timeout produces a bounded fallback
// (never a resend), and a process restart resumes polling the same job id.
//
// State is persisted atomically so it survives a restart. Browser output is
// never trusted here; this module only tracks job identity and lifecycle.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PENDING_STATES = Object.freeze(['dispatched', 'queued', 'claimed', 'processing', 'pending', 'awaiting_reply']);
export const TERMINAL_STATES = Object.freeze(['answered', 'timeout', 'error', 'cancelled']);

const PENDING = new Set(PENDING_STATES);
const TERMINAL = new Set(TERMINAL_STATES);

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

export function isTerminal(state) { return TERMINAL.has(String(state)); }
export function isPending(state) { return PENDING.has(String(state)); }

export class BrowserConsultationStore {
  constructor({ baseDir, now = () => Date.now() } = {}) {
    if (!baseDir) throw new Error('BrowserConsultationStore requires a baseDir.');
    this.baseDir = baseDir;
    this.now = now;
  }

  key(taskId, phase) { return digest(`${taskId} ${phase}`); }
  file(taskId, phase) { return path.join(this.baseDir, `${this.key(taskId, phase)}.json`); }

  read(taskId, phase) {
    try { return JSON.parse(fs.readFileSync(this.file(taskId, phase), 'utf8')); } catch { return null; }
  }

  write(record) {
    atomicJson(this.file(record.taskId, record.phase), record);
    return record;
  }

  // Dispatch at most once per (task, phase, fingerprint). Returns the existing
  // record unchanged when one is already active or already terminal for the
  // same request; only a genuinely new/changed request calls dispatchFn.
  async dispatchOnce(taskId, phase, fingerprint, dispatchFn) {
    const existing = this.read(taskId, phase);
    if (existing) {
      const sameRequest = existing.requestFingerprint === fingerprint;
      if (sameRequest && (isPending(existing.state) || isTerminal(existing.state))) {
        return { record: existing, dispatched: false, reason: isTerminal(existing.state) ? 'already-terminal' : 'already-active' };
      }
      if (!sameRequest && isPending(existing.state)) {
        // A phase already has an active consultation; refuse a second one.
        return { record: existing, dispatched: false, reason: 'phase-busy' };
      }
    }
    const jobId = await dispatchFn();
    if (jobId === undefined || jobId === null || jobId === '') {
      const record = this.write({
        taskId, phase, requestFingerprint: fingerprint, browserJobId: null,
        state: 'error', dispatchTime: this.now(), claimTime: null, lastPollTime: null,
        terminalTime: this.now(), result: null, error: 'dispatch produced no job id', consumed: false
      });
      return { record, dispatched: false, reason: 'dispatch-failed' };
    }
    const record = this.write({
      taskId, phase, requestFingerprint: fingerprint, browserJobId: jobId,
      state: 'dispatched', dispatchTime: this.now(), claimTime: null, lastPollTime: null,
      terminalTime: null, result: null, error: '', consumed: false
    });
    return { record, dispatched: true, reason: 'dispatched' };
  }

  // Poll the recorded job. Never dispatches. Pending stays pending. A terminal
  // result is recorded once and returned idempotently thereafter.
  async poll(taskId, phase, pollFn) {
    const record = this.read(taskId, phase);
    if (!record) throw new Error('No browser consultation to poll for this task phase.');
    if (isTerminal(record.state)) {
      const alreadyConsumed = record.consumed;
      if (!alreadyConsumed) { record.consumed = true; this.write(record); }
      return { record, terminal: true, alreadyConsumed };
    }
    const status = await pollFn(record.browserJobId);
    record.lastPollTime = this.now();
    const state = String(status?.state || 'pending');
    // Reject a reply addressed to a different task/job outright.
    if (status && status.forTaskId && String(status.forTaskId) !== String(taskId)) {
      record.state = 'error';
      record.error = 'poll returned a reply for a different task';
      record.terminalTime = this.now();
      this.write(record);
      return { record, terminal: true, rejected: 'wrong-task' };
    }
    if (status && status.forJobId !== undefined && String(status.forJobId) !== String(record.browserJobId)) {
      this.write(record); // ignore a stale/foreign job reply; keep polling ours
      return { record, terminal: false, ignored: 'foreign-job' };
    }
    if (isTerminal(state)) {
      record.state = state;
      record.result = status.result ?? null;
      record.error = state === 'error' ? String(status.error || 'browser job error') : '';
      record.terminalTime = this.now();
      record.consumed = true; // this poll delivers the one terminal result
      this.write(record);
      return { record, terminal: true };
    }
    if (state === 'claimed' && !record.claimTime) record.claimTime = this.now();
    record.state = isPending(state) ? state : 'pending';
    this.write(record);
    return { record, terminal: false };
  }

  // A timeout is a bounded fallback outcome, never a resend.
  markTimeout(taskId, phase, fallbackResult = null) {
    const record = this.read(taskId, phase);
    if (!record) throw new Error('No browser consultation to time out.');
    if (isTerminal(record.state)) return record;
    record.state = 'timeout';
    record.result = fallbackResult;
    record.terminalTime = this.now();
    return this.write(record);
  }

  cancel(taskId, phase) {
    const record = this.read(taskId, phase);
    if (!record) return null;
    if (isTerminal(record.state)) return record;
    record.state = 'cancelled';
    record.terminalTime = this.now();
    return this.write(record);
  }

  listRecords() {
    if (!fs.existsSync(this.baseDir)) return [];
    return fs.readdirSync(this.baseDir).filter((name) => name.endsWith('.json')).map((name) => {
      try { return JSON.parse(fs.readFileSync(path.join(this.baseDir, name), 'utf8')); } catch { return null; }
    }).filter(Boolean);
  }

  // On restart, resume polling every non-terminal record's existing job id.
  recover() {
    return this.listRecords().filter((record) => isPending(record.state));
  }

  activeCount() { return this.recover().length; }
}
