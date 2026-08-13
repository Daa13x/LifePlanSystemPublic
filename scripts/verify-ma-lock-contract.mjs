import assert from 'node:assert/strict';
import { ALLOWED_METADATA_PATHS, scanText, signatureMatches } from './ma-lock.mjs';

assert.ok(signatureMatches('Project Bible and MostlyArmless.Services.Core').length >= 2);
assert.equal(scanText('server/worker.js', 'Use Project Bible rules.').length, 1);
assert.equal(scanText('src/prompt.js', 'MostlyArmless.Services.Core').length, 1);
assert.equal(scanText('docs/architecture/REFERENCE_MATERIAL_BOUNDARY.md', 'Project Bible is prohibited.').length, 0);
assert.ok(ALLOWED_METADATA_PATHS.has('docs/attachments/ATTACHMENT_2026-07-04_MOSTLYARMLESS_CONTEXT.md'));

console.log('MA-lock contract verification passed: known doctrine and implementation signatures are rejected outside narrow boundary metadata.');
