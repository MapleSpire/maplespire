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

import type { C4Object, Connection, Group } from '../../types'
import type { ModelQuery } from '../modelQuery/types'

/**
 * On-demand rollup for the connection panel: the deeper direct connections a
 * level edge a↔b summarizes — the same semantics as `lowerConns` in ./levels,
 * but composed from bounded ModelQuery primitives instead of a whole-model
 * snapshot. The viewer's level window deliberately carries only the current
 * level's objects and same-level edges (useViewerData → viewerLevel), so the
 * subtree data `lowerConns` needs is never resident; fetching it when the
 * panel opens keeps the level fetch bounded without lying in the panel.
 */

/** The subset of the seam the rollup needs — lets tests stub four methods. */
export type LowerConnsBackend = Pick<ModelQuery, 'descendants' | 'outgoing' | 'incoming' | 'lookupMany'>

export interface LowerConnsResult {
  connections: Connection[]
  /** Endpoint objects of the rolled-up connections (subtree members live
   * outside the level window, so the panel cannot resolve their names). */
  objectById: Map<string, C4Object>
  /** True when a subtree exceeded the fan-out ceiling: the rollup may be
   * incomplete and the panel must disclose it, never present it as total. */
  truncated: boolean
}

/** Per-side fan-out ceiling. Enumerating one side costs 2 seam calls per id
 * (in-memory on the resident/worker tiers; HTTP on the server tier), so this
 * bounds a panel open at ~2·LIMIT requests worst-case. C4 subtrees are
 * shallow — a system rarely holds more than a few dozen descendants. */
const ENUM_LIMIT = 60

const isC4Object = (entity: C4Object | Group): entity is C4Object => 'scope' in entity

/** Fetch the lower connections rolled up by the level edge between `a` and
 * `b`: direct connections between the two subtrees ({self} ∪ descendants on
 * each side), excluding the a↔b edges themselves. Every such edge has exactly
 * one endpoint on each side, so enumerating the incident edges of ONE side
 * (the smaller) sees them all. */
export async function fetchLowerConns(
  mq: LowerConnsBackend,
  a: string,
  b: string,
  enumLimit: number = ENUM_LIMIT,
): Promise<LowerConnsResult> {
  const [descA, descB] = await Promise.all([mq.descendants(a), mq.descendants(b)])
  const sideA = new Set([a, ...descA])
  const sideB = new Set([b, ...descB])
  const [enumSide, otherSide] = sideA.size <= sideB.size ? [sideA, sideB] : [sideB, sideA]
  const ids = [...enumSide].slice(0, enumLimit)
  const truncated = enumSide.size > ids.length

  const edgeLists = await Promise.all(ids.flatMap((id) => [mq.outgoing(id), mq.incoming(id)]))
  const matched = new Map<string, Connection>()
  for (const edges of edgeLists) {
    for (const { connection: c } of edges) {
      if (c.kind === 'lower' || c.fromId === c.toId) continue
      if ((c.fromId === a && c.toId === b) || (c.fromId === b && c.toId === a)) continue
      const spansBoth =
        (enumSide.has(c.fromId) && otherSide.has(c.toId)) || (enumSide.has(c.toId) && otherSide.has(c.fromId))
      if (spansBoth) matched.set(c.id, c)
    }
  }

  const endpointIds = [...new Set([...matched.values()].flatMap((c) => [c.fromId, c.toId]))]
  const entities = endpointIds.length ? await mq.lookupMany(endpointIds) : new Map<string, C4Object | Group>()
  const objectById = new Map<string, C4Object>()
  for (const [id, entity] of entities) if (isC4Object(entity)) objectById.set(id, entity)

  // Deterministic, reader-facing order (the seam gives no global edge order).
  const name = (id: string) => objectById.get(id)?.name ?? id
  const connections = [...matched.values()].sort(
    (x, y) =>
      name(x.fromId).localeCompare(name(y.fromId)) ||
      name(x.toId).localeCompare(name(y.toId)) ||
      (x.label ?? '').localeCompare(y.label ?? ''),
  )
  return { connections, objectById, truncated }
}
