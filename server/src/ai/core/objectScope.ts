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

/**
 * Server copy of the per-diagram scope rule in `src/lib/diagrams/objectScope.ts`
 * (the server does not import client source). Same order, first match wins:
 * diagram override → C4 boundary rule (drill-down `parentObjectId`) → the
 * object's default scope → internal. `src/lib/diagrams/objectScope.test.ts`
 * runs ONE case table through both copies, so a drift between them goes red.
 */
export type ObjectScope = 'internal' | 'external'
export type ScopeSource = 'diagram' | 'boundary' | 'default'

interface ScopeObject { id: string; parentId?: string; scope?: string }
interface ScopeDiagram { parentObjectId?: unknown; objectScopes?: unknown }

const MAX_DEPTH = 64

export function resolveObjectScope(
  object: ScopeObject,
  diagram: ScopeDiagram,
  objectById: (id: string) => ScopeObject | undefined,
): { scope: ObjectScope; source: ScopeSource } {
  const overrides = diagram.objectScopes as Record<string, unknown> | undefined
  const override = overrides?.[object.id]
  if (override === 'internal' || override === 'external') return { scope: override, source: 'diagram' }
  const focusId = typeof diagram.parentObjectId === 'string' ? diagram.parentObjectId : undefined
  if (focusId && !insideFocus(object, focusId, objectById)) return { scope: 'external', source: 'boundary' }
  return { scope: object.scope === 'external' ? 'external' : 'internal', source: 'default' }
}

/** True only when the object is PROVABLY the focus or nested under it; an
 * ancestor missing from the model, or a parent cycle, counts as outside (the
 * client's reason is on `isInsideFocus`). */
function insideFocus(object: ScopeObject, focusId: string, objectById: (id: string) => ScopeObject | undefined): boolean {
  if (object.id === focusId) return true
  let parent = object.parentId
  for (let depth = 0; parent && depth < MAX_DEPTH; depth++) {
    if (parent === focusId) return true
    parent = objectById(parent)?.parentId
  }
  return false
}
