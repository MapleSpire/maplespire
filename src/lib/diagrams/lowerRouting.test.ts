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
import type { Connection } from '../../types'
import {
  applyLayoutRoutingPatch,
  cleanLowerRouting,
  forkLowerRouting3d,
  isLowerConnectionId,
  lowerConnectionId,
  lowerPairsOf,
  lowerRoutingForSpace,
  mergeLowerRouting,
  resolveLowerRouting,
  withLowerRoutingForSpace,
} from './lowerRouting'

const lower = (over: Partial<Connection> = {}): Connection =>
  ({ id: 'lower:S→P', fromId: 'S', toId: 'P', kind: 'lower', type: 'dashed', label: '', ...over })

describe('resolveLowerRouting', () => {
  it('replaces a lower\'s routing with the diagram\'s entry — ABSOLUTE, so a field the entry lacks is cleared', () => {
    const shared = lower({ fromAnchor: 9, waypoints: [{ x: 1, y: 1 }], label: 'kept' })
    const resolved = resolveLowerRouting(shared, { 'S→P': { toAnchor: 2, lockedToAnchors: true } })
    expect(resolved).toEqual({ ...lower({ label: 'kept' }), toAnchor: 2, lockedToAnchors: true })
    expect(shared.fromAnchor).toBe(9) // never mutates the shared object
  })

  it('returns the SAME reference for a direct connection, a lower without an entry, and no map', () => {
    const direct: Connection = { id: 'c1', fromId: 'S', toId: 'P', type: 'solid' }
    const unrouted = lower()
    expect(resolveLowerRouting(direct, { 'S→P': { fromAnchor: 1 } })).toBe(direct)
    expect(resolveLowerRouting(unrouted, { 'P→S': { fromAnchor: 1 } })).toBe(unrouted)
    expect(resolveLowerRouting(unrouted, undefined)).toBe(unrouted)
  })

  it('keys by DIRECTED pair: the two lines of a reciprocal pair resolve independently', () => {
    const routes = { 'S→P': { fromAnchor: 4 }, 'P→S': { fromAnchor: 8 } }
    expect(resolveLowerRouting(lower(), routes).fromAnchor).toBe(4)
    expect(resolveLowerRouting(lower({ id: 'lower:P→S', fromId: 'P', toId: 'S' }), routes).fromAnchor).toBe(8)
  })
})

describe('lower ids and pairs', () => {
  it('a lower id is its pair, recognisable without the object', () => {
    expect(lowerConnectionId('S', 'P')).toBe('lower:S→P')
    expect(isLowerConnectionId('lower:S→P')).toBe(true)
    expect(isLowerConnectionId('c1')).toBe(false)
  })

  it('lowerPairsOf: present lowers by endpoints, a dropped `lower:` id by its name, direct ids not at all', () => {
    const connections: Connection[] = [
      lower({ id: 'legacy-random-id' }),
      { id: 'c1', fromId: 's1', toId: 'p1', type: 'solid', kind: 'direct' },
    ]
    const pairs = lowerPairsOf(connections, ['legacy-random-id', 'c1', 'lower:P→S', 'gone'])
    expect([...pairs]).toEqual([['legacy-random-id', 'S→P'], ['lower:P→S', 'P→S']])
  })
})

describe('entry arithmetic', () => {
  it('cleanLowerRouting drops undefined and non-routing keys, and copies waypoints', () => {
    const waypoints = [{ x: 1, y: 2 }]
    const clean = cleanLowerRouting({ waypoints, fromAnchor: undefined, label: 'x' } as Record<string, unknown>)
    // Keys, not toEqual: toEqual ignores an `undefined` key, which is exactly
    // what must not reach Automerge (it rejects undefined).
    expect(Object.keys(clean)).toEqual(['waypoints'])
    expect(clean).toEqual({ waypoints: [{ x: 1, y: 2 }] })
    expect(clean.waypoints).not.toBe(waypoints)
  })

  it('mergeLowerRouting: undefined clears, other keys of the entry are kept', () => {
    const merged = mergeLowerRouting({ fromAnchor: 1, waypoints: [{ x: 0, y: 0 }] }, { waypoints: undefined, toAnchor: 3 })
    expect(merged).toEqual({ fromAnchor: 1, toAnchor: 3 })
    expect(Object.keys(merged).sort()).toEqual(['fromAnchor', 'toAnchor'])
  })

  it('per-space records: replacing one space leaves the other untouched', () => {
    const entry = { fromAnchor: 1, waypoints: [{ x: 0, y: 0 }], fromAnchor3d: 5 }
    expect(lowerRoutingForSpace(entry, '2d')).toEqual({ fromAnchor: 1, waypoints: [{ x: 0, y: 0 }] })
    expect(lowerRoutingForSpace(entry, '3d')).toEqual({ fromAnchor3d: 5 })
    expect(withLowerRoutingForSpace(entry, { toAnchor: 2 }, '2d')).toEqual({ toAnchor: 2, fromAnchor3d: 5 })
  })

  it('forkLowerRouting3d copies 2D into the twins once, and never over an existing 3D value', () => {
    expect(forkLowerRouting3d({ fromAnchor: 1, shape: 'straight' }))
      .toEqual({ fromAnchor: 1, shape: 'straight', fromAnchor3d: 1, shape3d: 'straight' })
    expect(forkLowerRouting3d({ fromAnchor: 1, toAnchor3d: 7 })).toEqual({ fromAnchor: 1, toAnchor3d: 7 })
  })

  it('applyLayoutRoutingPatch clears the end the layout did not pin (the layout owns its anchor state)', () => {
    const target = { fromAnchor: 7, toAnchor: 0, lockedToAnchors: true, waypoints: [{ x: 5, y: 5 }] }
    applyLayoutRoutingPatch(target, { toAnchor: 2, lockedToAnchors: true }, false)
    expect(target).toEqual({ toAnchor: 2, lockedToAnchors: true })
    const target3d = { fromAnchor: 7 }
    applyLayoutRoutingPatch(target3d, { lockedToAnchors: false }, true)
    expect(target3d).toEqual({ fromAnchor: 7, waypoints3d: [], lockedToAnchors3d: false })
  })
})
