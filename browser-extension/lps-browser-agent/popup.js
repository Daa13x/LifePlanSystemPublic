const state = document.querySelector('#state');
const bridge = document.querySelector('#bridge');
const tabs = document.querySelector('#tabs');
const diagnostic = document.querySelector('#diagnostic');

function displayTime(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toLocaleTimeString() : 'never';
}

async function refresh() {
  state.className = 'state';
  state.textContent = 'Checking the local bridge…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'lps-browser-agent-status' });
    if (!result?.ok) throw new Error(result?.error || 'The local bridge did not respond.');
    bridge.textContent = result.bridgeUrl;
    tabs.replaceChildren(...(result.tabs.length
      ? result.tabs.map((tab) => { const item = document.createElement('li'); item.textContent = tab.title || tab.url; return item; })
      : [Object.assign(document.createElement('li'), { textContent: 'No supported AI tabs are open.' })]));
    if (result.bridgeReachable) {
      state.className = 'state ok';
      state.textContent = `Connected: ${result.tabs.length} supported tab${result.tabs.length === 1 ? '' : 's'} visible.`;
      diagnostic.textContent = `Last bridge heartbeat: ${displayTime(result.lastSuccessAt)}.`;
    } else {
      state.textContent = 'Extension is running, but the local LPS bridge is unavailable.';
      diagnostic.textContent = `${result.lastError || 'No bridge response.'} Last check: ${displayTime(result.lastPollAt)}. Open LPS, then refresh.`;
    }
  } catch (error) {
    bridge.textContent = 'Unavailable';
    tabs.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Open LPS, then use Refresh status.' }));
    state.textContent = error.message;
    diagnostic.textContent = 'Reload the extension only after LPS is open and the pairing configuration has been refreshed.';
  }
}

document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#extensions').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/' }));
void refresh();
