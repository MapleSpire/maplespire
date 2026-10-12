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

import type { C4Object, Diagram } from '../../types'
import type { ExportBundle } from './types'
import { orderedTechnologyUsages } from '../technologyUsage'

/**
 * Export as a Mermaid C4 diagram (https://mermaid.js.org/syntax/c4.html).
 * A .mmd file holds ONE diagram: diagram scope emits that diagram
 * (C4Context / C4Container / C4Component by its level); landscape scope emits
 * the whole model as a single C4Context, with containers nested inside their
 * system's System_Boundary and components inside a Container_Boundary.
 *
 * Type mapping: actor → Person(_Ext) · system → System(_Ext) ·
 * store → SystemDb/ContainerDb · app → Container · component → Component.
 */

const esc = (s: string) => s.replace(/"/g, '”').replace(/\r?\n/g, ' ')
const q = (s: string) => `"${esc(s)}"`

/** Mermaid aliases must be plain identifiers; derive from ids (already short). */
function aliasFor(id: string): string {
  const a = id.replace(/[^a-zA-Z0-9_]/g, '_')
  return /^[a-zA-Z_]/.test(a) ? a : `e_${a}`
}

function technologyOf(o: C4Object): string {
  return orderedTechnologyUsages(o.technologyUsages, o.technologyUsageOrder).map((usage) => usage.snapshot.name).join(', ')
}

/** One element statement. `topLevel` picks System vs Container flavours for stores. */
function elementLine(o: C4Object, topLevel: boolean): string {
  const alias = aliasFor(o.id)
  const ext = o.scope === 'external'
  const desc = o.description ?? ''
  const tech = technologyOf(o)
  switch (o.type) {
    case 'actor':
      return `${ext ? 'Person_Ext' : 'Person'}(${alias}, ${q(o.name)}${desc ? `, ${q(desc)}` : ''})`
    case 'system':
      return `${ext ? 'System_Ext' : 'System'}(${alias}, ${q(o.name)}${desc ? `, ${q(desc)}` : ''})`
    case 'store':
      return `${topLevel ? (ext ? 'SystemDb_Ext' : 'SystemDb') : (ext ? 'ContainerDb_Ext' : 'ContainerDb')}(${alias}, ${q(o.name)}, ${q(tech)}${desc ? `, ${q(desc)}` : ''})`
    case 'component':
      return `Component(${alias}, ${q(o.name)}, ${q(tech)}${desc ? `, ${q(desc)}` : ''})`
    default:
      return `${ext ? 'Container_Ext' : 'Container'}(${alias}, ${q(o.name)}, ${q(tech)}${desc ? `, ${q(desc)}` : ''})`
  }
}

export function buildMermaid(bundle: ExportBundle, scope: 'landscape' | 'diagram'): string {
  const activeDiagram =
    scope === 'diagram'
      ? bundle.diagrams.find((d) => d.id === bundle.activeDiagramId) ?? bundle.diagrams[0] ?? null
      : null
  return activeDiagram ? buildDiagramMermaid(bundle, activeDiagram) : buildLandscapeMermaid(bundle)
}

/** The whole model as one C4Context with nested boundaries. */
function buildLandscapeMermaid(bundle: ExportBundle): string {
  const objects = bundle.objects
  const objById = new Map(objects.map((o) => [o.id, o]))
  const childrenOf = new Map<string, C4Object[]>()
  const topLevel: C4Object[] = []
  for (const o of objects) {
    if (o.parentId && objById.has(o.parentId)) {
      const list = childrenOf.get(o.parentId) ?? []
      list.push(o)
      childrenOf.set(o.parentId, list)
    } else {
      topLevel.push(o)
    }
  }

  const lines: string[] = ['C4Context', `    title ${esc(bundle.landscapeName)}`]
  const push = (depth: number, s: string) => lines.push('    '.repeat(depth) + s)

  const emitTree = (o: C4Object, depth: number): void => {
    const kids = childrenOf.get(o.id) ?? []
    if (kids.length === 0) {
      push(depth, elementLine(o, depth === 1))
      return
    }
    // Parent with children → the parent becomes a boundary around them.
    const boundary = o.type === 'system' ? 'System_Boundary' : 'Container_Boundary'
    push(depth, `${boundary}(${aliasFor(o.id)}, ${q(o.name)}) {`)
    for (const kid of kids) emitTree(kid, depth + 1)
    push(depth, '}')
  }
  for (const o of topLevel) emitTree(o, 1)

  for (const c of bundle.connections) {
    if (!objById.has(c.fromId) || !objById.has(c.toId)) continue
    push(1, `Rel(${aliasFor(c.fromId)}, ${aliasFor(c.toId)}${c.label ? `, ${q(c.label)}` : ', ""'})`)
  }
  return lines.join('\n') + '\n'
}

/** One diagram, at its own C4 level, boundaries from parent objects present in it. */
function buildDiagramMermaid(bundle: ExportBundle, diagram: Diagram): string {
  const header = diagram.type === 'container' ? 'C4Container' : diagram.type === 'component' ? 'C4Component' : 'C4Context'
  const objById = new Map(bundle.objects.map((o) => [o.id, o]))
  const members = diagram.objectIds.map((id) => objById.get(id)).filter((o): o is C4Object => !!o)
  const memberIds = new Set(members.map((o) => o.id))

  const lines: string[] = [header, `    title ${esc(diagram.name)}`]
  const push = (depth: number, s: string) => lines.push('    '.repeat(depth) + s)

  // Group members under a parent that is ALSO on the diagram (boundary); the
  // diagram's own parent object (drill-down focus) becomes a boundary too, even
  // when it isn't a member itself.
  const boundaryChildren = new Map<string, C4Object[]>()
  const loose: C4Object[] = []
  for (const o of members) {
    const parentOnDiagram = o.parentId && (memberIds.has(o.parentId) || o.parentId === diagram.parentObjectId)
    if (parentOnDiagram) {
      const list = boundaryChildren.get(o.parentId!) ?? []
      list.push(o)
      boundaryChildren.set(o.parentId!, list)
    } else {
      loose.push(o)
    }
  }

  for (const o of loose) {
    const kids = boundaryChildren.get(o.id)
    if (kids) {
      const boundary = o.type === 'system' ? 'System_Boundary' : 'Container_Boundary'
      push(1, `${boundary}(${aliasFor(o.id)}, ${q(o.name)}) {`)
      for (const kid of kids) push(2, elementLine(kid, false))
      push(1, '}')
      boundaryChildren.delete(o.id)
    } else {
      push(1, elementLine(o, true))
    }
  }
  // Boundaries whose parent object is NOT itself on the diagram (e.g. the
  // drill-down focus): emit them as named boundaries around their children.
  for (const [parentId, kids] of boundaryChildren) {
    const parent = objById.get(parentId)
    const boundary = parent?.type === 'system' ? 'System_Boundary' : 'Container_Boundary'
    push(1, `${boundary}(${aliasFor(parentId)}, ${q(parent?.name ?? 'Boundary')}) {`)
    for (const kid of kids) push(2, elementLine(kid, false))
    push(1, '}')
  }

  const connById = new Map(bundle.connections.map((c) => [c.id, c]))
  for (const cid of diagram.connectionIds) {
    const c = connById.get(cid)
    if (!c || !memberIds.has(c.fromId) || !memberIds.has(c.toId)) continue
    push(1, `Rel(${aliasFor(c.fromId)}, ${aliasFor(c.toId)}${c.label ? `, ${q(c.label)}` : ', ""'})`)
  }
  return lines.join('\n') + '\n'
}
