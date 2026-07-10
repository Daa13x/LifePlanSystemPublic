#!/usr/bin/env node
// Manual read-only list command for local-learning review candidates. It does
// not approve, reject, promote, modify, move, or delete candidates.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLocalLearningReviewCandidates } from '../server/localLearningReviewInboxReader.js';

function displayText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) {
    console.error('Usage: node scripts/list-local-learning-review-inbox.mjs');
    return 2;
  }

  const result = listLocalLearningReviewCandidates({ repoRoot: path.resolve('.') });
  if (!result.ok) {
    console.error(`FAIL local-learning review inbox could not be read: ${displayText(result.reason)}`);
    return 1;
  }

  if (result.candidateCount === 0) {
    console.log('No pending local-learning review candidates.');
  } else {
    console.log(`Pending local-learning review candidates: ${result.candidateCount}`);
    for (const candidate of result.candidates) {
      console.log(`- ${displayText(candidate.filename)} [${candidate.status}]`);
      console.log(`  path: ${displayText(candidate.relativePath)}`);
      if (candidate.task_type !== null) console.log(`  task_type: ${displayText(candidate.task_type)}`);
      if (candidate.memory_route !== null) console.log(`  memory_route: ${displayText(candidate.memory_route)}`);
      if (candidate.approval_required !== null) {
        console.log(`  approval_required: ${candidate.approval_required}`);
      }
      for (const error of candidate.errors) console.log(`  error: ${displayText(error)}`);
    }
  }

  console.log('Read-only listing: no candidate was approved, rejected, promoted, modified, moved, or deleted.');
  return 0;
}

const directRunPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (directRunPath === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
