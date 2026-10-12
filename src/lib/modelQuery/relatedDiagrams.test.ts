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
import type { Diagram } from '../../types'
import { boundRelatedDiagrams, emptyRelatedDiagrams } from './relatedDiagrams'

function diagram(index: number): Diagram {
  const suffix = String(index).padStart(5, '0')
  return {
    id: `fan-${suffix}`,
    name: `Shared architecture ${suffix}`,
    type: 'container',
    objectIds: ['shared'],
    connectionIds: [],
    groupIds: [],
  }
}

describe('bounded related diagrams', () => {
  it('never exposes a 10k fan-out to a React consumer', () => {
    const input = { detail: [], reference: Array.from({ length: 10_000 }, (_, index) => diagram(index)), parent: [] }
    const result = boundRelatedDiagrams(input, { limit: 50 })

    expect(result.reference).toHaveLength(50)
    expect(result.totals.reference).toBe(10_000)
    expect(result.limit).toBe(50)
    expect(result.truncated).toBe(true)
  })

  it('searches the complete fan-out before applying the limit', () => {
    const input = { detail: [], reference: Array.from({ length: 10_000 }, (_, index) => diagram(index)), parent: [] }
    const result = boundRelatedDiagrams(input, { query: '09999', limit: 50 })

    expect(result.reference.map((item) => item.id)).toEqual(['fan-09999'])
    expect(result.totals.reference).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('clamps empty responses to the public 1..100 limit contract', () => {
    expect(emptyRelatedDiagrams(1_000).limit).toBe(100)
    expect(emptyRelatedDiagrams(0).limit).toBe(1)
  })
})
