import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const boundaryPath = path.join(root, 'docs', 'architecture', 'REFERENCE_MATERIAL_BOUNDARY.md');
const runtimeAndPromptRoots = ['server', 'src', 'browser-extension', 'templates', path.join('docs', 'agent_mode')];
const forbidden = /(?:sacred\s+laws|project\s+bible|android\s+bible|failure\s+bible|prompt\s+bible|hayley\s+handbook|installer\s+rules)/i;
const ignored = new Set(['node_modules', 'dist', 'release', '.git', '.lps', '.cache']);

function filesUnder(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const next = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) found.push(next);
    }
  };
  walk(absolute);
  return found;
}

const failures = [];
const boundary = fs.readFileSync(boundaryPath, 'utf8');
for (const required of ['independent application', 'proprietary to Mostly Armless', 'not LPS specifications', 'not present it as LPS doctrine', 'not an LPS setup fault']) {
  if (!boundary.includes(required)) failures.push(`boundary document is missing required statement: ${required}`);
}

for (const relative of runtimeAndPromptRoots) {
  for (const file of filesUnder(relative)) {
    const text = fs.readFileSync(file, 'utf8');
    if (forbidden.test(text)) failures.push(`proprietary Bible/doctrine term is operationally reachable: ${path.relative(root, file)}`);
  }
}

const historicalAttachment = fs.readFileSync(path.join(root, 'docs', 'attachments', 'ATTACHMENT_2026-07-04_MOSTLYARMLESS_CONTEXT.md'), 'utf8');
if (historicalAttachment.length > 1000 || !historicalAttachment.includes('QUARANTINED') || !historicalAttachment.includes('must not be loaded as LPS agent context')) {
  failures.push('historical Mostly Armless attachment remains operational rather than quarantined');
}

const review = fs.readFileSync(path.join(root, 'docs', 'architecture', 'LPS_CSharp_Native_Core_WebView2_v5_Review.md'), 'utf8');
if (forbidden.test(review) || !review.includes('LPS-owned requirements and executable evidence')) {
  failures.push('native architecture review retains an external-doctrine dependency');
}

if (failures.length) {
  console.error('Reference-material boundary verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Reference-material boundary verification passed: proprietary Mostly Armless Bible/doctrine material is quarantined from LPS operational context.');
