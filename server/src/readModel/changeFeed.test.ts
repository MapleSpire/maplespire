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
})
