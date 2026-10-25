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

import type { Connection, LowerConnectionRouting, Position } from '../../types'

/**
 * The routing of a derived (`kind: 'lower'`) connection is VIEW state of one
 * diagram, exactly like a shape's position, so it lives where positions live:
 * `Diagram.lowerRouting`, keyed by the lower's endpoint pair, persisted in the
 * DiagramDoc, and merged onto the lower when the diagram is drawn.
 *
 * It used to live on the lower Connection object, which nothing persists: the
 * bridge filters lowers out of every model write, and a projection that
 * replaces `connections` (any model-doc change, the server render) drops them,
 * after which `syncLowerConnections` derives fresh ones. Measured 2026-10-21 on
 * an isolated stack (SAOE import, FSSystemContext, Auto-layout): the routing
 * Auto-layout wrote to the lowers was gone within ~2 s, so a reciprocal pair
 * (A→B and B→A, both lower) drew as one braided double line, and after a reload
 * every lower was unrouted.
 *
 * Why per DIAGRAM and not per lower: the lower object is shared by every diagram
 * that rolls an edge up onto the same pair (one object per pair, see
 * `deriveLowerConnections`), and those diagrams place the two endpoints at
 * different coordinates — waypoints are world coordinates. Giving each diagram
 * its own lower object instead would duplicate the pair in the model index the
 * Dependencies page aggregates (`lowerCount` per peer in modelReadCache.worker).
 */

/** The routing fields of the 2D canvas, in the order `applyDiagramLayout` writes them. */
export const LOWER_ROUTING_FIELDS_2D = [
  'waypoints', 'fromAnchor', 'toAnchor', 'lockedToAnchors', 'labelPosition', 'labelOffset', 'shape',
] as const satisfies readonly (keyof LowerConnectionRouting)[]

/** Their 3D-board twins (read rule everywhere: 3D value ?? 2D value). */
export const LOWER_ROUTING_FIELDS_3D = [
  'waypoints3d', 'fromAnchor3d', 'toAnchor3d', 'lockedToAnchors3d', 'labelPosition3d', 'labelOffset3d', 'shape3d',
] as const satisfies readonly (keyof LowerConnectionRouting)[]

export const LOWER_ROUTING_FIELDS = [...LOWER_ROUTING_FIELDS_2D, ...LOWER_ROUTING_FIELDS_3D] as const

export type LowerRoutingSpace = '2d' | '3d'

type RoutingField = (typeof LOWER_ROUTING_FIELDS)[number]

const ROUTING_FIELD_SET: ReadonlySet<string> = new Set<string>(LOWER_ROUTING_FIELDS)

export function lowerRoutingFields(space: LowerRoutingSpace): readonly RoutingField[] {
  return space === '3d' ? LOWER_ROUTING_FIELDS_3D : LOWER_ROUTING_FIELDS_2D
}

/** A lower's endpoint pair — the key of `Diagram.lowerRouting`. Same spelling as
 * the server render's `computeLowerConnections` and `diagramRenderLocal`. */
export function lowerPairKey(fromId: string, toId: string): string {
  return `${fromId}→${toId}`
}

export const LOWER_CONNECTION_ID_PREFIX = 'lower:'

/** The id of the lower for a pair. Deterministic, and the SAME id the server
 * render gives it (`lower:<from>→<to>`), so a lower keeps its id across every
 * re-derivation, a reload and both boot modes — a selection, a flow step or a
 * placement intent naming it still resolves after a projection re-minted it. */
export function lowerConnectionId(fromId: string, toId: string): string {
  return `${LOWER_CONNECTION_ID_PREFIX}${lowerPairKey(fromId, toId)}`
}

/** True for an id minted by `lowerConnectionId` (or the server render). Lets a
 * caller recognise a lower id whose object is not in the store, which is the
 * state a projection leaves `connectionIds` in until the roll-up runs. */
export function isLowerConnectionId(id: string): boolean {
  return id.startsWith(LOWER_CONNECTION_ID_PREFIX)
}

/** A lower named by an edit: its pair, its endpoints, and its object when the
 * store holds one. */
export interface LowerRef {
  pair: string
  fromId: string
  toId: string
  connection?: Connection
}

/**
 * id -> lower, for every id of `ids` that names a lower: one present in
 * `connections` with `kind: 'lower'`, or a `lower:` id with no object (a
 * projection dropped it and the roll-up has not re-minted it yet — the pair is
 * then its name, split at its first `→`). Ids of direct connections are absent.
 */
export function lowerRefsOf(connections: readonly Connection[], ids: Iterable<string>): Map<string, LowerRef> {
  const wanted = new Set(ids)
  const refs = new Map<string, LowerRef>()
  if (wanted.size === 0) return refs
  const present = new Set<string>()
  for (const connection of connections) {
    if (!wanted.has(connection.id)) continue
    present.add(connection.id)
    if (connection.kind !== 'lower') continue
    refs.set(connection.id, {
      pair: lowerPairKey(connection.fromId, connection.toId),
      fromId: connection.fromId,
      toId: connection.toId,
      connection,
    })
  }
  for (const id of wanted) {
    if (present.has(id) || !isLowerConnectionId(id)) continue
    const pair = id.slice(LOWER_CONNECTION_ID_PREFIX.length)
    const at = pair.indexOf('→')
    if (at < 0) continue
    refs.set(id, { pair, fromId: pair.slice(0, at), toId: pair.slice(at + 1) })
  }
  return refs
}

/** id -> pair of `lowerRefsOf`. */
export function lowerPairsOf(connections: readonly Connection[], ids: Iterable<string>): Map<string, string> {
  return new Map([...lowerRefsOf(connections, ids)].map(([id, ref]) => [id, ref.pair]))
}

function cloneValue(field: RoutingField, value: unknown): unknown {
  if (field === 'waypoints' || field === 'waypoints3d') {
    return (value as Position[]).map((point) => ({ x: point.x, y: point.y }))
  }
  return value
}

/** A fresh entry holding only the DEFINED routing fields of `source` (Automerge
 * rejects `undefined`, and a stored `undefined` would read as "set"). */
export function cleanLowerRouting(source: Partial<Record<string, unknown>> | undefined): LowerConnectionRouting {
  const out: Record<string, unknown> = {}
  if (!source) return out as LowerConnectionRouting
  for (const field of LOWER_ROUTING_FIELDS) {
    const value = source[field]
    if (value !== undefined) out[field] = cloneValue(field, value)
  }
  return out as LowerConnectionRouting
}

/** Deep copy of a whole `lowerRouting` map (a DiagramDoc proxy must never be
 * aliased into another document). */
export function cloneLowerRoutingMap(
  routes: Record<string, LowerConnectionRouting> | undefined,
): Record<string, LowerConnectionRouting> | undefined {
  if (!routes) return undefined
  const out: Record<string, LowerConnectionRouting> = {}
  for (const [pair, entry] of Object.entries(routes)) out[pair] = cleanLowerRouting(entry)
  return out
}

/**
 * The connection as `routes`' diagram draws it. A lower with an entry has its
 * routing fields REPLACED by the entry — absolute, so a field the entry does not
 * hold is cleared and an anchor left on the shared object can never show
 * through. A lower without an entry, and every direct connection, is returned
 * as the same reference.
 */
export function resolveLowerRouting(
  connection: Connection,
  routes: Record<string, LowerConnectionRouting> | undefined,
): Connection {
  if (connection.kind !== 'lower' || !routes) return connection
  const entry = routes[lowerPairKey(connection.fromId, connection.toId)]
  if (!entry) return connection
  // Same (object, entry) -> same result object, so a consumer that compares by
  // reference does not see a change on every sync where there is none.
  const cached = resolvedCache.get(connection)
  if (cached && cached.entry === entry) return cached.resolved
  const out = { ...connection } as Record<string, unknown>
  for (const field of LOWER_ROUTING_FIELDS) {
    const value = (entry as Record<string, unknown>)[field]
    if (value === undefined) delete out[field]
    else out[field] = value
  }
  const resolved = out as unknown as Connection
  resolvedCache.set(connection, { entry, resolved })
  return resolved
}

const resolvedCache = new WeakMap<Connection, { entry: LowerConnectionRouting; resolved: Connection }>()

/** Split a connection patch into the routing fields (any space) and the rest. */
export function splitRoutingPatch(data: Partial<Connection>): {
  routing: Partial<Record<RoutingField, unknown>>
  rest: Partial<Connection>
  hasRouting: boolean
} {
  const routing: Partial<Record<RoutingField, unknown>> = {}
  const rest: Record<string, unknown> = {}
  let hasRouting = false
  for (const [key, value] of Object.entries(data)) {
    if (ROUTING_FIELD_SET.has(key)) {
      routing[key as RoutingField] = value
      hasRouting = true
    } else {
      rest[key] = value
    }
  }
  return { routing, rest: rest as Partial<Connection>, hasRouting }
}

/** `Object.assign` semantics for a routing patch onto an entry, except that an
 * `undefined` value CLEARS the field. Returns a fresh entry. */
export function mergeLowerRouting(
  entry: LowerConnectionRouting | undefined,
  patch: Partial<Record<RoutingField, unknown>>,
): LowerConnectionRouting {
  const out = cleanLowerRouting(entry) as Record<string, unknown>
  for (const field of LOWER_ROUTING_FIELDS) {
    if (!(field in patch)) continue
    const value = patch[field]
    if (value === undefined) delete out[field]
    else out[field] = cloneValue(field, value)
  }
  return out as LowerConnectionRouting
}

/** The fields of one space only — what a placement record of that space holds.
 * ABSOLUTE: a field of the space absent here is cleared when it is applied. */
export function lowerRoutingForSpace(
  entry: LowerConnectionRouting | undefined,
  space: LowerRoutingSpace,
): LowerConnectionRouting {
  const out: Record<string, unknown> = {}
  if (!entry) return out as LowerConnectionRouting
  for (const field of lowerRoutingFields(space)) {
    const value = (entry as Record<string, unknown>)[field]
    if (value !== undefined) out[field] = cloneValue(field, value)
  }
  return out as LowerConnectionRouting
}

/** `entry` with the fields of `space` replaced by `routing` (absolute) and the
 * other space's fields untouched. Returns a fresh entry. */
export function withLowerRoutingForSpace(
  entry: LowerConnectionRouting | undefined,
  routing: LowerConnectionRouting,
  space: LowerRoutingSpace,
): LowerConnectionRouting {
  const out = cleanLowerRouting(entry) as Record<string, unknown>
  for (const field of lowerRoutingFields(space)) {
    const value = (routing as Record<string, unknown>)[field]
    if (value === undefined) delete out[field]
    else out[field] = cloneValue(field, value)
  }
  return out as LowerConnectionRouting
}

/** The 3D fork of one entry (`ensureFork3d`'s connection copy, for a lower): an
 * entry with no 3D field yet gets its 2D values copied into the twins, so a
 * later 2D edit can no longer move it on the board. */
export function forkLowerRouting3d(entry: LowerConnectionRouting): LowerConnectionRouting {
  for (const field of LOWER_ROUTING_FIELDS_3D) {
    if ((entry as Record<string, unknown>)[field] !== undefined) return cleanLowerRouting(entry)
  }
  const out = cleanLowerRouting(entry) as Record<string, unknown>
  LOWER_ROUTING_FIELDS_2D.forEach((field, index) => {
    const value = out[field]
    if (value !== undefined) out[LOWER_ROUTING_FIELDS_3D[index]] = cloneValue(field, value)
  })
  return out as LowerConnectionRouting
}

/** Entry minus every 3D field ("Align 3D with 2D"). */
export function withoutLowerRouting3d(entry: LowerConnectionRouting): LowerConnectionRouting {
  const out = cleanLowerRouting(entry) as Record<string, unknown>
  for (const field of LOWER_ROUTING_FIELDS_3D) delete out[field]
  return out as LowerConnectionRouting
}

/** The per-connection patch Auto-layout produces (`ConnPatch` in src/lib/layout). */
export interface LayoutRoutingPatch {
  waypoints?: Position[]
  fromAnchor?: number
  toAnchor?: number
  lockedToAnchors?: boolean
  shape?: Connection['shape']
  labelPosition?: number
  labelOffset?: number
}

/**
 * Apply an Auto-layout patch to `target` IN PLACE — a connection draft or a
 * lower-routing entry, whose routing fields have the same names. The layout
 * OWNS the anchor state it scored: an end the patch leaves undefined is CLEARED,
 * never kept (a stale anchor surviving a re-layout gets re-locked onto the wrong
 * port). In 3D the result lands on the `*3d` twins, and clears use explicit
 * sentinels (`[]` / `false`) so they do not fall back to the 2D values. Mirrors
 * `applyPatch` in src/lib/layout/index.ts — keep the two in lockstep.
 */
export function applyLayoutRoutingPatch(
  target: LowerConnectionRouting,
  p: LayoutRoutingPatch,
  use3d: boolean,
): void {
  if (use3d) {
    target.waypoints3d = p.waypoints && p.waypoints.length ? p.waypoints : []
    if (p.lockedToAnchors && (p.fromAnchor !== undefined || p.toAnchor !== undefined)) {
      target.lockedToAnchors3d = true
      if (p.fromAnchor !== undefined) target.fromAnchor3d = p.fromAnchor
      else delete target.fromAnchor3d
      if (p.toAnchor !== undefined) target.toAnchor3d = p.toAnchor
      else delete target.toAnchor3d
    } else {
      target.lockedToAnchors3d = false
      delete target.fromAnchor3d
      delete target.toAnchor3d
    }
    if (p.shape) target.shape3d = p.shape
    if (p.labelPosition !== undefined) target.labelPosition3d = p.labelPosition
    if (p.labelOffset !== undefined) target.labelOffset3d = p.labelOffset
    return
  }
  if (p.waypoints && p.waypoints.length) target.waypoints = p.waypoints
  else delete target.waypoints
  if (p.lockedToAnchors && (p.fromAnchor !== undefined || p.toAnchor !== undefined)) {
    target.lockedToAnchors = true
    if (p.fromAnchor !== undefined) target.fromAnchor = p.fromAnchor
    else delete target.fromAnchor
    if (p.toAnchor !== undefined) target.toAnchor = p.toAnchor
    else delete target.toAnchor
  } else {
    target.lockedToAnchors = false
    delete target.fromAnchor
    delete target.toAnchor
  }
  if (p.shape) target.shape = p.shape
  if (p.labelPosition !== undefined) target.labelPosition = p.labelPosition
  if (p.labelOffset !== undefined) target.labelOffset = p.labelOffset
}
