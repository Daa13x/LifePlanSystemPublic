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
    runValidation: async ({ worktree, changedFiles }) => ({
      ok: changedFiles.length === 1,
      output: 'PASS fixture checker',
      checks: [{ name: 'fixture checker', ok: true }]
    }),
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
          : modelMode === 'low-confidence'
            ? JSON.stringify({ action: 'propose_edits', confidence: 0.35, evidence_basis: 'The supplied source does not establish the intended production behavior.', summary: 'Stop for evidence.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] })
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
  assert.deepEqual(Object.keys(NATIVE_CODING_VALIDATIONS), ['syntax', 'frontend', 'runtime', 'project']);
  const productionServer = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(productionServer, /\['run', 'verify:runtime-safety'\]/, 'runtime validation must use the fixed runtime-safety command');
  assert.match(productionServer, /validation === 'project'/, 'full project validation profile must be wired');
  assert.match(productionServer, /const DEFAULT_LLAMA_CONTEXT_SIZE = 16384;/, 'managed llama.cpp must default to a coding-capable context');
  assert.match(productionServer, /managedContextSize.*MIN_CODING_CONTEXT_SIZE/s, 'coding route must detect and replace an undersized managed context');
  assert.match(productionServer, /context size must be an integer from/, 'llama context settings must be bounded');
  assert.throws(() => worker.create({ title: 'Traversal', objective: 'Must fail.', allowedPaths: ['src/../../secret.txt'] }), /unsafe or protected/);
  const baseCommit = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const task = worker.create({ title: 'Increment fixture', objective: 'Change value from one to two.', allowedPaths: ['src/value.js'], maxFilesChanged: 1, validation: 'syntax', baseCommit });
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
  const toolTask = worker.create({ title: 'Inspect fixture', objective: 'List, search, and read approved files before changing one.', allowedPaths: ['src'], maxFilesChanged: 1 });
  const toolReview = await worker.run(toolTask.id, { confirm: true, taskHash: toolTask.taskHash });
  assert.equal(toolReview.status, 'review');
  assert.deepEqual(toolReview.toolTrace.map((entry) => entry.name), ['list_files', 'search', 'read_file']);
  assert.ok(toolReview.toolTrace.every((entry) => /^[a-f0-9]{64}$/.test(entry.resultHash)));
  assert.ok(toolReview.toolTrace.every((entry) => typeof entry.resultPreview === 'string' && entry.resultPreview.length > 0), 'controller evidence excerpts remain reviewable in the durable task record');
  assert.match(toolReview.toolTrace.at(-1).resultPreview, /export const value = 1/, 'the final scoped file read is retained as evidence, not paraphrased model reasoning');
  assert.equal(fs.readFileSync(path.join(temp, 'src', 'value.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const value = 1;\n', 'tool-loop review changed live checkout');
  await worker.reject(toolTask.id);

  modelMode = 'tool-escape';
  const toolEscape = worker.create({ title: 'Escape tool', objective: 'Attempt an out-of-scope tool read.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  await assert.rejects(worker.run(toolEscape.id, { confirm: true, taskHash: toolEscape.taskHash }), /outside the approved scope/);
  assert.equal(worker.load(toolEscape.id).status, 'failed');

  modelMode = 'tool-loop';
  const toolLoop = worker.create({ title: 'Bound tool loop', objective: 'Prove endless tool requests stop.', allowedPaths: ['src'], maxFilesChanged: 1 });
  await assert.rejects(worker.run(toolLoop.id, { confirm: true, taskHash: toolLoop.taskHash }), /8-tool-call limit/);
  assert.equal(worker.load(toolLoop.id).toolTrace.length, 8);

  modelMode = 'delete';
  const deleteTask = worker.create({ title: 'Delete fixture', objective: 'Remove the approved obsolete file.', allowedPaths: ['src/obsolete.js'], maxFilesChanged: 1 });
  const deleteReview = await worker.run(deleteTask.id, { confirm: true, taskHash: deleteTask.taskHash });
  assert.match(deleteReview.diff, /deleted file mode/);
  assert.equal(fs.existsSync(path.join(temp, 'src', 'obsolete.js')), true, 'review deletion reached live checkout before Apply');
  await worker.reject(deleteTask.id);

  modelMode = 'new';
  const newFile = worker.create({ title: 'Add fixture', objective: 'Add one JavaScript fixture.', allowedPaths: ['src'], maxFilesChanged: 1 });
  const newReview = await worker.run(newFile.id, { confirm: true, taskHash: newFile.taskHash });
  assert.match(newReview.diff, /new file mode/);
  await worker.apply(newFile.id, { confirm: true, patchHash: newReview.patchHash });
  assert.equal(fs.readFileSync(path.join(temp, 'src', 'new.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const added = true;\n');
  fs.unlinkSync(path.join(temp, 'src', 'new.js'));

  modelMode = 'escape';
  const unsafe = worker.create({ title: 'Unsafe fixture', objective: 'Attempt an out-of-scope edit.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  await assert.rejects(worker.run(unsafe.id, { confirm: true, taskHash: unsafe.taskHash }), /outside the approved scope/);
  assert.equal(fs.existsSync(path.join(temp, 'outside.js')), false);
  assert.equal(worker.load(unsafe.id).status, 'failed');

  modelMode = 'low-confidence';
  const lowConfidence = worker.create({ title: 'Need more evidence', objective: 'Do not edit when the source does not establish the defect.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  await assert.rejects(worker.run(lowConfidence.id, { confirm: true, taskHash: lowConfidence.taskHash }), /LOW_CONFIDENCE/);
  const stopped = worker.load(lowConfidence.id);
  assert.equal(stopped.status, 'needs-evidence');
  assert.equal(stopped.assessment.confidence, 0.35);
  assert.match(stopped.error, /Gather the exact missing source/);
  await worker.reject(lowConfidence.id);

  modelMode = 'valid';
  const concurrentA = worker.create({ title: 'Concurrent A', objective: 'First single-flight task.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  const concurrentB = worker.create({ title: 'Concurrent B', objective: 'Second single-flight task.', allowedPaths: ['src/value.js'], maxFilesChanged: 1 });
  const concurrent = await Promise.allSettled([
    worker.run(concurrentA.id, { confirm: true, taskHash: concurrentA.taskHash }),
    worker.run(concurrentB.id, { confirm: true, taskHash: concurrentB.taskHash })
  ]);
  assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((item) => item.status === 'rejected' && /Another native coding task/.test(item.reason.message)).length, 1);
  for (const task of [concurrentA, concurrentB]) {
    const current = worker.load(task.id);
    if (['review', 'pending', 'failed'].includes(current.status)) await worker.reject(task.id);
  }

  const interrupted = worker.create({ title: 'Restart fixture', objective: 'Prove stale running state is not trusted.', allowedPaths: ['src/value.js'] });
  const interruptedFile = worker.taskFile(interrupted.id);
  fs.writeFileSync(interruptedFile, JSON.stringify({ ...interrupted, status: 'running', phase: 'local_coder_inference' }, null, 2));
  const recovered = new NativeCodingWorker({ root: temp, runGit: (args) => run('git', args), runValidation: worker.runValidation, invokeModel: worker.invokeModel, forbiddenPath: worker.forbiddenPath });
  assert.equal(recovered.load(interrupted.id).status, 'interrupted');

  console.log('Native coding worker acceptance passed: traversal rejection, base-commit/evidence sealing, bounded read-only tool loop, tool-scope refusal, safe deletion review, single-flight execution, sealed approvals, isolated tracked/new edits, validation evidence, patch-hash apply, restart recovery, and out-of-scope rejection are real.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
