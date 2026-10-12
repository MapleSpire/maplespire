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
import {
  buildViewerModel,
  childrenOf,
  connsAtLevel,
  connsForObject,
  descendants,
  directConns,
  hasChildren,
  levelKind,
  lowerConns,
  parentOf,
  validatePath,
} from './levels'
import type { C4Object, Connection } from '../../types'

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

/* The e-commerce shape from the design kit, miniature:
 *   root: customer (actor), storefront (system), orders (system)
 *   storefront ▸ web, bff        orders ▸ api, db
 *   web ▸ cart (component)
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
  conn('x1', 'customer', 'storefront'), // context level
  conn('x2', 'storefront', 'orders'), // context level
  conn('sf1', 'web', 'bff'), // storefront level
  conn('o1', 'api', 'db'), // orders level
  conn('l1', 'web', 'api'), // cross-boundary (lower of x2)
  conn('l2', 'cart', 'api'), // deeper cross-boundary (lower of x2)
  conn('rollup', 'storefront', 'orders', 'lower'), // stored per-diagram rollup — must never count
]

const model = buildViewerModel(OBJECTS)

describe('viewer level queries', () => {
  it('children / hasChildren / parentOf derive levels from parent links', () => {
    expect(childrenOf(model, null).map((o) => o.id)).toEqual(['customer', 'storefront', 'orders'])
    expect(childrenOf(model, 'storefront').map((o) => o.id)).toEqual(['web', 'bff'])
    expect(hasChildren(model, 'storefront')).toBe(true)
    expect(hasChildren(model, 'customer')).toBe(false)
    expect(parentOf(model, 'cart')).toBe('web')
    expect(parentOf(model, 'customer')).toBe(null)
  })

  it('a dangling parentId falls back to the root level (never unreachable)', () => {
    const m = buildViewerModel([...OBJECTS, obj('orphan', 'app', 'deleted-parent')])
    expect(childrenOf(m, null).some((o) => o.id === 'orphan')).toBe(true)
    expect(parentOf(m, 'orphan')).toBe(null)
  })

  it('descendants walks the whole subtree', () => {
    expect(descendants(model, 'storefront').sort()).toEqual(['bff', 'cart', 'web'])
    expect(descendants(model, 'customer')).toEqual([])
  })

  it('connsAtLevel keeps only same-level direct edges (no lower rollups, no cross-boundary)', () => {
    expect(connsAtLevel(model, CONNS, null).map((c) => c.id)).toEqual(['x1', 'x2'])
    expect(connsAtLevel(model, CONNS, 'storefront').map((c) => c.id)).toEqual(['sf1'])
    expect(connsAtLevel(model, CONNS, 'orders').map((c) => c.id)).toEqual(['o1'])
    // 'l1' (web→api) spans two boundaries — drawn at NO level.
    for (const parent of [null, 'storefront', 'orders', 'web'] as const) {
      expect(connsAtLevel(model, CONNS, parent).some((c) => c.id === 'l1')).toBe(false)
    }
  })

  it('connsForObject lists every direct connection touching the object, with direction', () => {
    const forApi = connsForObject(CONNS, 'api')
    expect(forApi.map((c) => `${c.connection.id}:${c.dir}`).sort()).toEqual(['l1:in', 'l2:in', 'o1:out'])
    expect(forApi.find((c) => c.connection.id === 'l1')?.otherId).toBe('web')
    // the stored rollup never counts
    expect(connsForObject(CONNS, 'storefront').some((c) => c.connection.id === 'rollup')).toBe(false)
  })

  it('directConns matches either direction, excluding rollups', () => {
    expect(directConns(CONNS, 'storefront', 'orders').map((c) => c.id)).toEqual(['x2'])
    expect(directConns(CONNS, 'orders', 'storefront').map((c) => c.id)).toEqual(['x2'])
  })

  it('lowerConns rolls up the deeper subtree↔subtree edges an edge summarizes', () => {
    const lower = lowerConns(model, CONNS, 'storefront', 'orders')
    expect(lower.map((c) => c.id).sort()).toEqual(['l1', 'l2'])
    // the direct x2 edge itself is excluded; same-side edges (sf1, o1) too
    expect(lower.some((c) => c.id === 'x2' || c.id === 'sf1' || c.id === 'o1')).toBe(false)
    // deepest level: nothing below
    expect(lowerConns(model, CONNS, 'web', 'bff')).toEqual([])
  })

  it('levelKind maps the drill parent to the C4 level shown inside it', () => {
    expect(levelKind(model, null)).toBe('context')
    expect(levelKind(model, 'storefront')).toBe('container')
    expect(levelKind(model, 'web')).toBe('component')
  })

  it('validatePath truncates at the first missing or reparented id', () => {
    expect(validatePath(model, ['storefront', 'web', 'cart'])).toEqual(['storefront', 'web', 'cart'])
    expect(validatePath(model, ['storefront', 'api'])).toEqual(['storefront']) // api is not a storefront child
    expect(validatePath(model, ['gone', 'web'])).toEqual([])
    expect(validatePath(model, [])).toEqual([])
  })
})
