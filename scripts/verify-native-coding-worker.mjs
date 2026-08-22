import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NATIVE_CODING_VALIDATIONS, NativeCodingWorker, parseNativeCodingResponse, parseNativeCodingTurn } from '../server/nativeCodingWorker.js';

const execFileAsync = promisify(execFile);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-native-code-'));
const run = async (command, args, cwd = temp) => {
  try {
    const result = await execFileAsync(command, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || ''), stderr: String(error.stderr || error.message) };
  }
};

try {
  await run('git', ['init', '-b', 'main']);
  await run('git', ['config', 'user.name', 'LPS verifier']);
  await run('git', ['config', 'user.email', 'lps-verifier@example.invalid']);
  fs.mkdirSync(path.join(temp, 'src'));
  fs.writeFileSync(path.join(temp, 'src', 'value.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(temp, 'src', 'obsolete.js'), 'export const obsolete = true;\n');
  fs.writeFileSync(path.join(temp, '.gitignore'), '.lps/\n');
  await run('git', ['add', '.']);
  await run('git', ['commit', '-m', 'fixture']);
  await run('git', ['remote', 'add', 'origin', 'https://github.com/Daa13x/LifePlanSystemPublic.git']);

  let modelMode = 'valid';
  const worker = new NativeCodingWorker({
    root: temp,
    runGit: (args) => run('git', args),
    runValidation: async ({ worktree, changedFiles }) => {
      if (modelMode === 'validation-permanent-failure') {
        return { ok: false, output: 'FAIL permanent fixture checker', checks: [{ name: 'permanent fixture checker', ok: false }] };
      }
      if (['validation-repair', 'validation-repair-low-confidence'].includes(modelMode)) {
        const value = fs.readFileSync(path.join(worktree, 'src', 'value.js'), 'utf8');
        const ok = value.includes('value = 3');
        return { ok, output: ok ? 'PASS repaired fixture checker' : 'FAIL fixture requires value = 3', checks: [{ name: 'repaired fixture checker', ok }] };
      }
      return { ok: changedFiles.length === 1, output: 'PASS fixture checker', checks: [{ name: 'fixture checker', ok: true }] };
    },
    invokeModel: async ({ prompt }) => ({
      model: { name: 'fake-local-coder', endpoint: 'http://127.0.0.1:1', source: 'acceptance fixture' },
      content: modelMode === 'tools'
        ? (!prompt.includes('Controller tool result')
          ? JSON.stringify({ tool: { name: 'list_files', path: 'src' } })
          : !prompt.includes('"query":"value"')
            ? JSON.stringify({ tool: { name: 'search', path: 'src', query: 'value' } })
            : !prompt.includes('"startLine":1')
              ? JSON.stringify({ tool: { name: 'read_file', path: 'src/value.js', startLine: 1, endLine: 20 } })
              : JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'The scoped list, search, and file read prove the fixture change.', summary: 'Used scoped evidence.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] }))
        : modelMode === 'tool-escape'
          ? JSON.stringify({ tool: { name: 'read_file', path: 'outside.js', startLine: 1, endLine: 20 } })
          : modelMode === 'tool-loop'
            ? JSON.stringify({ tool: { name: 'list_files', path: 'src' } })
          : modelMode === 'no-change'
        ? JSON.stringify({ action: 'report_no_change', confidence: 0.9, evidence_basis: 'The scoped fixture already exports the intended value, so no source change is warranted.', summary: 'No source mutation is recommended.' })
          : modelMode === 'valid'
        ? JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'The approved fixture source directly shows the exact value to change.', summary: 'Increment the fixture.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] })
        : modelMode === 'delete'
          ? JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'The approved obsolete fixture is present in the scoped source.', summary: 'Remove obsolete fixture.', edits: [{ path: 'src/obsolete.js', delete: true }] })
        : modelMode === 'new'
          ? JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'The approved source directory permits this bounded fixture addition.', summary: 'Add the fixture.', edits: [{ path: 'src/new.js', content: 'export const added = true;\n' }] })
          : modelMode === 'evidence-recovery'
            ? (!prompt.includes('Prior final proposal was below the edit threshold')
              ? JSON.stringify({ action: 'propose_edits', confidence: 0.35, evidence_basis: 'The supplied fixture context does not establish which value the checker expects.', evidence_gaps: ['Read the approved fixture file to verify the expected exported value.'], summary: 'Need the exact approved fixture value.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] })
              : !prompt.includes('Controller tool result')
                ? JSON.stringify({ tool: { name: 'read_file', path: 'src/value.js', startLine: 1, endLine: 20 } })
                : JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'The recovered approved fixture read proves the exact bounded change.', summary: 'Apply the evidence-backed fixture change.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] }))
          : modelMode === 'evidence-exhaustion'
              ? JSON.stringify({ action: 'propose_edits', confidence: 0.35, evidence_basis: 'The available fixture evidence remains insufficient to establish the required external contract.', evidence_gaps: ['Obtain the external contract that defines the required exported value.'], summary: 'The remaining evidence is outside the sealed scope.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] })
          : modelMode === 'validation-permanent-failure'
              ? JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'The approved fixture source supports the same bounded change during checker diagnosis.', summary: 'Retain the bounded fixture proposal.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] })
            : modelMode === 'validation-repair-low-confidence'
              ? (prompt.includes('Independent checker failure')
                ? JSON.stringify({ action: 'propose_edits', confidence: 0.35, evidence_basis: 'The checker failure identifies a mismatch but not the required production contract.', evidence_gaps: ['Read the production contract that defines the required corrected fixture value.'], summary: 'Stop with the concrete missing repair evidence.', edits: [{ path: 'src/value.js', content: 'export const value = 3;\n' }] })
                : JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'The approved fixture source establishes the initial bounded change before checker feedback.', summary: 'Initial value change.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] }))
          : modelMode === 'validation-repair'
            ? (prompt.includes('Independent checker failure')
              ? JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'The checker explicitly requires the corrected fixture value of three.', summary: 'Repair the value from checker feedback.', edits: [{ path: 'src/value.js', content: 'export const value = 3;\n' }] })
              : JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'The approved fixture source establishes an initial bounded change.', summary: 'Initial value change.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] }))
          : modelMode === 'low-confidence'
            ? JSON.stringify({ action: 'propose_edits', confidence: 0.35, evidence_basis: 'The supplied source does not establish the intended production behavior.', evidence_gaps: ['Read the production contract that specifies the intended exported value.'], summary: 'Stop for evidence.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] })
            : JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'This deliberately unsafe fixture is used to test path enforcement.', summary: 'Escape scope.', edits: [{ path: 'outside.js', content: 'bad\n' }] })
    }),
    forbiddenPath: (candidate) => candidate.startsWith('.git') || candidate.startsWith('.lps') || candidate.startsWith('data'),
    getExecutionContext: async () => ({
      executionType: 'local',
      modelProvider: 'fixture-local-model',
      modelId: 'fake-local-coder',
      inferenceEndpoint: 'http://127.0.0.1:1',
      localInferenceVerified: true,
      branchCreator: 'lifeplansystem-native-coding-controller'
    })
  });

  assert.throws(() => parseNativeCodingResponse('not json'), /valid JSON/);
  assert.throws(() => parseNativeCodingResponse(JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'This deliberately contradictory fixture checks the confidence contract.', evidence_gaps: ['Read a concrete missing source fact before claiming review readiness.'], edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] })), /cannot claim edit confidence/);
  assert.deepEqual(Object.keys(NATIVE_CODING_VALIDATIONS), ['syntax', 'frontend', 'runtime', 'project']);
  const productionServer = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(productionServer, /\['run', 'verify:runtime-safety'\]/, 'runtime validation must use the fixed runtime-safety command');
  assert.match(productionServer, /validation === 'project'/, 'full project validation profile must be wired');
  assert.match(productionServer, /const DEFAULT_LLAMA_CONTEXT_SIZE = 16384;/, 'managed llama.cpp must default to a coding-capable context');
  assert.match(productionServer, /managedContextSize.*MIN_CODING_CONTEXT_SIZE/s, 'coding route must detect and replace an undersized managed context');
  assert.match(productionServer, /context size must be an integer from/, 'llama context settings must be bounded');
  assert.match(productionServer, /\/api\/source\/coding\/tasks\/:id\/run\/propose/, 'coding run must start with a durable confirmation proposal route');
  assert.match(productionServer, /\/api\/source\/coding\/tasks\/:id\/run\/confirm/, 'coding run must require the token-backed confirmation route');
  assert.match(productionServer, /\/api\/source\/coding\/tasks\/:id\/apply\/propose/, 'patch apply must start with a durable confirmation proposal route');
  assert.match(productionServer, /confirmAndApply\([\s\S]*codingConfirmationSnapshot/, 'coding confirmations must revalidate the sealed task snapshot before side effects');
  assert.match(productionServer, /execFileWithTreeAbort[\s\S]*options\.signal/, 'runCli forwards cancellation through the bounded process-tree helper');
  const processTreeSource = fs.readFileSync(new URL('../server/processTree.js', import.meta.url), 'utf8');
  assert.match(processTreeSource, /taskkill\.exe[\s\S]*\/T/, 'the bounded helper terminates the full Windows process tree');
  assert.match(processTreeSource, /forceTermination\('timeout'\)/, 'the bounded helper tree-terminates timed-out validation');
  assert.match(processTreeSource, /forceTermination\('maxBuffer'\)/, 'the bounded helper tree-terminates output-limited validation');
  assert.match(processTreeSource, /forceTermination\('abort'\)/, 'the bounded helper tree-terminates cancelled validation');
  assert.match(productionServer, /validateNativeCodingWorktree\(\{ worktree, validation, changedFiles, signal \}\)/, 'native validation accepts the active run cancellation signal');
  assert.throws(() => worker.create({ title: 'Traversal', objective: 'Must fail.', allowedPaths: ['src/../../secret.txt'] }), /unsafe or protected/);
  const baseCommit = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  assert.throws(() => worker.create({ title: 'Unpinned task', objective: 'Must never acquire a base commit after user approval.', allowedPaths: ['src/value.js'] }), /base commit is required/);
  const createTask = (input) => worker.create({ ...input, baseCommit });
  const createPreparedTask = (input) => {
    const prepared = createTask(input);
    prepared.preparation = { status: 'ready', baseCommit, evidenceHash: 'c'.repeat(64), evidence: { anchors: [{ path: prepared.allowedPaths[0] }] } };
    prepared.status = 'prepared';
    prepared.phase = 'evidence_ready';
    worker.save(prepared);
    return prepared;
  };
  const runPreparedTask = (prepared, extra = {}) => worker.run(prepared.id, { confirm: true, taskHash: prepared.taskHash, evidenceHash: prepared.preparation.evidenceHash, adviceHash: '', ...extra });
  const task = createTask({ title: 'Increment fixture', objective: 'Change value from one to two.', allowedPaths: ['src/value.js'], maxFilesChanged: 1, validation: 'syntax' });
  await assert.rejects(worker.run(task.id, { confirm: true, taskHash: 'wrong' }), /sealed task scope/);
  await assert.rejects(worker.run(task.id, { confirm: true, taskHash: task.taskHash }), /Prepare and review scoped workspace evidence/);
  task.preparation = { status: 'ready', baseCommit, evidenceHash: 'a'.repeat(64), evidence: { anchors: [{ path: 'src/value.js' }] } };
  task.status = 'prepared';
  task.phase = 'evidence_ready';
  worker.save(task);
  await assert.rejects(worker.run(task.id, { confirm: true, taskHash: task.taskHash, evidenceHash: 'b'.repeat(64) }), /prepared workspace evidence/);
  const review = await worker.run(task.id, { confirm: true, taskHash: task.taskHash, evidenceHash: task.preparation.evidenceHash, adviceHash: '', approvedBy: 'acceptance' });
  assert.equal(review.status, 'review');
  assert.equal(review.assessment.confidence, 0.9);
  assert.match(review.assessment.evidenceBasis, /approved fixture source/);
  assert.ok(review.audit.some((event) => event.phase === 'model_action_assessment' && event.confidence === 0.9));
  assert.equal(review.changedFiles[0], 'src/value.js');
  assert.match(review.validationResult.evidenceHash, /^[a-f0-9]{64}$/);
  assert.match(review.patchHash, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(temp, 'src', 'value.js'), 'utf8'), 'export const value = 1;\n', 'live checkout changed before approval');
  await assert.rejects(worker.apply(task.id, { confirm: true, patchHash: 'wrong' }), /reviewed patch/);
  const applied = await worker.apply(task.id, { confirm: true, patchHash: review.patchHash, approvedBy: 'acceptance' });
  assert.equal(applied.status, 'applied');
  assert.equal(fs.readFileSync(path.join(temp, 'src', 'value.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const value = 2;\n');
  const status = await run('git', ['status', '--porcelain=v1']);
  assert.match(status.stdout, /src\/value\.js|src\\value\.js/);

  await run('git', ['restore', '--worktree', '--', 'src/value.js']);
  const concurrentApplyTask = createPreparedTask({ title: 'Serialize apply fixture', objective: 'Prove two independently valid apply calls cannot race the same reviewed patch.', allowedPaths: ['src/value.js'], maxFilesChanged: 1, validation: 'syntax' });
  const concurrentApplyReview = await runPreparedTask(concurrentApplyTask);
  const concurrentApplyResults = await Promise.allSettled([
    worker.apply(concurrentApplyTask.id, { confirm: true, patchHash: concurrentApplyReview.patchHash, approvedBy: 'acceptance' }),
    worker.apply(concurrentApplyTask.id, { confirm: true, patchHash: concurrentApplyReview.patchHash, approvedBy: 'acceptance' })
  ]);
  assert.equal(concurrentApplyResults.filter((result) => result.status === 'fulfilled').length, 1, 'exactly one concurrent apply owns the durable apply lease');
  assert.equal(concurrentApplyResults.filter((result) => result.status === 'rejected').length, 1, 'the second concurrent apply is rejected before touching the live checkout');
  assert.match(String(concurrentApplyResults.find((result) => result.status === 'rejected')?.reason?.message || ''), /already applying/, 'the losing apply reports durable ownership contention');
  assert.equal(worker.load(concurrentApplyTask.id).status, 'applied', 'the winning apply leaves one truthful terminal task state');
  await run('git', ['restore', '--worktree', '--', 'src/value.js']);
  const persistenceFaultTask = createPreparedTask({ title: 'Apply settlement fixture', objective: 'Keep a truthful applied receipt if task persistence and rollback both fail.', allowedPaths: ['src/value.js'], maxFilesChanged: 1, validation: 'syntax' });
  const persistenceFaultReview = await runPreparedTask(persistenceFaultTask);
  const normalSave = worker.save.bind(worker);
  let rejectAppliedSaveOnce = true;
  worker.save = (candidate) => {
    if (candidate.id === persistenceFaultTask.id && candidate.status === 'applied' && rejectAppliedSaveOnce) {
      rejectAppliedSaveOnce = false;
      throw new Error('injected applied-state persistence failure');
    }
    return normalSave(candidate);
  };
  const persistenceFaultResult = await worker.apply(persistenceFaultTask.id, { confirm: true, patchHash: persistenceFaultReview.patchHash });
  worker.save = normalSave;
  assert.equal(persistenceFaultResult.status, 'applied', 'a succeeded patch command and durable receipt never report a false failed outcome');
  assert.equal(worker.readApplyReceipt(persistenceFaultTask.id)?.state, 'applied', 'the durable apply receipt survives task persistence failure');
  assert.match(worker.load(persistenceFaultTask.id).persistenceWarning || '', /durable apply receipt/, 'the repaired task state preserves the settlement warning');
  await run('git', ['restore', '--worktree', '--', 'src/value.js']);
  const receiptFaultTask = createPreparedTask({ title: 'Apply receipt failure fixture', objective: 'A succeeded patch command remains an applied outcome when the WAL receipt write fails.', allowedPaths: ['src/value.js'], maxFilesChanged: 1, validation: 'syntax' });
  const receiptFaultReview = await runPreparedTask(receiptFaultTask);
  const normalWriteApplyReceipt = worker.writeApplyReceipt.bind(worker);
  worker.writeApplyReceipt = (candidate, state, detail) => {
    if (candidate.id === receiptFaultTask.id && state === 'applied') throw new Error('injected applied receipt failure');
    return normalWriteApplyReceipt(candidate, state, detail);
  };
  let rejectReceiptFaultSaveOnce = true;
  worker.save = (candidate) => {
    if (candidate.id === receiptFaultTask.id && candidate.status === 'applied' && rejectReceiptFaultSaveOnce) {
      rejectReceiptFaultSaveOnce = false;
      throw new Error('injected initial applied task persistence failure');
    }
    return normalSave(candidate);
  };
  const receiptFaultResult = await worker.apply(receiptFaultTask.id, { confirm: true, patchHash: receiptFaultReview.patchHash });
  worker.writeApplyReceipt = normalWriteApplyReceipt;
  worker.save = normalSave;
  assert.equal(receiptFaultResult.status, 'applied', 'receipt persistence failure cannot turn a succeeded patch command into a failed confirmation outcome');
  assert.match(worker.load(receiptFaultTask.id).persistenceWarning || '', /both its applied receipt and initial task persistence failed/, 'task state accurately records the combined degraded settlement');
  await run('git', ['restore', '--worktree', '--', 'src/value.js']);
  const cleanupFaultTask = createPreparedTask({ title: 'Apply lease cleanup failure fixture', objective: 'Auxiliary lease metadata cleanup cannot falsify an applied outcome.', allowedPaths: ['src/value.js'], maxFilesChanged: 1, validation: 'syntax' });
  const cleanupFaultReview = await runPreparedTask(cleanupFaultTask);
  let rejectCleanupSaveOnce = true;
  worker.save = (candidate) => {
    if (candidate.id === cleanupFaultTask.id && candidate.status === 'applied' && candidate.applyLease === null && rejectCleanupSaveOnce) {
      rejectCleanupSaveOnce = false;
      throw new Error('injected final lease metadata cleanup failure');
    }
    return normalSave(candidate);
  };
  const cleanupFaultResult = await worker.apply(cleanupFaultTask.id, { confirm: true, patchHash: cleanupFaultReview.patchHash });
  worker.save = normalSave;
  assert.equal(cleanupFaultResult.status, 'applied', 'auxiliary lease metadata cleanup cannot turn an applied mutation into a failed confirmation');
  assert.equal(worker.load(cleanupFaultTask.id).status, 'applied', 'the durable task outcome remains applied after cleanup metadata failure');
  await run('git', ['restore', '--worktree', '--', 'src/value.js']);
  const globalApplyTaskA = createPreparedTask({ title: 'Global apply A', objective: 'Prove the live checkout has one global apply owner.', allowedPaths: ['src/value.js'], maxFilesChanged: 1, validation: 'syntax' });
  const globalApplyTaskB = createPreparedTask({ title: 'Global apply B', objective: 'Prove another task cannot mutate the live checkout concurrently.', allowedPaths: ['src/value.js'], maxFilesChanged: 1, validation: 'syntax' });
  const globalReviewA = await runPreparedTask(globalApplyTaskA);
  const globalReviewB = await runPreparedTask(globalApplyTaskB);
  let applyPreflightResolve;
  let releaseApplyResolve;
  const applyPreflight = new Promise((resolve) => { applyPreflightResolve = resolve; });
  const releaseApply = new Promise((resolve) => { releaseApplyResolve = resolve; });
  const delayedRunGit = async (args) => {
    if (args[0] === 'status' && args[1] === '--porcelain=v1') { applyPreflightResolve(); await releaseApply; }
    return run('git', args);
  };
  const makeApplyWorker = (runGit) => new NativeCodingWorker({ root: temp, runGit, runValidation: worker.runValidation, invokeModel: worker.invokeModel, forbiddenPath: worker.forbiddenPath, getExecutionContext: worker.getExecutionContext });
  const applyWorkerA = makeApplyWorker(delayedRunGit);
  const applyWorkerB = makeApplyWorker((args) => run('git', args));
  const firstGlobalApply = applyWorkerA.apply(globalReviewA.id, { confirm: true, patchHash: globalReviewA.patchHash });
  await applyPreflight;
  await assert.rejects(applyWorkerB.apply(globalReviewB.id, { confirm: true, patchHash: globalReviewB.patchHash }), /already applying coding task/, 'a different task cannot acquire the single live-checkout apply owner');
  await assert.rejects(applyWorkerB.reject(globalReviewA.id), /already applying coding task/, 'reject cannot race and overwrite a task whose patch apply owns the live checkout');
  releaseApplyResolve();
  await firstGlobalApply;
  assert.equal(worker.load(globalReviewA.id).status, 'applied');
  assert.equal(worker.load(globalReviewB.id).status, 'review', 'the losing task remains review-ready and unmodified');
  await run('git', ['restore', '--worktree', '--', 'src/value.js']);
  await worker.reject(globalReviewB.id);
  modelMode = 'tools';
  const toolTask = createPreparedTask({ title: 'Inspect fixture', objective: 'List, search, and read approved files before changing one.', allowedPaths: ['src'], maxFilesChanged: 1 });
  const toolReview = await runPreparedTask(toolTask);
  assert.equal(toolReview.status, 'review');
  assert.deepEqual(toolReview.toolTrace.map((entry) => entry.name), ['list_files', 'search', 'read_file']);
  assert.ok(toolReview.toolTrace.every((entry) => /^[a-f0-9]{64}$/.test(entry.resultHash)));
  assert.ok(toolReview.toolTrace.every((entry) => typeof entry.resultPreview === 'string' && entry.resultPreview.length > 0), 'controller evidence excerpts remain reviewable in the durable task record');
  assert.match(toolReview.toolTrace.at(-1).resultPreview, /export const value = 1/, 'the final scoped file read is retained as evidence, not paraphrased model reasoning');
  assert.equal(fs.readFileSync(path.join(temp, 'src', 'value.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const value = 1;\n', 'tool-loop review changed live checkout');
  await worker.reject(toolTask.id);

  // No-change report parse contract (audit delta #2): grounded, edit-free, valid confidence.
  assert.equal(parseNativeCodingTurn(JSON.stringify({ action: 'report_no_change', confidence: 0.9, evidence_basis: 'The scoped evidence already satisfies the objective.', summary: 'No change.' })).type, 'no_change', 'a grounded no-change report parses');
  assert.throws(() => parseNativeCodingTurn(JSON.stringify({ action: 'report_no_change', confidence: 0.9, evidence_basis: 'short', summary: 'x' })), /evidence_basis of at least 12/, 'a no-change report without grounded evidence is rejected');
  assert.throws(() => parseNativeCodingTurn(JSON.stringify({ action: 'report_no_change', confidence: 0.9, evidence_basis: 'The scoped evidence already satisfies the objective.', edits: [{ path: 'src/value.js', content: 'x' }] })), /must not include edits/, 'a no-change report may not smuggle edits');
  assert.throws(() => parseNativeCodingTurn(JSON.stringify({ action: 'report_no_change', confidence: 2, evidence_basis: 'The scoped evidence already satisfies the objective.' })), /confidence from 0 to 1/, 'a no-change report needs a valid confidence');

  // Evidence-only outcome (audit delta #2): an honest "no source change" report
  // lands in an operator-closed evidence_only state, never a patch, and cannot be
  // applied. The live checkout stays untouched and the operator closes it.
  modelMode = 'no-change';
  const noChangeTask = createPreparedTask({ title: 'No-change fixture', objective: 'Report honestly that the fixture already meets the objective.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  const noChangeReview = await runPreparedTask(noChangeTask);
  assert.equal(noChangeReview.status, 'evidence_only', 'a no-change report lands in the evidence_only review state');
  assert.equal(noChangeReview.phase, 'awaiting_operator_close');
  assert.equal(noChangeReview.changedFiles.length, 0, 'an evidence-only outcome changes no files');
  assert.equal(noChangeReview.diff, '', 'an evidence-only outcome has no diff');
  assert.ok(!noChangeReview.patchHash, 'an evidence-only outcome has no patch hash');
  assert.equal(noChangeReview.assessment.action, 'report_no_change');
  assert.ok(noChangeReview.audit.some((event) => event.phase === 'no_change_report'), 'the no-change report is durable evidence');
  assert.equal(fs.readFileSync(path.join(temp, 'src', 'value.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const value = 1;\n', 'evidence-only outcome left the live checkout untouched');
  await assert.rejects(worker.apply(noChangeTask.id, { confirm: true, patchHash: 'anything' }), /review-ready task and explicit apply approval/, 'an evidence-only task cannot be applied');
  await worker.reject(noChangeTask.id);
  assert.equal(worker.load(noChangeTask.id).status, 'rejected', 'the operator can close an evidence-only task');
  modelMode = 'valid';

  const leasedTask = createPreparedTask({ title: 'Durable lease fixture', objective: 'Prove another process cannot enter the same sealed task while its execution lease exists.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  const heldLease = worker.acquireRunLease(leasedTask);
  await assert.rejects(runPreparedTask(leasedTask), /durable coding execution lease/, 'a durable lease blocks a second run even without an in-memory active worker');
  const wrongLease = { ...heldLease, token: 'wrong-owner-token' };
  assert.equal(worker.releaseRunLease(leasedTask, { lease: wrongLease }), false, 'a wrong-token release does not claim lease ownership');
  assert.equal(worker.readOperationLease(leasedTask.id, 'run')?.token, heldLease.token, 'a wrong-token release cannot delete the real owner lease');
  assert.ok(leasedTask.runLease?.tokenHash, 'a wrong-token release cannot clear the task owner metadata');
  worker.releaseRunLease(leasedTask, { lease: heldLease });
  worker.save(leasedTask);
  const staleApplyLease = worker.acquireOperationLease(leasedTask.id, 'apply');
  fs.writeFileSync(worker.operationLeaseFile(leasedTask.id, 'apply'), JSON.stringify({ ...staleApplyLease, token: 'replacement-owner-token', taskId: 'code-replacement-owner' }));
  let staleApplySettlementWrites = 0;
  assert.equal(worker.releaseOperationLease(leasedTask.id, 'apply', { lease: staleApplyLease, beforeRelease: () => { staleApplySettlementWrites += 1; } }), false, 'a stale apply owner cannot release a replacement owner lease');
  assert.equal(staleApplySettlementWrites, 0, 'a stale apply owner cannot execute final task persistence after token loss');
  fs.unlinkSync(worker.operationLeaseFile(leasedTask.id, 'apply'));
  const liveOwnerTask = createPreparedTask({ title: 'Live-owner restart fixture', objective: 'Prove startup cannot recover a task owned by another live unexpired lease.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  const liveOwnerLease = worker.acquireRunLease(liveOwnerTask);
  liveOwnerTask.status = 'running';
  liveOwnerTask.phase = 'local_coder_inference';
  worker.save(liveOwnerTask);
  const observingWorker = new NativeCodingWorker({ root: temp, runGit: (args) => run('git', args), runValidation: worker.runValidation, invokeModel: worker.invokeModel, forbiddenPath: worker.forbiddenPath });
  assert.equal(observingWorker.load(liveOwnerTask.id).status, 'running', 'a second process preserves a task with an unexpired durable owner lease');
  assert.equal(observingWorker.readOperationLease(liveOwnerTask.id, 'run')?.token, liveOwnerLease.token, 'startup recovery never deletes another process owner token');
  worker.releaseRunLease(liveOwnerTask, { lease: liveOwnerLease });
  liveOwnerTask.status = 'interrupted';
  liveOwnerTask.phase = 'interrupted';
  worker.save(liveOwnerTask);
  const staleLeaseTask = createPreparedTask({ title: 'Stale lease fixture', objective: 'Prove an expired execution lease is reclaimed rather than blocking recovery forever.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  fs.mkdirSync(worker.leaseDir, { recursive: true });
  fs.writeFileSync(worker.leaseFile(staleLeaseTask.id), JSON.stringify({ taskId: staleLeaseTask.id, token: 'expired', expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const reclaimedLease = worker.acquireRunLease(staleLeaseTask);
  assert.notEqual(reclaimedLease.token, 'expired', 'expired lease is atomically replaced with a new owner token');
  worker.releaseRunLease(staleLeaseTask, { lease: reclaimedLease });
  worker.save(staleLeaseTask);
  const reusedPidTask = createPreparedTask({ title: 'PID reuse fixture', objective: 'An unrelated live process ID cannot keep an expired owner lease alive.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  fs.writeFileSync(worker.leaseFile(reusedPidTask.id), JSON.stringify({ taskId: reusedPidTask.id, token: 'expired-reused-pid', ownerPid: process.pid, ownerInstanceId: 'f'.repeat(32), expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const pidReclaimedLease = worker.acquireRunLease(reusedPidTask);
  assert.notEqual(pidReclaimedLease.token, 'expired-reused-pid', 'an expired lease needs a fresh matching instance heartbeat, not merely a reused live PID');
  worker.releaseRunLease(reusedPidTask, { lease: pidReclaimedLease });
  const malformedLeaseTask = createPreparedTask({ title: 'Malformed lease fixture', objective: 'Quarantine an unreadable crashed-owner lease without silently trusting it.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  malformedLeaseTask.status = 'running'; malformedLeaseTask.phase = 'local_coder_inference'; worker.save(malformedLeaseTask);
  fs.mkdirSync(worker.leaseDir, { recursive: true });
  fs.writeFileSync(worker.leaseFile(malformedLeaseTask.id), '{not-json', 'utf8');
  const malformedRecoveryWorker = new NativeCodingWorker({ root: temp, runGit: (args) => run('git', args), runValidation: worker.runValidation, invokeModel: worker.invokeModel, forbiddenPath: worker.forbiddenPath });
  assert.equal(malformedRecoveryWorker.load(malformedLeaseTask.id).status, 'interrupted', 'startup marks a task with an unreadable crashed-owner lease for explicit review');
  assert.equal(fs.existsSync(worker.leaseFile(malformedLeaseTask.id)), false, 'the malformed lease no longer blocks future explicitly approved runs');
  assert.ok(fs.readdirSync(worker.leaseDir).some((name) => name.startsWith(`${malformedLeaseTask.id}.json.malformed.`)), 'the unreadable lease is quarantined for inspection rather than discarded');
  const preparedMalformedTask = createPreparedTask({ title: 'Prepared malformed lease fixture', objective: 'Recover a torn lease created before the running status transition.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  fs.writeFileSync(worker.leaseFile(preparedMalformedTask.id), '{torn', 'utf8');
  const preparedMalformedRecovery = new NativeCodingWorker({ root: temp, runGit: (args) => run('git', args), runValidation: worker.runValidation, invokeModel: worker.invokeModel, forbiddenPath: worker.forbiddenPath });
  assert.equal(preparedMalformedRecovery.load(preparedMalformedTask.id).status, 'prepared', 'a torn acquisition-window lease does not fabricate a started run');
  const preparedRecoveredLease = preparedMalformedRecovery.acquireRunLease(preparedMalformedTask);
  preparedMalformedRecovery.releaseRunLease(preparedMalformedTask, { lease: preparedRecoveredLease });
  fs.writeFileSync(worker.operationLeaseFile(preparedMalformedTask.id, 'apply'), '{torn-global', 'utf8');
  const globalMalformedRecovery = new NativeCodingWorker({ root: temp, runGit: (args) => run('git', args), runValidation: worker.runValidation, invokeModel: worker.invokeModel, forbiddenPath: worker.forbiddenPath });
  const recoveredGlobalApplyLease = globalMalformedRecovery.acquireOperationLease(preparedMalformedTask.id, 'apply');
  globalMalformedRecovery.releaseOperationLease(preparedMalformedTask.id, 'apply', { lease: recoveredGlobalApplyLease });
  assert.ok(fs.readdirSync(worker.leaseDir).some((name) => name.startsWith('global.apply.json.malformed.')), 'a torn global apply lease is quarantined and cannot block every future Apply or Reject');

  modelMode = 'evidence-recovery';
  const evidenceRecoveryTask = createPreparedTask({ title: 'Resolve own evidence gap', objective: 'Use an approved read to close a concrete gap before proposing the fixture edit.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  const evidenceRecoveryReview = await runPreparedTask(evidenceRecoveryTask);
  assert.equal(evidenceRecoveryReview.status, 'review');
  assert.equal(evidenceRecoveryReview.evidenceRecoveries, 1, 'a concrete in-scope evidence gap triggers unattended local recovery');
  assert.deepEqual(evidenceRecoveryReview.toolTrace.map((entry) => entry.name), ['read_file']);
  assert.ok(evidenceRecoveryReview.audit.some((event) => event.phase === 'evidence_recovery' && event.verdict === 'allow'), 'the recovery decision is durable operator evidence');
  assert.ok(evidenceRecoveryReview.audit.some((event) => event.phase === 'evidence_recovery_complete' && event.verdict === 'allow'), 'successful self-recovery records a durable completion event');
  assert.equal(evidenceRecoveryReview.recovery, null, 'a review-ready task does not retain stale current-blocker state after self-recovery');
  assert.match(evidenceRecoveryReview.assessment.evidenceBasis, /recovered approved fixture read/);
  assert.equal(fs.readFileSync(path.join(temp, 'src', 'value.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const value = 1;\n', 'evidence recovery never changes the live checkout');
  await worker.reject(evidenceRecoveryTask.id);

  modelMode = 'evidence-exhaustion';
  const exhaustedEvidenceTask = createPreparedTask({ title: 'Bound evidence recovery', objective: 'Stop only after the bounded sealed evidence-recovery budget is exhausted.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  await assert.rejects(runPreparedTask(exhaustedEvidenceTask), /LOW_CONFIDENCE/);
  const exhaustedEvidence = worker.load(exhaustedEvidenceTask.id);
  assert.equal(exhaustedEvidence.status, 'needs-evidence');
  assert.equal(exhaustedEvidence.evidenceRecoveries, 5, 'the worker makes all five permitted unattended evidence-recovery passes before stopping');
  assert.equal(exhaustedEvidence.audit.filter((event) => event.phase === 'evidence_recovery').length, 5, 'each exhausted evidence-recovery pass remains durable audit evidence');
  assert.match(exhaustedEvidence.recovery.nextPermittedAction, /Gather one of the named evidence gaps/);
  await worker.reject(exhaustedEvidenceTask.id);

  modelMode = 'validation-repair';
  const repairTask = createPreparedTask({ title: 'Repair after checker feedback', objective: 'Use the independent checker result to correct the approved fixture.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  const repairReview = await runPreparedTask(repairTask);
  assert.equal(repairReview.status, 'review');
  assert.equal(repairReview.validationRepairs, 1, 'one checker-guided repair remains bounded');
  assert.ok(repairReview.audit.some((event) => event.phase === 'validation_repair_assessment'), 'repair assessment is durable evidence');
  assert.match(repairReview.diff, /value = 3/);
  assert.equal(fs.readFileSync(path.join(temp, 'src', 'value.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const value = 1;\n', 'checker-guided repair never changes the live checkout');
  await worker.reject(repairTask.id);

  modelMode = 'validation-permanent-failure';
  const failedValidationTask = createPreparedTask({ title: 'Retain failed checker evidence', objective: 'Keep the terminal independent-checker result available for review.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  await assert.rejects(runPreparedTask(failedValidationTask), /Independent validation failed after 1 bounded repair attempt/);
  const failedValidation = worker.load(failedValidationTask.id);
  assert.equal(failedValidation.status, 'failed');
  assert.equal(failedValidation.validationResult?.ok, false, 'terminal checker failure remains structured task evidence');
  assert.match(failedValidation.validationResult?.output || '', /permanent fixture checker/);
  await worker.reject(failedValidationTask.id);

  modelMode = 'validation-repair-low-confidence';
  const lowConfidenceRepairTask = createPreparedTask({ title: 'Explain low-confidence checker repair', objective: 'Persist the exact missing evidence when checker-guided repair cannot safely continue.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  await assert.rejects(runPreparedTask(lowConfidenceRepairTask), /LOW_CONFIDENCE/);
  const lowConfidenceRepair = worker.load(lowConfidenceRepairTask.id);
  assert.equal(lowConfidenceRepair.status, 'needs-evidence');
  assert.equal(lowConfidenceRepair.assessment?.repairedAfterValidation, true);
  assert.deepEqual(lowConfidenceRepair.recovery?.evidenceGaps, ['Read the production contract that defines the required corrected fixture value.']);
  assert.match(lowConfidenceRepair.validationResult?.output || '', /fixture requires value = 3/, 'the failed first checker result remains visible beside repair evidence gaps');
  await worker.reject(lowConfidenceRepairTask.id);

  modelMode = 'tool-escape';
  const toolEscape = createPreparedTask({ title: 'Escape tool', objective: 'Attempt an out-of-scope tool read.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  await assert.rejects(runPreparedTask(toolEscape), /outside the approved scope/);
  assert.equal(worker.load(toolEscape.id).status, 'failed');

  modelMode = 'tool-loop';
  const toolLoop = createPreparedTask({ title: 'Bound tool loop', objective: 'Prove endless tool requests stop.', allowedPaths: ['src'], maxFilesChanged: 1 });
  await assert.rejects(runPreparedTask(toolLoop), /16-tool-call limit/);
  assert.equal(worker.load(toolLoop.id).toolTrace.length, 16);

  modelMode = 'delete';
  const deleteTask = createPreparedTask({ title: 'Delete fixture', objective: 'Remove the approved obsolete file.', allowedPaths: ['src/obsolete.js'], maxFilesChanged: 1 });
  const deleteReview = await runPreparedTask(deleteTask);
  assert.match(deleteReview.diff, /deleted file mode/);
  assert.equal(fs.existsSync(path.join(temp, 'src', 'obsolete.js')), true, 'review deletion reached live checkout before Apply');
  await worker.reject(deleteTask.id);

  modelMode = 'new';
  const newFile = createPreparedTask({ title: 'Add fixture', objective: 'Add one JavaScript fixture.', allowedPaths: ['src'], maxFilesChanged: 1 });
  const newReview = await runPreparedTask(newFile);
  assert.match(newReview.diff, /new file mode/);
  await worker.apply(newFile.id, { confirm: true, patchHash: newReview.patchHash });
  assert.equal(fs.readFileSync(path.join(temp, 'src', 'new.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const added = true;\n');
  fs.unlinkSync(path.join(temp, 'src', 'new.js'));

  modelMode = 'escape';
  const unsafe = createPreparedTask({ title: 'Unsafe fixture', objective: 'Attempt an out-of-scope edit.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  await assert.rejects(runPreparedTask(unsafe), /outside the approved scope/);
  assert.equal(fs.existsSync(path.join(temp, 'outside.js')), false);
  assert.equal(worker.load(unsafe.id).status, 'failed');

  modelMode = 'low-confidence';
  const lowConfidence = createPreparedTask({ title: 'Need more evidence', objective: 'Do not edit when the source does not establish the defect.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  await assert.rejects(runPreparedTask(lowConfidence), /LOW_CONFIDENCE/);
  const stopped = worker.load(lowConfidence.id);
  assert.equal(stopped.status, 'needs-evidence');
  assert.equal(stopped.assessment.confidence, 0.35);
  assert.match(stopped.recovery.nextPermittedAction, /prepare scoped evidence again/);
  assert.deepEqual(stopped.recovery.evidenceGaps, ['Read the production contract that specifies the intended exported value.']);
  assert.match(stopped.error, /Gather one of the named evidence gaps/);
  await assert.rejects(runPreparedTask(lowConfidence), /Task cannot run from status needs-evidence/, 'exhausted evidence recovery cannot blindly rerun against unchanged evidence');
  await worker.reject(lowConfidence.id);

  modelMode = 'valid';
  const concurrentA = createPreparedTask({ title: 'Concurrent A', objective: 'First single-flight task.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  const concurrentB = createPreparedTask({ title: 'Concurrent B', objective: 'Second single-flight task.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  const concurrent = await Promise.allSettled([
    runPreparedTask(concurrentA),
    runPreparedTask(concurrentB)
  ]);
  assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((item) => item.status === 'rejected' && /Another native coding task/.test(item.reason.message)).length, 1);
  for (const task of [concurrentA, concurrentB]) {
    const current = worker.load(task.id);
    if (['review', 'pending', 'failed'].includes(current.status)) await worker.reject(task.id);
  }

  const interrupted = createTask({ title: 'Restart fixture', objective: 'Prove stale running state is not trusted.', allowedPaths: ['src/value.js'] });
  const interruptedFile = worker.taskFile(interrupted.id);
  fs.writeFileSync(interruptedFile, JSON.stringify({ ...interrupted, status: 'running', phase: 'local_coder_inference' }, null, 2));
  const recovered = new NativeCodingWorker({ root: temp, runGit: (args) => run('git', args), runValidation: worker.runValidation, invokeModel: worker.invokeModel, forbiddenPath: worker.forbiddenPath });
  assert.equal(recovered.load(interrupted.id).status, 'interrupted');
  const applyInterrupted = createTask({ title: 'Interrupted apply fixture', objective: 'Require explicit inspection before closing an interrupted apply.', allowedPaths: ['src/value.js'] });
  applyInterrupted.status = 'apply-interrupted';
  applyInterrupted.phase = 'apply-interrupted';
  worker.save(applyInterrupted);
  const closedInterruptedApply = await worker.reject(applyInterrupted.id);
  assert.equal(closedInterruptedApply.status, 'rejected', 'an inspected apply-interrupted record has an explicit closure path');
  assert.match(closedInterruptedApply.audit.at(-1).detail, /does not assert whether/, 'closing an interrupted apply never claims the live patch state');

  let validationStartedResolve;
  let validationReleaseResolve;
  const validationStarted = new Promise((resolve) => { validationStartedResolve = resolve; });
  const validationRelease = new Promise((resolve) => { validationReleaseResolve = resolve; });
  const cancellationWorker = new NativeCodingWorker({
    root: temp,
    runGit: (args) => run('git', args),
    runValidation: async () => {
      validationStartedResolve();
      await validationRelease;
      return { ok: true, output: 'validation completed after cancellation request' };
    },
    invokeModel: async () => ({ content: JSON.stringify({ action: 'propose_edits', confidence: 0.9, evidence_basis: 'The approved fixture source establishes the bounded cancellation test edit.', summary: 'Cancellation test edit.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] }), model: { name: 'fake-local-coder' } }),
    forbiddenPath: worker.forbiddenPath,
    getExecutionContext: worker.getExecutionContext
  });
  const cancellationTask = cancellationWorker.create({ title: 'Cancel during validation', objective: 'Prove cancellation cannot settle a completed checker as review-ready.', allowedPaths: ['src/value.js'], maxFilesChanged: 1, validation: 'syntax', baseCommit });
  cancellationTask.preparation = { status: 'ready', baseCommit, evidenceHash: 'd'.repeat(64), evidence: { anchors: [{ path: 'src/value.js' }] } };
  cancellationTask.status = 'prepared';
  cancellationTask.phase = 'evidence_ready';
  cancellationWorker.save(cancellationTask);
  const cancellationRun = cancellationWorker.run(cancellationTask.id, { confirm: true, taskHash: cancellationTask.taskHash, evidenceHash: cancellationTask.preparation.evidenceHash, adviceHash: '' });
  await validationStarted;
  cancellationWorker.cancel(cancellationTask.id);
  validationReleaseResolve();
  await assert.rejects(cancellationRun, /cancelled during independent validation/, 'a cancellation committed during validation cannot become review-ready afterward');
  const cancelledDuringValidation = cancellationWorker.load(cancellationTask.id);
  assert.equal(cancelledDuringValidation.status, 'cancelled');
  assert.ok(cancelledDuringValidation.audit.some((event) => event.phase === 'cancel_request'), 'the cancellation request remains in the same durable task object and is not overwritten by run settlement');

  console.log('Native coding worker acceptance passed: traversal rejection, base-commit/evidence sealing, bounded read-only tool loop, tool-scope refusal, safe deletion review, single-flight execution, sealed approvals, isolated tracked/new edits, validation evidence, patch-hash apply, restart recovery, and out-of-scope rejection are real.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
