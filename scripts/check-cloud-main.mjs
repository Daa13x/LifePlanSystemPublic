import { execFileSync } from 'node:child_process';
import {
  GIT_AUTHORITY_POLICY,
  cloudMainWritePreflight,
  repositoryIdentity
} from '../server/gitAuthorityPolicy.js';

const AI_IDENTITY = /(?:claude|anthropic|chatgpt|openai|codex|gemini|grok|\bxai\b|copilot|openhands|\bqwen\b|\bllama\b)/i;
const AI_EMAIL = /(?:noreply@anthropic\.com|@anthropic\.com|@openai\.com)/i;

function git(args) {
  return String(execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })).trim();
}

try {
  const branch = git(['branch', '--show-current']);
  const remoteUrl = git(['remote', 'get-url', 'origin']);
  const repository = repositoryIdentity(remoteUrl);
  const head = git(['rev-parse', 'HEAD']);
  const userName = git(['config', 'user.name']);
  const userEmail = git(['config', 'user.email']);
  const preflight = cloudMainWritePreflight(branch);

  if (!preflight.allowed) throw new Error(preflight.reason);
  if (!GIT_AUTHORITY_POLICY.approvedRepositories.includes(repository)) {
    throw new Error(`Cloud write preflight failed: repository ${repository || '(unknown)'} is not approved.`);
  }
  if (!userName || !userEmail) {
    throw new Error('Cloud write preflight failed: Git user.name and user.email must be configured for the LifePlanSystem maintainer.');
  }
  if (AI_IDENTITY.test(`${userName}\n${userEmail}`) || AI_EMAIL.test(userEmail)) {
    throw new Error('Cloud write preflight failed: Git identity belongs to an AI service. Configure the LifePlanSystem maintainer identity; AI tools are not project contributors.');
  }

  console.log(`Cloud Git preflight passed: ${repository} main@${head.slice(0, 12)} as ${userName} <${userEmail}>.`);
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
