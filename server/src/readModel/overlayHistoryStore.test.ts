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
  acknowledgeOverlayBatches,
  isTerminalOverlayBatchStatus,
  overlayBatchStatuses,
  synchronizeOverlayHead,
  overlaySegmentSnapshots,
  synchronizeOverlaySegments,
} from './overlayHistoryStore.js'

const key = { landscapeId: 'land', versionId: 'version' }

describe('overlay history persistence', () => {
  it('distinguishes forwarding from terminal server acknowledgement', () => {
    expect(isTerminalOverlayBatchStatus('forwarding')).toBe(false)
    expect(isTerminalOverlayBatchStatus('forwarding_conflict')).toBe(false)
    expect(isTerminalOverlayBatchStatus('projected')).toBe(true)
    expect(isTerminalOverlayBatchStatus('forwarded')).toBe(true)
    expect(isTerminalOverlayBatchStatus('conflict')).toBe(true)
  })

  it('keeps a conflicting forward non-terminal until the current head projects it', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    await acknowledgeOverlayBatches(
      { query } as never, key, 'object', 'current', ['batch-1'],
      'forwarding_conflict', 4, 0,
    )
    const [sql] = query.mock.calls[0]
    expect(sql).toContain("status = 'forwarding_conflict'")
    expect(sql).toContain("THEN 'conflict'")
  })

  it('promotes a forwarding batch to forwarded when the current head projects it', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    await acknowledgeOverlayBatches({ query } as never, key, 'object', 'current', ['batch-1'], 'projected', 4, 9)
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain("status = 'forwarding'")
    expect(sql).toContain("THEN 'forwarded'")
    expect(params).toEqual(['land', 'version', 'current', 'object', 'projected', 4, 9, ['batch-1']])
  })

  it('returns only persisted statuses and leaves missing ids pending', async () => {
    const query = vi.fn(async () => ({
      rows: [{ batch_id: 'batch-1', status: 'conflict', document_id: 'old', updated_at: '2026-07-26T00:00:00.000Z' }],
      rowCount: 1,
    }))
    await expect(overlayBatchStatuses({ query } as never, key, ['batch-1', 'batch-2'])).resolves.toEqual([{
      batchId: 'batch-1', status: 'conflict', documentId: 'old', updatedAt: '2026-07-26T00:00:00.000Z',
    }])
  })

  it('restores projected segment snapshots including known-empty segments', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { document_id: 'old', last_projected_snapshot: {} },
        { document_id: 'current', last_projected_snapshot: { o1: { id: 'o1' } } },
      ],
      rowCount: 2,
    }))
    await expect(overlaySegmentSnapshots(
      { query } as never, key, 'object', ['old', 'current'],
    )).resolves.toEqual(new Map([
      ['old', {}],
      ['current', { o1: { id: 'o1' } }],
    ]))
    expect(query.mock.calls[0]?.[1]).toEqual(['land', 'version', 'object', ['old', 'current']])
  })

  it('demotes every current row before promoting exactly one synchronized head', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    await synchronizeOverlaySegments(
      { query } as never, key, 'object',
      ['automerge:old', 'automerge:current'], 'automerge:current',
    )
    expect(query).toHaveBeenCalledTimes(4)
    expect(String(query.mock.calls[0]?.[0])).toContain('pg_advisory_xact_lock')
    expect(query.mock.calls[0]?.[1]).toEqual(['overlay-rotation:land:version:object'])
    // The HASH EXPRESSION as well as the key text. Both halves are the wire
    // format: `hashtext($1)` and `hashtextextended($1, 0)` are different
    // functions returning different values, so a door using one excludes
    // nothing from a door using the other. These two takers spell the statement
    // by hand, so only this assertion pins their expression.
    expect(String(query.mock.calls[0]?.[0])).toContain('hashtextextended($1, 0)')
    expect(String(query.mock.calls[1]?.[0])).toContain('AND is_current')
    expect(String(query.mock.calls[1]?.[0])).not.toContain('IS DISTINCT FROM')
    expect(String(query.mock.calls[2]?.[0])).toContain('jsonb_to_recordset')
    expect(String(query.mock.calls[2]?.[0])).toContain('is_current = false')
    expect(query.mock.calls[2]?.[1]).toEqual([
      JSON.stringify([
        { documentId: 'old', url: 'automerge:old' },
        { documentId: 'current', url: 'automerge:current' },
      ]),
      'land', 'version', 'object', 30,
    ])
    expect(String(query.mock.calls[3]?.[0])).toContain('SET is_current = true')
    expect(query.mock.calls[3]?.[1]).toEqual(['land', 'version', 'object', 'current'])
  })

  it('synchronizes an enterprise overlay history in a bounded query count', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    const urls = Array.from({ length: 1_000 }, (_, index) => `automerge:segment-${index}`)
    await synchronizeOverlaySegments(
      { query } as never, key, 'object', urls, urls.at(-1),
    )

    expect(query).toHaveBeenCalledTimes(4)
    const segments = JSON.parse(String(query.mock.calls[2]?.[1]?.[0])) as unknown[]
    expect(segments).toHaveLength(1_000)
  })

  it('promotes a rotated head without replaying retained history', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    await synchronizeOverlayHead(
      { query } as never, key, 'object', 'automerge:current',
    )

    expect(query).toHaveBeenCalledTimes(3)
    expect(String(query.mock.calls[0]?.[0])).toContain('pg_advisory_xact_lock')
    // THE KEY, asserted here as it is for `synchronizeOverlaySegments`. A
    // changed key here alone would silently stop excluding this
    // transaction-scope taker from the session-scope ones, whose purpose is to
    // stop two transactions tripping `idx_read_model_overlay_segments_current`.
    expect(query.mock.calls[0]?.[1]).toEqual(['overlay-rotation:land:version:object'])
    expect(String(query.mock.calls[0]?.[0])).toContain('hashtextextended($1, 0)')
    expect(String(query.mock.calls[1]?.[0])).toContain('document_id <> $4')
    expect(String(query.mock.calls[2]?.[0])).toContain('is_current = true')
    expect(query.mock.calls[2]?.[1]).toEqual([
      'land', 'version', 'object', 'current', 'automerge:current',
    ])
  })
})
