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

import type { C4Object, Group } from '../../types'
import type { ModelObjectFilter } from './types'
import { canonicalTechnologyId } from '../technologies/canonicalIds'
import { canonicalTagId } from '../tags/canonicalIds'

type GovernedUsage = { technologyId?: string }
type TeamOwnedObject = C4Object & { ownerTeamIds?: string[]; teamIds?: string[] }
type TechnologyEntity = (C4Object | Group) & { technologyUsages?: Record<string, GovernedUsage> }
type TagEntity = C4Object | Group

const anySelected = (selected: readonly string[] | undefined, actual: readonly string[]): boolean =>
  !selected?.length || selected.some((value) => actual.includes(value))

/** True when an intrinsically object-only facet is active. Technology applies
 * to objects and groups; hierarchy ancestors remain visible as context. */
export function hasObjectOnlyFilter(filter: ModelObjectFilter): boolean {
  return !!(
    filter.scope || filter.status || filter.statuses?.length ||
    filter.hasDescription !== undefined ||
    filter.teamIds?.length
  )
}

export function matchesTechnologyFilter(
  entity: TechnologyEntity,
  selectedTechnologyIds: readonly string[] | undefined,
): boolean {
  const actualTechnologyIds = Object.values(entity.technologyUsages ?? {})
    .map((usage) => usage?.technologyId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const actualCanonicalIds = actualTechnologyIds.map(canonicalTechnologyId)
  const selectedCanonicalIds = selectedTechnologyIds?.map(canonicalTechnologyId)
  return anySelected(selectedCanonicalIds, actualCanonicalIds)
}

export function matchesTagFilter(
  entity: TagEntity,
  selectedTagIds: readonly string[] | undefined,
): boolean {
  const actualCanonicalIds = Object.keys(entity.tagAssignments ?? {}).map(canonicalTagId)
  const selectedCanonicalIds = selectedTagIds?.map(canonicalTagId)
  return anySelected(selectedCanonicalIds, actualCanonicalIds)
}

export function isModelObjectFilterActive(filter: ModelObjectFilter): boolean {
  return !!(
    filter.types?.length || hasObjectOnlyFilter(filter) ||
    filter.tagIds?.length ||
    filter.technologyIds?.length ||
    filter.inDiagram !== undefined
  )
}

/** Reusable facet contract. Values within a facet are OR'ed; every populated
 * facet is AND'ed with the others. Technology and team comparisons use IDs only. */
export function matchesModelObjectFilter(
  object: C4Object,
  filter: ModelObjectFilter,
  context: { diagramCount?: number; domainId?: string | null } = {}
): boolean {
  if (!anySelected(filter.types, [object.type])) return false

  const statuses = [...(filter.statuses ?? []), ...(filter.status ? [filter.status] : [])]
  if (!anySelected(statuses, object.status ? [object.status] : [])) return false
  if (filter.scope && object.scope !== filter.scope) return false

  if (filter.hasDescription !== undefined) {
    const hasDescription = !!object.description?.trim()
    if (hasDescription !== filter.hasDescription) return false
  }
  if (!matchesTagFilter(object, filter.tagIds)) return false

  const teamObject = object as TeamOwnedObject
  const actualTeams = [...(teamObject.ownerTeamIds ?? []), ...(teamObject.teamIds ?? [])]
  if (!anySelected(filter.teamIds, actualTeams)) return false

  if (!matchesTechnologyFilter(object, filter.technologyIds)) return false

  if (context.domainId && object.domainId !== context.domainId) return false
  if (filter.inDiagram !== undefined) {
    const inDiagram = (context.diagramCount ?? 0) > 0
    if (inDiagram !== filter.inDiagram) return false
  }
  return true
}
