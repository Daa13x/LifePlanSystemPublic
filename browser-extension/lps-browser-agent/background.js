const LPS = 'http://127.0.0.1:4177';
let pairingConfigPromise;
const bridgeState = { lastSuccessAt: '', lastError: '', lastPollAt: '' };

const AGENT_URLS = {
  ChatGPT: 'https://chatgpt.com/',
  Gemini: 'https://gemini.google.com/app',
  Grok: 'https://grok.com/',
  Claude: 'https://claude.ai/new'
};

const AGENT_HOSTS = {
  ChatGPT: ['chatgpt.com', 'auth.openai.com'],
  Gemini: ['gemini.google.com', 'accounts.google.com'],
  Grok: ['grok.com', 'x.com'],
  Claude: ['claude.ai']
};

function hostMatches(url, hosts) {
  try {
    const parsed = new URL(url);
    return hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

async function pairingConfig() {
  if (!pairingConfigPromise) {
    pairingConfigPromise = fetch(chrome.runtime.getURL('pairing-config.json'), { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('LPS pairing config is missing. Open LPS Tooling and reinstall/reload the connector.');
        return response.json();
      });
  }
  return pairingConfigPromise;
}

async function api(path, options = {}) {
  const config = await pairingConfig();
  const response = await fetch(`${config.bridgeUrl || LPS}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-LPS-Connector-Token': config.token,
      ...(options.headers || {})
    },
  });
  return response.json();
}

async function visibleTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.url && Object.values(AGENT_HOSTS).some((hosts) => hostMatches(tab.url, hosts)))
    .map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url || '' }));
}

async function heartbeat() {
  bridgeState.lastPollAt = new Date().toISOString();
  try {
    const result = await api('/api/browser/extension/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ tabs: await visibleTabs() })
    });
    if (!result?.ok) throw new Error(result?.error || 'The local bridge rejected the heartbeat.');
    bridgeState.lastSuccessAt = new Date().toISOString();
    bridgeState.lastError = '';
    return true;
  } catch (error) {
    bridgeState.lastError = String(error?.message || 'The local bridge did not respond.').slice(0, 300);
    // LPS may be closed; try again on the next tick.
    return false;
  }
}

async function tabForJob(job) {
  const hosts = AGENT_HOSTS[job.targetAgent] || [];
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.id && tab.url && hostMatches(tab.url, hosts));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    return existing.id;
  }
  const created = await chrome.tabs.create({ url: job.url || AGENT_URLS[job.targetAgent] || 'about:blank', active: true });
  return created.id;
}

async function runContentSend(targetAgent, prompt) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const adapters = {
    ChatGPT: { composer: ['[data-testid="prompt-textarea"]', '#prompt-textarea'], send: ['[data-testid="send-button"]', '[data-testid="composer-submit-button"]'], assistant: '[data-message-author-role="assistant"]' },
    Gemini: { composer: ['div[contenteditable="true"][aria-label*="prompt" i]', 'textarea[aria-label*="prompt" i]'], send: ['button[aria-label*="Send" i]', 'button[aria-label*="Submit" i]'], assistant: 'message-content' },
    Grok: { composer: ['textarea[placeholder*="Ask" i]', 'div[contenteditable="true"][role="textbox"]'], send: ['button[aria-label*="Send" i]', 'button[type="submit"]'], assistant: '.model-response-text' },
    Claude: { composer: ['div[contenteditable="true"][role="textbox"]', 'textarea[placeholder*="Message" i]'], send: ['button[aria-label*="Send" i]', 'button[type="submit"]'], assistant: '[data-testid="assistant-message"], [data-is-streaming="false"]' }
  };
  const adapter = adapters[targetAgent];
  if (!adapter) return { status: 'blocked', error: `Unsupported browser-agent provider: ${targetAgent}` };
  const selectors = adapter.composer;
  const sendSelectors = adapter.send;
  const promptText = String(prompt || '').replace(/\s+/g, ' ').trim();
  // ChatGPT's reasoning UI renders status labels ("Thinking", "Thought for a couple
  // of seconds") inside the assistant turn. They hold still long enough to pass the
  // stability check, so they must never count as answer text.
  const stripStatusPrefix = (value) =>
    value
      .replace(/^thinking[\s.…]+/i, '')
      .replace(/^thought for [\w ]{1,40}(seconds?|minutes?|s\b|m\b)[\s.…:]*/i, '')
      .trim();
  const isStatusText = (value) =>
    !value ||
    /^thinking[\s.…]*$/i.test(value) ||
    /^thought for [^]{0,60}$/i.test(value) ||
    /^(reasoning|analyzing|searching|working)[\s.…]*$/i.test(value);
  const isVisibleNode = (node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 20 && rect.height > 10;
  };
  const extractResponseText = (node) => {
    const raw = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    const text = stripStatusPrefix(raw);
    if (isStatusText(text)) return '';
    if (promptText && text.includes(promptText)) {
      const afterPrompt = stripStatusPrefix(text.slice(text.lastIndexOf(promptText) + promptText.length).trim());
      return isStatusText(afterPrompt) ? '' : afterPrompt.slice(0, 12000);
    }
    return text.slice(0, 12000);
  };
  // On ChatGPT pages capture is scoped to assistant turns at index >= minTurnIndex
  // (turns created after the prompt was sent), with no fallback to older turns or
  // generic containers — falling back returned stale answers from earlier turns.
  const assistantTurnCount = () => document.querySelectorAll(adapter.assistant).length;
  const readLatestResponse = (minTurnIndex = 0) => {
    const assistantNodes = [...document.querySelectorAll(adapter.assistant)];
    if (assistantNodes.length) {
      const candidates = assistantNodes.slice(minTurnIndex).filter(isVisibleNode);
      for (const node of candidates.reverse()) {
        const text = extractResponseText(node);
        if (text) return text;
      }
      return '';
    }
    return '';
  };

  let box = null;
  for (let i = 0; i < 240 && !box; i += 1) {
    box = selectors.map((selector) => document.querySelector(selector)).find((node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 20 && rect.height > 10;
    });
    if (!box) await sleep(1000);
  }
  if (!box) {
    return { status: 'blocked', error: 'No browser-agent composer was found. Sign in or finish verification in this tab, then send again.' };
  }

  box.focus();
  if (box.isContentEditable) {
    box.textContent = prompt;
  } else {
    box.value = prompt;
  }
  box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(300);

  // Snapshot immediately before send (page fully loaded) so late-rendering
  // conversation history cannot be mistaken for a new reply.
  const beforeTurnCount = assistantTurnCount();
  const beforeText = readLatestResponse();

  const button = sendSelectors.map((selector) => document.querySelector(selector)).find((node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return !node.disabled && rect.width > 0 && rect.height > 0;
  });
  if (button) {
    button.click();
  } else {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  }

  let lastText = '';
  let stableTicks = 0;
  for (let tick = 0; tick < 90; tick += 1) {
    await sleep(1000);
    const text = readLatestResponse(beforeTurnCount);
    // A repeated identical answer (text === beforeText) still counts when it comes
    // from a genuinely new assistant turn (turn count grew past the send snapshot).
    if (!text || (text === beforeText && assistantTurnCount() <= beforeTurnCount)) {
      stableTicks = 0;
      lastText = text;
      continue;
    }
    if (text === lastText) {
      stableTicks += 1;
    } else {
      lastText = text;
      stableTicks = 1;
    }
    // A 3-second stability window still passes if the provider's own streaming
    // rendering happens to pause for a few seconds mid-generation (observed
    // 2026-08-29: a longer multi-sentence ChatGPT reply was captured truncated
    // to its first 7 characters after a mid-stream pause satisfied this exact
    // window). One extra, longer confirmation read after reaching the window
    // guards against exactly that without slowing down the normal case, where
    // the text is already genuinely finished and this confirmation is a no-op.
    if (stableTicks >= 3) {
      await sleep(2500);
      const confirmed = readLatestResponse(beforeTurnCount);
      if (confirmed === text) {
        return {
          status: 'answered',
          url: location.href,
          title: document.title,
          answer: text,
          message: 'Prompt sent and response captured from the Life Planner Chrome connector.'
        };
      }
      lastText = confirmed;
      stableTicks = confirmed ? 1 : 0;
    }
  }

  return {
    status: 'blocked',
    url: location.href,
    title: document.title,
    error: 'Prompt was sent, but no completed browser-agent response was captured within 90 seconds.'
  };
}

async function handleJob(job) {
  try {
    const tabId = await tabForJob(job);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: runContentSend,
      args: [job.targetAgent, job.prompt]
    }).then(async ([result]) => {
      const data = result?.result || { status: 'error', error: 'No content-script result.' };
      await api(`/api/browser/extension/jobs/${job.id}`, {
        method: 'POST',
        body: JSON.stringify({ ...data, claimToken: job.claimToken })
      });
    });
  } catch (error) {
    await api(`/api/browser/extension/jobs/${job.id}`, {
      method: 'POST',
      body: JSON.stringify({ status: 'error', error: error.message || 'Chrome connector failed.', claimToken: job.claimToken })
    }).catch(() => {});
  }
}

async function poll() {
  await heartbeat();
  try {
    const result = await api('/api/browser/extension/next');
    if (result.ok && result.data?.job) await handleJob(result.data.job);
  } catch {
    // LPS may be closed; try again on the next tick.
  }
}

const POLL_ALARM = 'lps-browser-agent-poll';

async function wakeAndPoll() {
  await poll();
}

async function ensurePollAlarm() {
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
}

setInterval(poll, 1500);
chrome.runtime.onInstalled.addListener(() => { void ensurePollAlarm(); void wakeAndPoll(); });
chrome.runtime.onStartup.addListener(() => { void ensurePollAlarm(); void wakeAndPoll(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void wakeAndPoll();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'lps-browser-agent-status') return undefined;
  void (async () => {
    const config = await pairingConfig();
    const tabs = await visibleTabs();
    const bridgeReachable = await heartbeat();
    sendResponse({
      ok: true,
      bridgeUrl: config.bridgeUrl || LPS,
      bridgeReachable,
      lastSuccessAt: bridgeState.lastSuccessAt,
      lastPollAt: bridgeState.lastPollAt,
      lastError: bridgeState.lastError,
      tabs
    });
  })().catch((error) => sendResponse({ ok: false, error: error?.message || 'Unable to read connector status.' }));
  return true;
});

void ensurePollAlarm();
void poll();
