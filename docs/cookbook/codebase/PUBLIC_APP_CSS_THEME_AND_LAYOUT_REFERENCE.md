# LifePlanSystemPublic CSS, Theme, and Layout Reference

Status: complete source-level reference for the maintained visual system in `src/styles.css`, frontend theme persistence, major layouts, responsive behavior, and accessibility/maintenance limitations. Runtime visual acceptance remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
src/styles.css  2f13dbe42f3b81724930125b428488bf40d0d576
src/main.jsx    4592881c34af44848dfc72e74895face6098a1da
index.html      99ce548380591bae400968ba1c1ded403857e0f8
```

## 1. Visual architecture

The entire maintained application stylesheet is one global CSS file:

```text
src/styles.css
```

There are no CSS modules, CSS-in-JS components, utility framework, compiled design-token package, or per-panel stylesheets.

The main organization is:

```text
root theme variables
browser/body reset and minimum viewport
application shell/sidebar/topbar
shared controls and badges
panel/grid primitives
Planner layouts
Repository/Approval/Tooling layouts
Chat and forms
Memory/Browser/Settings layouts
Source Control additions
Dev Roadmap additions
limited max-width breakpoints
```

Class names are global and tightly coupled to markup in the single `src/main.jsx` file.

## 2. Theme model

Default theme:

```css
:root { color-scheme: dark; }
```

Light theme selector:

```css
:root[data-theme="light"]
```

The React `ThemeToggle` writes:

```text
localStorage key: life-planner-theme
values: dark | light
```

`App` sets:

```js
document.documentElement.dataset.theme = theme
```

This changes the root attribute and therefore the CSS variable set.

### Main tokens

```text
--bg
--bg-2
--panel
--panel-2
--line
--text
--muted
--soft
--accent
--accent-2
--amber
--red
--green
--blue
--shadow
```

Dark mode uses a near-black/blue-gray surface system with a mint accent. Light mode redefines the same tokens, allowing most component rules to remain theme-independent.

### Token exceptions

Several values are hard-coded outside the theme token set, including:

- dark and light code-block backgrounds;
- primary-button foregrounds;
- red/green diff backgrounds;
- accent glow RGBA values;
- some transparent color mixes.

These should be reviewed when changing accent or contrast behavior.

## 3. Typography

Default family:

```text
Inter, system UI fallbacks, Segoe UI, sans-serif
```

No font file is bundled or imported, so `Inter` is used only when available on the operating system.

Monospace areas use combinations of:

```text
Cascadia Code
SFMono-Regular
ui-monospace
Menlo
Consolas
monospace
```

Typography is compact and desktop-oriented:

- application title: 24px;
- panel heading: 17px;
- subheading: 14px;
- normal UI metadata: commonly 11–13px;
- code/diff areas: 12px.

## 4. Application shell

```css
.app-shell {
  display: grid;
  grid-template-columns: 250px 1fr;
  min-height: 100vh;
}
```

The sidebar is fixed at 250px in the grid and the main area takes the remainder.

The body has:

```css
min-width: 1080px;
```

At the only general breakpoint:

```css
@media (max-width: 1180px) {
  body { min-width: 900px; }
}
```

This means the design is desktop-first and deliberately forces horizontal width. It is not a mobile/responsive application.

## 5. Shared visual primitives

### Panels

Common panel surfaces include:

```text
.focus-panel
.right-rail
.bucket
.panel
.chat-panel
.session-list
```

They share border, panel background, 8px radius, and shadow.

### Buttons

Multiple selectors share a common button treatment. `.primary` applies the accent fill; `.danger` applies red text/border conventions.

There is no centralized size/type component beyond CSS selectors and the React helper usage. A button can receive conflicting global selectors depending on its panel ancestry.

### Pills/status

```text
.pill
.pill-good
.pill-bad
.pill-warn
.pill-info
```

The React `Pill` helper creates `pill-${tone}`. Other tones such as `default` or `muted` fall back to the base style because there are no dedicated rules for every semantic name.

### Empty states

`.empty` creates a centered dashed-box placeholder with title/body.

### Warnings

```text
.source-warning
.source-warning.info
.source-warning.warn
.source-warning.bad
```

These are used broadly for privacy, setup, error, and informational notices.

## 6. Major layout contracts

### Planner

```text
.planner-grid       main content + 320px rail
.metric-strip       seven columns, four below 1180px
.bucket-grid        three columns, two below 1180px
```

### Chat

```text
.chat-layout        280px session list + chat panel
height              calc(100vh - 112px)
.chat-panel         header / scrollable messages / composer
.message            max-width 76%
```

### Repository

```text
.repo-layout        360px file list + preview/editor
height              calc(100vh - 112px)
```

The generic 1180px rule changes `.repo-layout` to two equal columns rather than preserving the dedicated sidebar width.

### Settings

```text
.settings-grid      three columns: 1.1fr / 1fr / 330px
```

Below 1180px it becomes two equal columns.

### Two-column panels

```text
.two-column
.projects-layout
.tooling-grid
.calibration-grid
```

These generally use equal or near-equal columns and `align-items: start`.

### Source Control

The Source panel adds a second generation of styles:

```text
.sc-topbar
.sc-tabbar
.sc-changes-grid
.sc-branch-grid
.sc-sync-grid
.sc-history-list
.sc-branch-list
.sc-stash-list
.sc-tag-list
.sbs-diff
```

The changes grid collapses to one column below 1180px. Branch/sync grids use `auto-fit` with a 320px minimum.

### Dev Roadmap

```text
.roadmap-board       five columns
```

Below 1180px it becomes two columns. There is no one-column/mobile breakpoint.

## 7. Scrolling and viewport behavior

Several panels use viewport-derived fixed heights:

```text
.chat-layout  calc(100vh - 112px)
.repo-layout  calc(100vh - 112px)
```

Nested lists/messages use `overflow: auto` and parent containers use `min-height: 0` or `overflow: hidden` to establish scroll regions.

Potential issues:

- browser zoom and OS text scaling can reduce usable vertical space;
- topbar wrapping can make the fixed 112px subtraction inaccurate;
- forced body minimum width can create horizontal page scrolling;
- long forms may extend beyond the viewport rather than use a dedicated panel scroll container.

## 8. Form and editor behavior

Global `input`, `textarea`, and `select` rules provide full width, themed surfaces, borders, and padding.

Textareas resize vertically. Important editors:

- repository editor uses monospace and minimum 50vh;
- browser consultation textareas use minimum 130px;
- chat composer is constrained between 50px and 140px;
- code blocks cap height and scroll;
- diff/detail blocks use larger caps.

There are no explicit invalid, required, focus-visible, success, or autofill states beyond the browser defaults and the standard outline removal.

## 9. Accessibility behavior

Positive source-level elements:

- dark and light `color-scheme` declarations;
- semantic form controls in React;
- disabled controls visibly reduce opacity and cursor;
- theme control uses radio roles and `aria-checked`;
- status colors are usually accompanied by text labels.

Known limitations:

- global form controls use `outline: none` without a replacement focus-visible ring;
- most custom buttons have no explicit focus style;
- very small 10–12px metadata is common;
- hard minimum widths make narrow viewport and mobile accessibility poor;
- color contrast has not been recorded against WCAG targets;
- status still relies partly on red/amber/green color distinctions;
- fixed-height scroll regions can create nested keyboard scrolling;
- reduced-motion/high-contrast media preferences are not handled;
- no automated accessibility checks are maintained.

## 10. CSS maintenance risks

- One 1,000+ line global stylesheet serves every panel.
- Repeated `@media (max-width: 1180px)` blocks are separated across the file.
- Later Source Control and Roadmap rules append to older general rules, increasing override-order dependence.
- Generic selectors such as `.panel`, `nav`, `p`, `label`, and ancestry-based button groups can affect new components unintentionally.
- Class ownership is not enforced by modules or naming namespaces, except the newer `sc-` and `roadmap-` prefixes.
- `color-mix()` support is assumed.
- No CSS lint, unused-selector check, screenshot test, or design-token validation is configured.

## 11. Recommended ownership split when refactoring

Do not rewrite during MVP completion solely for style preference. When a verified need appears, split by responsibility:

```text
src/styles/tokens.css
src/styles/base.css
src/styles/layout.css
src/styles/components.css
src/styles/planner.css
src/styles/chat.css
src/styles/source-control.css
src/styles/roadmap.css
src/styles/responsive.css
```

Keep the variable names stable first so the change is mechanical and testable.

## 12. Runtime acceptance checklist

At 100% browser zoom, verify dark and light modes at:

```text
1920 x 1080
1440 x 900
1180 x 800
900 x 700
```

Check:

- sidebar and topbar do not overlap;
- every panel can reach all controls;
- chat/repository internal scrolling works;
- long paths/titles truncate without hiding required actions;
- Source Control diff columns remain readable;
- Roadmap columns do not lose controls;
- focus indicators are visible enough to operate by keyboard;
- light-mode code/diff text remains legible;
- theme persists after restart/reload;
- no console layout warnings occur.

Use `BROKEN` for inaccessible controls or overlapping content, not merely cosmetic preference.

## 13. Current conclusion

The visual system is coherent for a compact desktop control center and has a real tokenized dark/light implementation. It is not responsive below desktop widths, is not accessibility-verified, and remains structurally coupled through one global stylesheet and one React file.