# Layered Workboard Cards (design contract)

This is a future Workboard design only; it does not change the current UI.

Each card is one canonical state object, rendered in five layers: **Glance**
(title, critical status, owner, priority, progress), **Context** (short recap,
latest evidence, linked stream, source summary), **Execution** (subtasks,
active action, blocker, next step), **Proof** (build/test/runtime/browser
evidence and verification timestamps), and **History** (append-only prior
states, decisions, superseded evidence, transitions, and responsible actor).

Title and critical status remain visible in every layer. Cards have explicit
layer buttons and a labelled vertical scrub rail; mouse-wheel changes layers
only while the focused card/rail has intentional focus, never while ordinary
page scrolling. Keyboard supports Tab to controls, arrows/Home/End to select a
layer, and Enter/Space to activate it. Touch uses visible buttons or a
horizontal swipe only inside the card. The current layer is always labelled.

Respect reduced motion, use tablist/tab semantics with an announced selected
layer, and retain the selected layer per card locally. Deep links address a
specific card and layer. An expanded work-order view reveals all layers while
continuing to read the same canonical state. Proof and History are append-only;
no display-only duplicate state may become a competing source of truth.
