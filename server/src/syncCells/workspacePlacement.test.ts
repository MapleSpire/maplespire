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
import type { Queryable } from '../readModel/types.js'
import { workspacePartition } from './assignment.js'
import { placementWorkspaceKey, readWorkspacePlacement, StoredPlacementResolver } from './workspacePlacement.js'

const workspace = { landscapeId: 'placed-landscape', versionId: 'placed-version' }
const h = workspacePartition(workspace, 2), k = 1 - h
const row = { landscape_id: workspace.landscapeId, version_id: workspace.versionId, partition: k }
const database = (rows: unknown[]) => {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length })
  return { db: { query } as Queryable, query }
}

describe('workspace placement snapshot (D11)', () => {
  it('reads the effective generation once, then resolves synchronously without SQL', async () => {
    const { db, query } = database([row])
    const resolver = new StoredPlacementResolver('placed')
    expect(resolver.loaded).toBe(false)
    expect(() => resolver.partitionOf(workspace, 2)).toThrow('has not loaded')
    resolver.publish(await readWorkspacePlacement(db, 'effective-generation', 2))
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE topology_generation = $1'), ['effective-generation'])
    expect(resolver.loaded).toBe(true)
    expect(h).not.toBe(k)
    for (let i = 0; i < 20; i++) expect(resolver.partitionOf(workspace, 2)).toBe(k)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('shadow stays hashed, and a committed deletion restores hash in placed', async () => {
    const { db } = database([row])
    const stored = await readWorkspacePlacement(db, 'g', 2)
    const shadow = new StoredPlacementResolver('shadow')
    expect(shadow.partitionOf(workspace, 2)).toBe(h)
    shadow.publish(stored)
    expect(shadow.partitionOf(workspace, 2)).toBe(h)
    const placed = new StoredPlacementResolver('placed')
    placed.publish(stored)
    expect(placed.partitionOf(workspace, 2)).toBe(k)
    placed.publish(await readWorkspacePlacement(database([]).db, 'g', 2))
    expect(placed.partitionOf(workspace, 2)).toBe(h)
  })

  it('a failed refresh retains its previous view; a failed first read is unknown', async () => {
    const { db, query } = database([row])
    const ready = new StoredPlacementResolver('placed'), cold = new StoredPlacementResolver('placed')
    ready.publish(await readWorkspacePlacement(db, 'g', 2))
    query.mockRejectedValue(new Error('SQL unavailable'))
    for (const resolver of [ready, cold]) {
      await expect(readWorkspacePlacement(db, 'g', 2).then(rows => resolver.publish(rows))).rejects.toThrow('SQL unavailable')
    }
    expect(ready.partitionOf(workspace, 2)).toBe(k)
    expect(cold.loaded).toBe(false)
    expect(() => cold.partitionOf(workspace, 2)).toThrow('has not loaded')
  })

  it.each([-1, 2, 0.5, NaN, Infinity, '', ' ', '01', '1.0', '2', null, undefined])(
    'rejects invalid partition %s without publishing the valid prefix of a result', async value => {
      const resolver = new StoredPlacementResolver('placed')
      const { db } = database([row, { ...row, version_id: 'other', partition: value }])
      await expect(readWorkspacePlacement(db, 'g', 2).then(rows => resolver.publish(rows))).rejects.toThrow()
      expect(resolver.loaded).toBe(false)
    },
  )

  it('accepts canonical pg integer text and rejects duplicate or empty identity', async () => {
    const stored = await readWorkspacePlacement(database([{ ...row, partition: String(k) }]).db, 'g', 2)
    expect(stored.get(placementWorkspaceKey(workspace))).toBe(k)
    await expect(readWorkspacePlacement(database([row, row]).db, 'g', 2)).rejects.toThrow('Duplicate')
    await expect(readWorkspacePlacement(database([{ ...row, landscape_id: '' }]).db, 'g', 2)).rejects.toThrow('Malformed')
  })

  it('publishes an isolated map and distinguishes composite workspace keys', () => {
    const stored = new Map([[placementWorkspaceKey(workspace), k]])
    const resolver = new StoredPlacementResolver('placed')
    resolver.publish(stored)
    stored.clear()
    expect(resolver.partitionOf(workspace, 2)).toBe(k)
    expect(placementWorkspaceKey({ landscapeId: 'a/b', versionId: 'c' }))
      .not.toBe(placementWorkspaceKey({ landscapeId: 'a', versionId: 'b/c' }))
  })
})
