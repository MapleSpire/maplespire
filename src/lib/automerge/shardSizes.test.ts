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
import { importDocumentIdBudget } from './shardSizes'

describe('importDocumentIdBudget — every document an import can create', () => {
  const sizes = { registry: 200, model: 512 }

  it('counts the diagrams plus one shard per started block of each collection', () => {
    expect(importDocumentIdBudget({ diagrams: 17, objects: 40, connections: 60 }, sizes)).toBe(17 + 1 + 1 + 1)
  })

  it('a collection that spans blocks needs a shard per block', () => {
    // 401 diagrams → 3 registry shards; 1 025 objects → 3; 512 connections → 1.
    expect(importDocumentIdBudget({ diagrams: 401, objects: 1025, connections: 512 }, sizes)).toBe(401 + 3 + 3 + 1)
  })

  it('an empty collection needs no shard', () => {
    expect(importDocumentIdBudget({ diagrams: 2, objects: 0, connections: 0 }, sizes)).toBe(3)
    expect(importDocumentIdBudget({ diagrams: 0, objects: 0, connections: 0 }, sizes)).toBe(0)
  })

  it('a non-positive size (a bad env override) adds nothing rather than Infinity', () => {
    expect(importDocumentIdBudget({ diagrams: 2, objects: 5, connections: 5 }, { registry: 0, model: 0 })).toBe(2)
  })
})
