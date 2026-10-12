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

import type { C4Object, Connection } from '../types'
import { canonicalTechnologyId } from '../lib/technologies/canonicalIds'
import { orderedTechnologyUsages } from '../lib/technologyUsage'
import { orderedOwnerAssignments } from '../lib/owners'

export type ManagedPerspective = 'technology' | 'status' | 'teams'

export interface FacetValue {
  id: string
  label: string
}

export interface FacetPresentation {
  outline: FacetValue | null
  labels: FacetValue[]
  overflowCount: number
}

export interface FacetFocusMembership {
  resolved: boolean
  matchingObjectIds: ReadonlySet<string>
  connectedObjectIds: ReadonlySet<string>
}

type FacetCarrier = Pick<
  C4Object,
  'technologyUsages' | 'technologyUsageOrder' | 'ownerAssignments' | 'ownerAssignmentOrder' | 'ownerTeamIds'
> & { status?: C4Object['status'] }

/** Values are derived only from resident diagram objects; the global catalog is
 * never scanned or hydrated for the perspective bar. */
export function objectFacetValues(object: C4Object, kind: ManagedPerspective): FacetValue[] {
  return facetValues(object, kind)
}

export function facetValues(entity: FacetCarrier, kind: ManagedPerspective): FacetValue[] {
  if (kind === 'status') {
    const status = entity.status ?? 'live'
    return [{ id: status, label: status }]
  }
  if (kind === 'teams') {
    return orderedOwnerAssignments(entity).map((assignment) => ({
      id: assignment.id,
      label: assignment.name,
    }))
  }
  const seen = new Set<string>()
  return orderedTechnologyUsages(entity.technologyUsages, entity.technologyUsageOrder)
    .flatMap((usage): FacetValue[] => {
      const id = canonicalTechnologyId(usage.technologyId)
      if (!id || seen.has(id)) return []
      seen.add(id)
      return [{ id, label: usage.snapshot.name }]
    })
}

export function objectHasFacetValue(object: C4Object, kind: ManagedPerspective, valueId: string): boolean {
  return objectFacetValues(object, kind).some((value) => value.id === valueId)
}

export function collectDiagramFacetValues(
  entities: readonly FacetCarrier[],
  kind: ManagedPerspective,
): FacetValue[] {
  const values = new Map<string, FacetValue>()
  for (const entity of entities) {
    for (const value of facetValues(entity, kind)) {
      if (!values.has(value.id)) values.set(value.id, value)
    }
  }
  return [...values.values()].sort((left, right) => left.label.localeCompare(right.label))
}

export function resolveHiddenFacetState(
  object: FacetCarrier,
  kind: ManagedPerspective,
  hiddenIds: ReadonlySet<string>,
  hoveredId: string | null,
): { hidden: boolean; temporarilyRevealed: boolean } {
  const values = facetValues(object, kind)
  const temporarilyRevealed = Boolean(
    hoveredId && hiddenIds.has(hoveredId) && values.some((value) => value.id === hoveredId),
  )
  if (temporarilyRevealed) return { hidden: false, temporarilyRevealed: true }
  return {
    hidden: values.some((value) => hiddenIds.has(value.id)),
    temporarilyRevealed: false,
  }
}

export function resolveFacetFocusMembership(
  objects: readonly C4Object[],
  connections: readonly (Pick<Connection, 'fromId' | 'toId'> & Partial<Connection>)[],
  kind: ManagedPerspective,
  focusedId: string | null,
): FacetFocusMembership {
  const matchingObjectIds = new Set<string>()
  const connectedObjectIds = new Set<string>()
  if (!focusedId) return { resolved: true, matchingObjectIds, connectedObjectIds }
  for (const object of objects) {
    if (objectHasFacetValue(object, kind, focusedId)) matchingObjectIds.add(object.id)
  }
  const matchingConnection = connections.some((connection) => (
    facetValues(connection, kind).some((value) => value.id === focusedId)
  ))
  if (matchingObjectIds.size === 0 && !matchingConnection) {
    return { resolved: false, matchingObjectIds, connectedObjectIds }
  }
  const objectIds = new Set(objects.map((object) => object.id))
  for (const connection of connections) {
    if (matchingObjectIds.has(connection.fromId) && objectIds.has(connection.toId)) {
      connectedObjectIds.add(connection.toId)
    }
    if (matchingObjectIds.has(connection.toId) && objectIds.has(connection.fromId)) {
      connectedObjectIds.add(connection.fromId)
    }
  }
  return { resolved: true, matchingObjectIds, connectedObjectIds }
}

export function resolvePinnedFacetPresentation(
  object: C4Object,
  kind: ManagedPerspective,
  pinnedIds: readonly string[],
  maxLabels = 3,
): FacetPresentation {
  const values = objectFacetValues(object, kind)
  const byId = new Map(values.map((value) => [value.id, value]))
  const pinned = new Set(pinnedIds)
  const matching = values.filter((value) => pinned.has(value.id))
  let outline: FacetValue | null = null
  for (let index = pinnedIds.length - 1; index >= 0; index -= 1) {
    const value = byId.get(pinnedIds[index])
    if (value) {
      outline = value
      break
    }
  }
  return {
    outline,
    labels: matching.slice(0, maxLabels),
    overflowCount: Math.max(0, matching.length - maxLabels),
  }
}

/** Source-first connection inheritance, overridden by hover/focus/latest pin. */
export function resolveConnectionPerspectiveFacet(
  from: C4Object | undefined,
  to: C4Object | undefined,
  kind: ManagedPerspective,
  interactions: { hoveredId: string | null; focusedId: string | null; pinnedIds: readonly string[] },
  connection: Connection | undefined = undefined,
): FacetValue | null {
  const endpoints = [from, to].filter((object): object is C4Object => Boolean(object))
  const find = (id: string | null) => id
    ? [...(connection ? [connection] : []), ...endpoints]
      .flatMap((entity) => facetValues(entity, kind))
      .find((value) => value.id === id) ?? null
    : null
  return find(interactions.hoveredId)
    ?? find(interactions.focusedId)
    ?? [...interactions.pinnedIds].reverse().map(find).find(Boolean)
    ?? (from ? objectFacetValues(from, kind)[0] || null : null)
    ?? (to ? objectFacetValues(to, kind)[0] || null : null)
}
