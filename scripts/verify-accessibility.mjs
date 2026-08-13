import fs from 'node:fs';
import path from 'node:path';

// Accessibility regression guard (roadmap: Responsive and keyboard accessible UI).
// Static checks that keep the real accessibility behaviour from regressing: no
// desktop-locked body width, a visible keyboard focus indicator for form controls
// (the default outline is removed for a custom border, so a :focus-visible ring
// must replace it — WCAG 2.4.7), reduced-motion support, and no icon-only button
// left without an accessible name. Local and static. Exit 0 = pass.

const root = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8');

let failures = 0;
const line = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

console.log('--- accessibility guard ---');

// The layout must not reimpose a desktop-only minimum width on the body.
const bodyMin = css.match(/body\s*\{[^}]*min-width:\s*(\d+)px/);
line(Boolean(bodyMin) && Number(bodyMin[1]) <= 320, `the body min-width stays mobile-friendly (${bodyMin ? bodyMin[1] + 'px' : 'unset'})`);

// Form controls remove the native outline, so a focus-visible ring must replace
// it or keyboard users lose all focus indication on inputs.
const stripsOutline = /input,\s*textarea,\s*select\s*\{[^}]*outline:\s*none/s.test(css);
const restoresFocus = /input:focus-visible,\s*textarea:focus-visible,\s*select:focus-visible\s*\{[^}]*outline:/s.test(css);
line(!stripsOutline || restoresFocus, 'form controls that clear the native outline restore a visible :focus-visible ring');
line(restoresFocus, 'inputs, textareas, and selects define a keyboard focus-visible indicator');

// Interactive chrome keeps its focus-visible affordances and honours reduced motion.
line(/\.icon-button:focus-visible/.test(css), 'icon buttons keep a visible focus ring');
line(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css), 'reduced-motion preference is honoured');

// No icon-only button may ship without an accessible name (aria-label/title).
// Matches <button ...><Icon .../></button> with nothing else inside.
const iconOnly = [...ui.matchAll(/<button\b([^>]*)>\s*<[A-Z][A-Za-z0-9]*\b[^>]*\/>\s*<\/button>/g)];
const unnamed = iconOnly.filter((match) => !/\baria-label=|\btitle=/.test(match[1]));
line(unnamed.length === 0, `every icon-only button has an accessible name (${iconOnly.length} checked, ${unnamed.length} unnamed)`);
if (unnamed.length) console.log('   unnamed icon-only buttons:', unnamed.map((m) => m[0].slice(0, 70)).join(' | '));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll accessibility guard checks passed.');
process.exit(failures ? 1 : 0);
