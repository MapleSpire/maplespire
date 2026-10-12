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

import { describe, it, expect } from 'vitest'
import { useModelStore } from '../../stores/modelStore'
import { residentModelQuery } from './resident'
import type { C4Object, Connection } from '../../types'

// Performance regression guard: the resident ModelQuery serves adjacency from the
// DiagramIndex endpoint maps, so a focus lookup is O(degree of focus), NOT
// O(all connections). This builds a large landscape with a focus of KNOWN small
// degree embedded in tens of thousands of connections and asserts that many
// lookups stay cheap — which would blow past the bound if anyone regressed
// incoming()/outgoing() to a full scan.

function obj(id: string): C4Object {
  return {
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  }
}

function buildLandscape(nObjects: number, nConnections: number, focusDegree: number) {
  const objects: C4Object[] = []
  for (let i = 0; i < nObjects; i++) objects.push(obj('o' + i))
  objects.push(obj('FOCUS'))
  const connections: Connection[] = []
  const rid = () => 'o' + ((Math.random() * nObjects) | 0)
  for (let i = 0; i < nConnections; i++) {
    connections.push({ id: 'c' + i, fromId: rid(), toId: rid(), type: 'solid' })
  }
  const half = focusDegree / 2
  for (let i = 0; i < half; i++) {
    connections.push({ id: 'fin' + i, fromId: rid(), toId: 'FOCUS', type: 'solid' })
    connections.push({ id: 'fout' + i, fromId: 'FOCUS', toId: rid(), type: 'solid' })
  }
  return { objects, connections }
}

describe('residentModelQuery — performance (O(degree), not O(all))', () => {
  it('adjacency lookups stay cheap on a 50k-object / 80k-connection landscape', async () => {
    const N = 50_000
    const { objects, connections } = buildLandscape(N, 80_000, 100)
    useModelStore.setState({ objects, connections, groups: [], diagrams: [] })

    expect((await residentModelQuery.incoming('FOCUS')).length).toBe(50)
    expect((await residentModelQuery.outgoing('FOCUS')).length).toBe(50)

    for (let i = 0; i < 200; i++) { await residentModelQuery.incoming('FOCUS'); await residentModelQuery.outgoing('FOCUS') }
    const start = performance.now()
    for (let i = 0; i < 5000; i++) {
      await residentModelQuery.incoming('FOCUS')
      await residentModelQuery.outgoing('FOCUS')
    }
    const ms = performance.now() - start
    // 10,000 index-backed async lookups: ~tens of ms incl. microtask overhead. A
    // regression to a full O(all) scan would take seconds.
    expect(ms).toBeLessThan(500)
  })

  it('missing-focus lookups are also O(1) (empty, no scan)', async () => {
    const { objects, connections } = buildLandscape(20_000, 40_000, 100)
    useModelStore.setState({ objects, connections, groups: [], diagrams: [] })
    const start = performance.now()
    for (let i = 0; i < 5000; i++) await residentModelQuery.incoming('does-not-exist')
    expect(performance.now() - start).toBeLessThan(200)
    expect(await residentModelQuery.incoming('does-not-exist')).toEqual([])
  })
})
