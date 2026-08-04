import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring check for the layered Workboard card UI (checkpoint #3, slice 2).
// Asserts the real client/server contract: cards read the canonical work-order
// projection, the five layers are an accessible tablist with keyboard control,
// empty layers are shown honestly, and identity is pinned across layers.

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ui = read('src/main.jsx');
const navigation = read('src/navigation.js');
const styles = read('src/styles.css');
const server = read('server/index.js');

// Navigation + wiring: a Cards tab that survives refresh via the hash router.
assert.match(navigation, /\{ id: 'cards', label: 'Cards' \}/, 'navigation registers the Cards tab');
assert.match(ui, /route\.tab === 'cards' && <LayeredWorkboard[^>]*refreshSignal=\{refreshSignal\}/, 'Workboard renders LayeredWorkboard for the cards tab');
assert.match(ui, /function LayeredWorkboard\(/, 'LayeredWorkboard component exists');
assert.match(ui, /function LayeredCard\(/, 'LayeredCard component exists');

// It reads the canonical projection, and the server exposes it.
assert.match(ui, /api\('\/api\/workboard\/cards'\)/, 'the cards view reads the canonical work-order list endpoint');
assert.match(server, /app\.get\('\/api\/workboard\/cards'/, 'the server exposes the work-order list endpoint');

// Isolate the layered UI slice for the remaining structural checks.
const slice = ui.slice(ui.indexOf('const CARD_LAYERS'), ui.indexOf('function Knowledge('));
assert.ok(slice.length > 0, 'the layered-card UI slice is present');

// Five canonical layers, in order, rendered as an ARIA tablist/tabpanel.
assert.match(slice, /\{ id: 'glance'[\s\S]*'context'[\s\S]*'execution'[\s\S]*'proof'[\s\S]*'history'/, 'the five canonical layers are defined in order');
assert.match(slice, /role="tablist"[\s\S]*aria-orientation="vertical"/, 'layers are an accessible vertical tablist');
assert.match(slice, /role="tab"[\s\S]*aria-selected=\{i === index\}[\s\S]*tabIndex=\{i === index \? 0 : -1\}/, 'layer tabs use roving tabindex and aria-selected');
assert.match(slice, /role="tabpanel"[\s\S]*aria-labelledby=/, 'the layer body is a labelled tabpanel');

// Keyboard: arrows + Home/End move layers.
assert.match(slice, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowRight'/, 'arrow keys change layers');
assert.match(slice, /event\.key === 'Home'[\s\S]*event\.key === 'End'/, 'Home/End jump to first/last layer');

// Wheel is intentional-hover-only and never hijacks page scroll.
assert.match(slice, /const onWheel = \(event\) => \{\s*\n\s*if \(!hovered\) return;/, 'the mouse wheel only changes layers while the card is intentionally hovered');

// Identity is pinned; empty layers are honest, not fabricated.
for (const pinned of ['card.pinned.title', 'card.pinned.status', 'card.pinned.owner', 'card.pinned.blocker']) {
  assert.ok(slice.includes(pinned), `${pinned} is pinned from canonical data across layers`);
}
assert.match(slice, /function LayerEmpty\(/, 'empty layers render an explicit empty state');
assert.match(slice, /Nothing recorded yet/, 'the empty state truthfully says nothing is recorded yet');
assert.doesNotMatch(slice, /\.sort\(/, 'the UI does not re-order canonical data');

// Remember-last-layer persistence and reduced-motion support.
assert.match(slice, /localStorage\.setItem\(storageKey/, 'each card remembers its last selected layer');
assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/, 'reduced-motion mode is respected in the card styles');

console.log('Layered Workboard card UI wiring verification passed.');
