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

import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { ensureReadModelSchema } from './schema.js'
import { coldBuildReadModel, type WorkspaceKey } from './projector.js'
import { roDiagramRender } from './diagramRender.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const WS: WorkspaceKey = { landscapeId: 'ls1', versionId: 'v1' }

/**
 * End-to-end: cold-build a small sharded model into Postgres, then render a
 * top-level diagram and assert it returns the visible objects + persisted
 * connections + the computed lower roll-ups (so a client can draw it without the
 * whole model). Isolated schema; skips when no DB is reachable.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 4000, options: '-c search_path=diagramrender_test,public' }), 'diagramRender')
  try {
    const c = await p.connect()
    try {
      await c.query('CREATE SCHEMA IF NOT EXISTS diagramrender_test')
      await ensureReadModelSchema({ query: (text, params) => c.query(text, params) } as never)
    } finally {
      c.release()
    }
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[diagram-render] no Postgres at ${URL} — skipping`)

const obj = (id: string, over: Record<string, unknown> = {}) => ({ id, type: 'app', name: id, ...over })
const conn = (id: string, fromId: string, toId: string, over: Record<string, unknown> = {}) => ({ id, fromId, toId, type: 'solid', ...over })

suite('roDiagramRender (read model → render-ready diagram)', () => {
  afterAll(async () => {
    const c = await pool!.connect()
    try {
      await c.query('DROP SCHEMA IF EXISTS diagramrender_test CASCADE')
    } finally {
      c.release()
      await pool!.end()
    }
  })
  beforeEach(async () => {
    await ensureReadModelSchema(pool!)
  })

  it('returns visible objects + direct connections + rolled-up lower connections', async () => {
    // System A → app a1 → component a1c ; System B → app b1 → component b1c.
    const objects = [
      obj('A', { type: 'system' }), obj('B', { type: 'system' }),
      obj('a1', { parentId: 'A' }), obj('a1c', { type: 'component', parentId: 'a1' }),
      obj('b1', { parentId: 'B' }), obj('b1c', { type: 'component', parentId: 'b1' }),
    ]
    const connections = [
      conn('direct', 'A', 'B', { label: 'calls' }),    // both visible → shown direct, no lower
      conn('deep', 'a1c', 'b1c', { label: 'reads' }),  // rolls up A→B → lower
      conn('self', 'a1', 'a1c'),                        // both → A ⇒ self-loop, skip
    ]
    // The diagram (top-level) shows A and B; its persisted connectionIds = ['direct'].
    const diagrams = [
      { id: 'dg', name: 'Landscape', type: 'context', objectIds: ['A', 'B'], connectionIds: ['direct'], groupIds: [] },
    ]
    await coldBuildReadModel(pool!, WS, null, objects, connections, [], diagrams)

    const render = await roDiagramRender(pool!, WS, 'dg')
    expect(render).toBeDefined()
    expect((render!.objects as { id: string }[]).map((o) => o.id).sort()).toEqual(['A', 'B'])

    const conns = render!.connections as { id: string; fromId: string; toId: string; kind?: string }[]
    // The direct edge (full data) + exactly one computed lower A→B.
    expect(conns.find((c) => c.id === 'direct')?.kind).toBeUndefined()
    const lower = conns.filter((c) => c.kind === 'lower')
    expect(lower).toEqual([{ id: 'lower:A→B', fromId: 'A', toId: 'B', kind: 'lower', type: 'dashed', label: '' }])
  })

  it('returns undefined for an unknown diagram', async () => {
    await coldBuildReadModel(pool!, WS, null, [], [], [], [])
    expect(await roDiagramRender(pool!, WS, 'nope')).toBeUndefined()
  })
})
