const LPS = 'http://127.0.0.1:4177';

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

async function api(path, options = {}) {
  const response = await fetch(`${LPS}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  return response.json();
}

async function visibleTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.url && /^https?:\/\//i.test(tab.url))
    .map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url || '' }));
}

async function heartbeat() {
  try {
    await api('/api/browser/extension/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ tabs: await visibleTabs() })
    });
  } catch {
    // LPS may be closed; try again on the next tick.
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

async function runContentSend(prompt) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const selectors = [
    '[data-testid="prompt-textarea"]',
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    'textarea[aria-label*="Message"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea'
  ];
  const sendSelectors = [
    '[data-testid="send-button"]',
    '[data-testid="composer-submit-button"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]'
  ];
  const responseSelectors = [
    '[data-message-author-role="assistant"]',
    'message-content',
    '[data-testid="conversation-turn"]',
    '.model-response-text',
    'main'
  ];
  const promptText = String(prompt || '').replace(/\s+/g, ' ').trim();
  // TEMPORARY SMOKE-TEST PATCH (2026-07-03, release copy only — NOT the permanent
  // source fix): ChatGPT's reasoning UI renders status labels ("Thinking",
  // "Thought for a couple of seconds") inside the assistant turn. They hold still
  // long enough to pass the 3-tick stability check and get captured as the answer.
  // Strip leading status labels and treat status-only text as "no response yet".
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
  // TEMPORARY SMOKE-TEST PATCH (2026-07-03, part 3): scope capture to assistant
  // turns created after the prompt was sent. Previously, when the newest turn was
  // still a filtered status label ("Thinking"), the scan fell through to OLDER
  // assistant turns and returned a stale answer, which the part-2 turn-count
  // escape then accepted. On ChatGPT pages, only nodes at index >= minTurnIndex
  // are readable and there is no fallback to generic containers.
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
  const readLatestResponse = (minTurnIndex = 0) => {
    const assistantNodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    if (assistantNodes.length) {
      const candidates = assistantNodes.slice(minTurnIndex).filter(isVisibleNode);
      for (const node of candidates.reverse()) {
        const text = extractResponseText(node);
        if (text) return text;
      }
      return '';
    }
    for (const selector of responseSelectors.slice(1)) {
      const nodes = [...document.querySelectorAll(selector)].filter(isVisibleNode);
      for (const node of nodes.reverse()) {
        const text = extractResponseText(node);
        if (text) return text;
      }
    }
    return '';
  };

  // TEMPORARY SMOKE-TEST PATCH (2026-07-03, part 2): if the new answer is identical
  // to the previous turn's answer (e.g. rerunning "Reply with exactly: PING-OK" in
  // the same conversation), text === beforeText rejected it forever and timed out.
  // A grown assistant-turn count means a new reply exists even if the text repeats.
  const assistantTurnCount = () => document.querySelectorAll('[data-message-author-role="assistant"]').length;

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

  // Snapshot taken here (page fully loaded, immediately before send) so late-rendering
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
    if (stableTicks >= 3) {
      return {
        status: 'answered',
        url: location.href,
        title: document.title,
        answer: text,
        message: 'Prompt sent and response captured from the Life Planner Chrome connector.'
      };
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
      args: [job.prompt]
    }).then(async ([result]) => {
      const data = result?.result || { status: 'error', error: 'No content-script result.' };
      await api(`/api/browser/extension/jobs/${job.id}`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
    });
  } catch (error) {
    await api(`/api/browser/extension/jobs/${job.id}`, {
      method: 'POST',
      body: JSON.stringify({ status: 'error', error: error.message || 'Chrome connector failed.' })
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

setInterval(poll, 1500);
chrome.runtime.onInstalled.addListener(poll);
chrome.runtime.onStartup.addListener(poll);

