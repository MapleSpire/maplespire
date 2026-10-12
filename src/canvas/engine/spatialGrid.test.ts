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
import { SpatialGridIndex } from './spatialGrid'

describe('SpatialGridIndex', () => {
  it('returns only candidates intersecting the queried cells and de-duplicates spans', () => {
    const index = new SpatialGridIndex<number>(100)
    index.insert({ x: 10, y: 10, width: 20, height: 20 }, 0)
    index.insert({ x: 90, y: 90, width: 40, height: 40 }, 1)
    index.insert({ x: 500, y: 500, width: 20, height: 20 }, 2)

    expect([...index.query({ x: 0, y: 0, width: 150, height: 150 })].sort()).toEqual([0, 1])
    // The index intentionally returns cell candidates; the renderer applies
    // the final exact-bounds intersection before drawing.
    expect([...index.query({ x: 95, y: 95, width: 1, height: 1 })].sort()).toEqual([0, 1])
    expect([...index.query({ x: 300, y: 300, width: 20, height: 20 })]).toEqual([])
  })

  it('bounds zoomed-out queries by returning the indexed population directly', () => {
    const index = new SpatialGridIndex<string>(100)
    index.insert({ x: 0, y: 0, width: 20, height: 20 }, 'a')
    index.insert({ x: 10_000, y: 10_000, width: 20, height: 20 }, 'b')

    expect(index.query({ x: -1_000_000, y: -1_000_000, width: 2_000_000, height: 2_000_000 }))
      .toEqual(new Set(['a', 'b']))
  })

  it('updates and removes individual entries without rebuilding the index', () => {
    const index = new SpatialGridIndex<string>(100)
    index.insert({ x: 0, y: 0, width: 20, height: 20 }, 'moving')
    index.insert({ x: 0, y: 0, width: 20, height: 20 }, 'stable')

    index.insert({ x: 500, y: 500, width: 20, height: 20 }, 'moving')
    expect(index.query({ x: 0, y: 0, width: 20, height: 20 })).toEqual(new Set(['stable']))
    expect(index.query({ x: 500, y: 500, width: 20, height: 20 })).toEqual(new Set(['moving']))

    index.remove('moving')
    expect(index.query({ x: 500, y: 500, width: 20, height: 20 })).toEqual(new Set())
  })

  it('bounds giant entries while retaining them as exact-test candidates', () => {
    const index = new SpatialGridIndex<string>(100, 4)
    index.insert({ x: 0, y: 0, width: 10_000, height: 10_000 }, 'long-connection')
    index.insert({ x: 0, y: 0, width: 10, height: 10 }, 'local')

    expect(index.query({ x: 5_000, y: 5_000, width: 1, height: 1 }))
      .toEqual(new Set(['long-connection']))
    expect(index.query({ x: 0, y: 0, width: 1, height: 1 }))
      .toEqual(new Set(['long-connection', 'local']))
  })
})
