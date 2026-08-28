#!/usr/bin/env node
// Continuous Phase 2 journey acceptance on one fresh disposable database with
// canonical seed records. This chains existing product owners without claiming
// relational links that the current stores do not have.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import {
  removeInstalledChatFixture,
  runWithFinalizers,
  stopInstalledChatServer
} from './installed-chat-lifecycle.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-phase2-journey-'));
const dbPath = path.join(probeRoot, 'data', 'life-planner.sqlite');
const privateRepo = path.join(probeRoot, 'private-repo');
const projectTitle = 'Phase 2 clean-profile goal';
const actionTitle = 'Complete the first Phase 2 action';
const reviewTitle = 'Review the Phase 2 goal outcome';
const outcomeTitle = 'Phase 2 recorded outcome';
const reviewDate = new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);

let child = null;
let browser = null;
let base = '';
let csrf = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startServer() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(privateRepo, { recursive: true });
  const output = [];
  const port = await freePort();
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: appRoot,
    env: {
      ...process.env,
      LIFE_PLANNER_DB: dbPath,
      LIFE_PLANNER_PORT: String(port),
      LIFE_PLANNER_PRIVATE_REPO: privateRepo,
      LIFE_PLANNER_CONNECTOR_CONFIG: path.join(probeRoot, 'pairing.json')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let spawnError = null;
  server.once('error', (error) => { spawnError = error; });
  server.stdout.on('data', (chunk) => output.push(String(chunk)));
  server.stderr.on('data', (chunk) => output.push(String(chunk)));
  const serverBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`Unable to start Phase 2 server: ${spawnError.message}`, { cause: spawnError });
      if (server.exitCode !== null) throw new Error(`Phase 2 server exited early (${server.exitCode}): ${output.join('')}`);
      try { if ((await fetch(`${serverBase}/api/health`)).ok) return { child: server, base: serverBase }; } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Phase 2 server did not become healthy: ${output.join('')}`);
  } catch (error) {
    try { await stopInstalledChatServer(server); }
    catch (shutdownError) { error.message += `\nAdditional startup shutdown failure: ${shutdownError.message}`; }
    throw error;
  }
}

async function connectServer() {
  const started = await startServer();
  child = started.child;
  base = started.base;
  csrf = (await (await fetch(`${base}/api/csrf-token`)).json()).data.token;
}

async function restartServer() {
  await stopInstalledChatServer(child);
  child = null;
  await connectServer();
}

async function api(route, { method = 'GET', json } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') {
    headers.Origin = base;
    headers['X-LPS-CSRF'] = csrf;
  }
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json)
  });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON failure */ }
  return { status: response.status, body };
}

async function propose(actionId, sessionId, args) {
  const response = await api(`/api/actions/${actionId}/invoke`, { method: 'POST', json: { session_id: sessionId, args } });
  assert.equal(response.status, 200, `${actionId} proposal request succeeds`);
  assert.equal(response.body?.data?.status, 'needs_confirmation', `${actionId} remains confirmation-gated`);
  assert.match(response.body?.data?.confirmation?.confirmationId || '', /^[a-f0-9]{32}$/);
  assert.match(response.body?.data?.confirmation?.token || '', /^[a-f0-9]{64}$/);
  return response.body.data;
}

async function confirmPlanner(sessionId, proposal) {
  return api(`/api/chat/sessions/${sessionId}/planner/confirm`, {
    method: 'POST',
    json: {
      confirmationId: proposal.confirmation.confirmationId,
      token: proposal.confirmation.token
    }
  });
}

await runWithFinalizers(async () => {
  assert.ok(fs.existsSync(path.join(appRoot, 'dist', 'index.html')), 'Phase 2 UI acceptance requires a production build');
  await connectServer();

  // First run -> guided profile/context capture -> reviewed Knowledge.
  const sessions = (await api('/api/chat/sessions')).body?.data || [];
  const kickoff = sessions.find((session) => session.title === 'Life Planner kickoff');
  assert.ok(kickoff?.id, 'fresh profile seeds the canonical kickoff Chat');
  const seed = (await api(`/api/chat/sessions/${kickoff.id}/messages`)).body?.data || [];
  assert.equal(seed.length, 1);
  assert.match(seed[0].content, /what's one thing/i);
  const baselineCards = (await api('/api/workboard/cards')).body.data;
  const baselineTasks = (await api('/api/planner/tasks')).body.data;
  const baselineMemory = (await api('/api/memory')).body.data;
  const baselineCardIds = new Set(baselineCards.map((card) => card.id));

  const profileAnswer = 'My current goal is to finish one small, verified LifePlanSystem action before expanding scope.';
  const answered = await api(`/api/chat/sessions/${kickoff.id}/messages`, { method: 'POST', json: { content: profileAnswer } });
  assert.equal(answered.status, 200);
  assert.equal(answered.body?.data?.runtime, 'onboarding acknowledgment');
  let memory = (await api('/api/memory')).body.data;
  const profileCandidate = memory.candidates.find((candidate) => candidate.body === profileAnswer);
  assert.ok(profileCandidate?.id, 'guided answer becomes one reviewable candidate');
  assert.ok(memory.items.every((item) => item.body !== profileAnswer), 'guided answer is not auto-promoted');
  const correctedProfile = await api(`/api/memory/candidates/${profileCandidate.id}`, {
    method: 'PATCH',
    json: { title: 'Phase 2 goal context', evidence: 'Explicitly corrected during the clean-profile journey.' }
  });
  assert.equal(correctedProfile.status, 200, 'candidate correction succeeds before approval');
  const approvedProfile = await api(`/api/memory/candidates/${profileCandidate.id}/approve`, { method: 'POST', json: {} });
  assert.equal(approvedProfile.status, 200, 'profile context promotion requires and receives explicit approval');

  // Real goal/problem -> persistent Workboard contract -> selected next action.
  const cardsBefore = (await api('/api/workboard/cards')).body.data.length;
  const projectProposal = await propose('project.propose_create', kickoff.id, {
    title: projectTitle,
    body: 'Exercise every existing Phase 2 stage on one disposable profile.',
    next_action: actionTitle
  });
  assert.equal((await api('/api/workboard/cards')).body.data.length, cardsBefore, 'proposal alone writes no Workboard card');
  const wrongProjectToken = await api(`/api/chat/sessions/${kickoff.id}/project/confirm`, {
    method: 'POST',
    json: { confirmationId: projectProposal.confirmation.confirmationId, token: '0'.repeat(64) }
  });
  assert.equal(wrongProjectToken.status, 400, 'invalid confirmation fails visibly without mutation');
  assert.equal((await api('/api/workboard/cards')).body.data.length, cardsBefore, 'failed confirmation creates no card');
  const projectApplied = await api(`/api/chat/sessions/${kickoff.id}/project/confirm`, {
    method: 'POST',
    json: {
      confirmationId: projectProposal.confirmation.confirmationId,
      token: projectProposal.confirmation.token
    }
  });
  assert.equal(projectApplied.status, 200);
  const project = projectApplied.body?.data?.record;
  assert.equal(project?.name, projectTitle);
  assert.equal(project?.next_action, actionTitle);

  // Record an executable action as a durable Planner contract.
  const actionProposal = await propose('planner.propose_create', kickoff.id, {
    title: actionTitle,
    why: `Advance ${projectTitle}`,
    next_action: 'Run the connected acceptance and retain its evidence.',
    importance: 4,
    effort: 2,
    estimated_minutes: 20,
    deadline: reviewDate
  });
  const actionApplied = await confirmPlanner(kickoff.id, actionProposal);
  assert.equal(actionApplied.status, 200);
  const actionTask = actionApplied.body?.data?.record;
  assert.equal(actionTask?.status, 'active');

  // Propose the reviewed completion before restart, then resume and confirm the
  // same durable confirmation after restart.
  const completionProposal = await propose('planner.propose_update', kickoff.id, {
    id: actionTask.id,
    changes: { status: 'completed' }
  });
  await restartServer();
  assert.ok((await api('/api/workboard/cards')).body.data.some((card) => card.id === project.id), 'Workboard contract survives restart');
  assert.ok((await api('/api/planner/tasks')).body.data.some((task) => task.id === actionTask.id), 'Planner action survives restart');

  // Record reviewed completion through the pre-restart state-bound confirmation.
  const completionApplied = await confirmPlanner(kickoff.id, completionProposal);
  assert.equal(completionApplied.status, 200);
  const completedTask = completionApplied.body?.data?.record;
  assert.equal(completedTask?.status, 'completed');
  assert.ok(completedTask?.completed_at, 'reviewed completion records a durable timestamp');
  const completionEvents = (await api(`/api/planner/tasks/${actionTask.id}/events`)).body?.data || [];
  assert.equal(completionEvents.length, 1, 'reviewed completion records one durable Planner lifecycle event');
  assert.equal(completionEvents[0].eventType, 'completed');
  assert.equal(completionEvents[0].verificationState, 'unverified', 'a completion event is not mislabelled as independent verification');
  assert.equal(completionEvents[0].evidenceAvailable, false, 'the journey does not fabricate completion evidence');

  // Update evidence/memory only through explicit review and approval.
  const outcomeMessage = 'Remember that the first bounded Phase 2 action was recorded as completed after its checks passed.';
  const outcomeTurn = await api(`/api/chat/sessions/${kickoff.id}/messages`, { method: 'POST', json: { content: outcomeMessage } });
  assert.equal(outcomeTurn.status, 200);
  const outcomeCandidateId = outcomeTurn.body?.data?.candidateId;
  assert.ok(outcomeCandidateId, 'the exact durable-signal outcome turn creates a review candidate');
  const outcomeCandidate = (await api('/api/memory')).body.data.candidates.find((candidate) => candidate.id === outcomeCandidateId);
  assert.equal(outcomeCandidate?.status, 'candidate');
  assert.equal(outcomeCandidate?.body, outcomeMessage, 'the candidate contains only the exact outcome turn');
  const outcomeUserMessage = outcomeTurn.body.data.messages.find((message) => message.role === 'user');
  assert.equal(outcomeCandidate?.source_message_id, outcomeUserMessage?.id, 'the candidate retains exact-message provenance');
  assert.ok((await api('/api/memory')).body.data.items.every((item) => item.title !== outcomeTitle), 'recorded outcome remains unapproved before review');
  assert.equal((await api(`/api/memory/candidates/${outcomeCandidate.id}`, {
    method: 'PATCH',
    json: { title: outcomeTitle, evidence: `Reviewed Planner completion ${actionTask.id}; journey project reference ${project.id}.` }
  })).status, 200);
  assert.equal((await api(`/api/memory/candidates/${outcomeCandidate.id}/approve`, { method: 'POST', json: {} })).status, 200);

  // Schedule the next review as another real, confirmation-gated Planner task.
  const reviewProposal = await propose('planner.propose_create', kickoff.id, {
    title: reviewTitle,
    why: 'Re-check the retained evidence and decide the next bounded action.',
    next_action: `Review Workboard card ${project.id} and the approved outcome memory.`,
    importance: 4,
    effort: 1,
    estimated_minutes: 15,
    deadline: reviewDate
  });
  const reviewApplied = await confirmPlanner(kickoff.id, reviewProposal);
  assert.equal(reviewApplied.status, 200);
  assert.equal(reviewApplied.body?.data?.record?.deadline, reviewDate);

  // The confirmation boundary also proves that abandoning an unconfirmed
  // proposal cannot silently create another task.
  const tasksBeforeUnconfirmed = (await api('/api/planner/tasks')).body.data.length;
  await propose('planner.propose_create', kickoff.id, {
    title: 'Unconfirmed Phase 2 draft',
    next_action: 'This must never execute without confirmation.',
    importance: 1,
    effort: 1,
    estimated_minutes: 5,
    deadline: reviewDate
  });
  assert.equal((await api('/api/planner/tasks')).body.data.length, tasksBeforeUnconfirmed, 'an unconfirmed proposal performs no task write');

  // Assert each independent durable store honestly. Current Planner tasks and
  // memory records have no canonical foreign key to the Workboard project.
  const card = (await api(`/api/workboard/cards/${project.id}`)).body.data;
  assert.equal(card.history?.events?.length, 1);
  assert.equal(card.history.events[0].type, 'created');
  assert.equal(card.proof?.verifications?.length, 1);
  assert.equal(card.proof.verifications[0].kind, 'created');
  assert.equal(card.proof.verifications[0].detail, projectProposal.args.body, 'Workboard proof contains only reviewed create-proposal evidence');
  memory = (await api('/api/memory')).body.data;
  assert.ok(!baselineCardIds.has(project.id), 'journey project is distinct from canonical seed projects');
  assert.ok(baselineMemory.items.every((item) => item.body !== profileAnswer), 'journey profile memory is distinct from canonical seed Knowledge');
  assert.ok(tasksBeforeUnconfirmed > baselineTasks.length, 'journey tasks are additional to canonical seed Planner records');
  assert.ok(memory.items.some((item) => item.title === 'Phase 2 goal context'));
  assert.ok(memory.items.some((item) => item.title === outcomeTitle));
  assert.ok(memory.candidates.every((candidate) => !['candidate', 'deferred', 'processing'].includes(candidate.status)), 'journey leaves no unreviewed memory candidate');
  const tasks = (await api('/api/planner/tasks')).body.data;
  assert.ok(tasks.some((task) => task.id === actionTask.id && task.status === 'completed'));
  assert.ok(tasks.some((task) => task.title === reviewTitle && task.status === 'active' && task.deadline === reviewDate));
  const audit = (await api(`/api/chat/sessions/${kickoff.id}/audit`)).body.data;
  for (const operation of ['project.propose_create', 'project.create', 'planner.propose_create', 'planner.create', 'planner.propose_update', 'planner.update']) {
    assert.ok(audit.some((entry) => entry.capability === operation), `audit trail contains ${operation}`);
  }

  const uiProbe = new DatabaseSync(dbPath);
  const legacyUiTitle = 'Phase 2 legacy completion UI probe';
  uiProbe.prepare("INSERT INTO planner_tasks (title, status, completed_at, updated_at) VALUES (?, 'completed', ?, ?)")
    .run(legacyUiTitle, '2099-12-31T23:59:59.000Z', '2099-12-31T23:59:59.000Z');
  uiProbe.close();

  // Real narrow-screen UI: durable Workboard and Knowledge remain visible and
  // navigable after reload with semantic navigation names and no page overflow.
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${message.location().url || 'unknown'}`);
  });
  await page.goto(`${base}/#workboard/today`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Recently completed', exact: true }).waitFor({ timeout: 15000 });
  const recordedCompletion = page.locator('.item-row').filter({ hasText: actionTitle });
  const legacyCompletion = page.locator('.item-row').filter({ hasText: legacyUiTitle });
  await recordedCompletion.getByText('History available (1 completion event) · 0 active supporting evidence records · Unverified', { exact: true }).waitFor();
  await legacyCompletion.getByText('Legacy history unavailable · Verification unknown', { exact: true }).waitFor();
  await recordedCompletion.getByText('Supporting evidence (0) · Unverified', { exact: true }).click();
  await recordedCompletion.getByLabel('What supports this completion').fill('I completed the reviewed Phase 2 action.');
  await recordedCompletion.getByRole('button', { name: 'Attach supporting evidence', exact: true }).click();
  await recordedCompletion.getByText('History available (1 completion event) · 1 active supporting evidence record · Unverified', { exact: true }).waitFor();
  await recordedCompletion.getByText('I completed the reviewed Phase 2 action.', { exact: true }).waitFor();
  assert.equal(await recordedCompletion.getByText('User statement · active · unverified', { exact: true }).count(), 1, 'real UI keeps user evidence explicitly unverified');
  assert.equal(await recordedCompletion.locator('small').filter({ hasText: 'not independent verification' }).count(), 1);
  assert.equal(await legacyCompletion.locator('small').filter({ hasText: 'LPS will not invent a past event, supporting evidence binding, or verification result.' }).count(), 1);
  await page.goto(`${base}/#workboard/cards`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Cards', exact: true }).waitFor({ timeout: 15000 });
  await page.getByText(projectTitle, { exact: true }).first().waitFor({ timeout: 15000 });
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor({ timeout: 15000 });
  assert.ok(await page.getByRole('main').count(), 'journey status is contained in the semantic main landmark');
  const glanceTab = page.getByRole('tab', { name: 'Glance', exact: true }).first();
  const contextTab = page.getByRole('tab', { name: 'Context', exact: true }).first();
  await glanceTab.focus();
  await glanceTab.press('ArrowRight');
  assert.equal(await contextTab.getAttribute('aria-selected'), 'true', 'card layers support keyboard arrow navigation');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `narrow journey view must not overflow horizontally (overflow=${overflow})`);
  await page.goto(`${base}/#knowledge`, { waitUntil: 'domcontentloaded' });
  await page.getByText(outcomeTitle, { exact: true }).first().waitFor({ timeout: 15000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(outcomeTitle, { exact: true }).first().waitFor({ timeout: 15000 });
  assert.deepEqual(pageErrors, [], `journey UI emitted page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `journey UI emitted console errors: ${consoleErrors.join(' | ')}`);

  console.log(JSON.stringify({
    status: 'PASS',
    profile: 'fresh-disposable-with-canonical-seed-records',
    baselineSeedProjects: baselineCards.length,
    baselineSeedKnowledgeItems: baselineMemory.items.length,
    sessionId: kickoff.id,
    projectId: project.id,
    completedTaskId: actionTask.id,
    reviewTaskDeadline: reviewDate,
    approvedMemoryVisible: true,
    plannerCompletionHistoryRecordedUnverified: true,
    preRestartConfirmationResumed: true,
    wrongTokenFailClosed: true,
    unconfirmedProposalWroteNothing: true,
    workboardAndKnowledgeVisibleAt390px: true
  }, null, 2));
}, [
  { name: 'browser close', run: async () => { await browser?.close(); } },
  { name: 'server shutdown', run: async () => { await stopInstalledChatServer(child); } },
  { name: 'fixture cleanup', run: async () => { await removeInstalledChatFixture(probeRoot); } }
]);
