import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeCodingWorker, parseNativeCodingResponse } from '../server/nativeCodingWorker.js';

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
  await run('git', ['init']);
  await run('git', ['config', 'user.name', 'LPS verifier']);
  await run('git', ['config', 'user.email', 'lps-verifier@example.invalid']);
  fs.mkdirSync(path.join(temp, 'src'));
  fs.writeFileSync(path.join(temp, 'src', 'value.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(temp, '.gitignore'), '.lps/\n');
  await run('git', ['add', '.']);
  await run('git', ['commit', '-m', 'fixture']);

  let modelMode = 'valid';
  const worker = new NativeCodingWorker({
    root: temp,
    runGit: (args) => run('git', args),
    runValidation: async ({ worktree, changedFiles }) => ({
      ok: changedFiles.length === 1 && changedFiles.every((file) => fs.existsSync(path.join(worktree, file))),
      output: 'PASS fixture checker',
      checks: [{ name: 'fixture checker', ok: true }]
    }),
    invokeModel: async () => ({
      model: { name: 'fake-local-coder', endpoint: 'http://127.0.0.1:1', source: 'acceptance fixture' },
      content: modelMode === 'valid'
        ? JSON.stringify({ summary: 'Increment the fixture.', edits: [{ path: 'src/value.js', content: 'export const value = 2;\n' }] })
        : modelMode === 'new'
          ? JSON.stringify({ summary: 'Add the fixture.', edits: [{ path: 'src/new.js', content: 'export const added = true;\n' }] })
          : JSON.stringify({ summary: 'Escape scope.', edits: [{ path: 'outside.js', content: 'bad\n' }] })
    }),
    forbiddenPath: (candidate) => candidate.startsWith('.git') || candidate.startsWith('.lps') || candidate.startsWith('data')
  });

  assert.throws(() => parseNativeCodingResponse('not json'), /valid JSON/);
  assert.throws(() => worker.create({ title: 'Traversal', objective: 'Must fail.', allowedPaths: ['src/../../secret.txt'] }), /unsafe or protected/);
  const task = worker.create({ title: 'Increment fixture', objective: 'Change value from one to two.', allowedPaths: ['src/value.js'], maxFilesChanged: 1, validation: 'syntax' });
  await assert.rejects(worker.run(task.id, { confirm: true, taskHash: 'wrong' }), /sealed task scope/);
  const review = await worker.run(task.id, { confirm: true, taskHash: task.taskHash, approvedBy: 'acceptance' });
  assert.equal(review.status, 'review');
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

  console.log('Native coding worker acceptance passed: traversal rejection, single-flight execution, sealed approvals, isolated tracked/new edits, validation evidence, patch-hash apply, restart recovery, and out-of-scope rejection are real.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
