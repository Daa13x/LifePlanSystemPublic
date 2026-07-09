const REQUIRED_FIELDS = [
  'task_type',
  'selected_skills',
  'agent_target',
  'result_quality',
  'mistakes',
  'lesson',
  'skill_update_candidate',
  'memory_route',
  'approval_required'
];

const ALLOWED_AGENT_TARGETS = ['chatgpt', 'claude', 'codex', 'fable', 'human'];
const ALLOWED_RESULT_QUALITY = ['success', 'partial', 'blocked', 'unsafe', 'unknown'];
const ALLOWED_MEMORY_ROUTES = [
  'ignore',
  'temporary_handoff',
  'mistake_warning',
  'skill_improvement_candidate',
  'memory_inbox_candidate',
  'source_of_truth_candidate_requires_approval'
];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validateStringArray(value, field, { requireNonEmptyItems = false } = {}) {
  if (!Array.isArray(value)) {
    return [`${field} must be an array`];
  }

  const errors = [];
  value.forEach((item, index) => {
    const ok = requireNonEmptyItems ? isNonEmptyString(item) : typeof item === 'string';
    if (!ok) {
      errors.push(`${field}[${index}] must be ${requireNonEmptyItems ? 'a non-empty string' : 'a string'}`);
    }
  });
  return errors;
}

export function validateLocalLearningEvent(event) {
  const errors = [];

  if (!isRecord(event)) {
    return { ok: false, errors: ['event must be an object'] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!hasOwn(event, field)) {
      errors.push(`${field} is required`);
    }
  }

  for (const field of Object.keys(event)) {
    if (!REQUIRED_FIELDS.includes(field)) {
      errors.push(`${field} is not an allowed field`);
    }
  }

  if (hasOwn(event, 'task_type') && !isNonEmptyString(event.task_type)) {
    errors.push('task_type must be a non-empty string');
  }

  if (hasOwn(event, 'selected_skills')) {
    errors.push(...validateStringArray(event.selected_skills, 'selected_skills', { requireNonEmptyItems: true }));
  }

  if (hasOwn(event, 'agent_target') && !ALLOWED_AGENT_TARGETS.includes(event.agent_target)) {
    errors.push(`agent_target must be one of ${ALLOWED_AGENT_TARGETS.join(', ')}`);
  }

  if (hasOwn(event, 'result_quality') && !ALLOWED_RESULT_QUALITY.includes(event.result_quality)) {
    errors.push(`result_quality must be one of ${ALLOWED_RESULT_QUALITY.join(', ')}`);
  }

  if (hasOwn(event, 'mistakes')) {
    errors.push(...validateStringArray(event.mistakes, 'mistakes'));
  }

  if (hasOwn(event, 'lesson') && typeof event.lesson !== 'string') {
    errors.push('lesson must be a string');
  }

  if (hasOwn(event, 'skill_update_candidate')) {
    const value = event.skill_update_candidate;
    if (typeof value !== 'string' && !isRecord(value)) {
      errors.push('skill_update_candidate must be an object or string');
    }
  }

  if (hasOwn(event, 'memory_route') && !ALLOWED_MEMORY_ROUTES.includes(event.memory_route)) {
    errors.push(`memory_route must be one of ${ALLOWED_MEMORY_ROUTES.join(', ')}`);
  }

  if (hasOwn(event, 'approval_required') && typeof event.approval_required !== 'boolean') {
    errors.push('approval_required must be a boolean');
  }

  // Fail closed on the sensitive route: a source-of-truth candidate must always
  // require human approval. The route stays a label only (never authorization
  // to write); this check is intentionally stricter than the JSON schema.
  if (event.memory_route === 'source_of_truth_candidate_requires_approval'
    && event.approval_required !== true) {
    errors.push('approval_required must be true when memory_route is source_of_truth_candidate_requires_approval');
  }

  return { ok: errors.length === 0, errors };
}
