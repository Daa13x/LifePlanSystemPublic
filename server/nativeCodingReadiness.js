import crypto from 'node:crypto';

const RUNNABLE_STATUSES = new Set(['prepared', 'failed', 'interrupted', 'cancelled']);

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeLabel(value, fallback, max = 160) {
  const label = String(value || '').trim();
  if (!label || /[\0\r\n]/.test(label) || /^[A-Za-z]:[\\/]/.test(label) || /^[/\\]{1,2}/.test(label) || label.replaceAll('\\', '/').split('/').includes('..')) {
    return `${fallback}:${hash(label).slice(0, 12)}`;
  }
  return label.slice(0, max);
}

export function buildNativeCodingReadinessReceipt(input = {}) {
  const gate = (name, ok, reasonCode) => ({ gate: name, ok: Boolean(ok), reasonCode: ok ? 'ok' : reasonCode });
  const authorityChecks = Array.isArray(input.authority?.checks) ? input.authority.checks : [];
  const gates = [
    gate('task.status', RUNNABLE_STATUSES.has(input.task?.status), 'status-not-runnable'),
    gate('task.seal', input.taskSealValid === true, 'task-seal-mismatch'),
    gate('evidence.prepared', input.evidenceReady === true, 'prepared-evidence-missing'),
    gate('source.base-current', input.baseCurrent === true, 'sealed-base-not-current'),
    gate('advice.current', input.adviceCurrent === true, 'validated-advice-stale'),
    gate('validation.coverage', input.validationScope?.ok === true, 'validation-under-covered'),
    gate('model.configured', input.model?.configured === true, 'local-model-unavailable'),
    gate('model.local-verified', input.model?.localInferenceVerified === true, 'local-model-unverified'),
    gate('model.context-ready', input.model?.codingContextReady === true, 'coding-context-not-ready'),
    gate('model.loopback', input.model?.rejectedRemoteEndpoint !== true, 'remote-model-endpoint-refused'),
    gate('worker.available', input.workerAvailable === true, 'worker-already-active'),
    gate('lease.run-available', input.runLeaseState === 'available', `durable-run-lease-${input.runLeaseState || 'unknown'}`),
    gate('lease.apply-available', input.applyLeaseState === 'available', `durable-apply-lease-${input.applyLeaseState || 'unknown'}`),
    gate('worktree.available', input.worktreeAvailable === true, 'task-worktree-already-present'),
    ...authorityChecks.map((check) => gate(`git.${check.gate}`, check.ok, `git-${check.gate}`))
  ];
  const stable = {
    schemaVersion: 1,
    kind: 'native_coding.run_readiness',
    taskId: String(input.task?.id || ''),
    taskHash: String(input.task?.taskHash || ''),
    baseCommit: String(input.task?.baseCommit || ''),
    evidenceHash: String(input.evidenceHash || ''),
    adviceHash: String(input.adviceHash || ''),
    validation: String(input.task?.validation || ''),
    allowedPathsHash: hash(Array.isArray(input.task?.allowedPaths) ? input.task.allowedPaths : []),
    maxFilesChanged: Number(input.task?.maxFilesChanged || 0),
    model: {
      provider: safeLabel(input.model?.provider, 'local-provider', 80),
      id: safeLabel(input.model?.model, 'local-model'),
      source: safeLabel(input.model?.source, 'local-model-source', 100),
      identityHash: hash({ provider: input.model?.provider || '', model: input.model?.model || '', source: input.model?.source || '', endpoint: input.model?.endpoint || '' }),
      localInferenceVerified: input.model?.localInferenceVerified === true,
      verificationSource: safeLabel(input.model?.verificationSource, 'verification-source', 100),
      contextReady: input.model?.codingContextReady === true
    },
    repository: {
      identity: String(input.authority?.receipt?.repository || 'unknown').slice(0, 160),
      head: String(input.authority?.receipt?.startingCommit || 'unknown'),
      branch: String(input.authority?.receipt?.activeBranch || 'unknown').slice(0, 80),
      clean: authorityChecks.find((item) => item.gate === 'clean_worktree')?.ok === true
    },
    ownership: {
      runLease: input.runLeaseState || 'unknown',
      applyLease: input.applyLeaseState || 'unknown',
      worktreeAvailable: input.worktreeAvailable === true
    },
    workerAvailable: input.workerAvailable === true,
    gates,
    ready: gates.every((item) => item.ok),
    preparationOnly: true,
    authorizesExecution: false,
    authorizationRequired: true,
    authorizationGranted: false,
    executionStarted: false,
    effects: {
      runtimeStarted: false,
      worktreeCreated: false,
      leaseAcquired: false
    }
  };
  return Object.freeze({ ...stable, receiptHash: hash(stable) });
}

export function publicNativeCodingReadiness(receipt, observedAt = new Date().toISOString()) {
  return { ...receipt, observedAt };
}
