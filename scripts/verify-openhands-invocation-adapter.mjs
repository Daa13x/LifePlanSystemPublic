#!/usr/bin/env node
// Focused verification for the disabled OpenHands invocation adapter stub.
//
// This script is deterministic and local-only. It does not contact OpenHands,
// read secrets, install dependencies, mutate the repo, or invoke the server.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOpenHandsInvocationPayload,
  invokeOpenHandsAdapter,
  mapOpenHandsInvocationFailure,
  summarizeOpenHandsInvocationResult,
  validateOpenHandsInvocationConfig
} from '../server/openhandsInvocationAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const adapterPath = path.join(repoRoot, 'server', 'openhandsInvocationAdapter.js');

let failures = 0;
const line = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
};

const validConfig = Object.freeze({
  endpoint: 'http://127.0.0.1:3000',
  model: 'openai/qwen-test',
  provider: 'local',
  apiKeyRef: 'dummy',
  worktreeDir: 'C:/tmp/lps-openhands-worktree',
  allowedPaths: ['src'],
  timeoutMs: 300000,
  outputMaxBytes: 1048576
});

function deniesAutonomy(result) {
  return result
    && result.invoked === false
    && result.patchApproved === false
    && result.commitAllowed === false
    && result.pushAllowed === false
    && result.mergeAllowed === false
    && result.branchDeletionAllowed === false
    && result.resetAllowed === false
    && result.stashPopAllowed === false
    && result.mainMasterWriteAllowed === false
    && result.privateMemoryAccessAllowed === false
    && result.dependencyProvisioningAllowed === false
    && result.safety?.patchApproved === false
    && result.safety?.commitAllowed === false
    && result.safety?.pushAllowed === false
    && result.safety?.mergeAllowed === false
    && result.safety?.branchDeletionAllowed === false
    && result.safety?.resetAllowed === false
    && result.safety?.stashPopAllowed === false
    && result.safety?.mainMasterWriteAllowed === false
    && result.safety?.privateMemoryAccessAllowed === false
    && result.safety?.dependencyProvisioningAllowed === false;
}

console.log('--- Disabled OpenHands invocation adapter verification ---');

{
  const r = validateOpenHandsInvocationConfig({ ...validConfig, endpoint: '' });
  line(r.ok === false && r.setupGated === true && r.missing.includes('endpoint_config_present'),
    `missing endpoint is setup-gated -> ${JSON.stringify(r)}`);
}
{
  const r = validateOpenHandsInvocationConfig({ ...validConfig, model: '', provider: '' });
  line(r.ok === false && r.setupGated === true && r.missing.includes('model_provider_config_present'),
    `missing model/provider is setup-gated -> ${JSON.stringify(r)}`);
}
{
  const { allowedPaths, ...withoutAllowedPaths } = validConfig;
  const r = validateOpenHandsInvocationConfig(withoutAllowedPaths);
  line(r.ok === false && r.setupGated === true && r.missing.includes('allowed_paths_present'),
    `missing allowedPaths is setup-gated -> ${JSON.stringify(r)}`);
}
{
  const r = validateOpenHandsInvocationConfig({ ...validConfig, allowedPaths: [] });
  line(r.ok === false && r.setupGated === true && r.missing.includes('allowed_paths_present'),
    `empty allowedPaths is setup-gated -> ${JSON.stringify(r)}`);
}
{
  const r = validateOpenHandsInvocationConfig({ ...validConfig, allowedPaths: ['../escape'] });
  line(r.ok === false && r.setupGated === true && r.missing.includes('allowed_paths_valid'),
    `invalid allowedPaths is setup-gated -> ${JSON.stringify(r)}`);
}
{
  const r = validateOpenHandsInvocationConfig({ ...validConfig, worktreeDir: '' });
  line(r.ok === false && r.setupGated === true && r.missing.includes('worktree_directory_present'),
    `missing worktree directory is setup-gated -> ${JSON.stringify(r)}`);
}
{
  const r = validateOpenHandsInvocationConfig({ ...validConfig, timeoutMs: Infinity });
  line(r.ok === false && r.setupGated === true && r.missing.includes('timeout_limit_present'),
    `unsafe timeout is setup-gated -> ${JSON.stringify(r)}`);
}
{
  const r = validateOpenHandsInvocationConfig({ ...validConfig, outputMaxBytes: Infinity });
  line(r.ok === false && r.setupGated === true && r.missing.includes('output_cap_present'),
    `unsafe output cap is setup-gated -> ${JSON.stringify(r)}`);
}
{
  const r = invokeOpenHandsAdapter({ config: validConfig, invocationEnabled: false });
  line(r.ok === false && r.invoked === false && r.status === 'setup-gated' && r.code === 'adapter_stub_disabled',
    `invocation disabled returns invoked:false -> ${JSON.stringify(r)}`);
}
{
  const r = invokeOpenHandsAdapter({ config: validConfig });
  line(r.ok === false && r.invoked === false && r.missing.includes('invocation_flag_explicit_off_by_default'),
    `missing invocation flag is setup-gated -> ${JSON.stringify(r)}`);
}
{
  let called = false;
  const r = invokeOpenHandsAdapter({
    config: validConfig,
    invocationEnabled: true,
    transport: () => { called = true; }
  });
  line(called === false && r.ok === false && r.invoked === false && r.missing.includes('invocation_flag_explicit_off_by_default'),
    `stub invocation never calls OpenHands even when flag is true -> ${JSON.stringify(r)}`);
}
{
  const r = mapOpenHandsInvocationFailure({ code: 'timeout' });
  line(r.status === 'validation-failed' && deniesAutonomy(r),
    `timeout failure maps safely -> ${JSON.stringify(r)}`);
}
{
  const r = mapOpenHandsInvocationFailure({ code: 'excessive_output' });
  line(r.status === 'validation-failed' && deniesAutonomy(r),
    `excessive output failure maps safely -> ${JSON.stringify(r)}`);
}
{
  const r = mapOpenHandsInvocationFailure({ code: 'invalid_response' });
  line(r.status === 'blocked' && deniesAutonomy(r),
    `invalid/unparseable response maps safely -> ${JSON.stringify(r)}`);
}
{
  const r = mapOpenHandsInvocationFailure({ code: 'protected_path_touched' });
  line(r.status === 'refused' && deniesAutonomy(r),
    `protected-path result maps safely -> ${JSON.stringify(r)}`);
}
{
  const r = mapOpenHandsInvocationFailure({ code: 'changed_file_outside_allowedPaths' });
  line(r.status === 'refused' && deniesAutonomy(r),
    `changed-file-outside-allowedPaths result maps safely -> ${JSON.stringify(r)}`);
}
{
  const r = mapOpenHandsInvocationFailure({ code: 'too_many_files_changed' });
  line(r.status === 'refused' && deniesAutonomy(r),
    `too-many-files-changed result maps safely -> ${JSON.stringify(r)}`);
}
{
  const r = mapOpenHandsInvocationFailure({ code: 'validation_failed' });
  line(r.status === 'validation-failed' && deniesAutonomy(r),
    `validation failure maps safely -> ${JSON.stringify(r)}`);
}
{
  const payload = buildOpenHandsInvocationPayload(validConfig);
  const mapped = [
    invokeOpenHandsAdapter({ config: validConfig, invocationEnabled: false }),
    mapOpenHandsInvocationFailure({ code: 'protected_path_touched' }),
    summarizeOpenHandsInvocationResult({ ok: true, invoked: true })
  ];
  line(payload.ok === true && payload.invoked === false && mapped.every(deniesAutonomy) && payload.patchApproved === false,
    `adapter never claims a patch is approved -> ${JSON.stringify({ payload, mapped })}`);
}
{
  const r = summarizeOpenHandsInvocationResult({ ok: true, invoked: true });
  line(r.ok === false && deniesAutonomy(r),
    `adapter never claims commit/push/merge or branch deletion/reset/stash-pop/private access is allowed -> ${JSON.stringify(r)}`);
}
{
  const source = fs.readFileSync(adapterPath, 'utf8');
  const forbiddenSourcePatterns = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\baxios\b/,
    /from\s+['"]node:http/,
    /from\s+['"]node:https/,
    /from\s+['"]http/,
    /from\s+['"]https/,
    /\bchild_process\b/,
    /\bspawn\s*\(/,
    /\bexecFile\s*\(/,
    /\bexec\s*\(/
  ];
  const matches = forbiddenSourcePatterns.filter((pattern) => pattern.test(source)).map(String);
  line(matches.length === 0, `adapter exposes no network/process caller import -> ${JSON.stringify(matches)}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS - disabled OpenHands adapter remains local-only, setup-gated, and non-authorizing.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
