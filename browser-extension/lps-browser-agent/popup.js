const state = document.querySelector('#state');
const bridge = document.querySelector('#bridge');
const tabs = document.querySelector('#tabs');

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
    state.className = 'state ok';
    state.textContent = `Connected: ${result.tabs.length} supported tab${result.tabs.length === 1 ? '' : 's'} visible.`;
  } catch (error) {
    bridge.textContent = 'Unavailable';
    tabs.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Open LPS, then use Refresh status.' }));
    state.textContent = error.message;
  }
}

document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#extensions').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/' }));
void refresh();
