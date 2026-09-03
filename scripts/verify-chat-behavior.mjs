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
import { capabilityRequestForChatIntent, classifyChatIntent, shouldCreateMemoryCandidate } from '../server/chatIntent.js';
import { buildChatCommandCatalog, CHAT_COMMANDS, explicitChatCommand } from '../server/chatCommands.js';
import { createCapabilityRegistry } from '../server/chatCapabilities.js';
import { renderMarkdown } from '../src/markdown.js';

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
