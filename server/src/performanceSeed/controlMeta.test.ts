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

import { describe, expect, it } from 'vitest'
import {
  materializeAcknowledgedOverlayState,
  pruneCoveredPerformanceOverlayHistory,
  toPerformanceControlMeta,
} from './controlMeta.js'
import { OVERLAY_WRITE_HEAD_VERSION } from '../modelMeta.js'

describe('toPerformanceControlMeta', () => {
  it('removes immutable shard routes while preserving ordered editable control state', () => {
    const compact = toPerformanceControlMeta({
      objectShardUrls: ['base-o-1', 'base-o-2', 'overlay-o'],
      connectionShardUrls: ['base-c', 'overlay-c'],
      decisionRecordShardUrls: ['adr-1', 'adr-2'],
      editsObjectShardUrl: 'overlay-o',
      editsObjectShardUrls: ['overlay-o-old', 'overlay-o'],
      editsConnectionShardUrl: 'overlay-c',
      deletedObjectIds: ['gone'],
      domains: { d: { id: 'd' } },
    })
    expect(compact).toMatchObject({
      staticBaseline: true,
      objectShardUrls: ['overlay-o-old', 'overlay-o'],
      connectionShardUrls: ['overlay-c'],
      decisionRecordShardUrls: [],
      editsObjectShardUrl: 'overlay-o',
      deletedObjectIds: ['gone'],
      domains: { d: { id: 'd' } },
    })
    // `toMatchObject` above ignores keys it does not name, so the overlay list
    // and protocol version are asserted explicitly.
    expect(compact.editsObjectShardUrls).toEqual(['overlay-o-old', 'overlay-o'])
    expect(compact.editsOverlayWriteHeadVersion).toBe(OVERLAY_WRITE_HEAD_VERSION)
  })

  it('prunes only acknowledged retired overlays fully covered by tombstones', () => {
    const source = {
      editsObjectShardUrls: ['empty', 'deleted-only', 'business', 'unknown', 'current'],
      editsObjectShardUrl: 'current',
      editsConnectionShardUrls: ['connection-old', 'connection-current'],
      editsConnectionShardUrl: 'connection-current',
      deletedObjectIds: ['qa-1', 'qa-2'],
      deletedConnectionIds: ['gone-connection'],
    }
    const pruned = pruneCoveredPerformanceOverlayHistory(source, {
      objects: new Map([
        ['empty', {}],
        ['deleted-only', { 'qa-1': { id: 'qa-1' }, 'qa-2': { id: 'qa-2' } }],
        ['business', { 'qa-1': { id: 'qa-1' }, keep: { id: 'keep' } }],
        ['current', {}],
      ]),
      connections: new Map([
        ['connection-old', { 'gone-connection': { id: 'gone-connection' } }],
        ['connection-current', {}],
      ]),
    })
    expect(pruned.editsObjectShardUrls).toEqual(['business', 'unknown', 'current'])
    expect(pruned.objectShardUrls).toEqual(['business', 'unknown', 'current'])
    expect(pruned.editsConnectionShardUrls).toEqual(['connection-current'])
    expect(pruned.deletedObjectIds).toEqual(['qa-1', 'qa-2'])
    expect(pruned.editsObjectShardUrl).toBe('current')
  })

  it('drops only disposable tombstones proven absent from every retained overlay', () => {
    const disposable = (id: string) => id.startsWith('qa-')
    const source = {
      editsObjectShardUrls: ['qa-only', 'business', 'clean-current'],
      editsObjectShardUrl: 'clean-current',
      deletedObjectIds: ['qa-gone', 'qa-still-present', 'business-deletion'],
    }
    const snapshots = {
      objects: new Map([
        ['qa-only', { 'qa-gone': { id: 'qa-gone' } }],
        ['business', { keep: { id: 'keep' }, 'qa-still-present': { id: 'qa-still-present' } }],
        ['clean-current', {}],
      ]),
      connections: new Map<string, Record<string, unknown>>(),
    }

    const pruned = pruneCoveredPerformanceOverlayHistory(source, snapshots, {
      disposableObjectId: disposable,
    })

    expect(pruned.editsObjectShardUrls).toEqual(['business', 'clean-current'])
    expect(pruned.deletedObjectIds).toEqual(['qa-still-present', 'business-deletion'])

    snapshots.objects.delete('business')
    const conservative = pruneCoveredPerformanceOverlayHistory(source, snapshots, {
      disposableObjectId: disposable,
    })
    expect(conservative.deletedObjectIds).toEqual(source.deletedObjectIds)
  })

  it('materializes ordered overlay state only when every source is acknowledged', () => {
    const snapshots = new Map<string, Record<string, unknown>>([
      ['old', { replaced: { value: 'old' }, kept: { value: true } }],
      ['new', { replaced: { value: 'new' }, removed: { value: true } }],
    ])
    expect(materializeAcknowledgedOverlayState(
      ['old', 'new'], snapshots, new Set(['removed']),
    )).toEqual({ replaced: { value: 'new' }, kept: { value: true } })
    expect(materializeAcknowledgedOverlayState(
      ['old', 'missing'], snapshots, new Set(),
    )).toBeNull()
  })
})
