#!/usr/bin/env node
// Deterministic Phase 3 baseline for every intrinsic interactive control in the
// React surface. This does not pretend the current app-wide migration is done:
// it freezes the known mapped/unmapped inventory so new controls cannot silently
// increase registry debt, partial data-action annotations fail closed, and every
// mapped action must exist in the live neutral manifest.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { createCapabilityRegistry } from '../server/chatCapabilities.js';

const root = path.resolve(import.meta.dirname, '..');
const baselinePath = path.join(root, 'docs', 'audits', 'ACTION_CONTROL_INVENTORY_BASELINE.json');
const source = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
const interactiveTags = new Set(['button', 'input', 'select', 'textarea', 'summary']);
const controls = [];
const ownerOrdinals = new Map();

function staticAttribute(opening, name) {
  const attribute = opening.attributes.find((item) => item.type === 'JSXAttribute' && item.name?.name === name);
  if (!attribute) return null;
  if (attribute.value?.type === 'StringLiteral') return attribute.value.value;
  if (attribute.value?.type === 'JSXExpressionContainer' && attribute.value.expression?.type === 'StringLiteral') return attribute.value.expression.value;
  return '<dynamic>';
}

function directText(element) {
  return element.children
    .filter((child) => child.type === 'JSXText')
    .map((child) => child.value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 120);
}

function functionOwner(node, owner) {
  if (node.type === 'FunctionDeclaration' && node.id?.name) return node.id.name;
  if ((node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') && node.__variableOwner) return node.__variableOwner;
  return owner;
}

function walk(node, owner = '<module>') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, owner);
    return;
  }
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
    node.init.__variableOwner = node.id.name;
  }
  const nextOwner = functionOwner(node, owner);
  if (node.type === 'JSXElement') {
    const tag = node.openingElement.name?.type === 'JSXIdentifier' ? node.openingElement.name.name : '';
    if (interactiveTags.has(tag)) {
      const actionId = staticAttribute(node.openingElement, 'data-action-id');
      const controlId = staticAttribute(node.openingElement, 'data-control-id');
      const key = nextOwner;
      const ordinal = (ownerOrdinals.get(key) || 0) + 1;
      ownerOrdinals.set(key, ordinal);
      controls.push({
        owner: nextOwner,
        ordinal,
        tag,
        actionId,
        controlId,
        label: staticAttribute(node.openingElement, 'aria-label') || staticAttribute(node.openingElement, 'title') || staticAttribute(node.openingElement, 'placeholder') || directText(node) || '<dynamic>'
      });
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', '__variableOwner'].includes(key)) continue;
    walk(value, nextOwner);
  }
}

walk(ast);

for (const control of controls) {
  assert.equal(Boolean(control.actionId), Boolean(control.controlId), `control ${control.owner}#${control.ordinal} must declare both data-action-id and data-control-id or neither`);
  if (control.actionId) {
    assert.notEqual(control.actionId, '<dynamic>', `control ${control.owner}#${control.ordinal} action id must be static`);
    assert.notEqual(control.controlId, '<dynamic>', `control ${control.owner}#${control.ordinal} control id must be static`);
  }
}

const manifest = new Map(createCapabilityRegistry({}).listActions().map((action) => [action.id, action]));
for (const control of controls.filter((item) => item.actionId)) assert.ok(manifest.has(control.actionId), `${control.controlId} maps to unknown action ${control.actionId}`);

const byOwner = {};
for (const control of controls) {
  const summary = byOwner[control.owner] ||= { total: 0, mapped: 0, unmapped: 0 };
  summary.total += 1;
  summary[control.actionId ? 'mapped' : 'unmapped'] += 1;
}
const fingerprintInput = controls.map(({ owner, ordinal, tag, actionId, controlId, label }) => ({ owner, ordinal, tag, actionId, controlId, label }));
const actual = {
  schemaVersion: 1,
  source: 'src/main.jsx',
  total: controls.length,
  mapped: controls.filter((item) => item.actionId).length,
  unmapped: controls.filter((item) => !item.actionId).length,
  fingerprint: crypto.createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex'),
  byOwner: Object.fromEntries(Object.entries(byOwner).sort(([left], [right]) => left.localeCompare(right)))
};

if (process.argv.includes('--print-baseline')) {
  console.log(JSON.stringify(actual, null, 2));
  process.exit(0);
}

const expected = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
assert.deepEqual(actual, expected, 'interactive-control inventory changed; classify the real control delta and deliberately refresh the reviewed baseline');
assert.ok(actual.mapped > 0 && actual.unmapped > 0, 'baseline must truthfully retain both the accepted registry slice and explicit migration debt');
console.log(`Action-control inventory verified: ${actual.total} controls, ${actual.mapped} mapped, ${actual.unmapped} explicitly baselined as unmapped.`);
