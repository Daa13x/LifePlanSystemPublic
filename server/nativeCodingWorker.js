import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TASK_ID = /^code-[A-Za-z0-9-]+$/;
const MAX_CONTEXT_BYTES = 240000;
const MAX_FILE_BYTES = 120000;
const MAX_OUTPUT_BYTES = 800000;

export const NATIVE_CODING_VALIDATIONS = Object.freeze({
  syntax: 'Git diff + JavaScript/JSON syntax where supported',
  frontend: 'Frontend production build (changes restricted to src/)'
});

function normalize(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function hasTraversal(value) {
  return normalize(value).split('/').some((part) => part === '..');
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function taskSeal(task) {
  return digest({
    title: task.title,
    objective: task.objective,
    allowedPaths: task.allowedPaths,
    maxFilesChanged: task.maxFilesChanged,
    validation: task.validation,
    createdAt: task.createdAt
  });
}

function nearestExistingParent(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No existing parent was found for the proposed file.');
    current = parent;
  }
  return current;
}

export function parseNativeCodingResponse(text) {
  let raw = String(text || '').trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) raw = fenced[1];
  if (Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) throw new Error('Coding model response exceeded the output limit.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Coding model did not return valid JSON. No files were changed.'); }
  if (!parsed || !Array.isArray(parsed.edits) || !parsed.edits.length) throw new Error('Coding model returned no edits.');
  return { summary: String(parsed.summary || '').trim().slice(0, 2000), edits: parsed.edits };
}

export function buildNativeCodingSystemPrompt({ allowedPaths, maxFilesChanged, validation }) {
  return [
    'You are the local Coder worker inside Life Planner System.',
    'Work only from the supplied repository evidence. Never claim to have run tools or tests.',
    `You may edit only these paths: ${allowedPaths.join(', ')}.`,
    `Return at most ${maxFilesChanged} complete text-file replacements.`,
    `The independent Checker will run: ${NATIVE_CODING_VALIDATIONS[validation]}.`,
    'Output exactly one JSON object with this schema:',
    '{"summary":"short explanation","edits":[{"path":"relative/path","content":"complete file content"}]}',
    'No markdown fences, prose outside JSON, deletion, rename, binary content, commands, Git operations, secrets, or paths not shown in the context.'
  ].join('\n');
}

export class NativeCodingWorker {
  constructor({ root, runGit, runValidation, invokeModel, forbiddenPath }) {
    this.root = path.resolve(root);
    this.runGit = runGit;
    this.runValidation = runValidation;
    this.invokeModel = invokeModel;
    this.forbiddenPath = forbiddenPath;
    this.baseDir = path.join(this.root, '.lps', 'native-code');
    this.taskDir = path.join(this.baseDir, 'tasks');
    this.worktreeDir = path.join(this.baseDir, 'worktrees');
    this.active = new Map();
    this.reserved = false;
    this.recoverInterruptedTasks();
  }

  recoverInterruptedTasks() {
    if (!fs.existsSync(this.taskDir)) return;
    for (const name of fs.readdirSync(this.taskDir).filter((item) => item.endsWith('.json'))) {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(this.taskDir, name), 'utf8'));
        if (!['running', 'applying'].includes(task.status)) continue;
        const wasApplying = task.status === 'applying';
        task.status = wasApplying ? 'apply-interrupted' : 'interrupted';
        task.phase = task.status;
        task.error = wasApplying
          ? 'LPS stopped while applying this patch. Inspect Source changes before any further action; LPS will not guess whether the patch reached the live checkout.'
          : 'The LPS process stopped while this task was running. Reject it or explicitly rerun it; no model output from the interrupted process will be accepted.';
        this.record(task, 'restart_recovery', 'deny', task.error);
        this.save(task);
      } catch { /* unreadable task records stay inert and are omitted from the UI */ }
    }
  }

  taskFile(id) {
    if (!TASK_ID.test(String(id || ''))) throw new Error('Invalid coding task id.');
    return path.join(this.taskDir, `${id}.json`);
  }

  load(id) {
    const file = this.taskFile(id);
    if (!fs.existsSync(file)) throw new Error('Coding task not found.');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  save(task) {
    task.updatedAt = new Date().toISOString();
    atomicJson(this.taskFile(task.id), task);
    return task;
  }

  record(task, phase, verdict, detail = '') {
    task.audit = Array.isArray(task.audit) ? task.audit : [];
    task.audit.push({ at: new Date().toISOString(), phase, verdict, detail: String(detail).slice(0, 500), evidenceHash: digest(`${phase}\n${verdict}\n${detail}`) });
    task.audit = task.audit.slice(-100);
  }

  list() {
    if (!fs.existsSync(this.taskDir)) return [];
    return fs.readdirSync(this.taskDir).filter((name) => name.endsWith('.json')).map((name) => {
      try { return JSON.parse(fs.readFileSync(path.join(this.taskDir, name), 'utf8')); } catch { return null; }
    }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30);
  }

  async cleanupOrphanedWorktrees() {
    if (this.active.size || !fs.existsSync(this.worktreeDir)) return [];
    const removed = [];
    for (const name of fs.readdirSync(this.worktreeDir)) {
      if (!TASK_ID.test(name)) continue;
      let task = null;
      try { task = this.load(name); } catch { /* an unreadable/missing record cannot authorize preserving a repository copy */ }
      if (task && ['review', 'running', 'applying'].includes(task.status)) continue;
      const worktree = path.join(this.worktreeDir, name);
      const result = await this.runGit(['worktree', 'remove', '--force', worktree]);
      if (result.ok || !fs.existsSync(worktree)) removed.push(name);
      else if (task) {
        task.cleanupPending = true;
        this.record(task, 'orphan_cleanup', 'deny', result.stderr || 'Orphaned worktree cleanup failed.');
        this.save(task);
      }
    }
    return removed;
  }

  create(input = {}) {
    const title = String(input.title || '').trim().slice(0, 160);
    const objective = String(input.objective || '').trim().slice(0, 6000);
    const allowedPaths = [...new Set((Array.isArray(input.allowedPaths) ? input.allowedPaths : String(input.allowedPaths || '').split('\n')).map(normalize).filter(Boolean))];
    if (!title || !objective || !allowedPaths.length) throw new Error('Title, objective, and at least one allowed path are required.');
    for (const item of allowedPaths) {
      if (path.isAbsolute(item) || hasTraversal(item) || this.forbiddenPath(item)) throw new Error(`Allowed path is unsafe or protected: ${item}`);
    }
    const maxFilesChanged = Math.max(1, Math.min(5, Math.floor(Number(input.maxFilesChanged) || 3)));
    const validation = Object.hasOwn(NATIVE_CODING_VALIDATIONS, input.validation) ? input.validation : 'syntax';
    const createdAt = new Date().toISOString();
    const task = {
      id: `code-${createdAt.replace(/[^0-9]/g, '')}-${crypto.randomBytes(3).toString('hex')}`,
      title, objective, allowedPaths, maxFilesChanged, validation,
      status: 'pending', phase: 'awaiting_run_approval', createdAt, updatedAt: createdAt,
      summary: '', changedFiles: [], validationResult: null, diff: '', error: '', baseCommit: '', model: null, audit: []
    };
    task.taskHash = taskSeal(task);
    this.record(task, 'create', 'allow', `Task scope sealed as ${task.taskHash}.`);
    return this.save(task);
  }

  resolveAllowed(task, worktree, relative) {
    const normalized = normalize(relative);
    if (!normalized || path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || this.forbiddenPath(normalized)) {
      throw new Error(`Model attempted an unsafe or protected path: ${relative}`);
    }
    const permitted = task.allowedPaths.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed}/`));
    if (!permitted) throw new Error(`Model attempted a path outside the approved scope: ${normalized}`);
    const absolute = path.resolve(worktree, normalized);
    if (!inside(worktree, absolute)) throw new Error(`Model path escaped its isolated worktree: ${normalized}`);
    const realWorktree = fs.realpathSync.native(worktree);
    const realAnchor = fs.realpathSync.native(nearestExistingParent(absolute));
    if (!inside(realWorktree, realAnchor)) throw new Error(`Model path traversed a symlink or junction outside its worktree: ${normalized}`);
    if (fs.existsSync(absolute) && !inside(realWorktree, fs.realpathSync.native(absolute))) throw new Error(`Existing model target resolves outside its worktree: ${normalized}`);
    return { normalized, absolute };
  }

  collectContext(worktree, allowedPaths) {
    const files = [];
    let total = 0;
    const visit = (absolute) => {
      if (!fs.existsSync(absolute)) return;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(absolute).sort()) {
          if (['node_modules', '.git', '.lps', 'dist', 'release'].includes(name)) continue;
          visit(path.join(absolute, name));
          if (total >= MAX_CONTEXT_BYTES) break;
        }
        return;
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || total + stat.size > MAX_CONTEXT_BYTES) return;
      const content = fs.readFileSync(absolute, 'utf8');
      if (content.includes('\0')) return;
      const relative = path.relative(worktree, absolute).replaceAll('\\', '/');
      if (this.forbiddenPath(relative)) return;
      files.push({ path: relative, content });
      total += Buffer.byteLength(content);
    };
    const realWorktree = fs.realpathSync.native(worktree);
    for (const allowed of allowedPaths) {
      if (hasTraversal(allowed)) throw new Error(`Approved context path contains traversal: ${allowed}`);
      const absolute = path.resolve(worktree, allowed);
      if (!inside(worktree, absolute)) throw new Error(`Approved context path escapes its isolated worktree: ${allowed}`);
      if (fs.existsSync(absolute) && !inside(realWorktree, fs.realpathSync.native(absolute))) throw new Error(`Approved context path traverses a symlink or junction: ${allowed}`);
      visit(absolute);
    }
    if (!files.length) throw new Error('No readable text files were found in the approved paths.');
    return files;
  }

  async run(id, approval = {}) {
    const task = this.load(id);
    if (approval.confirm !== true) throw new Error('Explicit run approval is required.');
    if (taskSeal(task) !== task.taskHash || approval.taskHash !== task.taskHash) throw new Error('Run approval does not match the current sealed task scope. Refresh and approve again.');
    if (!['pending', 'failed', 'interrupted', 'cancelled'].includes(task.status)) throw new Error(`Task cannot run from status ${task.status}.`);
    if (this.reserved || this.active.size) throw new Error('Another native coding task is active. LPS runs one mutation-capable worker at a time.');
    this.reserved = true;
    let status;
    let head;
    try {
      if (['interrupted', 'cancelled'].includes(task.status)) await this.cleanupWorktree(task);
      status = await this.runGit(['status', '--porcelain=v1']);
      if (!status.ok || status.stdout.trim()) throw new Error('The live checkout must be clean before a coding worktree is created.');
      head = await this.runGit(['rev-parse', 'HEAD']);
      if (!head.ok) throw new Error(head.stderr || 'Unable to pin the task base commit.');
    } catch (error) {
      this.reserved = false;
      throw error;
    }
    const controller = new AbortController();
    this.active.set(task.id, controller);
    this.reserved = false;
    task.baseCommit = head.stdout.trim();
    task.status = 'running'; task.phase = 'creating_isolated_worktree'; task.error = '';
    task.runApprovedAt = new Date().toISOString(); task.runApprovedBy = String(approval.approvedBy || 'user').slice(0, 80);
    this.record(task, 'run_approval', 'allow', `One-shot approval matched task hash ${task.taskHash}.`);
    this.save(task);
    const worktree = path.join(this.worktreeDir, task.id);
    let preserve = false;
    try {
      fs.mkdirSync(this.worktreeDir, { recursive: true });
      const added = await this.runGit(['worktree', 'add', '--detach', worktree, task.baseCommit]);
      if (!added.ok) throw new Error(added.stderr || 'Unable to create isolated coding worktree.');
      this.currentTask = task;
      task.phase = 'reading_approved_context'; this.save(task);
      const context = this.collectContext(worktree, task.allowedPaths);
      task.phase = 'local_coder_inference'; this.save(task);
      const response = await this.invokeModel({
        systemPrompt: buildNativeCodingSystemPrompt(task),
        prompt: [`Task: ${task.title}`, task.objective, '', 'Approved repository files:', ...context.map((file) => `\n--- ${file.path} ---\n${file.content}`)].join('\n'),
        task,
        signal: controller.signal
      });
      if (controller.signal.aborted) throw new Error('Coding task cancelled before model output was accepted.');
      task.model = response.model;
      const proposal = parseNativeCodingResponse(response.content);
      if (proposal.edits.length > task.maxFilesChanged) throw new Error(`Model proposed ${proposal.edits.length} files; limit is ${task.maxFilesChanged}.`);
      task.phase = 'applying_in_isolation'; this.save(task);
      const changed = [];
      for (const edit of proposal.edits) {
        const target = this.resolveAllowed(task, worktree, edit.path);
        if (typeof edit.content !== 'string' || edit.content.includes('\0') || Buffer.byteLength(edit.content) > MAX_FILE_BYTES) throw new Error(`Invalid or oversized text content for ${target.normalized}.`);
        fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
        fs.writeFileSync(target.absolute, edit.content, 'utf8');
        changed.push(target.normalized);
      }
      const intent = await this.runGit(['-C', worktree, 'add', '-N', '--', ...changed]);
      if (!intent.ok) throw new Error(intent.stderr || 'Unable to prepare new files for an exact review patch.');
      task.phase = 'independent_validation'; this.save(task);
      const validationResult = await this.runValidation({ worktree, validation: task.validation, changedFiles: changed });
      const actual = await this.runGit(['-C', worktree, 'status', '--porcelain=v1', '-z']);
      const entries = String(actual.stdout || '').split('\0');
      const actualPaths = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!entry) continue;
        const statusCode = entry.slice(0, 2);
        actualPaths.push(normalize(entry.slice(3)));
        if (statusCode.includes('R') || statusCode.includes('C')) index += 1;
      }
      if (!actual.ok || actualPaths.length > task.maxFilesChanged || actualPaths.some((item) => !changed.includes(item))) throw new Error('Actual worktree changes did not match the approved model proposal.');
      if (!validationResult.ok) throw new Error(`Independent validation failed: ${validationResult.output}`);
      const diff = await this.runGit(['-C', worktree, 'diff', '--no-ext-diff', '--binary', 'HEAD']);
      if (!diff.ok || !diff.stdout.trim()) throw new Error('Coding task produced no reviewable diff.');
      task.summary = proposal.summary; task.changedFiles = actualPaths; task.validationResult = { ...validationResult, evidenceHash: digest(validationResult) };
      task.diff = diff.stdout; task.status = 'review'; task.phase = 'awaiting_apply_approval';
      task.patchHash = digest(task.diff);
      this.record(task, 'independent_validation', 'allow', `Validation evidence ${task.validationResult.evidenceHash}; patch ${task.patchHash}.`);
      preserve = true;
      return this.save(task);
    } catch (error) {
      task.status = controller.signal.aborted ? 'cancelled' : 'failed'; task.phase = task.status; task.error = error.message;
      this.record(task, task.phase, 'deny', error.message);
      this.save(task);
      throw error;
    } finally {
      this.active.delete(task.id);
      if (!preserve && fs.existsSync(worktree)) await this.runGit(['worktree', 'remove', '--force', worktree]);
    }
  }

  async apply(id, approval = {}) {
    const task = this.load(id);
    if (approval.confirm !== true || task.status !== 'review') throw new Error('A review-ready task and explicit apply approval are required.');
    if (approval.patchHash !== task.patchHash || digest(task.diff) !== task.patchHash) throw new Error('Apply approval does not match the reviewed patch. Refresh and approve again.');
    const [head, status] = await Promise.all([this.runGit(['rev-parse', 'HEAD']), this.runGit(['status', '--porcelain=v1'])]);
    if (!head.ok || head.stdout.trim() !== task.baseCommit) throw new Error('Live HEAD changed since generation. Regenerate the task from the new base.');
    if (!status.ok || status.stdout.trim()) throw new Error('Live checkout must be clean before applying a reviewed patch.');
    const patchFile = path.join(this.baseDir, `${task.id}.patch`);
    fs.writeFileSync(patchFile, task.diff, 'utf8');
    const check = await this.runGit(['apply', '--check', patchFile]);
    if (!check.ok) throw new Error(check.stderr || 'Patch no longer applies cleanly.');
    task.status = 'applying'; task.phase = 'applying_reviewed_patch';
    this.record(task, 'apply_start', 'allow', `Patch ${task.patchHash} passed git apply --check.`);
    this.save(task);
    const applied = await this.runGit(['apply', patchFile]);
    if (!applied.ok) {
      task.status = 'review'; task.phase = 'awaiting_apply_approval';
      this.record(task, 'apply', 'deny', applied.stderr || 'Patch apply failed.');
      this.save(task);
      throw new Error(applied.stderr || 'Patch apply failed.');
    }
    task.status = 'applied'; task.phase = 'complete'; task.appliedAt = new Date().toISOString(); task.appliedBy = String(approval.approvedBy || 'user').slice(0, 80);
    this.record(task, 'apply_approval', 'allow', `One-shot approval matched patch hash ${task.patchHash}.`);
    try {
      this.save(task);
    } catch (error) {
      const reversed = await this.runGit(['apply', '--reverse', patchFile]);
      if (!reversed.ok) throw new Error(`Patch applied but result persistence failed, and rollback also failed: ${reversed.stderr || error.message}`);
      task.status = 'review'; task.phase = 'awaiting_apply_approval'; task.appliedAt = '';
      throw new Error(`Patch result persistence failed; the live patch was rolled back: ${error.message}`);
    }
    try {
      await this.cleanupWorktree(task);
    } catch (error) {
      task.cleanupPending = true;
      this.record(task, 'cleanup', 'deny', `Patch applied successfully, but isolated cleanup remains pending: ${error.message}`);
      try { this.save(task); } catch { /* applied state was already durably recorded */ }
    }
    return task;
  }

  async reject(id) {
    const task = this.load(id);
    if (!['review', 'failed', 'pending', 'interrupted', 'cancelled'].includes(task.status)) throw new Error(`Task cannot be rejected from status ${task.status}.`);
    task.status = 'rejected'; task.phase = 'complete'; task.rejectedAt = new Date().toISOString();
    this.record(task, 'reject', 'allow', 'User rejected the proposal; no live checkout change was accepted.');
    this.save(task);
    await this.cleanupWorktree(task);
    return task;
  }

  cancel(id) {
    const task = this.load(id);
    const controller = this.active.get(task.id);
    if (!controller) throw new Error('Coding task is not actively running.');
    controller.abort();
    this.record(task, 'cancel_request', 'allow', 'User requested cancellation.');
    this.save(task);
    return task;
  }

  async cleanupWorktree(task) {
    const worktree = path.join(this.worktreeDir, task.id);
    if (fs.existsSync(worktree)) await this.runGit(['worktree', 'remove', '--force', worktree]);
    const patch = path.join(this.baseDir, `${task.id}.patch`);
    if (fs.existsSync(patch)) fs.unlinkSync(patch);
  }
}
