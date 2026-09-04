#!/usr/bin/env node
// Verify natural-chat behaviour: intent routing, memory-candidate gating, and
// safe Markdown rendering, using the REAL modules the app imports.
//
//   1. classifyChatIntent keeps ordinary messages conversational and only routes
//      explicit data questions (status / model / workboard / blocked).
//   2. shouldCreateMemoryCandidate does NOT fire for greetings, tests, or
//      "can you speak" checks, and DOES fire for explicit save + durable signals.
//   3. renderMarkdown formats bold/italics/headings/lists/inline+fenced code and
//      links, escapes raw HTML, and drops javascript: URLs (no unsafe HTML).
//
// Local-only: no network, no server, no DB. Exit 0 = pass.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  capabilityRequestForChatIntent,
  classifyChatIntent,
  formatPersonalityCapabilityReply,
  selectPersonalityCapabilityPlan,
  shouldCreateMemoryCandidate
} from '../server/chatIntent.js';
import { buildChatCommandCatalog, CHAT_COMMANDS, explicitChatCommand } from '../server/chatCommands.js';
import { createCapabilityRegistry } from '../server/chatCapabilities.js';
import { renderMarkdown } from '../src/markdown.js';
import {
  boundedConversationHistory,
  classifyConsultationReference,
  enforceAssistantResponseConsistency,
  formatConsultationReply
} from '../server/chatReliability.js';

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- chat behaviour verification ---');

// 1. Intent routing.
{
  const cases = [
    ['Hello, are you working?', 'conversation'],
    ['test i want to see you speak', 'conversation'],
    ['Test, I want to see you respond.', 'conversation'],
    ['Remember that I do not want cloud coding agents to create branches.', 'conversation'],
    ['Tell me a joke about databases.', 'conversation'],
    ['List my active Workboard project names.', 'workboard_list'],
    ['show me my projects', 'workboard_list'],
    ['Show me the current system status.', 'system_status'],
    ['what is the system status', 'system_status'],
    ['Which model is active?', 'model_query'],
    ['what model is loaded right now', 'model_query'],
    ['What is currently blocked?', 'blocked_query'],
    ['list everything blocked', 'blocked_query'],
    ['What date is it?', 'current_date'],
    ['What time is it?', 'current_time'],
    ['Do you have live news today?', 'live_news'],
    ['Where are my memories stored locally?', 'memory_storage'],
    ['Where do you store my memory?', 'memory_storage'],
    ['show my plan for today', 'planner_today'],
    ['/today', 'planner_today'],
    ['/status', 'system_status'],
    ['/model', 'model_query'],
    ['/projects', 'workboard_list'],
    ['/blockers', 'blocked_query'],
    ['list recent local runs', 'recent_runs'],
    ['/runs', 'recent_runs']
  ];
  for (const [input, expected] of cases) {
    const got = classifyChatIntent(input);
    line(got === expected, `intent(${JSON.stringify(input)}) = ${got} (expected ${expected})`);
  }
}

// 4. Consultation references and receipt-backed consistency guards.
{
  const consultation = { id: 19, consultation_id: 19, provider: 'ChatGPT', model: 'Current model selected in ChatGPT', status: 'completed', response: 'ATOMPROOF42' };
  line(classifyConsultationReference('what did you get from chatgpt?', { hasCompletedConsultation: true }) === 'result', 'ChatGPT result question resolves to the completed consultation');
  line(classifyConsultationReference('use that answer', { hasCompletedConsultation: true }) === 'use', 'contextual use-that-answer resolves to one-shot guidance');
  line(classifyConsultationReference('remove guidance', { hasCompletedConsultation: true }) === 'remove', 'contextual guidance removal resolves to the same owner');
  line(classifyConsultationReference("what's this?", { hasCompletedConsultation: true }) === 'describe', 'vague reference prefers the current consultation object');
  line(/ATOMPROOF42/.test(formatConsultationReply(consultation)), 'receipt-grounded reply carries the actual provider result');

  const denial = enforceAssistantResponseConsistency({ content: "I don't have access to ChatGPT or external messages.", userMessage: 'what did ChatGPT say?', consultation });
  line(denial.changed && /ATOMPROOF42/.test(denial.content), 'a false cloud-access denial is replaced from the durable receipt');
  const action = enforceAssistantResponseConsistency({ content: "I've saved that task for you.", userMessage: 'remember this', actionReceipt: null });
  line(action.changed && /no verified action receipt/i.test(action.content), 'an unreceipted save claim fails closed');
  const identity = enforceAssistantResponseConsistency({ content: "I'm Google's Gemini assistant.", userMessage: 'who are you?', route: { model: 'Qwen local' } });
  line(identity.changed && /LifePlanSystem Planner Assistant/.test(identity.content) && /Qwen local/.test(identity.content), 'provider identity is grounded in the actual local route');

  const history = boundedConversationHistory(Array.from({ length: 20 }, (_, index) => ({ id: index + 1, role: index % 2 ? 'assistant' : 'user', content: `turn-${index + 1}` })));
  line(history.length === 14 && history[0].id === 7 && history.at(-1).id === 20, 'conversation context is deterministically bounded to the latest 14 visible turns');
}

const actionMappings = new Map([
  ['system_status', 'system.status'],
  ['model_query', 'system.models'],
  ['recent_runs', 'system.runs'],
  ['workboard_list', 'workboard.list'],
  ['blocked_query', 'workboard.list'],
  ['planner_today', 'planner.today']
]);
for (const [intent, actionId] of actionMappings) {
  const request = capabilityRequestForChatIntent(intent);
  line(request?.actionId === actionId, `intent ${intent} delegates to the universal ${actionId} action`);
}
line(capabilityRequestForChatIntent('conversation') === null, 'ordinary conversation has no action-registry request');

const commandCatalog = buildChatCommandCatalog(createCapabilityRegistry({}).listActions());
line(commandCatalog.length === CHAT_COMMANDS.length, 'every built-in Chat command resolves to a live universal action');
line(commandCatalog.every((command) => command.permission && command.risk && command.confirmation), 'command discovery inherits permission, risk, and confirmation from the action registry');
line(explicitChatCommand('/add-task Buy milk')?.actionId === 'planner.propose_create', 'parameterised task command resolves to the proposal action');
line(explicitChatCommand('/does-not-exist') === null, 'unknown slash commands do not gain action authority');

// Personality-aware behaviour is a bounded adapter over the same registry.
// The profile is injected so this pure test proves that trait strength changes
// selection rather than merely changing prompt wording.
{
  const activeProfile = { traits: [
    { id: 'inquisitive', strength: 10 },
    { id: 'sceptical', strength: 9.5 },
    { id: 'practical', strength: 9 },
    { id: 'resource-conscious', strength: 7.5 }
  ] };
  const inactiveProfile = { traits: activeProfile.traits.map((trait) => ({ ...trait, strength: 0 })) };

  const today = selectPersonalityCapabilityPlan('What am I supposed to be doing today?', activeProfile);
  line(today?.actionId === 'planner.today' && today.replyKind === 'today', 'inquisitiveness selects the existing Today read');
  line(selectPersonalityCapabilityPlan('What am I supposed to be doing today?', inactiveProfile) === null, 'low trait strengths do not select the personality read');

  const run = selectPersonalityCapabilityPlan('Why did the last run fail?', activeProfile);
  line(run?.actionId === 'system.runs' && run.args.limit === 1, 'resource-conscious routing selects one bounded run read');

  const claim = selectPersonalityCapabilityPlan("I'm sure we already finished the personality work.", activeProfile);
  line(claim?.actionId === 'knowledge.search' && claim.verification === true && claim.args.scope === 'approved', 'scepticism checks a confident completion claim against approved evidence');

  const taskClaim = selectPersonalityCapabilityPlan('That task is completed.', activeProfile);
  line(taskClaim?.actionId === 'planner.today' && taskClaim.verification === true, 'scepticism checks a Planner completion claim');

  const crash = selectPersonalityCapabilityPlan('The model definitely caused the crash.', activeProfile);
  line(crash?.kind === 'uncertainty' && crash.actionId === null, 'unsupported causal claim states uncertainty without an irrelevant tool call');
  line(/not established/i.test(formatPersonalityCapabilityReply(crash)), 'unsupported causal reply does not mirror the user assumption');

  line(selectPersonalityCapabilityPlan('Hello', activeProfile) === null, 'simple conversation causes zero personality action fan-out');
  line(selectPersonalityCapabilityPlan('Add buy milk to today.', activeProfile) === null, 'consequential task intent is not authorised by personality');
  line(/cannot establish what failed or why/i.test(formatPersonalityCapabilityReply(run, { runs: [] })), 'insufficient run evidence produces explicit uncertainty');

  const registry = createCapabilityRegistry({
    searchKnowledge: async () => [],
    plannerToday: async () => ({ mode: 'normal', visible: [], deferred: [], recentlyCompleted: [] })
  });
  const personalityRead = await registry.execute('planner.today', {}, { caller: 'personality-reasoning', userId: 1 });
  line(personalityRead.status === 'success', 'trusted personality source can execute its narrow existing read allowlist');
  const personalityWrite = await registry.execute('planner.propose_create', { title: 'Buy milk' }, { caller: 'personality-reasoning', userId: 1 });
  line(personalityWrite.status === 'blocked', 'personality source cannot invoke a write/proposal action');
  const humanProposal = await registry.execute('planner.propose_create', { title: 'Buy milk' }, { caller: 'human-ui', userId: 1 });
  line(humanProposal.status === 'needs_confirmation' && humanProposal.data?.confirmation_required === true, 'the existing human proposal still requires Allow/Decline');
}

// 2. Memory-candidate gating.
{
  const noCandidate = [
    'hello', 'Hello', 'test', 'Test, I want to see you respond.', 'are you working?',
    'I want to see you speak', 'test i want to see you speak', 'thanks!', 'ok cool',
    'List my active Workboard project names.', 'Show me the current system status.'
  ];
  for (const input of noCandidate) {
    const r = shouldCreateMemoryCandidate(input);
    line(r.create === false, `no candidate for ${JSON.stringify(input)} -> ${r.reason}`);
  }
  const yesCandidate = [
    ['Remember that I do not want cloud coding agents to create branches.', 'explicit'],
    ['Please save this: the API key rotates every 90 days.', 'explicit'],
    ['I prefer dark mode and never want telemetry enabled.', 'preference'],
    ['We decided to ship the schema migration before the API change.', 'decision'],
    ['The deploy always fails when the migration runs on a cold database.', 'pattern']
  ];
  for (const [input, why] of yesCandidate) {
    const r = shouldCreateMemoryCandidate(input);
    line(r.create === true, `candidate created for ${JSON.stringify(input)} (${why}) -> ${r.reason}`);
  }
}

// 3. Markdown rendering + safety.
{
  const html = renderMarkdown('# Title\n\nA **bold** and _italic_ line with `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n```js\nconst x = 1;\n```\n\n[link](https://example.com)');
  line(/<h1[^>]*>Title<\/h1>/.test(html), 'heading renders');
  line(/<strong>bold<\/strong>/.test(html), 'bold renders');
  line(/<em>italic<\/em>/.test(html), 'italic renders');
  line(/<code>code<\/code>/.test(html), 'inline code renders');
  line(/<ul>[\s\S]*<li>one<\/li>/.test(html), 'unordered list renders');
  line(/<ol>[\s\S]*<li>first<\/li>/.test(html), 'ordered list renders');
  line(/<pre><code[^>]*>const x = 1;/.test(html), 'fenced code block renders');
  line(/<a href="https:\/\/example\.com"[^>]*>link<\/a>/.test(html), 'link renders');
  line(!/\*\*bold\*\*/.test(html) && !/# Title/.test(html), 'no literal Markdown markers leak outside code');

  const unsafe = renderMarkdown('hi <script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))');
  line(!/<script>/.test(unsafe), 'raw <script> is escaped, not executed');
  line(!/onerror=/.test(unsafe) || /&lt;img/.test(unsafe), 'raw <img onerror> is neutralised');
  line(!/href="javascript:/.test(unsafe), 'javascript: link dropped');
}

console.log(`\n${failures === 0 ? 'ALL PASS - chat stays conversational, memory is gated, and Markdown renders safely.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
