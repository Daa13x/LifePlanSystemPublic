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
  buildOpenHandsAdapterUiState,
  buildOpenHandsHumanNextSteps,
  buildOpenHandsInvocationDryRunChecklist,
  buildOpenHandsInvocationReportSection,
  buildOpenHandsInvocationStatusCard,
  buildOpenHandsPostRunReviewChecklist,
  invokeOpenHandsAdapter,
  mapOpenHandsInvocationFailure,
  OPENHANDS_INVOCATION_STATUS_TAXONOMY,
  summarizeOpenHandsInvocationResult,
  validateOpenHandsInvocationConfig
} from '../server/openhandsInvocationAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const adapterPath = path.join(repoRoot, 'server', 'openhandsInvocationAdapter.js');
const fixtureDir = path.join(repoRoot, 'docs', 'tooling', 'openhands_invocation_examples');

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
    && result.realInvocationEnabled === false
    && result.requiresHumanReview === true
    && result.requiresSeparatePostRunApproval === true
    && result.safety?.patchApproved === false
    && result.safety?.commitAllowed === false
    && result.safety?.pushAllowed === false
    && result.safety?.mergeAllowed === false
    && result.safety?.branchDeletionAllowed === false
    && result.safety?.resetAllowed === false
    && result.safety?.stashPopAllowed === false
    && result.safety?.mainMasterWriteAllowed === false
    && result.safety?.privateMemoryAccessAllowed === false
    && result.safety?.dependencyProvisioningAllowed === false
    && result.safety?.realInvocationEnabled === false
    && result.safety?.requiresHumanReview === true
    && result.safety?.requiresSeparatePostRunApproval === true;
}

function fixtureDeniesAutonomy(fixture) {
  return fixture
    && fixture.invoked === false
    && fixture.realInvocationEnabled === false
    && fixture.patchApproved === false
    && fixture.commitAllowed === false
    && fixture.pushAllowed === false
    && fixture.mergeAllowed === false
    && fixture.branchDeletionAllowed === false
    && fixture.resetAllowed === false
    && fixture.stashPopAllowed === false
    && fixture.mainMasterWriteAllowed === false
    && fixture.privateMemoryAccessAllowed === false
    && fixture.dependencyProvisioningAllowed === false
    && fixture.requiresHumanReview === true
    && fixture.requiresSeparatePostRunApproval === true;
}

function textHasNoAutomationCommand(text) {
  return !/\bauto-(commit|push|merge)\b/i.test(text)
    && !/\bautomatically\s+(commit|push|merge)\b/i.test(text);
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
  const requiredStatuses = ['setup-gated', 'blocked', 'refused', 'validation-failed', 'timeout', 'output-capped', 'invalid-response'];
  const missing = requiredStatuses.filter((status) => !OPENHANDS_INVOCATION_STATUS_TAXONOMY.includes(status));
  line(missing.length === 0, `status taxonomy covers required statuses -> ${JSON.stringify({ taxonomy: OPENHANDS_INVOCATION_STATUS_TAXONOMY, missing })}`);
}
{
  const expectedFixtures = [
    'disabled_invocation_request.example.json',
    'valid_local_config.example.json',
    'missing_endpoint_failure.example.json',
    'missing_model_failure.example.json',
    'timeout_failure.example.json',
    'output_capped_failure.example.json',
    'invalid_response_failure.example.json',
    'protected_path_failure.example.json',
    'changed_file_outside_allowed_paths_failure.example.json',
    'too_many_files_failure.example.json',
    'validation_failed_failure.example.json',
    'post_run_review_required.example.json'
  ];
  const parsed = [];
  for (const filename of expectedFixtures) {
    const fullPath = path.join(fixtureDir, filename);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const fixture = JSON.parse(raw);
    parsed.push({ filename, raw, fixture });
  }
  line(parsed.length === expectedFixtures.length, `all fixtures parse successfully -> ${JSON.stringify(parsed.map((item) => item.filename))}`);

  const secretPattern = /(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC |)PRIVATE KEY|password\s*[:=]|secret\s*[:=]|token\s*[:=])/i;
  const secretHits = parsed.filter((item) => secretPattern.test(item.raw)).map((item) => item.filename);
  line(secretHits.length === 0, `fixture files contain no likely secrets or real API keys -> ${JSON.stringify(secretHits)}`);

  const protectedHits = parsed.filter((item) => /source_of_truth|memory\//i.test(item.raw)
    && !(item.filename === 'protected_path_failure.example.json' && /forbidden\/protected path example/i.test(item.raw))).map((item) => item.filename);
  line(protectedHits.length === 0, `fixtures avoid private memory/source_of_truth except forbidden examples -> ${JSON.stringify(protectedHits)}`);

  const permissionFailures = parsed.filter((item) => !fixtureDeniesAutonomy(item.fixture)).map((item) => item.filename);
  line(permissionFailures.length === 0, `every fixture denies patch approval and commit/push/merge permissions -> ${JSON.stringify(permissionFailures)}`);

  const fixtureText = parsed.map((item) => item.fixture.humanNextStep || '').join('\n');
  line(textHasNoAutomationCommand(fixtureText), 'fixture human next steps never say to auto-commit, auto-push, or auto-merge');
}
{
  const outcomes = [
    invokeOpenHandsAdapter({ config: validConfig, invocationEnabled: false }),
    mapOpenHandsInvocationFailure({ code: 'timeout' }),
    mapOpenHandsInvocationFailure({ code: 'excessive_output' }),
    mapOpenHandsInvocationFailure({ code: 'invalid_response' }),
    mapOpenHandsInvocationFailure({ code: 'protected_path_touched' })
  ];
  const cards = outcomes.map(buildOpenHandsInvocationStatusCard);
  const reports = outcomes.map(buildOpenHandsInvocationReportSection);
  const uiStates = outcomes.map(buildOpenHandsAdapterUiState);
  line(cards.every(deniesAutonomy), `every status card denies autonomy -> ${JSON.stringify(cards)}`);
  line(reports.every(deniesAutonomy), `every report section denies autonomy -> ${JSON.stringify(reports.map((item) => ({ status: item.status, safety: item.safety })))}`);
  line(uiStates.every(deniesAutonomy), `every UI state denies autonomy -> ${JSON.stringify(uiStates.map((item) => ({ status: item.status, safety: item.safety })))}`);
}
{
  const dryRun = buildOpenHandsInvocationDryRunChecklist(validateOpenHandsInvocationConfig(validConfig));
  line(dryRun.requiresHumanApproval === true && dryRun.approvalRequiredBeforeInvocation === true && deniesAutonomy(dryRun),
    `dry-run checklist requires human approval -> ${JSON.stringify(dryRun)}`);
}
{
  const postRun = buildOpenHandsPostRunReviewChecklist(mapOpenHandsInvocationFailure({ code: 'validation_failed' }));
  line(postRun.requiresSeparatePostRunApproval === true && postRun.approvalRequiredBeforeCommitPushPr === true && deniesAutonomy(postRun),
    `post-run review checklist requires separate approval before commit/push/PR -> ${JSON.stringify(postRun)}`);
}
{
  const nextSteps = [
    ...buildOpenHandsHumanNextSteps({ status: 'setup-gated', reason: 'missing endpoint' }),
    ...buildOpenHandsHumanNextSteps({ status: 'refused', reason: 'protected path touched' }),
    ...buildOpenHandsHumanNextSteps({ status: 'validation-failed', code: 'timeout', reason: 'timeout' })
  ];
  line(textHasNoAutomationCommand(nextSteps.join('\n')),
    `human next steps never say to auto-commit, auto-push, or auto-merge -> ${JSON.stringify(nextSteps)}`);
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
    /\bexec\s*\(/,
    /\bwriteFile(?:Sync)?\s*\(/,
    /\bcreateWriteStream\s*\(/,
    /\bappendFile(?:Sync)?\s*\(/
  ];
  const matches = forbiddenSourcePatterns.filter((pattern) => pattern.test(source)).map(String);
  line(matches.length === 0, `adapter exposes no network/process/shell/secret-writing caller -> ${JSON.stringify(matches)}`);
}
{
  const source = fs.readFileSync(adapterPath, 'utf8');
  const truePermissionPatterns = [
    /patchApproved:\s*true/,
    /commitAllowed:\s*true/,
    /pushAllowed:\s*true/,
    /mergeAllowed:\s*true/,
    /branchDeletionAllowed:\s*true/,
    /resetAllowed:\s*true/,
    /stashPopAllowed:\s*true/
  ];
  const matches = truePermissionPatterns.filter((pattern) => pattern.test(source)).map(String);
  line(matches.length === 0, `no helper returns true for patch/git/reset/stash permissions -> ${JSON.stringify(matches)}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS - disabled OpenHands adapter remains local-only, setup-gated, and non-authorizing.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
