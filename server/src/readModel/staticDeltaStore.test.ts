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
import { recordStaticEntityDeltas, recordStaticMembershipSnapshot } from './staticDeltaStore.js'

const key = { landscapeId: 'land', versionId: 'version' }

describe('static delta store', () => {
  it('publishes upserts and tombstones as compact primary-key replacements', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    await recordStaticEntityDeltas(
      { query } as never,
      key,
      'object',
      7,
      [{ id: 'o1', name: 'updated' }, { id: 'o2', name: 'recreated' }],
      ['o2', 'o3', 'o3'],
    )

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0][0]).toContain('tombstone = false')
    expect(query.mock.calls[1][0]).toContain('tombstone = true')
    expect(query.mock.calls[1][1]).toEqual(['land', 'version', 'object', ['o3'], 7])
  })

  it('records removals from a baseline membership as tombstones', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    await recordStaticMembershipSnapshot(
      { query } as never,
      key,
      'diagram_object',
      'd1',
      9,
      [{ entityId: 'o1' }, { entityId: 'o2' }],
      [{ entityId: 'o2' }, { entityId: 'o3' }],
    )
    const rows = JSON.parse(query.mock.calls[0][1][0] as string) as Array<Record<string, unknown>>
    expect(rows).toEqual(expect.arrayContaining([
      { entityId: 'o1', auxiliaryId: '', tombstone: true },
      { entityId: 'o2', auxiliaryId: '', tombstone: false },
      { entityId: 'o3', auxiliaryId: '', tombstone: false },
    ]))
  })
})
