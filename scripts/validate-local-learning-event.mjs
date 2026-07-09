#!/usr/bin/env node
// Manual one-file validator for local-learning event JSON. This script reads
// the provided file, validates it, prints the result, and writes nothing.

import fs from 'node:fs';
import { validateLocalLearningEvent } from '../server/localLearningEventValidator.js';

const args = process.argv.slice(2);

if (args.length !== 1) {
  console.error('Usage: node scripts/validate-local-learning-event.mjs <event.json>');
  process.exit(2);
}

let raw;
try {
  raw = fs.readFileSync(args[0], 'utf8');
} catch (error) {
  console.error(`FAIL local-learning event file could not be read: ${error.message}`);
  process.exit(1);
}

let event;
try {
  event = JSON.parse(raw);
} catch (error) {
  console.error(`FAIL local-learning event JSON is malformed: ${error.message}`);
  process.exit(1);
}

const result = validateLocalLearningEvent(event);
if (result.ok) {
  console.log('PASS local-learning event is valid');
  process.exit(0);
}

console.error('FAIL local-learning event is invalid');
for (const error of result.errors) {
  console.error(`- ${error}`);
}
process.exit(1);
