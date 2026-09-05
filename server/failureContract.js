// One bounded, transport-neutral failure envelope for Chat, registered actions,
// cloud consultation and browser-agent boundaries. Existing subsystems retain
// ownership of detection and receipts; this module only normalizes the evidence
// they already have so UI and audit consumers do not invent a second taxonomy.

const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,79}$/;
const BOUNDARY = /^[a-z][a-z0-9_.-]{0,119}$/;

function boundedText(value, fallback = '', limit = 500) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, limit);
}

function boundary(value, fallback) {
  const text = boundedText(value, fallback, 120);
  return BOUNDARY.test(text) ? text : fallback;
}

function code(value, fallback = 'UNKNOWN_INTERNAL_ERROR') {
  const text = boundedText(value, fallback, 80);
  return ERROR_CODE.test(text) ? text : fallback;
}

function compactCause(value, depth = 0) {
  if (!value || depth >= 4) return null;
  const source = value.failure && typeof value.failure === 'object' ? value.failure : value;
  const nested = source.causedBy || source.cause || null;
  return {
    errorCode: code(source.errorCode || source.code),
    subsystem: boundary(source.subsystem, 'internal'),
    stage: boundary(source.stage, 'internal.unknown'),
    operation: boundary(source.operation, 'unknown'),
    reason: boundary(source.reason, 'unclassified'),
    ...(nested ? { causedBy: compactCause(nested, depth + 1) } : {})
  };
}

export function createFailureEnvelope(input = {}) {
  const timestamp = Number.isFinite(Date.parse(input.timestamp)) ? new Date(input.timestamp).toISOString() : new Date().toISOString();
  const failedStage = boundary(input.failedStage || input.stage, 'internal.unknown');
  const envelope = {
    version: 1,
    errorCode: code(input.errorCode),
    message: boundedText(input.message, 'The operation could not be completed safely.'),
    subsystem: boundary(input.subsystem, 'internal'),
    stage: boundary(input.stage, failedStage),
    operation: boundary(input.operation, 'unknown'),
    reason: boundary(input.reason, 'unclassified'),
    lastSuccessfulStage: input.lastSuccessfulStage ? boundary(input.lastSuccessfulStage, 'unknown') : null,
    failedStage,
    capability: input.capability ? boundary(input.capability, 'unknown') : null,
    tool: input.tool ? boundedText(input.tool, '', 120) : null,
    provider: input.provider ? boundedText(input.provider, '', 80) : null,
    model: input.model ? boundedText(input.model, '', 120) : null,
    correlationId: input.correlationId ? boundedText(input.correlationId, '', 128) : null,
    receiptIds: Array.isArray(input.receiptIds) ? input.receiptIds.map((item) => boundedText(item, '', 128)).filter(Boolean).slice(0, 20) : [],
    retryable: Boolean(input.retryable),
    userActionRequired: Boolean(input.userActionRequired),
    persistentChanges: Array.isArray(input.persistentChanges) ? input.persistentChanges.map((item) => boundedText(item, '', 180)).filter(Boolean).slice(0, 20) : [],
    lastConfirmed: input.lastConfirmed ? boundary(input.lastConfirmed, 'unknown') : null,
    firstUnconfirmed: input.firstUnconfirmed ? boundary(input.firstUnconfirmed, 'unknown') : null,
    timestamp
  };
  const causedBy = compactCause(input.causedBy || input.cause);
  return causedBy ? { ...envelope, causedBy } : envelope;
}

export class StructuredFailureError extends Error {
  constructor(input, options = {}) {
    const failure = createFailureEnvelope({ ...input, causedBy: input?.causedBy || options.cause });
    super(failure.message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'StructuredFailureError';
    this.code = failure.errorCode;
    this.failure = failure;
  }
}

export function normalizeFailure(error, fallback = {}) {
  if (error?.failure && typeof error.failure === 'object') return createFailureEnvelope({ ...fallback, ...error.failure });
  return createFailureEnvelope({
    ...fallback,
    message: fallback.message || error?.message,
    causedBy: fallback.causedBy || error
  });
}

export function failureChatContent(failure) {
  return [
    `**${failure.message}**`,
    '',
    `Error code: \`${failure.errorCode}\``
  ].join('\n');
}
