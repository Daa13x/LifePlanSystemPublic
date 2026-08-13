// LPS must never consume Mostly Armless Bible/doctrine material as model context.
// The MA-Dev/Serenity LoRA adapter and its companion systems are not available
// to LPS; a matching document is an environment mismatch, not missing setup.

export const MA_BIBLE_UNAVAILABLE_MESSAGE = 'No accurate Bibles found. You must not be on the MA-Dev machine.';

const MA_BIBLE_MARKERS = [
  /(?:mostly\s*armless|serenity).{0,80}\b(?:bible|sacred\s+laws?|handbook)\b/i,
  /\b(?:bible|sacred\s+laws?|handbook)\b.{0,80}(?:mostly\s*armless|serenity)/i,
  /sacred\s+law\s+32/i,
  /project\s+bible/i,
  /android\s+bible/i,
  /failure\s+bible/i,
  /prompt\s+bible/i,
  /hayley\s+handbook/i,
  /installer\s+rules/i,
  /mostly\s*armless/i,
  /serenity[-_\s]+(?:doctrine|bible|handbook)/i
];

export function isMaReferenceMaterial({ name = '', filePath = '', text = '' } = {}) {
  const candidate = `${name}\n${filePath}\n${String(text).slice(0, 200_000)}`;
  return MA_BIBLE_MARKERS.some((marker) => marker.test(candidate));
}

export function assertNoMaReferenceMaterial(input) {
  if (isMaReferenceMaterial(input)) {
    const error = new Error(MA_BIBLE_UNAVAILABLE_MESSAGE);
    error.code = 'ma_reference_material_unavailable';
    throw error;
  }
}
