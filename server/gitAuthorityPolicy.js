const REQUIRED_CLOUD_BRANCH = 'main';

export const GIT_AUTHORITY_POLICY = Object.freeze({
  requiredCloudBranch: REQUIRED_CLOUD_BRANCH,
  approvedRepositories: Object.freeze([
    'daa13x/lifeplansystem',
    'daa13x/lifeplansystempublic'
  ]),
  approvedLocalControllers: Object.freeze([
    'lifeplansystem-native-coding-controller',
    'lifeplansystem-openhands-controller'
  ])
});

const APPROVED_REPOSITORIES = new Set(GIT_AUTHORITY_POLICY.approvedRepositories);
const APPROVED_LOCAL_CONTROLLERS = new Set(GIT_AUTHORITY_POLICY.approvedLocalControllers);
const CLOUD_BRANCH_OPERATIONS = new Set([
  'create_branch',
  'switch_branch',
  'branch_worktree',
  'detached_worktree',
  'create_pr',
  'delete_branch',
  'delegate_branch'
]);
const LOCAL_FORBIDDEN_OPERATIONS = new Set([
  'push',
  'push_main',
  'merge',
  'integrate_main',
  'create_pr',
  'delete_branch'
]);
const CLOUD_MAIN_OPERATIONS = new Set(['write_main', 'commit_main', 'push_main', 'integrate_main']);
const KNOWN_OPERATIONS = new Set([
  ...CLOUD_BRANCH_OPERATIONS,
  ...LOCAL_FORBIDDEN_OPERATIONS,
  ...CLOUD_MAIN_OPERATIONS,
  'read',
  'review',
  'create_branch',
  'branch_worktree',
  'detached_worktree'
]);
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

function text(value) {
  return String(value || '').trim();
}

function slug(value, fallback = 'local-model') {
  const normalized = text(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

export function repositoryIdentity(value = '') {
  const raw = text(value);
  if (!raw || /[\0\n\r]/.test(raw)) return '';
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return raw.toLowerCase();

  const scp = raw.match(/^git@github\.com:([^/\s]+)\/(.+?)(?:\.git)?$/i);
  if (scp) return `${scp[1]}/${scp[2].replace(/\.git$/i, '')}`.toLowerCase();

  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password) return '';
    const parts = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length !== 2) return '';
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  } catch {
    return '';
  }
}

export function isLoopbackInferenceEndpoint(value = '') {
  try {
    const parsed = new URL(text(value));
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return ['http:', 'https:'].includes(parsed.protocol)
      && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1');
  } catch {
    return false;
  }
}

export function generatedLocalBranch({ taskId, modelId = '', namespace = 'agent' } = {}) {
  const task = text(taskId);
  if (!SAFE_TASK_ID.test(task)) throw new Error('A safe task ID is required before generating a local-model branch.');
  if (namespace === 'model') return `local-model/${slug(modelId)}/${task}`;
  if (namespace === 'agent') return `local-agent/${task}`;
  throw new Error('Local branch namespace must be "agent" or "model".');
}

export function isGeneratedLocalBranch(branch, { taskId, modelId = '' } = {}) {
  const candidate = text(branch);
  if (!candidate || !SAFE_TASK_ID.test(text(taskId))) return false;
  return candidate === generatedLocalBranch({ taskId, namespace: 'agent' })
    || candidate === generatedLocalBranch({ taskId, modelId, namespace: 'model' });
}

export function classifyExecutionAuthority(input = {}) {
  const requestedExecutionType = text(input.executionType).toLowerCase() || 'unknown';
  const provider = text(input.modelProvider || input.provider);
  const modelId = text(input.modelId || input.model);
  const controller = text(input.branchCreator || input.controller);
  const endpointIsLoopback = isLoopbackInferenceEndpoint(input.inferenceEndpoint || input.endpoint);
  const checks = [
    { gate: 'execution_type_local', ok: requestedExecutionType === 'local' },
    { gate: 'model_provider_recorded', ok: Boolean(provider) },
    { gate: 'model_id_recorded', ok: Boolean(modelId) },
    { gate: 'approved_local_controller', ok: APPROVED_LOCAL_CONTROLLERS.has(controller) },
    { gate: 'loopback_inference_endpoint', ok: endpointIsLoopback },
    { gate: 'local_inference_verified', ok: input.localInferenceVerified === true }
  ];
  const provenLocal = checks.every((check) => check.ok);
  return {
    executionType: provenLocal ? 'local' : 'cloud',
    requestedExecutionType,
    provenLocal,
    provider,
    modelId,
    controller,
    endpointIsLoopback,
    checks,
    reason: provenLocal
      ? 'Local inference and the approved LifePlanSystem controller were verified.'
      : `Local inference was not proven; fail-closed classification is cloud (${checks.filter((check) => !check.ok).map((check) => check.gate).join(', ')}).`
  };
}

function permissionsFor({ authority, operation, allowed }) {
  const cloudMain = authority.executionType === 'cloud' && CLOUD_MAIN_OPERATIONS.has(operation) && allowed;
  const localBranch = authority.executionType === 'local' && ['create_branch', 'branch_worktree'].includes(operation) && allowed;
  const localDetached = authority.executionType === 'local' && operation === 'detached_worktree' && allowed;
  return {
    writeMain: cloudMain,
    commitMain: cloudMain && operation === 'commit_main',
    pushMain: cloudMain && operation === 'push_main',
    integrateToMain: cloudMain && operation === 'integrate_main',
    createBranch: localBranch,
    createBranchBackedWorktree: localBranch && operation === 'branch_worktree',
    createDetachedWorktree: localDetached,
    pushBranch: false,
    mergeBranch: false,
    deleteBranch: false,
    createPullRequest: false,
    modifyProtectedPaths: false
  };
}

export function evaluateGitAuthority(input = {}) {
  const operation = text(input.operation).toLowerCase();
  const authority = classifyExecutionAuthority(input);
  const activeBranch = text(input.activeBranch);
  const startingBranch = text(input.startingBranch || activeBranch);
  const taskId = text(input.taskId);
  const targetBranch = text(input.targetBranch);
  const repository = repositoryIdentity(input.repository || input.remoteUrl);
  const allowedPaths = Array.isArray(input.allowedPaths) ? input.allowedPaths.filter((item) => text(item)) : [];
  const protectedPathHits = Array.isArray(input.protectedPathHits) ? input.protectedPathHits.filter((item) => text(item)) : [];
  const checks = [];
  const check = (gate, ok, detail) => {
    checks.push({ gate, ok: Boolean(ok), detail });
    return Boolean(ok);
  };

  check('known_operation', KNOWN_OPERATIONS.has(operation), operation || 'operation missing');

  if (authority.executionType === 'cloud') {
    const branchAllowed = !CLOUD_MAIN_OPERATIONS.has(operation) || activeBranch === REQUIRED_CLOUD_BRANCH;
    check('cloud_required_branch_main', branchAllowed,
      branchAllowed ? `active branch is ${activeBranch || '(not needed for read/review)'}` : `cloud write branch is ${activeBranch || '(detached)'}, not main`);
    check('cloud_branch_operations_denied', !CLOUD_BRANCH_OPERATIONS.has(operation),
      CLOUD_BRANCH_OPERATIONS.has(operation) ? `${operation} is denied to cloud-controlled workflows` : `${operation} does not create, switch, delete, or delegate a branch`);
    check('cloud_operation_allowed', ['read', 'review', ...CLOUD_MAIN_OPERATIONS].includes(operation),
      `${operation || '(missing)'} must be a read/review or a direct-main operation`);
  } else {
    check('local_forbidden_operations_denied', !LOCAL_FORBIDDEN_OPERATIONS.has(operation),
      LOCAL_FORBIDDEN_OPERATIONS.has(operation) ? `${operation} is never granted to a local-model workflow` : `${operation} stays inside the proposal boundary`);
    check('local_operation_supported', ['read', 'review', 'create_branch', 'branch_worktree', 'detached_worktree'].includes(operation),
      `${operation || '(missing)'} must be a supported local proposal operation`);

    if (['create_branch', 'branch_worktree', 'detached_worktree'].includes(operation)) {
      check('approved_repository', APPROVED_REPOSITORIES.has(repository), repository || 'repository identity missing or unapproved');
      check('starting_branch_main', startingBranch === REQUIRED_CLOUD_BRANCH, startingBranch || '(detached)');
      check('active_branch_main_before_isolation', activeBranch === REQUIRED_CLOUD_BRANCH, activeBranch || '(detached)');
      check('clean_worktree', input.worktreeClean === true, input.worktreeClean === true ? 'clean' : 'dirty or unverified');
      check('starting_commit_recorded', COMMIT_SHA.test(text(input.startingCommit)), text(input.startingCommit) || 'missing');
      check('task_card_valid', input.taskCardValid === true && SAFE_TASK_ID.test(taskId), taskId || 'missing/invalid task ID');
      check('allowed_paths_present', allowedPaths.length > 0, `${allowedPaths.length} path(s)`);
      check('protected_paths_denied', protectedPathHits.length === 0, protectedPathHits.join(', ') || 'none');
      check('approved_branch_creator', APPROVED_LOCAL_CONTROLLERS.has(authority.controller), authority.controller || 'missing');
      if (operation !== 'detached_worktree') {
        check('generated_local_branch_name', isGeneratedLocalBranch(targetBranch, { taskId, modelId: authority.modelId }), targetBranch || 'missing');
      }
    }
  }

  const allowed = checks.every((item) => item.ok);
  const permissions = permissionsFor({ authority, operation, allowed });
  const receipt = {
    executionType: authority.executionType,
    modelProvider: authority.provider || 'unknown',
    modelId: authority.modelId || 'unknown',
    repository: repository || 'unknown',
    startingCommit: text(input.startingCommit) || 'unknown',
    activeBranch: activeBranch || 'detached',
    branchCreator: authority.controller || 'unknown',
    taskId: taskId || 'unknown',
    operation,
    targetBranch: targetBranch || null,
    permissions
  };

  return {
    allowed,
    classification: authority,
    checks,
    receipt,
    reason: allowed
      ? `${authority.executionType} ${operation} is within Git authority policy.`
      : `Git authority denied ${operation || 'the operation'}: ${checks.filter((item) => !item.ok).map((item) => item.gate).join(', ')}.`
  };
}

export function cloudMainWritePreflight(activeBranch) {
  const branch = text(activeBranch);
  return {
    allowed: branch === REQUIRED_CLOUD_BRANCH,
    activeBranch: branch || 'detached',
    requiredBranch: REQUIRED_CLOUD_BRANCH,
    reason: branch === REQUIRED_CLOUD_BRANCH
      ? 'Cloud write preflight passed on main.'
      : `Cloud write preflight failed: active branch is ${branch || 'detached'}, required branch is main.`
  };
}
