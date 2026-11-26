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
  BASE_SHARD_STORAGE_COMPACTION_FLAG,
  BaseShardStorageCompactionConfigError,
  baseShardStorageCompactionMode,
} from './baseShardStorageCompactionConfig.js'

describe('AM_BASE_SHARD_STORAGE_COMPACTION (G4-16f F1 kill switch)', () => {
  it('missing, blank and on are on (the default)', () => {
    expect(baseShardStorageCompactionMode({})).toBe('on')
    expect(baseShardStorageCompactionMode({ [BASE_SHARD_STORAGE_COMPACTION_FLAG]: '' })).toBe('on')
    expect(baseShardStorageCompactionMode({ [BASE_SHARD_STORAGE_COMPACTION_FLAG]: ' on ' })).toBe('on')
  })

  it('off is off', () => {
    expect(baseShardStorageCompactionMode({ [BASE_SHARD_STORAGE_COMPACTION_FLAG]: 'off' })).toBe('off')
  })

  it('anything else refuses to boot', () => {
    for (const value of ['OFF', 'false', '0', 'shadow', 'yes']) {
      expect(() => baseShardStorageCompactionMode({ [BASE_SHARD_STORAGE_COMPACTION_FLAG]: value }))
        .toThrow(BaseShardStorageCompactionConfigError)
    }
  })
})
