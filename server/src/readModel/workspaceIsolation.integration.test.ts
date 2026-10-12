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
import {
  roObject, roPageObjects, roPageConnections, roSearch, roConnectionCount, roDescendants,
} from './queries.js'
import { roDiagramRender } from './diagramRender.js'
import type { ObjectInput, ConnectionInput, DiagramInput } from './types.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * `ro_*` rows carry every workspace a projector has cold-built, side by side in the same tables (composite PK
 * (landscape_id, version_id, id)). This suite projects TWO distinct workspaces
 * with colliding entity ids and asserts every query function — and
 * `roDiagramRender`'s full-table scans (parent/edge lookups) — returns ONLY the
 * requested workspace's rows. Isolated schema; skips when no DB is reachable.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 4000, options: '-c search_path=wsisolation_test,public' }), 'workspaceIsolation')
  try {
    const c = await p.connect()
    try {
      await c.query('CREATE SCHEMA IF NOT EXISTS wsisolation_test')
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
if (!pool) console.warn(`[workspace isolation] no Postgres at ${URL} — skipping`)

const WS_A: WorkspaceKey = { landscapeId: 'ls-a', versionId: 'v1' }
const WS_B: WorkspaceKey = { landscapeId: 'ls-b', versionId: 'v1' }

const o = (id: string, over: Partial<ObjectInput> = {}): ObjectInput => ({ id, name: id, ...over })
const c = (id: string, fromId: string, toId: string, over: Partial<ConnectionInput> = {}): ConnectionInput =>
  ({ id, fromId, toId, ...over })

suite('read-model workspace isolation (R6)', () => {
  afterAll(async () => {
    const c2 = await pool!.connect()
    try {
      await c2.query('DROP SCHEMA IF EXISTS wsisolation_test CASCADE')
    } finally {
      c2.release()
      await pool!.end()
    }
  })
  beforeEach(async () => {
    await ensureReadModelSchema(pool!)
  })

  it('projects two workspaces with colliding ids and keeps every read scoped to its own workspace', async () => {
    // Same object/connection ids in BOTH workspaces, different content — a
    // cross-workspace leak would surface as reading the WRONG workspace's data,
    // not just extra rows, catching a missing WHERE clause immediately.
    await coldBuildReadModel(
      pool!, WS_A, 'org-a',
      [o('shared', { name: 'Alpha Object', parentId: 'root' }), o('root', { name: 'Alpha Root' })],
      [c('e1', 'shared', 'root', { label: 'alpha-edge' })]
    )
    await coldBuildReadModel(
      pool!, WS_B, 'org-b',
      [o('shared', { name: 'Beta Object', parentId: 'root' }), o('root', { name: 'Beta Root' })],
      [c('e1', 'shared', 'root', { label: 'beta-edge' })]
    )

    // Point lookup by id resolves to the CALLER's workspace, not whichever was
    // projected last.
    expect((await roObject(pool!, WS_A, 'shared'))?.name).toBe('Alpha Object')
    expect((await roObject(pool!, WS_B, 'shared'))?.name).toBe('Beta Object')

    // Paging never leaks the other workspace's rows into the page or the count.
    const pageA = await roPageObjects(pool!, WS_A, { limit: 10 })
    const pageB = await roPageObjects(pool!, WS_B, { limit: 10 })
    expect(pageA.objects.map((x) => x.id).sort()).toEqual(['root', 'shared'])
    expect(pageB.objects.map((x) => x.id).sort()).toEqual(['root', 'shared'])
    expect(pageA.objects.find((x) => x.id === 'shared')?.name).toBe('Alpha Object')
    expect(pageB.objects.find((x) => x.id === 'shared')?.name).toBe('Beta Object')

    const connPageA = await roPageConnections(pool!, WS_A, { limit: 10 })
    expect(connPageA.connections.map((x) => x.label)).toEqual(['alpha-edge'])

    // Search matches only the requesting workspace's text.
    const hitsAlpha = await roSearch(pool!, WS_A, 'alpha')
    const hitsBeta = await roSearch(pool!, WS_B, 'alpha')
    expect(hitsAlpha.length).toBeGreaterThan(0)
    expect(hitsBeta.length).toBe(0)

    // Adjacency count is per-workspace even though the id 'shared'/'root' collide.
    expect(await roConnectionCount(pool!, WS_A, 'shared')).toBe(1)
    expect(await roConnectionCount(pool!, WS_B, 'shared')).toBe(1)

    // Descendants (recursive CTE) never walks into the other workspace's tree.
    expect(await roDescendants(pool!, WS_A, 'root')).toEqual(['shared'])
    expect(await roDescendants(pool!, WS_B, 'root')).toEqual(['shared'])
  })

  it('roDiagramRender scopes its full-table parent/edge scans to one workspace', async () => {
    // A deep edge in workspace A rolls up to a lower connection; the SAME ids in
    // workspace B have no such relationship (flat, no parent) — if the parent/
    // edge bulk-scan in diagramRender.ts weren't workspace-scoped, B's render
    // would spuriously see A's roll-up (or vice versa).
    const diagramsA: DiagramInput[] = [
      { id: 'dg', name: 'D', type: 'context', objectIds: ['Sys1', 'Sys2'], connectionIds: [], groupIds: [] },
    ]
    await coldBuildReadModel(
      pool!, WS_A, null,
      [o('Sys1'), o('Sys2'), o('app1', { parentId: 'Sys1' }), o('app2', { parentId: 'Sys2' })],
      [c('deep', 'app1', 'app2')],
      [],
      diagramsA
    )
    const diagramsB: DiagramInput[] = [
      { id: 'dg', name: 'D', type: 'context', objectIds: ['Sys1', 'Sys2'], connectionIds: [], groupIds: [] },
    ]
    await coldBuildReadModel(
      pool!, WS_B, null,
      [o('Sys1'), o('Sys2')], // no children in B — 'deep' below has no valid endpoints in B
      [],
      [],
      diagramsB
    )

    const renderA = await roDiagramRender(pool!, WS_A, 'dg')
    const renderB = await roDiagramRender(pool!, WS_B, 'dg')
    expect(renderA).toBeDefined()
    expect(renderB).toBeDefined()
    const lowerA = (renderA!.connections as { kind?: string }[]).filter((x) => x.kind === 'lower')
    const lowerB = (renderB!.connections as { kind?: string }[]).filter((x) => x.kind === 'lower')
    expect(lowerA).toHaveLength(1) // Sys1→Sys2 roll-up from app1→app2
    expect(lowerB).toHaveLength(0) // B has no 'deep' connection and no app1/app2 objects
  })
})
