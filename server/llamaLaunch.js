import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_LLAMA_GPU_LAYERS = 0;
export const MIN_LLAMA_GPU_LAYERS = 0;
export const MAX_LLAMA_GPU_LAYERS = 999;

// Basic configured-file readiness is distinct from successful inference. For
// the bundled payload, also validate the dependency/digest manifest produced by
// the existing pinned provisioner; an orphaned executable is not a runtime.
export function configuredLlamaRuntimeAvailable(file, bundledRoot) {
  try {
    if (!file || !fs.statSync(file).isFile()) return false;
    const parent = path.resolve(path.dirname(file));
    const bundle = path.resolve(bundledRoot);
    const same = process.platform === 'win32' ? parent.toLowerCase() === bundle.toLowerCase() : parent === bundle;
    if (!same) return true;
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'runtime-manifest.json'), 'utf8'));
    for (const [name, expected] of [['llama-server.exe', manifest.serverSha256], ['ggml-base.dll', manifest.baseDllSha256]]) {
      const candidate = path.join(bundle, name);
      if (!/^[a-f0-9]{64}$/i.test(expected || '') || !fs.statSync(candidate).isFile()) return false;
      const fd = fs.openSync(candidate, 'r');
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)); }
      finally { fs.closeSync(fd); }
      if (hash.digest('hex') !== expected.toLowerCase()) return false;
    }
    return true;
  } catch { return false; }
}

// Consume the authoritative model owner's file/readiness result, never a UI
// default or the mere presence of a registry row. This plans provisioning only;
// it does not claim a configured endpoint is reachable or invoke inference.
export function startupProvisioningDecision(status) {
  if (!status || typeof status.assigned !== 'boolean') return 'unverified';
  if (status.endpointConfigured) return 'configured-endpoint';
  if (status.assigned) {
    return status.llamaServerExists || status.llamaCliExists ? 'none' : 'runtime-only';
  }
  if (status.model) return 'repair-required';
  return 'starter';
}

export function normalizeLlamaGpuLayers(value = DEFAULT_LLAMA_GPU_LAYERS) {
  const candidate = value === '' || value === null || value === undefined
    ? DEFAULT_LLAMA_GPU_LAYERS
    : Number(value);
  if (!Number.isInteger(candidate) || candidate < MIN_LLAMA_GPU_LAYERS || candidate > MAX_LLAMA_GPU_LAYERS) {
    throw new Error(`llama.cpp GPU layers must be an integer from ${MIN_LLAMA_GPU_LAYERS} to ${MAX_LLAMA_GPU_LAYERS}.`);
  }
  return candidate;
}

export function buildManagedLlamaArgs({ modelPath, port, contextSize, gpuLayers = DEFAULT_LLAMA_GPU_LAYERS }) {
  return [
    '-m', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-c', String(contextSize),
    '--reasoning-budget', '0',
    '--n-gpu-layers', String(normalizeLlamaGpuLayers(gpuLayers))
  ];
}
