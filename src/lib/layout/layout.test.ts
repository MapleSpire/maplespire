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

import { describe, it, expect, beforeAll } from 'vitest'
import { parseWorkspace } from '../structurizr/parser'
import { mapWorkspace } from '../structurizr/mapper'
import { applyAutoLayout, measureDiagram, type LayoutContext } from './index'
import type { Diagram } from '../../types'
import bigBank from '../structurizr/fixtures/big-bank-plc.dsl?raw'

describe('auto-layout (ELK portfolio) — Big Bank plc quality gates', () => {
  let n = 0
  const m = mapWorkspace(parseWorkspace(bigBank), { idFactory: () => `id${++n}` })
  let out: { diagrams: Diagram[]; ctx: LayoutContext }

  beforeAll(async () => {
    const res = await applyAutoLayout(
      m.diagrams,
      { objects: m.objects, connections: m.connections, groups: m.groups },
      m.layoutHints,
    )
    out = { diagrams: res.diagrams, ctx: { objects: m.objects, connections: res.connections, groups: m.groups } }
  })

  for (const d0 of m.diagrams) {
    describe(`diagram "${d0.name}" (${d0.type})`, () => {
      it('meets the hard structural gates and reports metrics', () => {
        const d = out.diagrams.find((x) => x.id === d0.id)!
        for (const id of d.objectIds) expect(d.layouts?.[id], `layout for ${id}`).toBeDefined()
        const { metrics } = measureDiagram(d, out.ctx)
         
        console.log(`  [${d0.name}]`, JSON.stringify(metrics))
        expect(metrics.nodeOverlaps, 'nodeOverlaps').toBe(0)
        expect(metrics.minGap, 'minGap').toBeGreaterThan(0)
        expect(metrics.edgeNodeOverlaps, 'edgeNodeOverlaps').toBe(0)
        expect(metrics.edgeCrossings, 'edgeCrossings').toBeLessThanOrEqual(
          Math.max(1, Math.ceil(metrics.edgeCount * 0.35)),
        )
      })
    })
  }
})
