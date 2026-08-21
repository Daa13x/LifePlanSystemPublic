import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildManagedLlamaArgs,
  DEFAULT_LLAMA_GPU_LAYERS,
  normalizeLlamaGpuLayers
} from '../server/llamaLaunch.js';

const root = path.resolve(import.meta.dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8');

const base = { modelPath: 'C:\\models\\planner.gguf', port: 8080, contextSize: 16384 };
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
