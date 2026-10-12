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
import { structurizrSource } from './structurizrSource'
import type { ImportResult } from './types'
import { measureDiagram } from '../layout'
import { StructurizrParseError } from '../structurizr/types'
import bigBank from '../structurizr/fixtures/big-bank-plc.dsl?raw'
import noViews from '../structurizr/fixtures/no-views.dsl?raw'
import grouped from '../structurizr/fixtures/grouped.dsl?raw'
import hierarchical from '../structurizr/fixtures/hierarchical.dsl?raw'
import saoe from '../structurizr/fixtures/saoe.dsl?raw'

const FIXTURES: Record<string, string> = {
  'big-bank-plc': bigBank,
  'no-views': noViews,
  grouped,
  hierarchical,
  saoe,
  sample: structurizrSource.placeholder!,
}

const run = (dsl: string) => structurizrSource.run!(dsl)

describe('Structurizr import — end-to-end quality gates per fixture', () => {
  for (const [name, dsl] of Object.entries(FIXTURES)) {
    describe(name, () => {
      let result: ImportResult
      beforeAll(async () => {
        result = await run(dsl)
      }, 60_000)

      it('produces objects and at least one diagram', () => {
        expect(result.objects.length).toBeGreaterThan(0)
        expect(result.diagrams.length).toBeGreaterThan(0)
        expect(result.entryDiagramId).toBeTruthy()
      })

      it('every diagram has a layout for every object + group', () => {
        for (const d of result.diagrams) {
          for (const id of d.objectIds) expect(d.layouts?.[id], `${d.name}:${id}`).toBeDefined()
          for (const gid of d.groupIds) expect(d.layouts?.[gid], `${d.name}:group ${gid}`).toBeDefined()
        }
      })

      it('meets the layout quality gates on every diagram', () => {
        const ctx = { objects: result.objects, connections: result.connections, groups: result.groups }
        for (const d of result.diagrams) {
          const { metrics } = measureDiagram(d, ctx)
          const msg = `${name} / ${d.name}: ${JSON.stringify(metrics)}`
          expect(metrics.nodeOverlaps, msg).toBe(0)
          expect(metrics.minGap, msg).toBeGreaterThan(0)
          expect(metrics.edgeNodeOverlaps, msg).toBe(0)
          expect(metrics.boundaryViolations, msg).toBe(0) // externals stay outside the system/container box
          expect(metrics.edgeCrossings, msg).toBeLessThanOrEqual(Math.max(1, Math.ceil(metrics.edgeCount * 0.35)))
        }
      }, 30_000)
    })
  }
})

describe('Structurizr import — specific behaviours', () => {
  it('synthesises diagrams when no views block is present', async () => {
    const r = await run(noViews)
    expect(r.stats.byLevel.context).toBeGreaterThanOrEqual(1)
    expect(r.stats.byLevel.container).toBeGreaterThanOrEqual(1)
  })

  it('maps datastore-flavoured containers to the store type', async () => {
    const r = await run(grouped)
    expect(r.objects.find((o) => o.name === 'Cache')?.type).toBe('store') // Redis
    expect(r.objects.find((o) => o.name === 'Message Bus')?.type).toBe('store') // RabbitMQ / bus
  })

  it('honours the `autoLayout lr` hint — landscape laid out wider than tall', async () => {
    const r = await run(grouped)
    const ctx = { objects: r.objects, connections: r.connections, groups: r.groups }
    const landscape = r.diagrams.find((d) => d.name === 'Landscape')!
    const m = measureDiagram(landscape, ctx).metrics
    expect(m.width).toBeGreaterThan(m.height)
  })

  it('resolves hierarchical dotted references', async () => {
    const r = await run(hierarchical)
    const apis = r.objects.filter((o) => o.name === 'API')
    expect(apis.length).toBe(2)
    const conn = r.connections.find(
      (c) => apis.some((a) => a.id === c.fromId) && apis.some((a) => a.id === c.toId),
    )
    expect(conn).toBeDefined()
  })

  it('rejects malformed DSL with a StructurizrParseError', async () => {
    await expect(run('not a workspace at all')).rejects.toBeInstanceOf(StructurizrParseError)
  })
})
