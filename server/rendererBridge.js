import { randomUUID, randomBytes } from 'node:crypto';
import { PRIMARY_NAVIGATION, SECTION_TABS, routeFor, routeFromHash } from '../src/navigation.js';

// Pure, dependency-injected server -> renderer navigation command/acknowledgement
// bridge. Like the action registry, it deliberately knows nothing about Express,
// SQLite, SSE sockets, or timers: a caller registers renderers, issues commands,
// and delivers acknowledgements, and every branch returns one closed-set outcome.
//
// The wire command is intentionally tiny and non-programmable. A command carries a
// single verb ("navigate") plus one *semantic destination token* (e.g. "workboard")
// drawn from a closed allowlist. The concrete route is resolved here through the
// app's own canonical router (src/navigation.js) and round-trip validated, so a
// command can never carry a URL, a file path, a script, or an arbitrary opener.
// There is deliberately no executeJavascript, no http/https/file/shell/javascript
// URL, and no free-form target anywhere in the contract.

export const COMMAND_VERB = 'navigate';

// Terminal resolutions for a command. Every issued command ends in exactly one.
export const COMMAND_RESOLUTIONS = Object.freeze([
  'APPLIED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'STALE_RENDERER'
]);

// Acknowledgement statuses a renderer may report. The server maps these onto the
// terminal resolutions; anything outside this set is rejected, never applied.
export const ACK_STATUSES = Object.freeze(['APPLIED', 'FAILED', 'CANCELLED']);

// Content-minimised failure categories for the bounded audit. No message bodies,
// no private memory, no secrets, no tokens ever appear in an audit record.
export const FAILURE_CATEGORIES = Object.freeze([
  'unknown_destination', 'invalid_command', 'invalid_ack', 'correlation_mismatch',
  'wrong_renderer', 'token_mismatch', 'generation_mismatch', 'duplicate_ack',
  'renderer_stale', 'renderer_unknown', 'renderer_gone', 'timeout', 'cancelled',
  'renderer_failed'
]);

const DESTINATION_ID = /^[a-z][a-z0-9]*$/;

// The closed set of semantic destinations. Each maps to a canonical section/tab
// pair that is resolved through routeFor() at construction and validated by
// round-tripping through routeFromHash(). A destination whose route does not
// round-trip cleanly is dropped (fail-closed): the bridge never offers a
// destination the real router cannot honour, so nothing here can invent a route.
const SEMANTIC_DESTINATIONS = Object.freeze({
  chat: { section: 'chat', tab: null },
  knowledge: { section: 'knowledge', tab: null },
  workboard: { section: 'workboard', tab: null },
  planner: { section: 'workboard', tab: 'today' },
  system: { section: 'system', tab: null },
  settings: { section: 'settings', tab: null }
});

function defaultTabFor(section) {
  return PRIMARY_NAVIGATION.find((entry) => entry.id === section)?.defaultTab || null;
}

// Build the runtime destination catalog by resolving each semantic destination
// through the app's canonical router and keeping only those that round-trip to the
// intended section (and tab, when one is requested). This is the single source of
// truth for "is this destination real?" and reuses routeFor/routeFromHash rather
// than duplicating any routing logic.
export function buildDestinationCatalog(destinations = SEMANTIC_DESTINATIONS) {
  const catalog = new Map();
  for (const [id, target] of Object.entries(destinations)) {
    if (!DESTINATION_ID.test(id)) continue;
    const section = target?.section;
    const tab = target?.tab ?? null;
    if (typeof section !== 'string' || !section) continue;
    let route;
    try { route = routeFor(section, tab); } catch { continue; }
    if (typeof route !== 'string' || !route.startsWith('#')) continue;
    let parsed;
    try { parsed = routeFromHash(route); } catch { continue; }
    // Reject anything the canonical parser could not place (it degrades unknown
    // routes to a legacy chat fallback); require the section to match and the tab
    // to match the request or the section's own default.
    if (!parsed || parsed.legacy || parsed.section !== section) continue;
    const expectedTab = tab ?? defaultTabFor(section);
    if ((parsed.tab ?? null) !== (expectedTab ?? null)) continue;
    catalog.set(id, Object.freeze({ id, section, tab: expectedTab, route }));
  }
  return catalog;
}

function newRendererId(factory) {
  const value = String(factory());
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new Error('rendererIdFactory returned an invalid identifier.');
  return value;
}

function newSecret(factory) {
  const value = String(factory());
  if (!/^[A-Za-z0-9._-]{24,256}$/.test(value)) throw new Error('secretFactory returned an invalid secret.');
  return value;
}

function newCommandId(factory) {
  const value = String(factory());
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new Error('commandIdFactory returned an invalid identifier.');
  return value;
}

// Correlation IDs are supplied by the caller (bound to the originating action
// invocation) so the whole action -> command -> ack -> audit chain shares one id.
function validCorrelationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
}

function reject(code, category, message) {
  return { ok: false, error: { code, category, message: String(message).slice(0, 240) } };
}

export function createRendererBridge({
  now = () => Date.now(),
  rendererIdFactory = randomUUID,
  secretFactory = () => randomBytes(24).toString('hex'),
  commandIdFactory = randomUUID,
  commandTtlMs = 10_000,
  rendererIdleMs = 60_000,
  destinations = SEMANTIC_DESTINATIONS
} = {}) {
  if (typeof now !== 'function') throw new Error('now must be a function.');
  if (!Number.isInteger(commandTtlMs) || commandTtlMs < 250) throw new Error('commandTtlMs must be a sane integer.');
  if (!Number.isInteger(rendererIdleMs) || rendererIdleMs < commandTtlMs) throw new Error('rendererIdleMs must be >= commandTtlMs.');

  const catalog = buildDestinationCatalog(destinations);
  if (!catalog.size) throw new Error('No semantic destinations resolved to a canonical route.');

  const renderers = new Map();       // rendererId -> renderer record
  const windowIndex = new Map();     // windowId -> current live rendererId
  const commands = new Map();        // commandId -> command record
  const resolutionListeners = new Map(); // commandId -> Set<fn(resolution)>

  function isRendererLive(renderer, ts) {
    return renderer && !renderer.superseded && !renderer.unregistered && (ts - renderer.lastSeenAt) <= rendererIdleMs;
  }

  function notify(command) {
    const listeners = resolutionListeners.get(command.commandId);
    if (!listeners) return;
    resolutionListeners.delete(command.commandId);
    const resolution = commandResolution(command);
    for (const fn of listeners) { try { fn(resolution); } catch { /* listener errors never break resolution */ } }
  }

  function resolveCommand(command, status, category, ackDetail) {
    if (command.resolved) return command;
    command.resolved = true;
    command.status = status;
    command.failureCategory = status === 'APPLIED' ? null : (category || null);
    command.resolvedAt = now();
    command.ackDetail = ackDetail ? String(ackDetail).slice(0, 200) : null;
    notify(command);
    return command;
  }

  // Mark every pending command bound to a renderer as stale (used when a renderer
  // reloads/supersedes, unregisters, or is pruned for idleness).
  function staleAllForRenderer(rendererId, category = 'renderer_stale') {
    for (const command of commands.values()) {
      if (command.rendererId === rendererId && !command.resolved) resolveCommand(command, 'STALE_RENDERER', category);
    }
  }

  function registerRenderer({ windowId, chatSessionId = null } = {}) {
    const win = String(windowId || '').slice(0, 128);
    if (!win) return reject('INVALID_WINDOW', 'invalid_command', 'A window identifier is required.');
    const ts = now();
    // A reload of the same window supersedes the previous generation: its still
    // pending commands become STALE_RENDERER and can no longer be acknowledged.
    const priorId = windowIndex.get(win);
    let generation = 1;
    if (priorId && renderers.has(priorId)) {
      const prior = renderers.get(priorId);
      generation = prior.generation + 1;
      prior.superseded = true;
      prior.connected = false;
      staleAllForRenderer(priorId, 'renderer_stale');
    }
    const rendererId = newRendererId(rendererIdFactory);
    const token = newSecret(secretFactory);
    const renderer = {
      rendererId, token, windowId: win,
      chatSessionId: chatSessionId == null ? null : String(chatSessionId).slice(0, 64),
      generation, registeredAt: ts, lastSeenAt: ts,
      connected: false, superseded: false, unregistered: false
    };
    renderers.set(rendererId, renderer);
    windowIndex.set(win, rendererId);
    return { ok: true, rendererId, token, generation };
  }

  function authRenderer(rendererId, token) {
    const renderer = renderers.get(String(rendererId || ''));
    if (!renderer) return null;
    // Constant-ish comparison is unnecessary here (local single-user app) but the
    // token must match exactly; a wrong/absent token authenticates nothing.
    if (!token || renderer.token !== String(token)) return null;
    return renderer;
  }

  function touch(rendererId, token) {
    const renderer = authRenderer(rendererId, token);
    if (!renderer || renderer.unregistered) return reject('UNKNOWN_RENDERER', 'renderer_unknown', 'Unknown renderer or token.');
    renderer.lastSeenAt = now();
    return { ok: true };
  }

  // Non-mutating authentication check used before a caller is allowed to target a
  // renderer with a command (defence in depth: only the window that registered and
  // holds the token may have commands issued to it).
  function authenticate(rendererId, token) {
    const renderer = authRenderer(rendererId, token);
    if (!renderer || renderer.unregistered || renderer.superseded) return reject('UNKNOWN_RENDERER', 'renderer_unknown', 'Unknown, superseded, or unauthorised renderer.');
    return { ok: true };
  }

  function attachStream(rendererId, token) {
    const renderer = authRenderer(rendererId, token);
    if (!renderer || renderer.unregistered || renderer.superseded) return reject('UNKNOWN_RENDERER', 'renderer_unknown', 'Unknown, superseded, or unauthorised renderer.');
    renderer.connected = true;
    renderer.lastSeenAt = now();
    return { ok: true, renderer: rendererView(renderer) };
  }

  function detachStream(rendererId, token) {
    const renderer = authRenderer(rendererId, token);
    if (!renderer) return reject('UNKNOWN_RENDERER', 'renderer_unknown', 'Unknown renderer or token.');
    renderer.connected = false;
    return { ok: true };
  }

  function unregisterRenderer(rendererId, token) {
    const renderer = authRenderer(rendererId, token);
    if (!renderer) return reject('UNKNOWN_RENDERER', 'renderer_unknown', 'Unknown renderer or token.');
    renderer.unregistered = true;
    renderer.connected = false;
    if (windowIndex.get(renderer.windowId) === renderer.rendererId) windowIndex.delete(renderer.windowId);
    staleAllForRenderer(renderer.rendererId, 'renderer_gone');
    return { ok: true };
  }

  // Issue a navigation command to a specific renderer. Returns the tiny, non-
  // programmable envelope to push over that renderer's channel, or a rejection.
  function issueCommand({ rendererId, destination, correlationId } = {}) {
    if (!validCorrelationId(correlationId)) return reject('INVALID_CORRELATION', 'invalid_command', 'A valid correlation id is required.');
    const dest = String(destination || '');
    if (!DESTINATION_ID.test(dest) || !catalog.has(dest)) return reject('UNKNOWN_DESTINATION', 'unknown_destination', `Unknown navigation destination: ${dest.slice(0, 40) || '<empty>'}.`);
    const renderer = renderers.get(String(rendererId || ''));
    const ts = now();
    if (!renderer || renderer.unregistered) return reject('RENDERER_UNKNOWN', 'renderer_unknown', 'The target renderer is not registered.');
    if (!isRendererLive(renderer, ts)) return reject('RENDERER_STALE', 'renderer_stale', 'The target renderer is stale or superseded.');
    const entry = catalog.get(dest);
    const command = {
      commandId: newCommandId(commandIdFactory),
      commandToken: newSecret(secretFactory),
      correlationId: String(correlationId),
      rendererId: renderer.rendererId,
      windowId: renderer.windowId,
      generation: renderer.generation,
      chatSessionId: renderer.chatSessionId,
      command: COMMAND_VERB,
      destination: entry.id,
      route: entry.route,
      section: entry.section,
      tab: entry.tab,
      issuedAt: ts,
      expiresAt: ts + commandTtlMs,
      resolved: false,
      status: null,
      failureCategory: null,
      resolvedAt: null,
      ackDetail: null
    };
    commands.set(command.commandId, command);
    return { ok: true, envelope: commandEnvelope(command), commandId: command.commandId };
  }

  // The envelope actually delivered to the renderer. It carries the single-use
  // command token (so the renderer can prove it received THIS command when it acks)
  // and the pre-resolved canonical route, but never any secret of the renderer.
  function commandEnvelope(command) {
    return {
      commandId: command.commandId,
      commandToken: command.commandToken,
      correlationId: command.correlationId,
      rendererId: command.rendererId,
      command: command.command,
      destination: command.destination,
      route: command.route,
      expiresAt: command.expiresAt
    };
  }

  // Deliver a renderer's acknowledgement. Single-use and fully bound: the ack must
  // present the command id, the same correlation id, the target renderer id, that
  // renderer's live token, and the command's own single-use token, and an allowed
  // status. Any mismatch is rejected and the command is NOT resolved by it (so a
  // forged or stray ack can neither fake success nor rob a legitimate ack/timeout).
  function acknowledge({ commandId, correlationId, rendererId, token, commandToken, status, detail } = {}) {
    const command = commands.get(String(commandId || ''));
    if (!command) return reject('UNKNOWN_COMMAND', 'invalid_ack', 'Unknown command.');
    if (command.resolved) return reject('ALREADY_RESOLVED', 'duplicate_ack', 'This command was already resolved (single-use).');
    if (!ACK_STATUSES.includes(status)) return reject('INVALID_ACK_STATUS', 'invalid_ack', 'Unsupported acknowledgement status.');
    if (String(correlationId || '') !== command.correlationId) return reject('CORRELATION_MISMATCH', 'correlation_mismatch', 'Acknowledgement correlation id does not match the command.');
    if (String(rendererId || '') !== command.rendererId) return reject('WRONG_RENDERER', 'wrong_renderer', 'Acknowledgement came from a renderer that was not targeted.');
    const renderer = authRenderer(rendererId, token);
    if (!renderer) return reject('TOKEN_MISMATCH', 'token_mismatch', 'Renderer token did not authenticate.');
    if (renderer.generation !== command.generation || renderer.superseded || renderer.unregistered) {
      // The renderer that received this command has been superseded/closed; resolve
      // the command as stale rather than applying a reload's acknowledgement.
      resolveCommand(command, 'STALE_RENDERER', 'generation_mismatch');
      return reject('GENERATION_MISMATCH', 'generation_mismatch', 'The acknowledging renderer generation no longer matches the command.');
    }
    if (String(commandToken || '') !== command.commandToken) return reject('COMMAND_TOKEN_MISMATCH', 'token_mismatch', 'Command token did not match.');
    renderer.lastSeenAt = now();
    const resolution = status === 'APPLIED' ? 'APPLIED' : status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    const category = status === 'APPLIED' ? null : status === 'CANCELLED' ? 'cancelled' : 'renderer_failed';
    resolveCommand(command, resolution, category, detail);
    return { ok: true, resolution: commandResolution(command) };
  }

  // Server-side cancellation (the issuer aborts before any terminal ack).
  function cancelCommand(commandId, { reason = 'cancelled' } = {}) {
    const command = commands.get(String(commandId || ''));
    if (!command) return reject('UNKNOWN_COMMAND', 'invalid_command', 'Unknown command.');
    if (command.resolved) return reject('ALREADY_RESOLVED', 'duplicate_ack', 'This command was already resolved.');
    resolveCommand(command, 'CANCELLED', 'cancelled', reason);
    return { ok: true, resolution: commandResolution(command) };
  }

  // Resolve every expired-but-unacknowledged command as TIMEOUT. The wiring layer
  // calls this on an interval and opportunistically; it is idempotent.
  function expireDueCommands(ts = now()) {
    const expired = [];
    for (const command of commands.values()) {
      if (!command.resolved && ts >= command.expiresAt) {
        resolveCommand(command, 'TIMEOUT', 'timeout');
        expired.push(commandResolution(command));
      }
    }
    return expired;
  }

  // Mark renderers idle beyond the ceiling as stale and fail their pending commands.
  function pruneStaleRenderers(ts = now()) {
    const pruned = [];
    for (const renderer of renderers.values()) {
      if (renderer.unregistered || renderer.superseded) continue;
      if ((ts - renderer.lastSeenAt) > rendererIdleMs) {
        renderer.superseded = true;
        renderer.connected = false;
        if (windowIndex.get(renderer.windowId) === renderer.rendererId) windowIndex.delete(renderer.windowId);
        staleAllForRenderer(renderer.rendererId, 'renderer_stale');
        pruned.push(renderer.rendererId);
      }
    }
    return pruned;
  }

  // Register a one-shot resolution listener (resolves immediately if already
  // terminal). The wiring layer awaits this to turn the async ack into a response.
  function onResolved(commandId, listener) {
    const command = commands.get(String(commandId || ''));
    if (!command) return false;
    if (command.resolved) { try { listener(commandResolution(command)); } catch { /* ignore */ } return true; }
    if (!resolutionListeners.has(command.commandId)) resolutionListeners.set(command.commandId, new Set());
    resolutionListeners.get(command.commandId).add(listener);
    return true;
  }

  function commandResolution(command) {
    return {
      commandId: command.commandId,
      correlationId: command.correlationId,
      destination: command.destination,
      status: command.status,
      resolved: command.resolved,
      failureCategory: command.failureCategory,
      resolvedAt: command.resolvedAt
    };
  }

  // Bounded audit record: action-relevant identifiers only. No route bodies beyond
  // the semantic destination, no tokens, no chat content, no private memory.
  function toAuditRecord(command) {
    return {
      command: command.command,
      destination: command.destination,
      correlationId: command.correlationId,
      rendererSession: command.rendererId,
      windowId: command.windowId,
      generation: command.generation,
      status: command.status,
      failureCategory: command.failureCategory,
      issuedAt: command.issuedAt,
      resolvedAt: command.resolvedAt
    };
  }

  function rendererView(renderer) {
    return {
      rendererId: renderer.rendererId, windowId: renderer.windowId,
      chatSessionId: renderer.chatSessionId, generation: renderer.generation,
      connected: renderer.connected, superseded: renderer.superseded,
      unregistered: renderer.unregistered, lastSeenAt: renderer.lastSeenAt
    };
  }

  function getCommand(commandId) {
    const command = commands.get(String(commandId || ''));
    return command ? { ...commandResolution(command), audit: toAuditRecord(command) } : null;
  }

  function getRenderer(rendererId) {
    const renderer = renderers.get(String(rendererId || ''));
    return renderer ? rendererView(renderer) : null;
  }

  function listDestinations() {
    return [...catalog.values()].map((entry) => ({ id: entry.id, route: entry.route, section: entry.section, tab: entry.tab }));
  }

  function snapshot() {
    let live = 0;
    const ts = now();
    for (const renderer of renderers.values()) if (isRendererLive(renderer, ts)) live += 1;
    let pending = 0;
    for (const command of commands.values()) if (!command.resolved) pending += 1;
    return { renderers: renderers.size, liveRenderers: live, commands: commands.size, pendingCommands: pending, destinations: catalog.size };
  }

  return Object.freeze({
    COMMAND_VERB,
    registerRenderer, unregisterRenderer, attachStream, detachStream, touch, authenticate,
    issueCommand, acknowledge, cancelCommand, expireDueCommands, pruneStaleRenderers,
    onResolved, toAuditRecord, getCommand, getRenderer, listDestinations, snapshot
  });
}
