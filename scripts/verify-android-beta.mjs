import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isPrivateNetworkHost, normalizeNativeServerUrl, normalizeSyncBaseUrl } from '../src/nativeConnection.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

assert.equal(normalizeNativeServerUrl('https://beta.example.test/'), 'https://beta.example.test');
assert.equal(normalizeNativeServerUrl('http://127.0.0.1:4177'), 'http://127.0.0.1:4177');
assert.throws(() => normalizeNativeServerUrl('http://beta.example.test'), /must use HTTPS/);
assert.throws(() => normalizeNativeServerUrl('https://user:secret@beta.example.test'), /must not contain/);

for (const host of ['192.168.1.20', '10.0.0.5', '172.16.2.4', '169.254.1.2', 'lps.local', '::1']) {
  assert.equal(isPrivateNetworkHost(host), true, `${host} is an allowed private sync host`);
}
assert.equal(normalizeSyncBaseUrl('http://192.168.1.20:4178/'), 'http://192.168.1.20:4178');
assert.equal(normalizeSyncBaseUrl('https://sync.example.test'), 'https://sync.example.test');
assert.throws(() => normalizeSyncBaseUrl('http://sync.example.test:4178'), /local\/private-network/);

const networkPolicy = read('android/app/src/main/res/xml/network_security_config.xml');
const ui = read('src/main.jsx');
const server = read('server/index.js');
assert.match(networkPolicy, /base-config cleartextTrafficPermitted="true"/, 'APK permits the user-entered private-LAN HTTP sync bridge');
assert.match(ui, /function NativeBackendPanel/, 'native app has an always-reachable backend configuration panel');
assert.match(ui, /Configure LifePlanSystem server/, 'native top bar exposes backend configuration after an offline start');
assert.match(ui, /Save and connect[\s\S]*Use USB default/, 'native backend setup has connect/retry and USB-loopback paths');
const sendStart = ui.indexOf('async function send()');
const sendEnd = ui.indexOf('\n  async function loadMessages', sendStart);
const sendFlow = ui.slice(sendStart, sendEnd > sendStart ? sendEnd : sendStart + 9000);
assert.match(sendFlow, /if \(IS_NATIVE\)/, 'native chat takes its local command path regardless of optional backend reachability');
assert.match(sendFlow, /This Closed Beta keeps phone chat on device for now/, 'native unmatched chat is explicit about the v0.1 boundary');
assert.match(server, /req\.method === 'POST' && req\.path === '\/api\/feedback'/, 'hosted mode allows only the feedback submission method');
assert.match(server, /INSERT INTO feedback \(user_id, sentiment/, 'feedback submissions are attributed to the authenticated tester');

console.log('Android Closed Beta connection and feedback contract verification passed.');
