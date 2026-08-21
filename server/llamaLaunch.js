export const DEFAULT_LLAMA_GPU_LAYERS = 0;
export const MIN_LLAMA_GPU_LAYERS = 0;
export const MAX_LLAMA_GPU_LAYERS = 999;

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
