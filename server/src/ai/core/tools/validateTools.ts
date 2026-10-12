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

import { z } from 'zod'
import { defineAiTool, type AiToolDef } from '../toolRegistry.js'
import { nameTypeWarning } from '../c4Rules.js'
import { objects, connections, nameOf } from './shapes.js'

/**
 * C4 structure lint — the AI's self-check companion to
 * audit_model_completeness (completeness ≠ structure). Advisory by design:
 * it reads and reports; the AI fixes its OWN output and only PROPOSES fixes
 * for pre-existing human content (see c4Rules).
 */

interface Finding {
  kind: string
  message: string
  ids: string[]
}

export const validateTools: AiToolDef[] = [
  defineAiTool({
    name: 'validate_architecture',
    title: 'Validate C4 architecture structure',
    description:
      'C4 structure lint: nesting violations (components outside apps, containers parented to non-systems, cycles), duplicate sibling names, connection issues, name/type mismatches and diagram-type inconsistencies. Returns errors (fix them in content YOU created) and warnings (recommendations). Run it after building or editing, before reporting done.',
    mode: 'read',
    schema: z.object({}),
    execute: async (ctx) => {
      const m = await ctx.session.snapshot()
      const objs = Object.values(objects(m))
      const errors: Finding[] = []
      const warnings: Finding[] = []

      // ── Nesting rules ────────────────────────────────────────────────────
      for (const o of objs) {
        const parent = o.parentId ? objects(m)[o.parentId] : undefined
        if (o.type === 'component') {
          if (!o.parentId) {
            errors.push({ kind: 'component-without-parent', ids: [o.id], message: `component "${o.name}" has no parent app — set parentId` })
          } else if (parent?.type !== 'app') {
            errors.push({ kind: 'component-bad-parent', ids: [o.id], message: `component "${o.name}" is parented to a ${parent?.type ?? 'missing object'} — its parent must be an app` })
          }
        }
        if ((o.type === 'app' || o.type === 'store') && o.parentId && parent?.type !== 'system') {
          errors.push({ kind: 'container-bad-parent', ids: [o.id], message: `${o.type} "${o.name}" is parented to a ${parent?.type ?? 'missing object'} — its parent must be a system` })
        }
        if ((o.type === 'app' || o.type === 'store') && !o.parentId && (o.scope ?? 'internal') === 'internal') {
          warnings.push({ kind: 'container-without-parent', ids: [o.id], message: `${o.type} "${o.name}" has no parent system — containers usually live inside a system` })
        }
        // Cycles: walk up; if we come back to o.id the chain loops.
        const seen = new Set<string>()
        for (let p = o.parentId; p; p = objects(m)[p]?.parentId) {
          if (p === o.id) {
            errors.push({ kind: 'parent-cycle', ids: [o.id], message: `"${o.name}" is part of a parentId cycle` })
            break
          }
          if (seen.has(p)) break
          seen.add(p)
        }
        const naming = nameTypeWarning(o.name ?? '', o.type)
        if (naming) warnings.push({ kind: 'name-type-mismatch', ids: [o.id], message: naming })
      }

      // ── Duplicate sibling names (same parent + same name) ────────────────
      const byParentAndName = new Map<string, string[]>()
      for (const o of objs) {
        const key = `${o.parentId ?? ''}::${(o.name ?? '').trim().toLowerCase()}`
        byParentAndName.set(key, [...(byParentAndName.get(key) ?? []), o.id])
      }
      for (const [key, ids] of byParentAndName) {
        const name = key.split('::')[1]
        if (ids.length > 1 && name) {
          errors.push({ kind: 'duplicate-sibling-name', ids, message: `${ids.length} siblings share the name "${name}" — rename to disambiguate` })
        }
      }

      // ── Connections ──────────────────────────────────────────────────────
      for (const c of Object.values(connections(m))) {
        const from = objects(m)[c.fromId]
        const to = objects(m)[c.toId]
        if (!from || !to) {
          errors.push({ kind: 'connection-dangling', ids: [c.id], message: `connection ${c.id} references a missing object` })
          continue
        }
        if (from.parentId === c.toId || to.parentId === c.fromId) {
          errors.push({ kind: 'connection-parent-child', ids: [c.id], message: `connection between "${from.name}" and "${to.name}" links a parent to its own child — nesting already expresses containment` })
        }
        if ((c.kind ?? 'direct') === 'direct' && !c.label?.trim()) {
          warnings.push({ kind: 'connection-unlabeled', ids: [c.id], message: `connection ${nameOf(m, c.fromId)} → ${nameOf(m, c.toId)} has no label — add a verb phrase` })
        }
      }

      // ── Diagrams ─────────────────────────────────────────────────────────
      for (const d of Object.values(m.diagrams)) {
        const type = String(d.meta.type ?? 'context')
        const ids = (d.meta.objectIds as string[] | undefined) ?? []
        const dName = String(d.meta.name ?? d.id)
        if (ids.length === 0) {
          warnings.push({ kind: 'diagram-empty', ids: [d.id], message: `diagram "${dName}" is empty` })
        }
        if ((type === 'container' || type === 'component') && !d.meta.parentObjectId) {
          warnings.push({ kind: 'diagram-no-parent', ids: [d.id], message: `${type} diagram "${dName}" has no parentObjectId — it usually zooms into an object` })
        }
        if (type === 'context' && ids.some((oid) => objects(m)[oid]?.type === 'component')) {
          warnings.push({ kind: 'diagram-level-mismatch', ids: [d.id], message: `context diagram "${dName}" shows components — they belong on component diagrams` })
        }
        if (type === 'container' && d.meta.parentObjectId) {
          const children = objs.filter((o) => o.parentId === d.meta.parentObjectId).map((o) => o.id)
          const shown = new Set(ids)
          const missing = children.filter((cid) => !shown.has(cid))
          if (children.length > 0 && missing.length > 0) {
            warnings.push({
              kind: 'diagram-incomplete',
              ids: [d.id, ...missing],
              message: `container diagram "${dName}" is missing ${missing.length} container(s) of its system: ${missing.map((cid) => nameOf(m, cid)).join(', ')}`,
            })
          }
        }
      }

      return {
        ok: errors.length === 0,
        summary: { errors: errors.length, warnings: warnings.length },
        errors,
        warnings,
      }
    },
  }),
]
