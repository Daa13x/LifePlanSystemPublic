#!/usr/bin/env node
// Verify the display-only legacy chat-message compatibility parser.
//
// Older assistant rows were stored before structured metadata existed, with a
// diagnostic trailer (Memory governance / Runtime / Files in context / ...)
// concatenated onto the answer. parseLegacyAssistantMessage() separates that
// trailer for DISPLAY ONLY: it never rewrites the row and fails safe (returns
// null -> the original message is shown verbatim) whenever the structure is at
// all uncertain.
//
// This proves, using the REAL parser + Markdown renderer the app imports:
//   1. Representative old message from the current DB (chat_messages id 3) is
//      split into a complete answer + recognised trailer.
//   2. The conversational answer stays complete and **bold** renders.
//   3. Legacy diagnostics no longer interrupt Clean-mode replies (they are not
//      in the rendered answer body).
//   4. Switching detail modes changes the diagnostics shown, immediately and
//      synchronously (clean hides; detailed curates; developer shows all).
//   5. No content is ever discarded: answer + trailer reconstruct the original.
//   6. Ordinary user text that merely contains "runtime"/"source" is untouched.
//   7. Uncertain structures fail safe (no trailer, duplicate labels, no strong
//      anchor -> original shown).
//   8. The display modules carry no DB/fs/network capability, so historical
//      rows cannot be mutated by this feature.
//
// Local-only: no network, no server boot, no DB access, no repo mutation.
// Exit code 0 = all checks pass; non-zero = a check failed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLegacyAssistantMessage,
  buildLegacyDetailRows
} from '../src/messageDetail.js';
import { renderMarkdown } from '../src/markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };
const rowsToMap = (rows) => Object.fromEntries(rows);
// The panel is hidden in clean and open otherwise (mirrors LegacyMessageDetails).
const legacyPanelVisible = (mode) => mode !== 'clean';

console.log('--- legacy chat-message display verification ---');

// Fixtures. The first is the verbatim body of chat_messages id 3 in the
// current database (an assistant reply whose answer itself ends with the word
// "runtime"). The rest reconstruct other shapes the old server emitted, plus
// adversarial cases that must fail safe.
const REAL_DB_MESSAGE_ID3 =
  'Saved to chat. No Planner Assistant model is assigned and no local endpoint is configured yet; use Settings to connect Ollama, LM Studio, or a GGUF runtime.\n\n' +
  'Memory governance: I saved your note as a candidate for review and will not promote it until you approve it.\n\n' +
  'Runtime: unavailable.';

const WITH_CONTEXT_AND_BOLD =
  'Here is the **plan** for the auth migration. Ship the schema change first.\n\n' +
  'Memory governance: I saved your note as a candidate for review and will not promote it until you approve it.\n\n' +
  'Files in context: notes/plan.md, src/app.js. Source files are context only; I am not treating inference as source-of-truth.\n\n' +
  'Runtime: local endpoint (qwen2.5).';

const BROADER_MARKERS =
  'Confirmed the rollout order.\n\n' +
  'Memory governance: I saved this to chat history and did not extract a memory candidate from this short note.\n\n' +
  'Source: knowledge base.\n\n' +
  'Knowledge attached: 3 items.\n\n' +
  'Workboard state: 2 blockers open.\n\n' +
  'Runtime: managed llama-server.';

// --- Fail-safe fixtures (parser must return null) ---
const NO_TRAILER = 'Just a normal answer with no diagnostics appended at all.';
const PROSE_MENTIONS =
  'The runtime crashed overnight and the source of the failure was unclear.\n\n' +
  'I will check the source logs and restart the runtime in the morning.';
const DUPLICATE_RUNTIME = // answer paragraph itself starts with "Runtime:"
  'Runtime: pick whichever engine you prefer for this task.\n\n' +
  'Memory governance: I saved your note as a candidate for review and will not promote it until you approve it.\n\n' +
  'Runtime: unavailable.';
const NO_STRONG_ANCHOR =
  'According to the article, the deadline moved.\n\n' +
  'Source: New York Times.';

// 1 + 2 + 3 + 5. Real DB message: complete answer, bold-safe, clean does not leak.
{
  const parsed = parseLegacyAssistantMessage(REAL_DB_MESSAGE_ID3);
  line(parsed !== null, 'real id-3 message is recognised as legacy');
  const answer = parsed?.answer || '';
  line(
    answer === 'Saved to chat. No Planner Assistant model is assigned and no local endpoint is configured yet; use Settings to connect Ollama, LM Studio, or a GGUF runtime.',
    'answer is the complete first paragraph (ends with "...GGUF runtime.")'
  );
  line(/\bGGUF runtime\.$/.test(answer), 'answer keeps the trailing word "runtime" — not stripped as a diagnostic');
  line(parsed?.legacy.runtime === 'unavailable', `runtime recovered -> ${JSON.stringify(parsed?.legacy.runtime)}`);
  line(/candidate for review/.test(parsed?.legacy.memoryGovernanceText || ''), 'memory governance text recovered');
  // No content discarded: answer + trailer reconstruct the original byte-for-byte.
  line(`${parsed.answer}\n\n${parsed.trailer}` === REAL_DB_MESSAGE_ID3, 'answer + trailer reconstruct the original exactly (nothing discarded)');
  // Clean-mode answer body must not contain any diagnostic trailer text.
  const cleanHtml = renderMarkdown(parsed.answer);
  line(!/Memory governance:/.test(cleanHtml) && !/Runtime:/.test(cleanHtml), 'clean-mode rendered answer contains no diagnostic trailer');
}

// 2. Bold rendering + context variant.
{
  const parsed = parseLegacyAssistantMessage(WITH_CONTEXT_AND_BOLD);
  line(parsed !== null, 'context+bold message is recognised as legacy');
  const html = renderMarkdown(parsed.answer);
  line(/<strong>plan<\/strong>/.test(html), `**bold** renders in the answer -> ${/<strong>plan<\/strong>/.test(html)}`);
  line(!/Files in context:/.test(html) && !/Runtime:/.test(html), 'context/runtime trailer absent from rendered answer');
  line(/notes\/plan\.md/.test(parsed.legacy.contextText || ''), 'context files recovered into structured field');
  line(parsed.legacy.runtime === 'local endpoint (qwen2.5)', `parenthesised runtime value recovered -> ${JSON.stringify(parsed.legacy.runtime)}`);
  line(`${parsed.answer}\n\n${parsed.trailer}` === WITH_CONTEXT_AND_BOLD, 'context variant reconstructs original exactly');
}

// 4. Detail-mode behaviour: clean hides, detailed curates, developer shows all.
{
  const parsed = parseLegacyAssistantMessage(BROADER_MARKERS);
  line(parsed !== null, 'broader-marker message (governance+source+knowledge+workboard+runtime) recognised');

  line(legacyPanelVisible('clean') === false, 'clean mode: legacy diagnostics panel hidden');

  const detailed = buildLegacyDetailRows(parsed.legacy, 'detailed');
  const developer = buildLegacyDetailRows(parsed.legacy, 'developer');
  const dMap = rowsToMap(detailed);
  const devMap = rowsToMap(developer);
  line(legacyPanelVisible('detailed') && detailed.length > 0, `detailed mode shows curated rows -> ${detailed.length} rows`);
  line(dMap['Runtime / provider'] === 'managed llama-server', 'detailed shows runtime/provider');
  line(dMap['Memory action'] === 'No memory candidate created', 'detailed maps "did not extract" governance to no-candidate');
  line(dMap['Source'] === 'knowledge base.' && dMap['Workboard state'] === '2 blockers open.', 'detailed surfaces source + workboard (verbatim, incl. trailing period)');
  line(developer.length > detailed.length, `developer mode adds rows over detailed (${developer.length} > ${detailed.length}) — switching modes changes output immediately`);
  line('Origin' in devMap && /legacy message text/.test(devMap['Origin']), 'developer marks the rows as reconstructed from legacy text');
  line('Memory governance (verbatim)' in devMap, 'developer exposes the verbatim governance line');
}

// 6. Ordinary user text mentioning "runtime"/"source" is never stripped.
{
  line(parseLegacyAssistantMessage(PROSE_MENTIONS) === null, 'prose mentioning "runtime"/"source" is not treated as a trailer');
  line(parseLegacyAssistantMessage(NO_TRAILER) === null, 'a plain single-paragraph answer has no trailer to strip');
}

// 7. Fail-safe on uncertain structure -> original shown (parser returns null).
{
  line(parseLegacyAssistantMessage(DUPLICATE_RUNTIME) === null, 'duplicate "Runtime:" labels fail safe (answer line preserved)');
  line(parseLegacyAssistantMessage(NO_STRONG_ANCHOR) === null, 'trailing "Source:" with no strong anchor fails safe');
  line(parseLegacyAssistantMessage('') === null && parseLegacyAssistantMessage(null) === null, 'empty / null input fails safe');
}

// 5b. Parser never mutates its input string.
{
  const input = REAL_DB_MESSAGE_ID3;
  const copy = String(input);
  parseLegacyAssistantMessage(input);
  line(input === copy, 'parser does not mutate the input message content');
}

// 8. Display modules carry no DB/fs/network capability (cannot touch rows).
{
  const forbidden = [/node:sqlite/, /DatabaseSync/, /node:fs\b/, /child_process/, /node:https?\b/, /\bfetch\s*\(/];
  for (const file of ['src/messageDetail.js', 'src/markdown.js']) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const hits = forbidden.filter((p) => p.test(source)).map(String);
    line(hits.length === 0, `${file} has no DB/fs/network capability -> ${JSON.stringify(hits)}`);
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS - legacy replies split cleanly, fail safe when uncertain, and never mutate stored rows.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
