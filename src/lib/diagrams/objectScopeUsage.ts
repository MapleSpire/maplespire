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
import { resolveObjectScope, type ParentOf } from './objectScope'

/**
 * Derived scope usage of one object across the whole model: on how many of the
 * diagrams it appears on (`total` — the same membership as the "In diagrams"
 * count) does it resolve external. Model-wide pages show this next to the
 * object's DEFAULT scope ("External in N of M diagrams").
 *
 * Reads only registry-level fields — `objectIds`, `parentObjectId` and
 * `objectScopes` are all denormalised into the registry DiagramMeta (see
 * `buildMeta`), so layout-less stubs of non-active diagrams answer it without
 * loading their DiagramDocs. The server tier computes the same numbers in SQL
 * (`server/src/readModel/objectScopeUsage.ts`); this module's test and the
 * server's `objectScopeUsage.integration.test.ts` pin the same cases.
 */
export interface ObjectScopeUsage {
  external: number
  total: number
}

export type ScopeUsageDiagram = Pick<Diagram, 'objectIds' | 'parentObjectId' | 'objectScopes'>
type ScopeUsageObject = Pick<C4Object, 'id' | 'scope' | 'parentId'>

/** Scope usage of ONE object over the diagrams that show it (the caller's
 * membership index — e.g. `DiagramIndex.objectToDiagramIds` — so a page of
 * rows costs its own memberships, not a pass over every diagram). */
export function scopeUsageOf(
  object: ScopeUsageObject,
  diagramsShowingIt: Iterable<ScopeUsageDiagram>,
  parentOf: ParentOf,
): ObjectScopeUsage {
  const usage = { external: 0, total: 0 }
  for (const diagram of diagramsShowingIt) {
    usage.total += 1
    if (resolveObjectScope(object, diagram, parentOf).scope === 'external') usage.external += 1
  }
  return usage
}
