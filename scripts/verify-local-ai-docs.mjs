import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-local-ai-docs-'));
const dbPath = path.join(probeRoot, 'acceptance.sqlite');
const port = 42800 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const provisioner = fs.readFileSync(path.join(root, 'scripts', 'windows', 'Install-LlamaRuntime.ps1'), 'utf8');
let server;

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Isolated acceptance server did not become healthy.');
}

async function jsonApi(url, options) {
  const response = await fetch(`${base}${url}`, options);
  const body = await response.json();
  return { response, body };
}

try {
  assert.match(provisioner, /llama-b8354-bin-win-cpu-x64\.zip/);
  assert.match(provisioner, /6deafbf1f065e02d5aba723ff015cfef642501264c1e30b31c89b70085dd1721/);
  assert.match(provisioner, /Qwen2\.5-1\.5B-Instruct-Q4_K_M\.gguf/);
  assert.match(provisioner, /1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370/);
  assert.match(serverSource, /waitForLlamaServer/);
  assert.match(serverSource, /fs\.renameSync\(partial, target\)/);
  assert.doesNotMatch(serverSource, /\/api\/tooling\/ollama/);
  assert.doesNotMatch(serverSource, /OLLAMA_URL|OPENHANDS_MODEL/);

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, LIFE_PLANNER_DB: dbPath, LIFE_PLANNER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  await waitForHealth();

  const openHands = await jsonApi('/api/tooling/openhands/status');
  assert.equal(openHands.response.status, 200);
  assert.equal(openHands.body.data.enabled, false);
  assert.equal(openHands.body.data.optional, true);
  assert.equal(openHands.body.data.installed, 'not checked');

  const disabledRequest = await jsonApi('/api/tooling/openhands/requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'test', objective: 'test' })
  });
  assert.equal(disabledRequest.response.status, 409);

  const preview = await jsonApi('/api/browser/consult/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      target_agent: 'Claude', local_draft: 'Reply to me at person@example.com using secret=abcdefghijklmnop'
    })
  });
  assert.equal(preview.response.status, 200);
  assert.match(preview.body.data.prompt, /\[REDACTED EMAIL\]/);
  assert.match(preview.body.data.prompt, /secret=\[REDACTED\]/);
  assert.match(preview.body.data.promptHash, /^[a-f0-9]{64}$/);

  const unconfirmed = await jsonApi('/api/browser/consult', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      target_agent: 'Claude', local_draft: 'Safe prompt', temporary_chat_required: false
    })
  });
  assert.equal(unconfirmed.response.status, 428);

  const htmlResponse = await fetch(`${base}/api/export/context.html?scope=roadmap`);
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get('content-disposition') || '', /life-planner-roadmap-context\.html/);
  assert.match(html, /Search this export/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /https?:\/\//);

  const markdownResponse = await fetch(`${base}/api/export/context.md?scope=roadmap`);
  const markdown = await markdownResponse.text();
  assert.equal(markdownResponse.status, 200);
  assert.match(markdown, /# Life Planner Context Export/);
  assert.match(markdown, /## Roadmap Items/);

  const publicExport = await jsonApi('/api/export/json?mode=public');
  assert.equal(publicExport.response.status, 409);

  const pdfResponse = await fetch(`${base}/api/export/context.pdf?scope=roadmap`);
  const pdf = Buffer.from(await pdfResponse.arrayBuffer());
  assert.equal(pdfResponse.status, 200, pdf.toString('utf8'));
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.length > 1000);

  const imported = await jsonApi('/api/import/pdf', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'roadmap-export.pdf', base64: pdf.toString('base64') })
  });
  assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
  assert.ok(imported.body.data.pages >= 1);
  assert.equal(imported.body.data.item.status, 'pending review');
  assert.match(imported.body.data.item.evidence, /SHA-256 [a-f0-9]{64}/);

  console.log('Local AI, cloud egress, PDF, and portable context acceptance passed.');
} finally {
  if (server && !server.killed) server.kill();
  for (let attempt = 0; attempt < 30 && server?.exitCode === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fs.rmSync(probeRoot, { recursive: true, force: true });
}
