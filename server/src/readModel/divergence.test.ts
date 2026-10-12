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
  comparePass,
  confirmDivergence,
  entityHash,
  summarizeDivergence,
  type DivergenceItem,
  type DivergencePass,
} from './divergence.js'

const entity = (id: string, fields: Record<string, unknown> = {}) => ({ id, fields })
const emptyCounts = (): DivergencePass['counts'] => ({
  object: { crdt: 0, readModel: 0 },
  connection: { crdt: 0, readModel: 0 },
  group: { crdt: 0, readModel: 0 },
  diagram: { crdt: 0, readModel: 0 },
  flow: { crdt: 0, readModel: 0 },
})
const pass = (items: DivergenceItem[]): DivergencePass => ({ counts: emptyCounts(), items })

describe('entityHash', () => {
  it('ignores key order, so field ordering cannot fake a mismatch', () => {
    expect(entityHash({ a: 1, b: 2 })).toBe(entityHash({ b: 2, a: 1 }))
  })

  it('treats an absent field and an undefined one as equal', () => {
    // The read model cannot represent the difference, so reporting it would be
    // a permanent false positive on every entity with an optional field.
    expect(entityHash({ a: 1, b: undefined })).toBe(entityHash({ a: 1 }))
  })

  it('distinguishes null from absent', () => {
    expect(entityHash({ a: null })).not.toBe(entityHash({}))
  })

  it('detects a real value change', () => {
    expect(entityHash({ name: 'x' })).not.toBe(entityHash({ name: 'y' }))
  })
})

describe('comparePass', () => {
  it('reports nothing when both sides agree', () => {
    const left = [entity('a', { name: 'A' }), entity('b', { name: 'B' })]
    const right = [entity('b', { name: 'B' }), entity('a', { name: 'A' })]
    expect(comparePass('object', left, right)).toEqual([])
  })

  it('reports an entity the projector never wrote', () => {
    const items = comparePass('object', [entity('a')], [])
    expect(items).toEqual([{ kind: 'missing-in-read-model', entity: 'object', id: 'a' }])
  })

  it('reports a read-model row with no CRDT counterpart', () => {
    // A stale row that survived a delete — the read model claiming something
    // the model does not contain.
    const items = comparePass('object', [], [entity('ghost')])
    expect(items).toEqual([{ kind: 'missing-in-crdt', entity: 'object', id: 'ghost' }])
  })

  it('names the differing FIELDS and not their values', () => {
    // Values carry customer content and this report reaches logs and metrics.
    const items = comparePass('object', [entity('a', { name: 'secret', kind: 'x' })], [entity('a', { name: 'other', kind: 'x' })])
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('content-mismatch')
    expect(items[0]!.detail).toBe('fields: name')
    expect(JSON.stringify(items)).not.toContain('secret')
  })

  it('caps the item list so a 100k-object workspace cannot produce an unreadable report', () => {
    const many = Array.from({ length: 500 }, (_, i) => entity(`o${i}`))
    expect(comparePass('object', many, [], { maxItems: 10 })).toHaveLength(10)
  })
})

describe('confirmDivergence', () => {
  it('treats a difference that healed between passes as LAG, not divergence', () => {
    const first = pass([{ kind: 'missing-in-read-model', entity: 'object', id: 'a' }])
    const result = confirmDivergence(first, pass([]), { generationBefore: 7, generationAfter: 7 })
    expect(result.outcome).toBe('clean')
    expect(result.healed).toBe(1)
  })

  it('confirms a difference that survived both passes at an unchanged generation', () => {
    const item: DivergenceItem = { kind: 'content-mismatch', entity: 'object', id: 'a' }
    const result = confirmDivergence(pass([item]), pass([item]), { generationBefore: 7, generationAfter: 7 })
    expect(result.outcome).toBe('diverged')
    expect(result.confirmed).toEqual([item])
  })

  it('is INCONCLUSIVE when the projector advanced between passes', () => {
    // It was working, so even a surviving difference is not yet proof. A
    // detector that cries wolf during normal catch-up gets switched off.
    const item: DivergenceItem = { kind: 'content-mismatch', entity: 'object', id: 'a' }
    const result = confirmDivergence(pass([item]), pass([item]), { generationBefore: 7, generationAfter: 8 })
    expect(result.outcome).toBe('inconclusive')
    expect(result.reason).toMatch(/advanced 7 -> 8/)
  })

  it('is INCONCLUSIVE rather than clean when no generation is recorded', () => {
    // No generation means the workspace was never projected; reporting "clean"
    // would let an unprojected workspace pass as verified.
    const result = confirmDivergence(pass([]), pass([]), { generationBefore: null, generationAfter: null })
    expect(result.outcome).toBe('inconclusive')
    expect(result.reason).toMatch(/no projection generation/)
  })

  it('matches items by kind AND id, so a different defect on the same id is not treated as the same one', () => {
    const first = pass([{ kind: 'missing-in-read-model', entity: 'object', id: 'a' }])
    const second = pass([{ kind: 'content-mismatch', entity: 'object', id: 'a' }])
    const result = confirmDivergence(first, second, { generationBefore: 1, generationAfter: 1 })
    expect(result.outcome).toBe('clean')
  })
})

describe('summarizeDivergence', () => {
  it('says "none" for a clean run rather than an empty string', () => {
    expect(summarizeDivergence([])).toBe('none')
  })

  it('groups by entity and kind and caps the ids listed', () => {
    const items: DivergenceItem[] = Array.from({ length: 25 }, (_, i) => ({
      kind: 'missing-in-read-model', entity: 'object', id: `o${i}`,
    }))
    const summary = summarizeDivergence(items, { maxIds: 3 })
    expect(summary).toMatch(/object\/missing-in-read-model=25/)
    expect(summary).toMatch(/…/)
  })
})
