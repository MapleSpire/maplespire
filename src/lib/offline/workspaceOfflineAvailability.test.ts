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
import type { ModelCacheWorkspaceMeta } from '../modelQuery/idbSchema'
import { assessWorkspaceOfflineCapacity } from './workspaceOfflineAvailability'

const MIB = 1024 * 1024

function meta(bytes: number): ModelCacheWorkspaceMeta {
  return {
    workspaceKey: 'ls/v1', activeGeneration: 2, serverGeneration: 2,
    coverage: 'working-set', pinned: false, lastAccessAt: 1,
    objectCount: 10, connectionCount: 0, accountedBytes: { objects: bytes },
    generationStats: { '2': { objectCount: 10, connectionCount: 0, accountedBytes: { objects: bytes } } },
  }
}

const estimate = {
  objectCount: 100, groupCount: 2, connectionCount: 300,
  rawPayloadBytes: 1, searchCharacters: 1, estimatedBytes: 100 * MIB,
}

describe('assessWorkspaceOfflineCapacity', () => {
  it('counts only the net replacement of the current working set', () => {
    const result = assessWorkspaceOfflineCapacity(
      estimate, [meta(20 * MIB)], { usageBytes: 200 * MIB, quotaBytes: 2_000 * MIB }, 'ls/v1',
    )
    expect(result.additionalBytes).toBe(80 * MIB)
    expect(result.desiredDerivedBytes).toBe(100 * MIB)
    expect(result.fits).toBe(true)
  })

  it('rejects a download that would consume protected quota headroom', () => {
    const result = assessWorkspaceOfflineCapacity(
      { ...estimate, estimatedBytes: 400 * MIB },
      [meta(20 * MIB)],
      { usageBytes: 900 * MIB, quotaBytes: 1_024 * MIB },
      'ls/v1',
    )
    expect(result.fits).toBe(false)
  })

  it('counts an interrupted target generation toward a resumed download', () => {
    const interrupted = meta(20 * MIB)
    interrupted.generationStats['3'] = {
      objectCount: 50,
      connectionCount: 100,
      accountedBytes: { objects: 60 * MIB },
    }
    interrupted.offlineDownload = {
      generation: 3, serverGeneration: 3, status: 'paused', phase: 'connections',
      nextCursor: 'next', objectCount: 50, connectionCount: 100, diagramCount: 0,
      pinned: true, ownerId: 'old-tab', leaseExpiresAt: 0, startedAt: 1, updatedAt: 2,
    }
    const result = assessWorkspaceOfflineCapacity(
      estimate,
      [interrupted],
      { usageBytes: 240 * MIB, quotaBytes: 2_000 * MIB },
      'ls/v1',
    )
    expect(result.additionalBytes).toBe(40 * MIB)
    expect(result.desiredDerivedBytes).toBe(120 * MIB)
  })
})
