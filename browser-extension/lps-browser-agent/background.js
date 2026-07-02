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
  return { status: 'sent', url: location.href, title: document.title, message: 'Prompt sent from the Life Planner Chrome connector.' };
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
