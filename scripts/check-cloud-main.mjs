import { execFileSync } from 'node:child_process';
import {
  GIT_AUTHORITY_POLICY,
  cloudMainWritePreflight,
  repositoryIdentity
} from '../server/gitAuthorityPolicy.js';

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
  const preflight = cloudMainWritePreflight(branch);

  if (!preflight.allowed) throw new Error(preflight.reason);
  if (!GIT_AUTHORITY_POLICY.approvedRepositories.includes(repository)) {
    throw new Error(`Cloud write preflight failed: repository ${repository || '(unknown)'} is not approved.`);
  }

  console.log(`Cloud Git preflight passed: ${repository} main@${head.slice(0, 12)}.`);
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
