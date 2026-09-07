import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repoRoot, 'browser-extension', 'lps-browser-agent', 'background.js'), 'utf8');
const ast = parse(source, { sourceType: 'script' });
const declaration = ast.program.body.find((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'runContentSend');
assert.ok(declaration, 'runContentSend declaration is available for executable verification');
const functionSource = source.slice(declaration.start, declaration.end);

function visibleRect() { return { width: 200, height: 40 }; }

function assistantNode(id, text, attributes = {}) {
  return {
    id,
    innerText: text,
    textContent: text,
    parentElement: null,
    getBoundingClientRect: visibleRect,
    getAttribute(name) { return attributes[name] ?? null; }
  };
}

function control({ id, disabled = false, click = null } = {}) {
  return {
    id,
    disabled,
    isContentEditable: false,
    value: '',
    textContent: '',
    getBoundingClientRect: visibleRect,
    getAttribute() { return null; },
    focus() {},
    dispatchEvent() {},
    click() { click?.(); }
  };
}

async function runScenario(scenario) {
  let now = 0;
  let sentAt = null;
  let assistantQueries = 0;
  let dispatchReceipts = 0;
  const historic = assistantNode('historic', 'Older completed answer.', { 'data-is-streaming': 'false' });
  const composer = control({ id: 'composer' });
  let sendButton;
  const elapsed = () => sentAt == null ? -1 : now - sentAt;
  const currentState = () => sentAt == null
    ? { node: null, generation: 'idle' }
    : scenario.stateAt(elapsed());
  sendButton = control({ id: 'send', click: () => { sentAt = now; } });
  const generatingControl = control({ id: 'stop' });

  const document = {
    title: 'ChatGPT',
    querySelector(selector) {
      if (selector.includes('prompt-textarea')) return composer;
      if (selector.includes('send-button') || selector.includes('composer-submit-button')) return sendButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') {
        assistantQueries += 1;
        const state = currentState();
        return state.node ? [historic, state.node] : [historic];
      }
      const state = currentState();
      if (selector.includes('stop-button') || selector.includes('Stop') || selector.includes('data-is-streaming="true"') || selector.includes('aria-busy="true"')) {
        return state.generation === 'generating' ? [generatingControl] : [];
      }
      if (selector.includes('send-button') || selector.includes('composer-submit-button')) {
        return sentAt == null || state.generation === 'idle' ? [sendButton] : [];
      }
      return [];
    }
  };

  const context = {
    document,
    location: { get href() { return scenario.urlAt?.(elapsed()) || 'https://chatgpt.com/c/test'; } },
    chrome: { runtime: { async sendMessage() { dispatchReceipts += 1; return { ok: true }; } } },
    InputEvent: class { constructor(type, options) { this.type = type; this.options = options; } },
    Event: class { constructor(type, options) { this.type = type; this.options = options; } },
    KeyboardEvent: class { constructor(type, options) { this.type = type; this.options = options; } },
    setTimeout(callback, delay) { now += Number(delay) || 0; callback(); return 1; },
    clearTimeout() {},
    console: { warn() {} },
    Promise
  };
  const runContentSend = vm.runInNewContext(`(${functionSource})`, context);
  const result = await runContentSend('ChatGPT', 'Review this architecture.', {
    type: 'lps-browser-agent-job-sent', jobId: 24, claimToken: 'claim-token'
  });
  return { result: JSON.parse(JSON.stringify(result)), assistantQueries, dispatchReceipts, elapsed: elapsed() };
}

const partialNode = assistantNode('partial', 'REMOTE-PARTIAL');
const finalNode = assistantNode('final', 'REMOTE-COMPLETE-ABCDEF full architecture review');

{
  const observed = await runScenario({
    stateAt(ms) {
      if (ms < 5_000) return { node: partialNode, generation: 'generating' };
      return { node: finalNode, generation: 'idle' };
    }
  });
  assert.equal(observed.result.status, 'answered');
  assert.equal(observed.result.answer, finalNode.innerText, 'stable partial prefix cannot finalize while provider generation continues');
  assert.equal(observed.dispatchReceipts, 1, 'provider dispatch receipt remains a separate one-time boundary');
}

{
  const observed = await runScenario({ stateAt: () => ({ node: finalNode, generation: 'ambiguous' }) });
  assert.equal(observed.result.status, 'blocked', 'missing generation selectors are ambiguous and time out closed');
  assert.match(observed.result.error, /no completed browser-agent response/i);
}

{
  const oldPartial = assistantNode('old-partial', 'REMOTE-OLD-PARTIAL');
  const replacement = assistantNode('replacement', 'REMOTE-NEW-COMPLETE-UVWXYZ architecture review');
  const observed = await runScenario({
    stateAt(ms) {
      if (ms < 3_500) return { node: oldPartial, generation: 'idle' };
      if (ms < 6_000) return { node: replacement, generation: 'generating' };
      return { node: replacement, generation: 'idle' };
    }
  });
  assert.equal(observed.result.status, 'answered');
  assert.equal(observed.result.answer, replacement.innerText, 'assistant DOM replacement invalidates the old partial node');
  assert.ok(observed.assistantQueries >= 8, 'the current assistant turn is repeatedly re-resolved, including final confirmation');
}

{
  const streamNode = assistantNode('stream', '');
  const streamTexts = ['R', 'REMOTE-', 'REMOTE-STREAMING', 'REMOTE-STREAMING-ABCDEF complete'];
  const observed = await runScenario({
    stateAt(ms) {
      const index = Math.min(Math.max(Math.floor(ms / 1_000), 0), streamTexts.length - 1);
      streamNode.innerText = streamTexts[index];
      streamNode.textContent = streamTexts[index];
      return { node: streamNode, generation: ms < 6_000 ? 'generating' : 'idle' };
    }
  });
  assert.equal(observed.result.answer, streamTexts.at(-1), 'incremental mutation of one assistant node cannot finalize partial content');
}

{
  const stable = assistantNode('stable', 'REMOTE-STABLE-ABCDEF complete');
  const observed = await runScenario({
    stateAt(ms) {
      if (ms < 3_500) return { node: stable, generation: 'idle' };
      if (ms < 9_000) return { node: stable, generation: 'generating' };
      return { node: stable, generation: 'idle' };
    }
  });
  assert.equal(observed.result.status, 'answered');
  assert.ok(observed.elapsed >= 10_000, 'final confirmation rechecks generation state and refuses a restarted stream');
}

{
  const observed = await runScenario({ stateAt: () => ({ node: null, generation: 'ambiguous' }) });
  assert.equal(observed.result.status, 'blocked', 'timeout without a current post-dispatch assistant turn fails closed');
  assert.equal(observed.dispatchReceipts, 1, 'timeout does not erase the already-observed dispatch receipt');
}

console.log('Browser capture state verification passed: current-turn identity, tri-state generation evidence, replacement/streaming races, confirmation, and timeout.');
