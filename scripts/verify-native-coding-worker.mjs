import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NATIVE_CODING_VALIDATIONS, NativeCodingWorker, parseNativeCodingResponse } from '../server/nativeCodingWorker.js';

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
  assert.equal(exhaustedEvidence.evidenceRecoveries, 3, 'the worker makes all three permitted unattended evidence-recovery passes before stopping');
  assert.equal(exhaustedEvidence.audit.filter((event) => event.phase === 'evidence_recovery').length, 3, 'each exhausted evidence-recovery pass remains durable audit evidence');
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
  await assert.rejects(runPreparedTask(toolLoop), /8-tool-call limit/);
  assert.equal(worker.load(toolLoop.id).toolTrace.length, 8);

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

  console.log('Native coding worker acceptance passed: traversal rejection, base-commit/evidence sealing, bounded read-only tool loop, tool-scope refusal, safe deletion review, single-flight execution, sealed approvals, isolated tracked/new edits, validation evidence, patch-hash apply, restart recovery, and out-of-scope rejection are real.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
