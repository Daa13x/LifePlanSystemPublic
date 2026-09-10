import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  buildManagedLlamaArgs,
  DEFAULT_LLAMA_GPU_LAYERS,
  normalizeLlamaGpuLayers,
  startupProvisioningDecision,
  configuredLlamaRuntimeAvailable
} from '../server/llamaLaunch.js';

const root = path.resolve(import.meta.dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8');

const base = { modelPath: 'C:\\models\\planner.gguf', port: 8080, contextSize: 16384 };
assert.equal(startupProvisioningDecision(null), 'unverified');
assert.equal(startupProvisioningDecision({}), 'unverified');
assert.equal(startupProvisioningDecision({ assigned: false, endpointConfigured: true }), 'configured-endpoint');
assert.equal(startupProvisioningDecision({ assigned: true, llamaServerExists: true }), 'none');
assert.equal(startupProvisioningDecision({ assigned: true, llamaCliExists: true }), 'none');
assert.equal(startupProvisioningDecision({ assigned: true }), 'runtime-only');
assert.equal(startupProvisioningDecision({ assigned: false, model: { path: 'missing-saved-model.gguf' } }), 'repair-required');
assert.equal(startupProvisioningDecision({ assigned: false }), 'starter');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-llama-readiness-'));
try {
  const bundle = path.join(fixture, 'llama');
  fs.mkdirSync(bundle);
  const executable = path.join(bundle, 'llama-server.exe');
  fs.mkdirSync(executable);
  assert.equal(configuredLlamaRuntimeAvailable(executable, bundle), false, 'a directory is not an executable');
  fs.rmdirSync(executable);
  fs.writeFileSync(executable, 'runtime-fixture');
  assert.equal(configuredLlamaRuntimeAvailable(executable, bundle), false, 'an orphaned bundled executable is not ready');
  const baseDll = path.join(bundle, 'ggml-base.dll');
  fs.writeFileSync(baseDll, 'base-dll-fixture');
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(bundle, 'runtime-manifest.json'), JSON.stringify({ serverSha256: digest(executable), baseDllSha256: digest(baseDll) }));
  assert.equal(configuredLlamaRuntimeAvailable(executable, bundle), true);
  fs.writeFileSync(baseDll, 'base-dll-corrupt');
  assert.equal(configuredLlamaRuntimeAvailable(executable, bundle), false, 'corrupted bundled dependency cannot suppress repair');
  assert.equal(startupProvisioningDecision({ assigned: true, llamaServerExists: configuredLlamaRuntimeAvailable(executable, bundle) }), 'runtime-only');
  const external = path.join(fixture, 'custom-runtime.exe');
  fs.writeFileSync(external, 'custom-file');
  assert.equal(configuredLlamaRuntimeAvailable(external, bundle), true, 'a custom runtime is not required to carry the bundled provisioner manifest');
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
const defaultArgs = buildManagedLlamaArgs(base);
assert.equal(DEFAULT_LLAMA_GPU_LAYERS, 0);
assert.deepEqual(defaultArgs.slice(-2), ['--n-gpu-layers', '0']);

const overrideArgs = buildManagedLlamaArgs({ ...base, gpuLayers: 24 });
assert.deepEqual(overrideArgs.slice(-2), ['--n-gpu-layers', '24']);
assert.equal(normalizeLlamaGpuLayers('0'), 0);
assert.equal(normalizeLlamaGpuLayers('999'), 999);
for (const value of [-1, 1000, 1.5, 'gpu', Number.NaN]) {
  assert.throws(() => normalizeLlamaGpuLayers(value), /GPU layers must be an integer from 0 to 999/);
}

assert.match(serverSource, /gpuLayers: req\.body\.gpuLayers/);
assert.match(serverSource, /setSetting\('llamaGpuLayers', gpuLayers\)/);
assert.match(serverSource, /managedLlamaServerLaunch\.gpuLayers === requestedLaunch\.gpuLayers/);
assert.match(uiSource, /llamaGpuLayers: Number\(llamaGpuLayers\)/);
assert.match(uiSource, /gpuLayers: Number\(llamaGpuLayers\)/);

console.log('Managed llama.cpp CPU-first launch contract verification passed.');
