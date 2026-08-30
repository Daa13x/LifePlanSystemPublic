// Zero-API-key Chat: deterministic command patterns that work with no LLM,
// no server, and no network at all -- exactly the interaction Phase 2 of the
// standalone-phone goal requires. Chat must never simply become "AI
// unavailable" on a phone with no configured provider.
//
// matchLocalCommand(text) returns { handled: false } if nothing matched (the
// caller falls through to the real LLM chat path, or explains clearly that
// this needs a connected provider), or { handled: true, reply } with the
// deterministic answer after performing the real local action.
//
// These are explicit command patterns, not natural-language understanding --
// deliberately so. A reply is never presented as generated AI.

import {
  localPlannerDay, localListTasks, localCreateTask, localCompleteTask,
  localDeferTask, localUpdateTask, localCreateNote, localListNotes, localCreateMemoryCandidate
} from './localData.js';

function describeTask(task) {
  const bits = [task.title];
  if (task.deadline) bits.push(`due ${task.deadline}`);
  if (task.blocker) bits.push(`blocked: ${task.blocker}`);
  return bits.join(' — ');
}

// Returns { task } on exactly one match, { ambiguous: [...] } on more than
// one (never silently acts on the first match -- a substring like "email"
// could match two unrelated tasks), or { task: null } on none.
async function findTaskByTitleFragment(fragment) {
  const needle = fragment.trim().toLowerCase();
  if (!needle) return { task: null };
  const tasks = await localListTasks();
  const matches = tasks.filter((t) => t.status === 'active' && t.title.toLowerCase().includes(needle));
  if (matches.length > 1) return { ambiguous: matches };
  return { task: matches[0] || null };
}

async function resolveOneTask(fragment) {
  const result = await findTaskByTitleFragment(fragment);
  if (result.ambiguous) return { error: `That matches ${result.ambiguous.length} tasks: ${result.ambiguous.map((t) => t.title).join(', ')}. Be more specific.` };
  if (!result.task) return { error: `I couldn't find an active task matching "${fragment.trim()}".` };
  return { task: result.task };
}

const HANDLERS = [
  {
    pattern: /^(what do i need to do today|what'?s (on )?today|show today)\??$/i,
    async run() {
      const day = await localPlannerDay();
      if (!day.visible.length) return 'Nothing is scheduled for today. Add a task with "add <task>".';
      return `Today (${day.mode}):\n${day.visible.map((t) => `- ${describeTask(t)}`).join('\n')}`;
    }
  },
  {
    pattern: /^what goals? am i working on\??$/i,
    async run() {
      const tasks = await localListTasks();
      const active = tasks.filter((t) => t.status === 'active');
      if (!active.length) return 'No active goals or tasks yet. Try "add <task>" to create one.';
      return `Active (${active.length}):\n${active.map((t) => `- ${describeTask(t)}`).join('\n')}`;
    }
  },
  {
    pattern: /^show completed tasks?\??$/i,
    async run() {
      const tasks = await localListTasks();
      const done = tasks.filter((t) => t.status === 'completed');
      if (!done.length) return 'Nothing completed yet.';
      return `Completed (${done.length}):\n${done.map((t) => `- ${t.title}`).join('\n')}`;
    }
  },
  {
    // Today only ever shows active-status tasks (matching the desktop app's
    // own behaviour) -- a task marked "not today"/deferred has no other
    // surface today, so this and "reactivate" below are the only way to see
    // or recover it in standalone mode.
    pattern: /^show deferred( tasks)?\??$/i,
    async run() {
      const tasks = await localListTasks();
      const deferred = tasks.filter((t) => t.status === 'deferred');
      if (!deferred.length) return 'Nothing deferred right now.';
      return `Deferred (${deferred.length}):\n${deferred.map((t) => `- ${describeTask(t)}`).join('\n')}`;
    }
  },
  {
    pattern: /^reactivate (.+)$/i,
    async run(match) {
      const needle = match[1].trim().toLowerCase();
      const tasks = await localListTasks();
      const matches = tasks.filter((t) => ['deferred', 'parked'].includes(t.status) && t.title.toLowerCase().includes(needle));
      if (matches.length > 1) return `That matches ${matches.length} deferred/parked tasks: ${matches.map((t) => t.title).join(', ')}. Be more specific.`;
      if (!matches.length) return `I couldn't find a deferred or parked task matching "${match[1].trim()}".`;
      await localUpdateTask(matches[0].id, { status: 'active' });
      return `Reactivated: ${matches[0].title}`;
    }
  },
  {
    pattern: /^mark (.+) done$/i,
    async run(match) {
      const resolved = await resolveOneTask(match[1]);
      if (resolved.error) return resolved.error;
      await localCompleteTask(resolved.task.id);
      return `Marked done: ${resolved.task.title}`;
    }
  },
  {
    pattern: /^defer (.+?)(?: until (.+))?$/i,
    async run(match) {
      const resolved = await resolveOneTask(match[1]);
      if (resolved.error) return resolved.error;
      await localDeferTask(resolved.task.id);
      // "until <date>" is deliberately not honored yet -- localData.js has
      // no scheduled-reactivation mechanism (that's Phase 3 notifications
      // territory), so claiming a specific return date here would be a
      // promise this command can't keep. Say so rather than pretend.
      const untilNote = match[2] ? ` ("until ${match[2].trim()}" isn't scheduled yet -- reactivate it yourself when ready.)` : '';
      return `Deferred: ${resolved.task.title}. Deferring is a choice, not a failure.${untilNote}`;
    }
  },
  {
    pattern: /^add (.+)$/i,
    async run(match) {
      const title = match[1].trim();
      if (!title) return 'Tell me what to add, e.g. "add buy milk".';
      const task = await localCreateTask({ title });
      return `Added: ${task.title}`;
    }
  },
  {
    pattern: /^remember that (.+)$/i,
    async run(match) {
      const text = match[1].trim();
      await localCreateMemoryCandidate({ body: text });
      return `Saved as a memory candidate (not yet reviewed): "${text}"`;
    }
  },
  {
    pattern: /^(note|capture):? (.+)$/i,
    async run(match) {
      const note = await localCreateNote({ body: match[2].trim() });
      return `Noted: ${note.body}`;
    }
  },
  {
    pattern: /^show notes\??$/i,
    async run() {
      const notes = await localListNotes();
      if (!notes.length) return 'No notes yet. Try "note: <text>" to capture one.';
      return `Notes (${notes.length}):\n${notes.map((n) => `- ${n.body}`).join('\n')}`;
    }
  }
];

// Side-effect-free: only tests patterns, never runs a handler. Callers use
// this to decide ROUTING (local vs. network) before committing to the local
// path, so a caller can set a busy/re-entrancy guard first and only then
// call matchLocalCommand (below) to actually perform the action -- pattern
// testing itself must never be able to double-execute a mutation.
// A trailing '.'/'?'/'!' is conversational punctuation, not part of the
// command -- stripping it once here (rather than encoding tolerance into
// every individual pattern) means "show today" and "Show today." are the
// same command, and a captured free-text group (an added task's title, a
// "remember that" fact) never ends up with a stray period glued onto it.
function normalizeCommandText(text) {
  return String(text || '').trim().replace(/[.!?]+$/, '');
}

export function isLocalCommandPattern(text) {
  const trimmed = normalizeCommandText(text);
  return HANDLERS.some((handler) => handler.pattern.test(trimmed));
}

export async function matchLocalCommand(text) {
  const trimmed = normalizeCommandText(text);
  for (const handler of HANDLERS) {
    const match = handler.pattern.exec(trimmed);
    if (match) {
      try {
        return { handled: true, reply: await handler.run(match) };
      } catch (error) {
        return { handled: true, reply: `That didn't work: ${error.message}` };
      }
    }
  }
  return { handled: false };
}

export const LOCAL_COMMAND_EXAMPLES = [
  'What do I need to do today?',
  'What goals am I working on?',
  'Show completed tasks.',
  'Mark <task> done',
  'Defer <task>',
  'Show deferred',
  'Reactivate <task>',
  'Add <task>',
  'Remember that <fact>',
  'Note: <text>',
  'Show notes'
];
