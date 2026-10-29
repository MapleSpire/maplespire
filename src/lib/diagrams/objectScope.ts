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

import type { C4Object, Diagram, ObjectScope } from '../../types'

/**
 * Internal/external is a property of an object ON A DIAGRAM, not of the model
 * object: the same system is the subject of its own container diagram and
 * context on its neighbour's. Resolution, first match wins:
 *
 *   1. the diagram's explicit override (`diagram.objectScopes[id]`);
 *   2. the C4 boundary rule — on a drill-down diagram (`parentObjectId` set),
 *      an object that is neither the focus nor nested under it is external;
 *   3. the object's default scope (`C4Object.scope`);
 *   4. internal.
 *
 * The boundary rule never makes anything internal, so an object whose default
 * is external stays external everywhere unless a diagram overrides it.
 */
export type ScopeDiagram = Pick<Diagram, 'parentObjectId' | 'objectScopes'>

/**
 * Parent lookup for the boundary rule over RESIDENT objects:
 * - a parent id when the object is resident and nested;
 * - `null` when the object is resident and has no parent (a proven root);
 * - `undefined` when the object is not resident (paged / off-window).
 */
export type ParentOf = (id: string) => string | null | undefined

export type ScopeSource = 'diagram' | 'boundary' | 'default'

export interface ResolvedScope {
  scope: ObjectScope
  source: ScopeSource
}

/** Depth cap for the ancestor walk: guards a parentId cycle in corrupted data. */
const MAX_DEPTH = 64

/**
 * True only when the object is PROVABLY the focus or nested under it.
 *
 * Inside must be proven, not outside: the walk needs ancestors, and which
 * ancestors are resident differs by tier (the server-booted editor holds only
 * the diagram's own objects; share bake and the AI tools see the whole model).
 * With "unknown ⇒ inside", a sibling container whose parent system was not
 * loaded drew internal in one tier and external in the others. With "unknown ⇒
 * outside" the common cases — the focus's direct children (`parentId ===
 * focus`) and anything else — agree in every tier; tiers can still differ only
 * for an object two or more levels under the focus whose intermediate parent
 * is neither on the diagram nor resident.
 */
export function isInsideFocus(
  object: Pick<C4Object, 'id' | 'parentId'>,
  focusId: string,
  parentOf?: ParentOf,
): boolean {
  if (object.id === focusId) return true
  let parent = object.parentId
  for (let depth = 0; parent && depth < MAX_DEPTH; depth++) {
    if (parent === focusId) return true
    const next = parentOf?.(parent)
    if (!next) return false // a proven root, or an ancestor we cannot see
    parent = next
  }
  return false // no parent, or a capped walk (parent cycle)
}

export function resolveObjectScope(
  object: Pick<C4Object, 'id' | 'scope' | 'parentId'>,
  diagram: ScopeDiagram | undefined,
  parentOf?: ParentOf,
): ResolvedScope {
  const override = diagram?.objectScopes?.[object.id]
  if (override === 'internal' || override === 'external') return { scope: override, source: 'diagram' }
  const focusId = diagram?.parentObjectId
  if (focusId && !isInsideFocus(object, focusId, parentOf)) return { scope: 'external', source: 'boundary' }
  return { scope: object.scope === 'external' ? 'external' : 'internal', source: 'default' }
}

/** A `ParentOf` over a resident-object getter. */
export function parentLookup(get: (id: string) => Pick<C4Object, 'parentId'> | undefined): ParentOf {
  return (id) => {
    const o = get(id)
    if (!o) return undefined
    return o.parentId ?? null
  }
}

/** The display copy of an object for one diagram, with `scope` replaced by its
 * effective value. Returns the same reference when nothing changes, so memoised
 * consumers (engine diffing, useShallow) see no churn. */
export function withEffectiveScope<T extends Pick<C4Object, 'id' | 'scope' | 'parentId'>>(
  object: T,
  diagram: ScopeDiagram | undefined,
  parentOf?: ParentOf,
): T {
  const { scope } = resolveObjectScope(object, diagram, parentOf)
  return scope === object.scope ? object : { ...object, scope }
}
