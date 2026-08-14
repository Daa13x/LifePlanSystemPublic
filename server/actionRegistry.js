import { randomUUID } from 'node:crypto';

// Pure, dependency-injected action contract and dispatcher. It deliberately
// knows nothing about Express, SQLite, the filesystem, or model prompts. A
// caller supplies registered handlers plus a trusted invocation context; the
// registry validates the contract, permission, availability, arguments, and
// result before returning one closed-set outcome.

export const ACTION_STATUSES = Object.freeze([
  'success',
  'failed',
  'blocked',
  'unavailable',
  'needs_confirmation',
  'needs_approval',
  'cancelled'
]);

export const ACTION_RISKS = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  REVERSIBLE_WRITE: 'REVERSIBLE_WRITE',
  EXTERNAL_COMMUNICATION: 'EXTERNAL_COMMUNICATION',
  REPOSITORY_CHANGE: 'REPOSITORY_CHANGE',
  SETTINGS_CHANGE: 'SETTINGS_CHANGE',
  SENSITIVE_DATA: 'SENSITIVE_DATA',
  DESTRUCTIVE_OR_IRREVERSIBLE: 'DESTRUCTIVE_OR_IRREVERSIBLE'
});

export const ACTION_CONFIRMATIONS = Object.freeze({
  NONE: 'none',
  USER: 'user_confirmation',
  APPROVAL: 'explicit_approval'
});

const ACTION_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const TEST_ID = /^[a-z0-9][a-z0-9._-]*$/;
const INPUT_TYPES = new Set(['string', 'id', 'integer', 'object', 'boolean']);
const RESULT_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneContractValue(value) {
  if (Array.isArray(value)) return value.map(cloneContractValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneContractValue(item)]));
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function contractError(id, message) {
  throw new Error(`Action contract ${id || '<unknown>'}: ${message}`);
}

function requireText(action, key) {
  if (typeof action[key] !== 'string' || !action[key].trim()) contractError(action.id, `"${key}" must be a non-empty string.`);
}

function validateInputSchema(id, schema) {
  if (!isPlainObject(schema)) contractError(id, '"inputSchema" must be a plain object.');
  for (const [key, spec] of Object.entries(schema)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) contractError(id, `input field "${key}" has an invalid name.`);
    if (!isPlainObject(spec) || !INPUT_TYPES.has(spec.type)) contractError(id, `input field "${key}" has an unsupported type.`);
    if ('required' in spec && typeof spec.required !== 'boolean') contractError(id, `input field "${key}" has a non-boolean required flag.`);
    if ('maxLength' in spec && (!Number.isInteger(spec.maxLength) || spec.maxLength < 1)) contractError(id, `input field "${key}" has an invalid maxLength.`);
    if ('min' in spec && typeof spec.min !== 'number') contractError(id, `input field "${key}" has an invalid minimum.`);
    if ('max' in spec && typeof spec.max !== 'number') contractError(id, `input field "${key}" has an invalid maximum.`);
    if ('min' in spec && 'max' in spec && spec.min > spec.max) contractError(id, `input field "${key}" has min greater than max.`);
    if ('enum' in spec && (!Array.isArray(spec.enum) || !spec.enum.length || spec.enum.some((value) => typeof value !== 'string'))) {
      contractError(id, `input field "${key}" has an invalid enum.`);
    }
    if ('maxLength' in spec && spec.type !== 'string') contractError(id, `input field "${key}" may use maxLength only with strings.`);
    if (('min' in spec || 'max' in spec) && spec.type !== 'integer') contractError(id, `input field "${key}" may use min/max only with integers.`);
    if ('enum' in spec && spec.type !== 'string') contractError(id, `input field "${key}" may use enum only with strings.`);
    if ('default' in spec) {
      const value = spec.default;
      if (spec.type === 'string') {
        if (typeof value !== 'string') contractError(id, `input field "${key}" has a non-string default.`);
        if (spec.maxLength && value.length > spec.maxLength) contractError(id, `input field "${key}" has an overlong default.`);
        if (spec.enum && !spec.enum.includes(value)) contractError(id, `input field "${key}" has a default outside its enum.`);
      } else if (spec.type === 'id' && (!Number.isInteger(value) || value <= 0)) {
        contractError(id, `input field "${key}" has an invalid record-id default.`);
      } else if (spec.type === 'integer' && (!Number.isInteger(value) || value < (spec.min ?? -Infinity) || value > (spec.max ?? Infinity))) {
        contractError(id, `input field "${key}" has an invalid integer default.`);
      } else if (spec.type === 'object' && !isPlainObject(value)) {
        contractError(id, `input field "${key}" has a non-object default.`);
      } else if (spec.type === 'boolean' && typeof value !== 'boolean') {
        contractError(id, `input field "${key}" has a non-boolean default.`);
      }
    }
  }
}

function validateResultSchema(id, schema) {
  if (!isPlainObject(schema) || schema.type !== 'object') contractError(id, '"resultSchema" must describe an object.');
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string' || !key))) {
    contractError(id, '"resultSchema.required" must be an array of field names.');
  }
  if (!isPlainObject(schema.properties)) contractError(id, '"resultSchema.properties" must be a plain object.');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    contractError(id, '"resultSchema.additionalProperties" must be boolean when supplied.');
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) contractError(id, `result field "${key}" has an invalid name.`);
    const types = isPlainObject(spec) && Array.isArray(spec.type) ? spec.type : [spec?.type];
    if (!isPlainObject(spec) || !types.length || types.some((type) => !RESULT_TYPES.has(type)) || new Set(types).size !== types.length) {
      contractError(id, `result field "${key}" has an unsupported type.`);
    }
  }
  for (const key of schema.required || []) {
    if (!(key in schema.properties)) contractError(id, `required result field "${key}" has no property schema.`);
  }
}

function validateDefinition(action) {
  if (!isPlainObject(action)) contractError('', 'each entry must be a plain object.');
  requireText(action, 'id');
  if (!ACTION_ID.test(action.id)) contractError(action.id, '"id" must be a stable lowercase machine identifier.');
  if (action.id.length > 80) contractError(action.id.slice(0, 80), '"id" must be 80 characters or fewer.');
  for (const key of ['label', 'description', 'feature', 'permission', 'testId']) requireText(action, key);
  if (!TEST_ID.test(action.testId)) contractError(action.id, '"testId" must be a stable lowercase test identifier.');
  validateInputSchema(action.id, action.inputSchema);
  validateResultSchema(action.id, action.resultSchema);
  if (!Object.values(ACTION_RISKS).includes(action.risk)) contractError(action.id, '"risk" is not a supported risk class.');
  if (!Object.values(ACTION_CONFIRMATIONS).includes(action.confirmation)) contractError(action.id, '"confirmation" is not supported.');
  if (!Array.isArray(action.sideEffects) || action.sideEffects.some((item) => typeof item !== 'string' || !item.trim())) {
    contractError(action.id, '"sideEffects" must be an array of non-empty descriptions.');
  }
  if (!Array.isArray(action.sourceControls) || action.sourceControls.some((item) => typeof item !== 'string' || !item.trim())) {
    contractError(action.id, '"sourceControls" must be an array of stable control identifiers.');
  }
  if (!isPlainObject(action.availability) || typeof action.availability.description !== 'string' || !action.availability.description.trim() || typeof action.availability.check !== 'function') {
    contractError(action.id, '"availability" must provide a description and check function.');
  }
  if (typeof action.handler !== 'function') contractError(action.id, '"handler" is missing or unknown.');
  if (action.risk === ACTION_RISKS.READ_ONLY && action.sideEffects.length) contractError(action.id, 'read-only actions cannot declare side effects.');
  if (action.risk === ACTION_RISKS.READ_ONLY && action.confirmation !== ACTION_CONFIRMATIONS.NONE) contractError(action.id, 'read-only actions cannot require write confirmation.');
  if ([ACTION_RISKS.REVERSIBLE_WRITE, ACTION_RISKS.EXTERNAL_COMMUNICATION, ACTION_RISKS.SETTINGS_CHANGE].includes(action.risk)
      && action.confirmation === ACTION_CONFIRMATIONS.NONE) {
    contractError(action.id, `${action.risk} actions must require user confirmation or explicit approval.`);
  }
  if ([ACTION_RISKS.REPOSITORY_CHANGE, ACTION_RISKS.DESTRUCTIVE_OR_IRREVERSIBLE].includes(action.risk)
      && action.confirmation !== ACTION_CONFIRMATIONS.APPROVAL) {
    contractError(action.id, `${action.risk} actions must require explicit approval.`);
  }
  if (![ACTION_RISKS.READ_ONLY, ACTION_RISKS.SENSITIVE_DATA].includes(action.risk) && !action.sideEffects.length) {
    contractError(action.id, `${action.risk} actions must describe their proposal or side effects.`);
  }
}

export function validateActionArgs(id, schema, rawArgs) {
  if (rawArgs === undefined || rawArgs === null) rawArgs = {};
  if (!isPlainObject(rawArgs)) throw new Error(`${id}: arguments must be a plain object.`);
  const args = {};
  for (const [key, spec] of Object.entries(schema)) {
    let value = rawArgs[key];
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (spec.required) throw new Error(`${id}: missing required argument "${key}".`);
      if ('default' in spec) args[key] = spec.default;
      continue;
    }
    if (spec.type === 'string') {
      if (typeof value !== 'string') throw new Error(`${id}: "${key}" must be a string.`);
      value = value.trim();
      if (!value && spec.required) throw new Error(`${id}: missing required argument "${key}".`);
      if (spec.maxLength) value = value.slice(0, spec.maxLength);
      if (spec.enum && !spec.enum.includes(value)) throw new Error(`${id}: "${key}" must be one of: ${spec.enum.join(', ')}.`);
    } else if (spec.type === 'id') {
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${id}: "${key}" must be a positive record id.`);
    } else if (spec.type === 'integer') {
      if (!Number.isInteger(value)) throw new Error(`${id}: "${key}" must be an integer.`);
      value = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, value));
    } else if (spec.type === 'object') {
      if (!isPlainObject(value)) throw new Error(`${id}: "${key}" must be a plain object.`);
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${id}: "${key}" must be a boolean.`);
    }
    args[key] = value;
  }
  for (const key of Object.keys(rawArgs)) {
    if (!(key in schema)) throw new Error(`${id}: unexpected argument "${key}".`);
  }
  return args;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateActionResult(id, schema, data) {
  if (!isPlainObject(data)) throw new Error(`${id}: handler result must be a plain object.`);
  for (const key of schema.required || []) {
    if (!(key in data)) throw new Error(`${id}: handler result is missing "${key}".`);
  }
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    if (key in data && !types.some((type) => matchesType(data[key], type))) throw new Error(`${id}: handler result "${key}" must be ${types.join(' or ')}.`);
  }
  if (schema.additionalProperties !== true) {
    for (const key of Object.keys(data)) {
      if (!(key in schema.properties)) throw new Error(`${id}: handler result contains unexpected field "${key}".`);
    }
  }
  return data;
}

function publicContract(action) {
  return {
    id: action.id,
    label: action.label,
    description: action.description,
    feature: action.feature,
    inputSchema: cloneContractValue(action.inputSchema),
    resultSchema: cloneContractValue(action.resultSchema),
    availability: { description: action.availability.description },
    permission: action.permission,
    risk: action.risk,
    confirmation: action.confirmation,
    sideEffects: [...action.sideEffects],
    sourceControls: [...action.sourceControls],
    testId: action.testId
  };
}

function normalizeAvailability(value) {
  if (typeof value === 'boolean') return { available: value, reason: value ? null : 'Action is currently unavailable.' };
  if (!isPlainObject(value) || typeof value.available !== 'boolean') throw new Error('Availability check returned an invalid result.');
  const reason = value.reason === undefined || value.reason === null ? null : String(value.reason).slice(0, 240);
  if (!value.available && !reason) return { available: false, reason: 'Action is currently unavailable.' };
  return { available: value.available, reason };
}

function requestedActionId(id) {
  return String(id === undefined || id === null ? '' : id);
}

function errorResult(status, actionId, correlationId, code, message) {
  return { status, actionId, correlationId, error: { code, message: String(message).slice(0, 500) } };
}

export function createActionRegistry(actions, { correlationIdFactory = randomUUID } = {}) {
  if (!Array.isArray(actions)) throw new Error('Action registry requires an array of action contracts.');
  if (typeof correlationIdFactory !== 'function') throw new Error('Action registry correlationIdFactory must be a function.');
  const entries = new Map();
  for (const action of actions) {
    validateDefinition(action);
    if (entries.has(action.id)) throw new Error(`Duplicate action id: ${action.id}`);
    entries.set(action.id, Object.freeze({
      ...action,
      inputSchema: deepFreeze(cloneContractValue(action.inputSchema)),
      resultSchema: deepFreeze(cloneContractValue(action.resultSchema)),
      availability: Object.freeze({ ...action.availability }),
      sideEffects: Object.freeze([...action.sideEffects]),
      sourceControls: Object.freeze([...action.sourceControls])
    }));
  }

  function correlationId() {
    const value = String(correlationIdFactory());
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new Error('Action correlation ID factory returned an invalid identifier.');
    return value;
  }

  function list() {
    return [...entries.values()].map(publicContract);
  }

  async function inspect(id, context = {}) {
    const action = entries.get(requestedActionId(id));
    if (!action) return null;
    let availability;
    try { availability = normalizeAvailability(await action.availability.check(context)); }
    catch { availability = { available: false, reason: 'Availability check failed.' }; }
    const scopes = Array.isArray(context.scopes) ? context.scopes : [];
    return { ...publicContract(action), availability: { ...publicContract(action).availability, ...availability }, permitted: scopes.includes(action.permission) };
  }

  async function invoke(id, rawArgs, context = {}) {
    const requestedId = requestedActionId(id);
    const actionId = requestedId.slice(0, 80);
    let trace;
    try { trace = correlationId(); }
    catch (error) { return errorResult('failed', actionId, '', 'CORRELATION_ID_FAILURE', error.message); }
    const visibleActionIds = Array.isArray(context.allowedActionIds) ? new Set(context.allowedActionIds) : null;
    const action = visibleActionIds && !visibleActionIds.has(requestedId) ? null : entries.get(requestedId);
    if (!action) return errorResult('blocked', actionId, trace, 'UNKNOWN_ACTION', `Unknown action: ${actionId || '<empty>'}`);

    const actor = typeof context.actor === 'string' ? context.actor : '';
    const scopes = Array.isArray(context.scopes) ? context.scopes.filter((scope) => typeof scope === 'string') : [];
    if (!actor || !scopes.includes(action.permission)) {
      return errorResult('blocked', actionId, trace, 'UNAUTHORIZED', `Caller is not authorised for ${action.permission}.`);
    }
    if (context.signal?.aborted) return errorResult('cancelled', actionId, trace, 'CANCELLED', 'Action was cancelled before execution.');

    let availability;
    try { availability = normalizeAvailability(await action.availability.check(context)); }
    catch { return errorResult('unavailable', actionId, trace, 'AVAILABILITY_CHECK_FAILED', 'Availability check failed.'); }
    if (!availability.available) return errorResult('unavailable', actionId, trace, 'UNAVAILABLE', availability.reason);

    let args;
    try { args = validateActionArgs(actionId, action.inputSchema, rawArgs); }
    catch (error) { return errorResult('blocked', actionId, trace, 'INVALID_ARGUMENTS', error.message); }

    try {
      const data = validateActionResult(actionId, action.resultSchema, await action.handler(args, { ...context, actor, scopes, correlationId: trace }));
      if (action.confirmation !== ACTION_CONFIRMATIONS.NONE && data.confirmation_required !== true) {
        return errorResult('failed', actionId, trace, 'INVALID_CONFIRMATION_RESULT', 'Confirmation-gated action did not return a confirmation proposal.');
      }
      const status = action.confirmation === ACTION_CONFIRMATIONS.USER
        ? 'needs_confirmation'
        : action.confirmation === ACTION_CONFIRMATIONS.APPROVAL ? 'needs_approval' : 'success';
      return { status, actionId, correlationId: trace, args, data };
    } catch {
      return errorResult('failed', actionId, trace, 'HANDLER_FAILED', `Action failed safely. Reference ${trace}.`);
    }
  }

  return Object.freeze({ list, inspect, invoke });
}
