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

// QA lens: bestLayout's hint escape hatches. Across the whole layout/import/
// structurizr/export suite NONE of them fires (instrumented 2026-10-22), so each is
// pinned here with synthetic candidates: the ELK portfolio is mocked per direction,
// and the custom engine's metrics are replaced via measureLaidOut (its only caller
// once ELK is mocked).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LayoutMetrics } from './metrics'
import type { C4Object, Connection, Diagram } from '../../types'

const state = vi.hoisted(() => ({
  elk: {} as Record<'DOWN' | 'RIGHT', Record<string, number>>,
  custom: {} as Record<string, number>,
}))

const metricsOf = (o: Record<string, number>): LayoutMetrics =>
  ({
    nodeCount: 2, edgeCount: 1, nodeOverlaps: 0, minGap: 100, edgeCrossings: 0, edgeNodeOverlaps: 0,
    boundaryViolations: 0, groupStraddles: 0, hubSpread: 1, aspect: 1.5, width: 600, height: 400, score: 0,
    ...o,
  }) as unknown as LayoutMetrics

vi.mock('./elk/elkLayout', () => ({
  layoutDiagramElk: async (_d: unknown, _c: unknown, s: { id: string; direction: 'DOWN' | 'RIGHT' }) => ({
    source: s.id, layouts: {}, connPatches: {}, edgeGeoms: [], metrics: metricsOf(state.elk[s.direction]),
  }),
}))
vi.mock('./graph', async (importOriginal) => {
  const real = await importOriginal<typeof import('./graph')>()
  return {
    ...real,
    measureLaidOut: (...args: Parameters<typeof real.measureLaidOut>) => ({ ...real.measureLaidOut(...args), metrics: metricsOf(state.custom) }),
  }
})

const { bestLayout } = await import('./index')
const { STRATEGIES } = await import('./elk/elkConfig')
const directionOf = (source: string) => (source === 'custom' ? 'custom' : STRATEGIES.find((s) => s.id === source)!.direction)

const object = (id: string): C4Object =>
  ({ id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 150, height: 90 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} }) as unknown as C4Object
const objects = [object('a'), object('b')]
const connections: Connection[] = [{ id: 'e', fromId: 'a', toId: 'b', type: 'solid', label: '' }]
const d = { id: 'v', name: 'v', type: 'container', objectIds: ['a', 'b'], connectionIds: ['e'], groupIds: [], layouts: {} } as unknown as Diagram
const pick = async () => directionOf((await bestLayout(d, { objects, connections, groups: [] }, 'tb')).source)

describe('bestLayout — when a `tb` hint must give way to the overall best (RIGHT)', () => {
  beforeEach(() => {
    state.custom = { score: 5 }
  })

  it('control: a DOWN candidate scoring a little worse is kept', async () => {
    state.elk = { RIGHT: { score: -20 }, DOWN: { score: -10 } }
    expect(await pick()).toBe('DOWN')
  })

  it('a hinted candidate with more group straddles', async () => {
    state.elk = { RIGHT: { score: -20 }, DOWN: { score: -10, groupStraddles: 1 } }
    expect(await pick()).toBe('RIGHT')
  })

  it('a hinted candidate that fails the gates the best passes', async () => {
    state.elk = { RIGHT: { score: 0 }, DOWN: { score: -10, hubSpread: 0.1 } }
    state.custom = { score: -5, hubSpread: 0.1 }
    expect(await pick()).toBe('RIGHT')
  })

  it('a hinted candidate with more hard violations, when the best fails the gates too', async () => {
    state.elk = { RIGHT: { score: 0, edgeCrossings: 10 }, DOWN: { score: -10, nodeOverlaps: 1 } }
    state.custom = { score: -5, nodeOverlaps: 1 }
    expect(await pick()).toBe('RIGHT')
  })

  it('a sliver is not a hinted candidate — the custom engine (hinted, not a sliver) wins instead', async () => {
    state.elk = { RIGHT: { score: -20 }, DOWN: { score: -10, aspect: 0.1, width: 300, height: 3000 } }
    expect(await pick()).toBe('custom')
  })

  it('no hinted candidate at all', async () => {
    const sliver = { aspect: 0.1, width: 300, height: 3000 }
    state.elk = { RIGHT: { score: -20 }, DOWN: { score: -10, ...sliver } }
    state.custom = { score: 5, ...sliver }
    expect(await pick()).toBe('RIGHT')
  })
})
