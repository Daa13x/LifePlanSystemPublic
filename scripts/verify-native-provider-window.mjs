import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('native/LifePlanSystem.Native/MainForm.cs');
const provider = read('native/LifePlanSystem.Native/Providers/ProviderWindowForm.cs');
const policy = read('native/LifePlanSystem.Native/Providers/ProviderPolicyRegistry.cs');
const ui = read('src/main.jsx');

assert.match(main, /IsTrustedMainUri\(source\)/, 'only the local LPS view may request a provider window');
assert.match(main, /open-provider-window/, 'native request type is explicit');
assert.match(main, /provider\.GetString\(\), "chatgpt"/, 'native request is limited to ChatGPT');
assert.match(provider, /"webview", "providers", _providerId/, 'provider uses a profile separate from the main LPS view');
assert.match(provider, /IsAllowedNavigation\(_providerId/, 'every provider navigation is allow-listed');
assert.match(provider, /WebMessageReceived.*no native message channel/s, 'provider pages cannot invoke native commands');
assert.match(policy, /"chatgpt\.com", "auth\.openai\.com"/, 'ChatGPT host policy remains explicit');
assert.match(ui, /openNativeProviderWindow\('chatgpt'\)/, 'ChatGPT controls use native provider window when available');
assert.match(ui, /Open ChatGPT provider window/, 'the UI does not misrepresent opening the isolated provider window as connector pairing');

console.log('Native provider-window safety verification passed.');
