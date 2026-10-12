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

import type { C4Object, Connection } from '../../types'

/**
 * Model Viewer level queries — the pure derivation layer behind the automatic
 * grid view (design kit `ui_kits/model-viewer/mv-data.jsx`, mapped onto the
 * real model): C4 levels come from `C4Object.parentId` links, and only DIRECT
 * connections participate (`kind: 'lower'` rollups are a per-diagram artifact
 * maintained by syncLowerConnections — the viewer derives its own rollups from
 * the tree, so counting stored lower edges would double them).
 *
 * Everything here is synchronous over a snapshot `{ objects, connections }`
 * fetched once through the ModelQuery seam (see useViewerData) — keeping these
 * functions pure keeps them unit-testable and backend-agnostic.
 */

/** Root level sentinel: objects with no parent (the landscape/context level). */
export type ParentId = string | null

export interface ViewerModel {
  objectById: Map<string, C4Object>
  /** Direct children per parent id; key null = the context (root) level. */
  childrenByParent: Map<ParentId, C4Object[]>
  /** Server/Worker-projected direct counts preserve the expand affordance even
   * when lower levels are intentionally not resident in this render window. */
  childCountById: Map<string, number>
}

export function buildViewerModel(objects: C4Object[], childCounts: ReadonlyMap<string, number> = new Map()): ViewerModel {
  const objectById = new Map<string, C4Object>()
  for (const o of objects) objectById.set(o.id, o)
  const childrenByParent = new Map<ParentId, C4Object[]>()
  for (const o of objects) {
    // A dangling parentId (parent deleted / off-window) must not orphan the
    // object into an unreachable level — treat it as a root.
    const parent: ParentId = o.parentId && objectById.has(o.parentId) ? o.parentId : null
    let list = childrenByParent.get(parent)
    if (!list) {
      list = []
      childrenByParent.set(parent, list)
    }
    list.push(o)
  }
  return { objectById, childrenByParent, childCountById: new Map(childCounts) }
}

export function childrenOf(model: ViewerModel, parentId: ParentId): C4Object[] {
  return model.childrenByParent.get(parentId) ?? []
}

export function hasChildren(model: ViewerModel, id: string): boolean {
  return (model.childCountById.get(id) ?? model.childrenByParent.get(id)?.length ?? 0) > 0
}

/** The resolved parent of an object id (dangling parent links read as root). */
export function parentOf(model: ViewerModel, id: string): ParentId {
  const o = model.objectById.get(id)
  if (!o?.parentId) return null
  return model.objectById.has(o.parentId) ? o.parentId : null
}

/** Transitive descendant ids (children, grandchildren, …). */
export function descendants(model: ViewerModel, id: string): string[] {
  const out: string[] = []
  const walk = (x: string) => {
    for (const child of model.childrenByParent.get(x) ?? []) {
      out.push(child.id)
      walk(child.id)
    }
  }
  walk(id)
  return out
}

const isDirect = (c: Connection) => c.kind !== 'lower'

/** Connections drawn AT a level: both endpoints are direct children of
 * `parentId` (null = context). Direct only; self-loops excluded. */
export function connsAtLevel(model: ViewerModel, connections: Connection[], parentId: ParentId): Connection[] {
  return connections.filter((c) => {
    if (!isDirect(c) || c.fromId === c.toId) return false
    if (!model.objectById.has(c.fromId) || !model.objectById.has(c.toId)) return false
    return parentOf(model, c.fromId) === parentId && parentOf(model, c.toId) === parentId
  })
}

export interface ObjectConn {
  connection: Connection
  dir: 'in' | 'out'
  otherId: string
}

/** Every direct connection touching an object (panel + tile counts). */
export function connsForObject(connections: Connection[], id: string): ObjectConn[] {
  const out: ObjectConn[] = []
  for (const c of connections) {
    if (!isDirect(c) || c.fromId === c.toId) continue
    if (c.fromId === id) out.push({ connection: c, dir: 'out', otherId: c.toId })
    else if (c.toId === id) out.push({ connection: c, dir: 'in', otherId: c.fromId })
  }
  return out
}

/** Direct connections between two objects (either direction). */
export function directConns(connections: Connection[], a: string, b: string): Connection[] {
  return connections.filter(
    (c) => isDirect(c) && ((c.fromId === a && c.toId === b) || (c.fromId === b && c.toId === a))
  )
}

/** The deeper connections a level edge between `a` and `b` rolls up: direct
 * connections between the two objects' subtrees (self or descendant on each
 * side), excluding the a↔b edges themselves. */
export function lowerConns(model: ViewerModel, connections: Connection[], a: string, b: string): Connection[] {
  const da = new Set(descendants(model, a))
  const db = new Set(descendants(model, b))
  return connections.filter((c) => {
    if (!isDirect(c)) return false
    if ((c.fromId === a && c.toId === b) || (c.fromId === b && c.toId === a)) return false
    const fromA = c.fromId === a || da.has(c.fromId)
    const toB = c.toId === b || db.has(c.toId)
    const fromB = c.fromId === b || db.has(c.fromId)
    const toA = c.toId === a || da.has(c.toId)
    return (fromA && toB) || (fromB && toA)
  })
}

/** The C4 level shown INSIDE `parentId` (i18n key suffix): the root shows
 * systems/actors (context); inside a system, containers; deeper, components. */
export function levelKind(model: ViewerModel, parentId: ParentId): 'context' | 'container' | 'component' {
  if (parentId === null) return 'context'
  const parent = model.objectById.get(parentId)
  if (!parent) return 'context'
  return parent.type === 'system' ? 'container' : 'component'
}

/** Validate a drill path against the current model: every id must exist and be
 * a child of the previous entry — truncated at the first broken link (objects
 * can be deleted or reparented while the viewer is open). */
export function validatePath(model: ViewerModel, path: string[]): string[] {
  const out: string[] = []
  let parent: ParentId = null
  for (const id of path) {
    if (!model.objectById.has(id) || parentOf(model, id) !== parent) break
    out.push(id)
    parent = id
  }
  return out
}
