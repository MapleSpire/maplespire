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
import { appendReadModelChange, READ_MODEL_CHANGE_CHANNEL, roReadModelChanges } from './changeFeed.js'

describe('read-model change feed', () => {
  it('publishes the durable row and transaction-scoped notification together', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    await appendReadModelChange(
      { query },
      { landscapeId: 'ls', versionId: 'v1' },
      { generation: 9, startedAtMs: Date.now() },
      { kind: 'objects', upsertIds: ['o1'], deleteIds: [] },
    )
    expect(query).toHaveBeenCalledTimes(3)
    expect(query).toHaveBeenLastCalledWith('SELECT pg_notify($1, $2)', [
      READ_MODEL_CHANGE_CHANNEL,
      JSON.stringify({ landscapeId: 'ls', versionId: 'v1', generation: 9 }),
    ])
  })

  it('publishes reset instead of silently truncating an oversized id batch', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    await appendReadModelChange(
      { query },
      { landscapeId: 'ls', versionId: 'v1' },
      { generation: 10, startedAtMs: Date.now() },
      {
        kind: 'objects',
        upsertIds: Array.from({ length: 5_001 }, (_, index) => `o${index}`),
        deleteIds: [],
      },
    )
    expect(query.mock.calls[0][1]?.[3]).toBe('reset')
    expect(JSON.parse(query.mock.calls[0][1]?.[4] as string)).toEqual({ scope: 'all' })
  })

  it('returns consecutive bounded events', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('projection_state')
      ? { rows: [{ projected_generation: 4 }], rowCount: 1 }
      : { rows: [
        { generation: 3, change_kind: 'objects', payload: { upsertIds: ['o1'], deleteIds: [] } },
        { generation: 4, change_kind: 'connections', payload: { upsertIds: [], deleteIds: ['c1'] } },
      ], rowCount: 2 })
    const page = await roReadModelChanges({ query }, { landscapeId: 'ls', versionId: 'v' }, { afterGeneration: 2 })
    expect(page.resetRequired).toBe(false)
    expect(page.nextGeneration).toBe(4)
    expect(page.events).toHaveLength(2)
  })

  it('requires a clean snapshot when retained generations contain a gap', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('projection_state')
      ? { rows: [{ projected_generation: 5 }], rowCount: 1 }
      : { rows: [{ generation: 5, change_kind: 'objects', payload: { upsertIds: ['o1'], deleteIds: [] } }], rowCount: 1 })
    const page = await roReadModelChanges({ query }, { landscapeId: 'ls', versionId: 'v' }, { afterGeneration: 2 })
    expect(page.resetRequired).toBe(true)
  })

  it('does not require a complete model rebuild for a consecutive scoped reset', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('projection_state')
      ? { rows: [{ projected_generation: 3 }], rowCount: 1 }
      : { rows: [{ generation: 3, change_kind: 'reset', payload: { scope: 'diagrams' } }], rowCount: 1 })
    const page = await roReadModelChanges(
      { query }, { landscapeId: 'ls', versionId: 'v' }, { afterGeneration: 2 },
    )
    expect(page.resetRequired).toBe(false)
    expect(page.events).toEqual([{ generation: 3, kind: 'reset', scope: 'diagrams' }])
  })

  describe('exact changes', () => {
    const stored = async (changes: Parameters<typeof appendReadModelChange>[3]) => {
      const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
      await appendReadModelChange(
        { query }, { landscapeId: 'ls', versionId: 'v1' }, { generation: 7, startedAtMs: Date.now() }, changes,
      )
      const params = query.mock.calls[0][1] as unknown[]
      return { kind: params[3], payload: JSON.parse(params[4] as string) }
    }

    it('stores one kind of row as the plain event every reader understands', async () => {
      expect(await stored({ kind: 'exact', changes: { objects: { upsertIds: ['g1', 'g1'], deleteIds: [] } } }))
        .toEqual({ kind: 'objects', payload: { upsertIds: ['g1'], deleteIds: [] } })
      expect(await stored({ kind: 'exact', changes: {
        objects: { upsertIds: [], deleteIds: [] }, connections: { upsertIds: ['c1'], deleteIds: [] },
      } })).toEqual({ kind: 'connections', payload: { upsertIds: ['c1'], deleteIds: [] } })
      // Nothing served moved: an empty event, never a reset.
      expect(await stored({ kind: 'exact', changes: {} }))
        .toEqual({ kind: 'objects', payload: { upsertIds: [], deleteIds: [] } })
    })

    it('stores several kinds — or any diagram — as reset/all carrying the lists', async () => {
      // An older reader sees exactly the reset/all these passes always wrote.
      expect(await stored({ kind: 'exact', changes: {
        objects: { upsertIds: ['g1'], deleteIds: [] }, connections: { upsertIds: [], deleteIds: ['c9'] },
      } })).toEqual({ kind: 'reset', payload: { scope: 'all', exact: {
        objects: { upsertIds: ['g1'], deleteIds: [] }, connections: { upsertIds: [], deleteIds: ['c9'] },
      } } })
      expect(await stored({ kind: 'exact', changes: { diagrams: { upsertIds: ['d1'], deleteIds: [] } } }))
        .toEqual({ kind: 'reset', payload: { scope: 'all', exact: { diagrams: { upsertIds: ['d1'], deleteIds: [] } } } })
    })

    it('falls back to a plain reset past the id ceiling, whichever kinds carry the ids', async () => {
      const many = Array.from({ length: 3_000 }, (_, index) => `x${index}`)
      expect(await stored({ kind: 'exact', changes: {
        objects: { upsertIds: many, deleteIds: [] }, diagrams: { upsertIds: many.map((id) => `d${id}`), deleteIds: [] },
      } })).toEqual({ kind: 'reset', payload: { scope: 'all' } })
      // Every kind counts toward the ceiling, connections included.
      expect(await stored({ kind: 'exact', changes: {
        objects: { upsertIds: many, deleteIds: [] }, connections: { upsertIds: many.map((id) => `c${id}`), deleteIds: [] },
      } })).toEqual({ kind: 'reset', payload: { scope: 'all' } })
    })

    it('reads the envelope back as precise, and only a reset WITHOUT it as requiring a rebuild', async () => {
      const page = async (payload: Record<string, unknown>) => roReadModelChanges({
        query: vi.fn(async (sql: string) => sql.includes('projection_state')
          ? { rows: [{ projected_generation: 3 }], rowCount: 1 }
          : { rows: [{ generation: 3, change_kind: 'reset', payload }], rowCount: 1 }),
      }, { landscapeId: 'ls', versionId: 'v' }, { afterGeneration: 2 })
      const exact = { diagrams: { upsertIds: ['d1'], deleteIds: [] }, connections: { upsertIds: ['c1'], deleteIds: [] } }
      const precise = await page({ scope: 'all', exact })
      expect(precise.resetRequired).toBe(false)
      expect(precise.events).toEqual([{ generation: 3, kind: 'reset', scope: 'all', exact }])
      expect((await page({ scope: 'all' })).resetRequired).toBe(true)
      // A malformed or not-fully-understood envelope is the plain reset it also
      // is — never "nothing", and never the part this build happens to know.
      expect((await page({ scope: 'all', exact: 'garbage' })).resetRequired).toBe(true)
      expect((await page({ scope: 'all', exact: {} })).resetRequired).toBe(true)
      expect((await page({ scope: 'all', exact: { objects: 5 } })).resetRequired).toBe(true)
      expect((await page({ scope: 'all', exact: { objects: { upsertIds: ['o1'] } } })).resetRequired).toBe(true)
      expect((await page({ scope: 'all', exact: {
        objects: { upsertIds: ['o1'], deleteIds: [] }, flows: { upsertIds: ['f1'], deleteIds: [] },
      } })).resetRequired).toBe(true)
    })
  })
})
