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

import { describe, expect, it } from 'vitest'
import { fetchLowerConns, type LowerConnsBackend } from './lowerConnsQuery'
import { buildViewerModel, lowerConns } from './levels'
import type { C4Object, Connection } from '../../types'

/**
 * Regression: the connection panel's "Lower connections" rollup went blank
 * ("this is the deepest level" on a system full of containers) after the
 * viewer moved to the bounded level window — lowerConns() had no subtree data
 * left to derive from. fetchLowerConns must reproduce the pure lowerConns
 * semantics from seam primitives alone (descendants + incoming/outgoing +
 * lookupMany), without a whole-model snapshot.
 */

const obj = (id: string, type: C4Object['type'], parentId?: string): C4Object => ({
  id,
  type,
  name: id,
  position: { x: 0, y: 0 },
  size: { width: 160, height: 100 },
  parentId,
  tagAssignments: {}, tagOrder: [], scope: 'internal',
  status: 'live',
  properties: {},
})

const conn = (id: string, fromId: string, toId: string, kind?: 'direct' | 'lower'): Connection => ({
  id,
  fromId,
  toId,
  type: 'solid',
  kind,
})

/* The Northwind shape the e2e drives, miniature:
 *   root: customer (actor), storefront (system), orders (system)
 *   storefront ▸ web, bff     web ▸ cart      orders ▸ api, db
 */
const OBJECTS = [
  obj('customer', 'actor'),
  obj('storefront', 'system'),
  obj('orders', 'system'),
  obj('web', 'app', 'storefront'),
  obj('bff', 'app', 'storefront'),
  obj('api', 'app', 'orders'),
  obj('db', 'store', 'orders'),
  obj('cart', 'component', 'web'),
]

const CONNS = [
  conn('x1', 'customer', 'storefront'), // context level, outside both subtrees
  conn('x2', 'storefront', 'orders'), // the level edge itself — never its own rollup
  conn('sf1', 'web', 'bff'), // same-side (storefront level)
  conn('o1', 'api', 'db'), // same-side (orders level)
  conn('l1', 'web', 'api'), // subtree A → subtree B
  conn('l2', 'cart', 'api'), // deeper A → B
  conn('l3', 'db', 'cart'), // reverse direction: B → deeper A
  conn('l4', 'storefront', 'api'), // root A itself → subtree B
  conn('rollup', 'storefront', 'orders', 'lower'), // stored per-diagram artifact — never counts
  conn('loop', 'api', 'api'), // self-loop — never counts
]

/** Seam stub over the fixture arrays — the four primitives the rollup uses. */
function stubBackend(objects: C4Object[], connections: Connection[]): LowerConnsBackend {
  const byId = new Map(objects.map((o) => [o.id, o]))
  return {
    async descendants(objectId) {
      const out: string[] = []
      const walk = (id: string) => {
        for (const o of objects) {
          if (o.parentId === id) {
            out.push(o.id)
            walk(o.id)
          }
        }
      }
      walk(objectId)
      return out
    },
    async outgoing(focusId) {
      return connections
        .filter((c) => c.fromId === focusId && c.toId !== focusId)
        .map((c) => ({ connection: c, peerId: c.toId }))
    },
    async incoming(focusId) {
      return connections
        .filter((c) => c.toId === focusId && c.fromId !== focusId)
        .map((c) => ({ connection: c, peerId: c.fromId }))
    },
    async lookupMany(ids) {
      const m = new Map<string, C4Object>()
      for (const id of ids) {
        const o = byId.get(id)
        if (o) m.set(id, o)
      }
      return m
    },
  }
}

const mq = stubBackend(OBJECTS, CONNS)

describe('fetchLowerConns (seam-composed rollup)', () => {
  it('rolls up subtree↔subtree edges in both directions, roots included', async () => {
    const result = await fetchLowerConns(mq, 'storefront', 'orders')
    // sorted by from-name, then to-name: cart→api, db→cart, storefront→api, web→api
    expect(result.connections.map((c) => c.id)).toEqual(['l2', 'l3', 'l4', 'l1'])
    expect(result.truncated).toBe(false)
  })

  it('excludes the a↔b edges, same-side edges, stored rollups and self-loops', async () => {
    const result = await fetchLowerConns(mq, 'storefront', 'orders')
    const ids = new Set(result.connections.map((c) => c.id))
    for (const excluded of ['x1', 'x2', 'sf1', 'o1', 'rollup', 'loop']) {
      expect(ids.has(excluded)).toBe(false)
    }
  })

  it('matches the pure lowerConns semantics on the same fixture', async () => {
    const pure = lowerConns(buildViewerModel(OBJECTS), CONNS, 'storefront', 'orders')
    const fetched = await fetchLowerConns(mq, 'storefront', 'orders')
    expect(new Set(fetched.connections.map((c) => c.id))).toEqual(new Set(pure.map((c) => c.id)))
  })

  it('is endpoint-order agnostic (the edge can be clicked from either side)', async () => {
    const forward = await fetchLowerConns(mq, 'storefront', 'orders')
    const swapped = await fetchLowerConns(mq, 'orders', 'storefront')
    expect(swapped.connections.map((c) => c.id)).toEqual(forward.connections.map((c) => c.id))
  })

  it('resolves rollup endpoint objects the level window does not hold', async () => {
    const result = await fetchLowerConns(mq, 'storefront', 'orders')
    for (const id of ['web', 'cart', 'api', 'db', 'storefront']) {
      expect(result.objectById.get(id)?.name).toBe(id)
    }
  })

  it('returns empty (not lying) at the deepest level', async () => {
    const result = await fetchLowerConns(mq, 'web', 'bff')
    expect(result.connections).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('discloses truncation when a subtree exceeds the fan-out ceiling', async () => {
    // ceiling of 1: only `orders` itself is enumerated — every rollup edge is
    // beyond the ceiling, and the result must say so rather than read as "none".
    const result = await fetchLowerConns(mq, 'storefront', 'orders', 1)
    expect(result.truncated).toBe(true)
    expect(result.connections).toEqual([])
  })
})
