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
  isUninformative,
  readEntityMap,
  readEntityMapOrDefect,
  summarizeModelDefects,
  type ModelDefect,
} from './modelDefects.js'

describe('readEntityMapOrDefect', () => {
  it('returns the map and no defect for a normal shard', () => {
    const result = readEntityMapOrDefect({ objects: { a: { id: 'a' } } }, 'objects', 'object-shard', 'u')
    expect(result.defect).toBeNull()
    expect(Object.keys(result.map)).toEqual(['a'])
  })

  it('treats a PRESENT-but-empty map as normal, not as a defect', () => {
    // `{ objects: {} }` is exactly what `createObjectShardHandle({ objects: {} })`
    // writes and what a user who deleted everything leaves behind. Reporting it
    // would put a defect on every empty workspace in the fleet.
    const result = readEntityMapOrDefect({ objects: {} }, 'objects', 'object-shard', 'u')
    expect(result.defect).toBeNull()
    expect(result.map).toEqual({})
  })

  it('reports an ABSENT field as uninitialised', () => {
    // The real-world case: an Automerge document with no data chunk resolves
    // happily and `doc()` returns `{}`.
    const result = readEntityMapOrDefect({}, 'objects', 'object-shard', 'u')
    expect(result.defect).toEqual({ kind: 'document-uninitialised', source: 'object-shard', url: 'u' })
    expect(result.map).toEqual({})
  })

  it('reports a field that is undefined the same as an absent one', () => {
    // Automerge rejects undefined values, so a field reading undefined is a
    // field that is not there. Distinguishing them would be a distinction
    // production cannot produce.
    const result = readEntityMapOrDefect({ objects: undefined }, 'objects', 'object-shard', 'u')
    expect(result.defect?.kind).toBe('document-uninitialised')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not a document'],
    ['an array', [1, 2]],
  ])('reports %s as unreadable', (_label, doc) => {
    const result = readEntityMapOrDefect(doc, 'objects', 'object-shard', 'u')
    expect(result.defect?.kind).toBe('document-unreadable')
  })

  it('reports a non-map field distinctly from an absent one', () => {
    const result = readEntityMapOrDefect({ objects: ['a', 'b'] }, 'objects', 'object-shard', 'u')
    expect(result.defect?.kind).toBe('field-not-a-map')
  })
})

describe('readEntityMap (collecting form)', () => {
  it('appends to the caller list rather than replacing it', () => {
    const defects: ModelDefect[] = [{ kind: 'root-no-model-reference', source: 'root', url: null }]
    readEntityMap({}, 'objects', 'object-shard', 'u', defects)
    expect(defects).toHaveLength(2)
  })
})

describe('isUninformative', () => {
  it.each([
    ['document-unreadable', true],
    ['document-uninitialised', true],
    // A field that IS there but has the wrong type is corruption, not absence:
    // the writer reached the document. Deleting on that basis is at least
    // acting on something that was really written.
    ['field-not-a-map', false],
    ['root-no-model-reference', false],
  ] as const)('%s -> %s', (kind, expected) => {
    expect(isUninformative({ kind, source: 'object-shard', url: 'u' })).toBe(expected)
  })

  it('is false for no defect at all', () => {
    expect(isUninformative(null)).toBe(false)
  })
})

describe('summarizeModelDefects', () => {
  it('says "none" rather than an empty string', () => {
    expect(summarizeModelDefects([])).toBe('none')
  })

  it('groups by source and kind and caps the urls listed', () => {
    const defects: ModelDefect[] = Array.from({ length: 9 }, (_, index) => ({
      kind: 'document-uninitialised', source: 'object-shard', url: `automerge:shard${index}`,
    }))
    const summary = summarizeModelDefects(defects, { maxUrls: 2 })
    expect(summary).toContain('object-shard/document-uninitialised=9')
    expect(summary).toContain('…')
  })

  it('bounds the total length, because this string reaches a TEXT column', () => {
    const defects: ModelDefect[] = Array.from({ length: 40 }, (_, index) => ({
      kind: 'document-uninitialised', source: 'object-shard', url: `automerge:${'x'.repeat(60)}${index}`,
    }))
    expect(summarizeModelDefects(defects, { maxUrls: 40, maxLength: 200 }).length).toBeLessThanOrEqual(200)
  })

  it('names the root without a url instead of printing "null"', () => {
    expect(summarizeModelDefects([{ kind: 'root-no-model-reference', source: 'root', url: null }]))
      .toContain('<root>')
  })
})
