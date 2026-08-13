import fs from 'node:fs';
import path from 'node:path';
import { scanStaged, scanText, scanWorkingTree } from './ma-lock.mjs';

const root = path.resolve(process.cwd());
const stagedOnly = process.argv.includes('--staged');
const attachment = path.join(root, 'docs', 'attachments', 'ATTACHMENT_2026-07-04_MOSTLYARMLESS_CONTEXT.md');
const boundary = path.join(root, 'docs', 'architecture', 'REFERENCE_MATERIAL_BOUNDARY.md');
const findings = stagedOnly ? scanStaged(root) : scanWorkingTree(root);

if (!stagedOnly) {
  const attachmentText = fs.readFileSync(attachment, 'utf8');
  if (attachmentText.length > 1000 || !attachmentText.includes('QUARANTINED') || !attachmentText.includes('must not be loaded as LPS agent context')) {
    findings.push('historical MA attachment is not a compact quarantine marker');
  }
  const boundaryText = fs.readFileSync(boundary, 'utf8');
  if (!boundaryText.includes('not an LPS setup fault') || !boundaryText.includes('MA-lock')) {
    findings.push('reference boundary does not define the missing-orchestrator and MA-lock rules');
  }
  const sourceControlAttachment = path.join(root, 'docs', 'attachments', 'ma-source-control');
  if (fs.existsSync(sourceControlAttachment) && fs.readdirSync(sourceControlAttachment).length) {
    findings.push('raw Mostly Armless Source Control attachment remains in the LPS repository');
  }
}

if (findings.length) {
  console.error('MA-lock blocked proprietary Mostly Armless material from LPS:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(stagedOnly
  ? 'MA-lock staged-change verification passed.'
  : 'MA-lock verification passed: known proprietary Mostly Armless material is absent from LPS operational and repository content.');
