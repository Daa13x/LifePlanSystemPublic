import assert from 'node:assert/strict';
import { assertNoMaReferenceMaterial, isMaReferenceMaterial, MA_BIBLE_UNAVAILABLE_MESSAGE } from '../server/maReferenceGuard.js';

assert.equal(isMaReferenceMaterial({ name: 'Life plan.pdf', text: 'A normal user document.' }), false);
assert.equal(isMaReferenceMaterial({ name: 'LPS Sacred Laws.md', text: 'LPS has its own local reference guidance.' }), false);
assert.equal(isMaReferenceMaterial({ name: 'Project Bible.pdf' }), true);
assert.equal(isMaReferenceMaterial({ filePath: 'docs/Serenity-handbook.md' }), true);
assert.equal(isMaReferenceMaterial({ text: 'Mostly Armless Sacred Laws define this protocol.' }), true);
assert.throws(() => assertNoMaReferenceMaterial({ name: 'Failure Bible.pdf' }), { message: MA_BIBLE_UNAVAILABLE_MESSAGE, code: 'ma_reference_material_unavailable' });

console.log('MA reference guard verification passed: Bible-like material is rejected before LPS prompt or PDF intake.');
