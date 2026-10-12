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
import { planDerivedCacheRetention } from './cacheRetention'

const MIB = 1024 * 1024

function meta(bytes: number): ModelCacheWorkspaceMeta {
  return {
    workspaceKey: 'ls/v1', activeGeneration: 1, serverGeneration: 1,
    coverage: 'full', pinned: false, lastAccessAt: 1,
    objectCount: 1, connectionCount: 0,
    accountedBytes: { objects: bytes },
    generationStats: { '1': { objectCount: 1, connectionCount: 0, accountedBytes: { objects: bytes } } },
  }
}

describe('planDerivedCacheRetention', () => {
  it('keeps a bounded cache when quota headroom is healthy', () => {
    const plan = planDerivedCacheRetention([meta(100 * MIB)], { usageBytes: 500 * MIB, quotaBytes: 4_000 * MIB })
    expect(plan.bytesToFree).toBe(0)
    expect(plan.accountedBytes).toBe(100 * MIB)
  })

  it('calculates bytes to evict when derived data crowds protected headroom', () => {
    const plan = planDerivedCacheRetention([meta(300 * MIB)], { usageBytes: 900 * MIB, quotaBytes: 1_024 * MIB })
    expect(plan.bytesToFree).toBe(132 * MIB)
  })
})
