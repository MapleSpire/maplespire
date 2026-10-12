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

import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Bare numeric parses of environment variables ─────────────────────────────
//
// `Number('')` is 0, and 0 is finite, so a dangling `KNOB=` in a `.env` reads as
// a deliberate zero. In this tree that has meant: idle eviction disabled,
// `setInterval(…, 0)` spins, shard size 0, and — on `gc.ts`, which deletes
// DURABLY — a 24-hour safety margin collapsed to NOW. Garbage is safe (NaN
// fails every comparison); a BLANK is the dangerous input.
//
// This AST rule follows `parseInt`/`parseFloat`/unary-`+`,
// `Number.parseInt`/`Number.parseFloat`, a `?.trim()` between the read and the
// parse, aliases, and destructuring — none of which a source-text match can see.
// It is keyed on the RESOLVED value, not on spelling.

/** The repo root, derived from THIS file's location.
 *
 * NOT `context.cwd`, which is the directory ESLint was INVOKED from: running
 * `npx eslint src/automergeServer.ts` from `server/` would produce
 * `src/automergeServer.ts` against an allowlist keyed
 * `server/src/automergeServer.ts`, and report phantom errors in editors that
 * lint per folder. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Is this node `process.env` or `import.meta.env`?
 * `resolve` maps an Identifier to the expression it was initialised from, or
 * null.
 */
function isEnvObject(node, resolve, depth = 0) {
  if (!node || depth > 6) return false
  switch (node.type) {
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'ChainExpression':
      return isEnvObject(node.expression, resolve, depth + 1)
    case 'MemberExpression': {
      if (node.computed || node.property?.name !== 'env') return false
      const object = node.object
      if (object?.type === 'Identifier' && object.name === 'process') return true
      if (object?.type === 'MetaProperty') return true
      // `globalThis.process.env`, and any member chain ending `.process.env`.
      return object?.type === 'MemberExpression' && !object.computed && object.property?.name === 'process'
    }
    case 'Identifier': {
      const initialiser = resolve(node)
      // A destructured binding is a VALUE out of the env, never the env object.
      if (!initialiser || initialiser.destructuredFromEnv) return false
      return isEnvObject(initialiser, resolve, depth + 1)
    }
    default:
      return false
  }
}

/** Calls that hand their argument straight back as a string. `''.trim()` is
 * still `''`, so a wrapper does not make a blank safe — it only makes it
 * invisible to a detector that stops at the call. */
const PASS_THROUGH_CALLEES = new Set(['String'])

/**
 * Every environment knob whose value can reach `node`, as names — `'*'` where
 * the name is not statically known. Empty when none can.
 *
 * A LIST, not a single name, because `Number(process.env.A ?? process.env.B)`
 * has two: an allowlisted `A` must not silence an undeclared `B` at the same
 * site.
 */
function envKnobNames(node, resolve, depth = 0) {
  if (!node || depth > 8) return []
  switch (node.type) {
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'ChainExpression':
      return envKnobNames(node.expression, resolve, depth + 1)
    case 'LogicalExpression':
      // `process.env.X ?? '5'`, `'5' || process.env.X`, and both-env. What
      // matters is that an env value can reach the parse from EITHER side.
      return [
        ...envKnobNames(node.left, resolve, depth + 1),
        ...envKnobNames(node.right, resolve, depth + 1),
      ]
    case 'ConditionalExpression':
      return [
        ...envKnobNames(node.consequent, resolve, depth + 1),
        ...envKnobNames(node.alternate, resolve, depth + 1),
      ]
    case 'TemplateLiteral':
      return node.expressions.flatMap((expression) => envKnobNames(expression, resolve, depth + 1))
    case 'CallExpression': {
      // `process.env.X?.trim()` — a common idiom in this tree. The receiver is
      // what carries the value.
      if (node.callee?.type === 'MemberExpression') {
        return envKnobNames(node.callee.object, resolve, depth + 1)
      }
      // `String(process.env.X)`.
      if (node.callee?.type === 'Identifier' && PASS_THROUGH_CALLEES.has(node.callee.name)) {
        return envKnobNames(node.arguments?.[0], resolve, depth + 1)
      }
      return []
    }
    case 'MemberExpression': {
      if (!isEnvObject(node.object, resolve)) return []
      if (!node.computed) return [node.property?.name ?? '*']
      if (node.property?.type === 'Literal' && typeof node.property.value === 'string') {
        return [node.property.value]
      }
      // `process.env[name]` — the shape every GENERIC helper uses, and the one
      // a name-keyed detector cannot see at all.
      return ['*']
    }
    case 'Identifier': {
      const initialiser = resolve(node)
      if (!initialiser) return []
      if (initialiser.destructuredFromEnv) return [initialiser.knob]
      return envKnobNames(initialiser, resolve, depth + 1)
    }
    default:
      return []
  }
}

const PARSING_CALLEES = new Set(['Number', 'parseInt', 'parseFloat'])

/** `Number.parseInt` / `Number.parseFloat` — a MemberExpression callee, which
 * an Identifier-only check would miss. This repo already uses that spelling at
 * production sites, so it must be covered as well as the bare one. */
function isNumberNamespaceParse(callee) {
  return (
    callee?.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object?.type === 'Identifier' &&
    callee.object.name === 'Number' &&
    (callee.property?.name === 'parseInt' || callee.property?.name === 'parseFloat')
  )
}

/**
 * Repo-relative, POSIX-separated, so one allowlist works on every checkout and
 * on Windows. Written by hand rather than with `path.relative` because this
 * module is imported by both the ESLint config and a `node --test` suite, and
 * the second passes synthetic filenames that are not on disk.
 */
export function repoRelative(cwd, filename) {
  const root = String(cwd ?? '').replace(/\\/g, '/').replace(/\/$/, '')
  const full = String(filename ?? '').replace(/\\/g, '/')
  return root && full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full
}

/**
 * The rule. `declared` is the allowlist: entries are `{ file, knob }` where
 * `file` is a repo-relative POSIX path and `knob` is the variable name or `'*'`
 * for a computed read. An allowlisted site is silent; anything else is an error.
 *
 * The allowlist is deliberately NOT a per-line disable comment. A disable
 * comment says "this one is fine" at the site and nowhere records WHY, so the
 * measurement of what a blank costs there would live in no file at all.
 *
 * `root` is injectable for the test suite only; production callers take the
 * module-relative default.
 */
export function createNoBareEnvNumberRule(declared, root = REPO_ROOT) {
  const allowed = new Set(declared.map((entry) => `${entry.file}::${entry.knob}`))
  return {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Disallow parsing an environment variable with bare Number/parseInt/parseFloat/unary-+.',
      },
      messages: {
        bare:
          "Bare numeric parse of `{{knob}}`: a dangling `{{knob}}=` is '' and `Number('')` is 0, which is finite and passes `>= 0`. Use `envNumber()` (server/src/envNumber.ts) with explicit bounds, or declare this site in scripts/env-knob-declarations.mjs with what a blank costs here.",
      },
      schema: [],
    },
    create(context) {
      const filename = context.filename ?? context.getFilename()
      const relative = repoRelative(root, filename)

      // Alias/destructure resolution through ESLint's own scope analysis —
      // what a regex cannot do. `resolving` (plus the depth caps) bounds the
      // walk: `const a = b` and `const b = a` would otherwise recurse for ever.
      const resolving = new Set()
      const resolve = (identifier) => {
        let scope = context.sourceCode.getScope(identifier)
        let variable = null
        while (scope && !variable) {
          variable = scope.variables.find((candidate) => candidate.name === identifier.name) ?? null
          scope = scope.upper
        }
        const definition = variable?.defs?.[0]
        if (!definition || definition.type !== 'Variable') return null
        const declarator = definition.node
        if (resolving.has(declarator)) return null

        if (declarator.id?.type === 'ObjectPattern') {
          // `const { KNOB } = process.env`, and — because the real resolver is
          // passed down — also `const e = process.env; const { KNOB } = e`.
          resolving.add(declarator)
          const fromEnv = isEnvObject(declarator.init, resolve)
          resolving.delete(declarator)
          if (!fromEnv) return null
          const property = declarator.id.properties.find(
            (candidate) =>
              candidate.type === 'Property' &&
              (candidate.value?.name === identifier.name || candidate.key?.name === identifier.name),
          )
          if (!property) return null
          const knob =
            property.key?.type === 'Identifier'
              ? property.key.name
              : property.key?.type === 'Literal'
                ? String(property.key.value)
                : '*'
          return { destructuredFromEnv: true, knob }
        }

        if (declarator.init) return declarator.init
        // `let raw; raw = process.env.X` — declared without an initialiser and
        // assigned once. Only ONE write is followed: with two, which assignment
        // reaches the parse is a flow question a syntax rule cannot answer, and
        // guessing would produce a report naming the wrong knob.
        const writes = (variable.references ?? []).filter((reference) => reference.writeExpr)
        return writes.length === 1 ? writes[0].writeExpr : null
      }

      const report = (node, argument) => {
        const seen = new Set()
        for (const knob of envKnobNames(argument, resolve)) {
          if (seen.has(knob)) continue
          seen.add(knob)
          if (allowed.has(`${relative}::${knob}`)) continue
          context.report({ node, messageId: 'bare', data: { knob } })
        }
      }

      return {
        CallExpression(node) {
          const callee = node.callee
          const bare = callee?.type === 'Identifier' && PARSING_CALLEES.has(callee.name)
          if (!bare && !isNumberNamespaceParse(callee)) return
          report(node, node.arguments?.[0])
        },
        UnaryExpression(node) {
          if (node.operator !== '+') return
          report(node, node.argument)
        },
      }
    },
  }
}
