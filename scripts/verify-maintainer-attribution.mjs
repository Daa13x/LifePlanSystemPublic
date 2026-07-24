import { execFileSync } from 'node:child_process';

const AI_IDENTITY = /(?:claude|anthropic|chatgpt|openai|codex|gemini|grok|\bxai\b|copilot|openhands|\bqwen\b|\bllama\b)/i;
const AI_TRAILER = /^\s*(?:co-authored-by|coauthored-by|authored-by|contributed-by|contributor|signed-off-by)\s*:.*(?:claude|anthropic|chatgpt|openai|codex|gemini|grok|\bxai\b|copilot|openhands|\bqwen\b|\bllama\b)/im;
const AI_EMAIL = /(?:noreply@anthropic\.com|@anthropic\.com|@openai\.com)/i;

function git(args, { allowFailure = false } = {}) {
  try {
    return String(execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })).trim();
  } catch (error) {
    if (allowFailure) return '';
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function isZeroSha(value) {
  return !value || /^0+$/.test(value);
}

function assertNoAiAttribution(label, text) {
  const value = String(text || '');
  if (AI_TRAILER.test(value) || AI_EMAIL.test(value)) {
    throw new Error(`${label} contains prohibited AI contributor attribution. LifePlanSystem is owned and authored under the maintainer's identity; AI tools must never be added as authors, co-authors, contributors, sign-offs, taggers, or release contributors.`);
  }
}

function inspectCommit(sha) {
  const identity = git(['show', '-s', '--format=%an%n%ae%n%cn%n%ce', sha]);
  if (AI_IDENTITY.test(identity) || AI_EMAIL.test(identity)) {
    throw new Error(`Commit ${sha.slice(0, 12)} uses a prohibited AI author or committer identity.`);
  }
  const message = git(['show', '-s', '--format=%B', sha]);
  assertNoAiAttribution(`Commit ${sha.slice(0, 12)}`, message);
}

const before = process.argv[2] || '';
const requestedAfter = process.argv[3] || 'HEAD';
const pushedRef = process.argv[4] || '';
const after = git(['rev-parse', `${requestedAfter}^{commit}`]);

let commits = [];
if (!isZeroSha(before)) {
  commits = git(['rev-list', `${before}..${after}`], { allowFailure: true }).split('\n').filter(Boolean);
}
if (!commits.length) commits = [after];

for (const sha of commits) inspectCommit(sha);

if (pushedRef.startsWith('refs/tags/')) {
  const tagIdentityAndMessage = git([
    'for-each-ref',
    '--format=%(taggername)%n%(taggeremail)%n%(contents)',
    pushedRef
  ], { allowFailure: true });
  if (AI_IDENTITY.test(tagIdentityAndMessage) || AI_EMAIL.test(tagIdentityAndMessage)) {
    throw new Error(`Tag ${pushedRef.replace('refs/tags/', '')} contains a prohibited AI tagger identity or attribution.`);
  }
  assertNoAiAttribution(`Tag ${pushedRef.replace('refs/tags/', '')}`, tagIdentityAndMessage);
}

console.log(`Maintainer attribution verified for ${commits.length} commit(s)${pushedRef ? ` on ${pushedRef}` : ''}. No AI contributor metadata found.`);
