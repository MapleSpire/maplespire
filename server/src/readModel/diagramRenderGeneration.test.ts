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

import { describe, expect, it, vi } from 'vitest'
import {
  bumpDiagramRenderGenerations,
  DiagramRenderContextLoader,
  roDiagramRenderContext,
  roDiagramRenderGeneration,
  selectDiagramRenderCacheGeneration,
} from './diagramRenderGeneration.js'

const key = { landscapeId: 'landscape', versionId: 'version' }

describe('diagram render dependency generations', () => {
  it('loads workspace generation and static epoch with one PostgreSQL statement', async () => {
    const query = vi.fn(async () => ({
      rows: [{ projection_generation: '42', static_baseline_epoch: '2026-07-28 12:00:00+00' }],
    }))

    await expect(roDiagramRenderContext({ query } as never, key)).resolves.toEqual({
      projectionGeneration: 42,
      staticBaselineEpoch: '2026-07-28 12:00:00+00',
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain('read_model_projection_state')
    expect(query.mock.calls[0]?.[0]).toContain('read_model_static_workspaces')
  })

  it('coalesces concurrent context lookups without retaining a stale result', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const query = vi.fn(async () => {
      await blocked
      return { rows: [{ projection_generation: 7, static_baseline_epoch: null }] }
    })
    const loader = new DiagramRenderContextLoader({ query } as never)

    const first = loader.load(key)
    const second = loader.load(key)
    expect(second).toBe(first)
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { projectionGeneration: 7 }, { projectionGeneration: 7 },
    ])
    await loader.load(key)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('returns the touched diagram generation and leaves an untouched diagram at the immutable baseline', async () => {
    const query = vi.fn(async (_sql: string, params?: unknown[]) => ({
      rows: params?.[2] === 'touched' ? [{ render_generation: 41 }] : [], rowCount: 1,
    }))
    const db = { query } as never
    await expect(roDiagramRenderGeneration(db, key, 'touched')).resolves.toBe(41)
    await expect(roDiagramRenderGeneration(db, key, 'untouched')).resolves.toBe(0)
  })

  it('bumps only diagrams depending on the changed entities plus explicit diagram ids', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 2 }))
    await expect(bumpDiagramRenderGenerations({ query } as never, key, 42, {
      diagramIds: ['d-explicit'], objectIds: ['o1'], connectionIds: ['c1'], groupIds: ['g1'],
    })).resolves.toBe(2)
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('FROM ro_diagram_objects')
    expect(sql).toContain('FROM ro_diagram_connections')
    expect(sql).toContain('FROM ro_diagram_groups')
    expect(sql).toContain('GREATEST(read_model_diagram_render_generations.render_generation')
    expect(params).toEqual(['landscape', 'version', 42, ['d-explicit'], ['o1'], ['c1'], ['g1']])
  })

  it('uses dependency generations only for scoped static renders and falls back to workspace generation otherwise', () => {
    expect(selectDiagramRenderCacheGeneration({ staticReadModel: true, dependencyScoped: true, workspaceGeneration: 99, diagramGeneration: 7 })).toBe(7)
    expect(selectDiagramRenderCacheGeneration({ staticReadModel: true, dependencyScoped: false, workspaceGeneration: 99, diagramGeneration: 7 })).toBe(99)
    expect(selectDiagramRenderCacheGeneration({ staticReadModel: false, dependencyScoped: true, workspaceGeneration: 99, diagramGeneration: 7 })).toBe(99)
  })
})
