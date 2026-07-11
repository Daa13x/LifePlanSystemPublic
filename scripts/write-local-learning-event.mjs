#!/usr/bin/env node
// Manual writer for a validated local-learning event. It writes only to the
// ignored local review inbox and never promotes anything to durable memory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLocalLearningReviewCandidate } from '../server/localLearningReviewInbox.js';

export function main(argv = process.argv.slice(2)) {
  if (argv.length < 1 || argv.length > 2) {
    console.error('Usage: node scripts/write-local-learning-event.mjs <event.json> [filename-slug]');
    return 2;
  }

  const [eventPath, slug] = argv;
  let raw;
  try {
    raw = fs.readFileSync(eventPath, 'utf8');
  } catch (error) {
    console.error(`FAIL local-learning event file could not be read: ${error.message}`);
    return 1;
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch (error) {
    console.error(`FAIL local-learning event JSON is malformed: ${error.message}`);
    return 1;
  }

  const result = writeLocalLearningReviewCandidate(event, {
    repoRoot: path.resolve('.'),
    slug
  });

  if (!result.ok) {
    console.error(`FAIL local-learning review candidate was not written: ${result.reason}`);
    for (const error of result.errors || []) {
      console.error(`- ${error}`);
    }
    return 1;
  }

  console.log('PASS local-learning review candidate written');
  console.log(result.path);
  console.log('This file is an unapproved review candidate, not memory.');
  return 0;
}

const directRunPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (directRunPath === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
