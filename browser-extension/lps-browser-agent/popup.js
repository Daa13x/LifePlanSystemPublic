const state = document.querySelector('#state');
const bridge = document.querySelector('#bridge');
const tabs = document.querySelector('#tabs');
const diagnostic = document.querySelector('#diagnostic');
const running = document.querySelector('#running');
const expected = document.querySelector('#expected');
const reloadState = document.querySelector('#reload-state');
const extensions = document.querySelector('#extensions');

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
    running.textContent = result.runningVersion || 'not reported';
    expected.textContent = result.expectedVersion || 'not available';
    extensions.hidden = result.lifecycleState !== 'MANUAL_RELOAD_REQUIRED';
    tabs.replaceChildren(...(result.tabs.length
      ? result.tabs.map((tab) => { const item = document.createElement('li'); item.textContent = tab.title || tab.url; return item; })
      : [Object.assign(document.createElement('li'), { textContent: 'No supported AI tabs are open.' })]));
    if (result.lifecycleState === 'CONNECTED_CURRENT') {
      state.className = 'state ok';
      state.textContent = `Connected — current. ${result.tabs.length} supported tab${result.tabs.length === 1 ? '' : 's'} visible.`;
      reloadState.textContent = result.reloadState === 'settled' ? 'Automatic update recovery completed.' : 'No update action is needed.';
      diagnostic.textContent = `Last bridge heartbeat: ${displayTime(result.lastSuccessAt)}.`;
    } else if (result.lifecycleState === 'RELOAD_IN_PROGRESS') {
      state.textContent = 'Update detected — reloading automatically…';
      reloadState.textContent = 'One guarded automatic reload has been scheduled.';
      diagnostic.textContent = `Last bridge heartbeat: ${displayTime(result.lastSuccessAt)}.`;
    } else if (result.lifecycleState === 'MANUAL_RELOAD_REQUIRED') {
      state.textContent = 'Browser Agent update needs attention.';
      reloadState.textContent = 'Automatic reload was already attempted. Open extensions and Reload Life Planner Browser Agent once.';
      diagnostic.textContent = `Last bridge heartbeat: ${displayTime(result.lastSuccessAt)}.`;
    } else if (result.bridgeReachable) {
      state.textContent = 'Connected, but the Browser Agent version is not current.';
      reloadState.textContent = 'Waiting for verified version recovery.';
      diagnostic.textContent = `Last bridge heartbeat: ${displayTime(result.lastSuccessAt)}.`;
    } else {
      state.textContent = 'Extension is running, but the local LPS bridge is unavailable.';
      reloadState.textContent = 'No reload is requested from an unavailable bridge.';
      diagnostic.textContent = `${result.lastError || 'No bridge response.'} Last check: ${displayTime(result.lastPollAt)}. Open LPS, then refresh.`;
    }
  } catch (error) {
    bridge.textContent = 'Unavailable';
    running.textContent = chrome.runtime.getManifest().version;
    expected.textContent = 'not available';
    reloadState.textContent = 'No verified update instruction is available.';
    extensions.hidden = true;
    tabs.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Open LPS, then use Refresh status.' }));
    state.textContent = error.message;
    diagnostic.textContent = 'Reload the extension only after LPS is open and the pairing configuration has been refreshed.';
  }
}

document.querySelector('#refresh').addEventListener('click', refresh);
extensions.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/' }));
void refresh();
