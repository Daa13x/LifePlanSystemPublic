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
  //
  // The read-check-then-write-after-await used to be a real check-then-act
  // race: two concurrent dispatchOnce calls for the same (taskId, phase)
  // could both read no/inactive existing record before either had persisted
  // anything, and both would then call dispatchFn -- a real duplicate
  // external dispatch (e.g. sending the same prompt to a cloud provider
  // twice), directly contradicting this module's own "at most once"
  // guarantee. Fixed by synchronously writing a claim record (state:
  // 'dispatched', browserJobId: null) immediately after the check, before
  // calling dispatchFn. Because Node only switches tasks at an `await`, the
  // read-check-claim sequence below has none, so no concurrent dispatchOnce
  // call can observe the pre-claim state -- it will see this claim instead
  // and correctly report 'already-active'/'phase-busy'. This protects
  // concurrent calls within one process, matching every other store in this
  // codebase's existing single-process-writer assumption; it is not a
  // cross-process lock.
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
    const claim = this.write({
      taskId, phase, requestFingerprint: fingerprint, browserJobId: null,
      state: 'dispatched', dispatchTime: this.now(), claimTime: null, lastPollTime: null,
      terminalTime: null, result: null, error: '', consumed: false
    });
    // settleClaim: while dispatchFn is awaiting, a concurrent poll()/cancel()
    // call can legitimately observe this claim (it's a pending state) and
    // terminalize it on its own (e.g. poll() finding the job id unavailable,
    // or an explicit cancel()). Blindly writing `claim` again once dispatchFn
    // settles would silently overwrite that already-terminal outcome with a
    // stale pre-await snapshot -- resurrecting a settled record, which this
    // codebase's own terminal-state guarantee elsewhere explicitly forbids.
    // Re-read first: only apply this claim's own update if the record is
    // still exactly the claim we made; otherwise respect whatever it
    // already became and return that instead.
    const settleClaim = (updates) => {
      const current = this.read(taskId, phase);
      if (!current || current.dispatchTime !== claim.dispatchTime || current.requestFingerprint !== claim.requestFingerprint) {
        // Something else already replaced this exact claim.
        return current || claim;
      }
      if (isTerminal(current.state)) {
        // A concurrent poll()/cancel() already terminalized this claim while
        // dispatchFn was still resolving -- respect it, never resurrect it.
        return current;
      }
      return this.write({ ...current, ...updates });
    };
    let jobId;
    try {
      jobId = await dispatchFn();
    } catch (error) {
      const record = settleClaim({ state: 'error', terminalTime: this.now(), error: error?.message || 'dispatch threw' });
      return { record, dispatched: false, reason: 'dispatch-failed' };
    }
    if (jobId === undefined || jobId === null || jobId === '') {
      const record = settleClaim({ state: 'error', terminalTime: this.now(), error: 'dispatch produced no job id' });
      return { record, dispatched: false, reason: 'dispatch-failed' };
    }
    const record = settleClaim({ browserJobId: jobId });
    return { record, dispatched: record.browserJobId === jobId, reason: record.browserJobId === jobId ? 'dispatched' : 'settled-concurrently' };
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
  //
  // A record can be pending with browserJobId still null: dispatchOnce
  // writes that exact shape as its synchronous pre-dispatch claim (see
  // dispatchOnce's own comment), and a process crash/unclean exit between
  // that write and dispatchFn resolving leaves it exactly like that,
  // permanently. There is nothing to resume polling for it (no job id was
  // ever assigned), and dispatchOnce's own "already-active" check would
  // otherwise block this (task, phase, fingerprint) from ever dispatching
  // again. Settle it to a real 'error' terminal record instead of returning
  // it as a in-flight job to poll (an adversarial review flagged the
  // original null-job-id claim as a possible stuck/mishandled state).
  recover() {
    const records = this.listRecords();
    const pollable = [];
    for (const record of records) {
      if (!isPending(record.state)) continue;
      if (record.browserJobId === null) {
        this.write({ ...record, state: 'error', terminalTime: this.now(), error: 'orphaned dispatch claim found on restart with no assigned job id (process likely exited between claim and dispatch)' });
        continue;
      }
      pollable.push(record);
    }
    return pollable;
  }

  activeCount() { return this.recover().length; }
}
