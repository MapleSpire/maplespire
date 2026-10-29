// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

// ── A write into the VALUE of an assignment is a write into a detached copy ──
// In an Automerge change callback, both
//
//   const c = d.f ?? (d.f = {}); c.k = v
//   (d.f ??= []).push(v)
//
// use the value of the assignment expression, which JavaScript defines as the
// right-hand side: the plain `{}`/`[]`, not the proxy Automerge now stores.
// Whenever `d.f` was absent the write is silently dropped and the document
// keeps an EMPTY container. Measured with @automerge/automerge 3.2.6:
// `{"a":{},"b":{},"c":[]}` for those shapes, `{"e":{"k":1}}` for
// `if (!d.e) d.e = {}; const e = d.e; e.k = 1`. It had shipped on the sync
// path, server and client, at every site commit e0c608c5 lists, each one
// reporting success.
//
// The rule is syntactic, so it cannot tell an Automerge draft from a plain
// object. It flags the shape everywhere: assign-then-reread is equally correct
// on a plain object, and a reviewer cannot tell the two apart either.
//
// FLAGGED: a member-expression assignment (`=`, `??=`, `||=`, `&&=`) of an
// object/array literal — or of `x ?? {}` / `x || []` — whose VALUE is used:
// `x ?? (o.f = {})`, `o.f ? o.f : (o.f = {})`, `(o.f ??= []).push(v)`,
// `(o.f = {}).k = 1`, `return (o.f = {})`, `fn(o.f = [])`, `{ a: (o.f ??= {}) }`,
// `(o.f = o.f ?? {}).k = 1`, an arrow body `() => (o.f = {})`.
// NOT FLAGGED: the statement forms (`o.f ??= {}` on its own line, then a
// re-read; also inside a `for (…;…;…)` header or a statement-level comma
// list), a bare identifier on the left (`x ??= []` binds a local, not a
// document field), and a non-literal right-hand side (`??= new Thing()`): the
// loss needs Automerge to COPY the value, which it does for plain literals.
// STILL NOT CAUGHT: a literal reached through a variable
// (`const empty = {}; d.f = empty; empty.k = 1`), `Object.assign`-style
// helpers, and a helper that silently does nothing on an absent container
// (`reconcile(d.f, target)` with `d.f` undefined — bridge.ts had three).
// This is a tripwire, not a proof; the regression tests next to each fixed
// site are the proof.

const LITERAL = new Set(['ObjectExpression', 'ArrayExpression'])

const unwrap = (node) => {
  let current = node
  while (current && (current.type === 'TSAsExpression' || current.type === 'TSNonNullExpression'
    || current.type === 'TSSatisfiesExpression' || current.type === 'TSTypeAssertion')) {
    current = current.expression
  }
  return current
}

const OPERATORS = new Set(['=', '??=', '||=', '&&='])

/** A literal, or `x ?? literal` / `x || literal` (whose value can be that literal). */
const isContainerLiteral = (node) => {
  const value = unwrap(node)
  if (LITERAL.has(value?.type)) return true
  return value?.type === 'LogicalExpression' && (value.operator === '??' || value.operator === '||')
    && LITERAL.has(unwrap(value.right)?.type)
}

const isMemberLiteralAssignment = (node) => node?.type === 'AssignmentExpression'
  && OPERATORS.has(node.operator)
  && node.left.type === 'MemberExpression'
  && isContainerLiteral(node.right)

/** Is the value of `node` discarded (statement position)? */
const valueDiscarded = (node) => {
  let child = node
  let parent = node.parent
  // TS wrappers and parentheses pass the value through unchanged.
  while (parent && (parent.type === 'TSAsExpression' || parent.type === 'TSNonNullExpression'
    || parent.type === 'TSSatisfiesExpression')) {
    child = parent
    parent = parent.parent
  }
  if (!parent) return true
  if (parent.type === 'ExpressionStatement') return true
  if (parent.type === 'ForStatement') return parent.init === child || parent.update === child
  if (parent.type === 'SequenceExpression') {
    // Only the LAST element of a comma list is its value.
    if (parent.expressions.at(-1) !== child) return true
    return valueDiscarded(parent)
  }
  return false
}

export const noDetachedContainerWriteRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow using the value of a container-literal assignment (detached Automerge write).' },
    messages: {
      detached:
        'The value of `{{text}}` is the plain literal, not the stored proxy: on an Automerge draft every write into it is lost. Assign as a statement, then re-read: `if (!o.f) o.f = {}; const f = o.f`.',
    },
    schema: [],
  },
  create(context) {
    const report = (node) => context.report({
      node,
      messageId: 'detached',
      data: { text: context.sourceCode.getText(node).slice(0, 60) },
    })
    return {
      AssignmentExpression(node) {
        if (!isMemberLiteralAssignment(node)) return
        if (valueDiscarded(node)) return
        report(node)
      },
    }
  },
}
