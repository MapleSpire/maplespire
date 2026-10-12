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
  OVERLAY_WRITE_HEAD_VERSION,
  planBfsWriteMode,
  planOverlayWriteHeads,
  shouldRotateOverlayWriteHead,
} from './overlayWriteHead'

const valid = (url: string) => url.startsWith('automerge:')

describe('bounded overlay write heads', () => {
  it('never selects historical segments for interactive hydration', () => {
    const plan = planOverlayWriteHeads({
      editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
      editsObjectShardUrls: ['automerge:old-a', 'automerge:old-b', 'automerge:object-head'],
      editsObjectShardUrl: 'automerge:object-head',
      editsConnectionShardUrls: ['automerge:old-c', 'automerge:connection-head'],
      editsConnectionShardUrl: 'automerge:connection-head',
    }, valid)

    expect(plan).toEqual({
      migrateLegacy: false,
      objectUrl: 'automerge:object-head',
      connectionUrl: 'automerge:connection-head',
      historicalObjectSegments: 2,
      historicalConnectionSegments: 1,
    })
  })

  it('rotates legacy heads without resolving their contents', () => {
    const validator = vi.fn(valid)
    const plan = planOverlayWriteHeads({
      editsObjectShardUrls: ['automerge:large-legacy-a', 'automerge:large-legacy-b'],
      editsObjectShardUrl: 'automerge:large-legacy-b',
      editsConnectionShardUrls: ['automerge:large-legacy-c'],
      editsConnectionShardUrl: 'automerge:large-legacy-c',
    }, validator)

    expect(plan.migrateLegacy).toBe(true)
    expect(plan.objectUrl).toBeUndefined()
    expect(plan.connectionUrl).toBeUndefined()
    expect(plan.historicalObjectSegments).toBe(1)
    expect(plan.historicalConnectionSegments).toBe(0)
    expect(validator).toHaveBeenCalledTimes(5)
  })

  it('creates only the missing side of a versioned head pair', () => {
    const plan = planOverlayWriteHeads({
      editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
      editsObjectShardUrls: ['automerge:object-head'],
      editsObjectShardUrl: 'automerge:object-head',
      editsConnectionShardUrls: [],
    }, valid)

    expect(plan.migrateLegacy).toBe(false)
    expect(plan.objectUrl).toBe('automerge:object-head')
    expect(plan.connectionUrl).toBeUndefined()
  })

  it('retains the legacy current head when first opened offline', () => {
    const plan = planOverlayWriteHeads({
      editsObjectShardUrls: ['automerge:legacy-old', 'automerge:legacy-current'],
      editsObjectShardUrl: 'automerge:legacy-current',
      editsConnectionShardUrls: ['automerge:legacy-connection'],
      editsConnectionShardUrl: 'automerge:legacy-connection',
    }, valid, false)

    expect(plan.migrateLegacy).toBe(false)
    expect(plan.objectUrl).toBe('automerge:legacy-current')
    expect(plan.connectionUrl).toBe('automerge:legacy-connection')
  })

  it('enters bfs when both heads are valid and the version is current', () => {
    expect(planBfsWriteMode({
      editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
      editsObjectShardUrl: 'automerge:object-head',
      editsObjectShardUrls: ['automerge:object-head'],
      editsConnectionShardUrl: 'automerge:connection-head',
      editsConnectionShardUrls: ['automerge:connection-head'],
    }, valid)).toEqual({ mode: 'bfs' })
  })

  it('falls back to resident ONLY when the overlay is provably empty (born-broken meta)', () => {
    // A client-authored ModelMeta carrying shard arrays and NONE of the edits*
    // fields. Nothing was ever written to an overlay, so the base shards are
    // the whole model and the resident path is a lossless, immediately-durable
    // downgrade. A planner that never falls back fails here.
    const plan = planBfsWriteMode({}, valid)
    expect(plan.mode).toBe('resident-fallback')
  })

  it('stays on bfs (degraded) when heads are missing but overlay SEGMENTS are listed', () => {
    // A planner that falls back whenever heads are unusable fails here: resident
    // projection merges no overlay, so falling back would hide the content of
    // these segments and let new edits fork from a stale view.
    const plan = planBfsWriteMode({
      editsObjectShardUrls: ['automerge:orphan-segment'],
    }, valid)
    expect(plan.mode).toBe('bfs-degraded')
  })

  it('stays on bfs (degraded) when pending tombstones exist', () => {
    // Meta tombstones are overlay state too: resident projection does not
    // filter them, so a fallback would resurrect deleted entities on screen.
    const plan = planBfsWriteMode({ deletedObjectIds: ['gone'] }, valid)
    expect(plan.mode).toBe('bfs-degraded')
    expect(planBfsWriteMode({ deletedConnectionIds: ['gone'] }, valid).mode).toBe('bfs-degraded')
  })

  it('stays on bfs (degraded) on a legacy write-head version — heads present, protocol stale', () => {
    // fsck `write-head-version`: writeEditsShards plans this shape as needing
    // rotation and bails, so the write path is wedged — but the legacy head may
    // hold arbitrary content, which rules the resident fallback out.
    const plan = planBfsWriteMode({
      editsObjectShardUrl: 'automerge:legacy-head',
      editsObjectShardUrls: ['automerge:legacy-head'],
      editsConnectionShardUrl: 'automerge:legacy-conn',
      editsConnectionShardUrls: ['automerge:legacy-conn'],
    }, valid)
    expect(plan.mode).toBe('bfs-degraded')
    expect((plan as { reason: string }).reason).toContain('legacy')
  })

  it('stays on bfs (degraded) when only ONE head is missing', () => {
    const plan = planBfsWriteMode({
      editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
      editsObjectShardUrl: 'automerge:object-head',
      editsObjectShardUrls: ['automerge:object-head'],
    }, valid)
    expect(plan.mode).toBe('bfs-degraded')
  })

  it('rotates from a durable cross-session batch count', () => {
    expect(shouldRotateOverlayWriteHead({
      entryCount: 1,
      pendingNewIds: 0,
      durableBatchCount: 32,
      limit: 32,
    })).toBe(true)
    expect(shouldRotateOverlayWriteHead({
      entryCount: 1,
      pendingNewIds: 0,
      durableBatchCount: 31,
      limit: 32,
    })).toBe(false)
  })
})
