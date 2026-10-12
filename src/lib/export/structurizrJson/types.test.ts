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
import { createExportIds, type WireIdBearer } from './types'

const carrying = (id: string, wireId?: string): WireIdBearer => ({
  id,
  ...(wireId === undefined ? {} : { properties: { 'structurizr.id': wireId } }),
})

describe('ExportIds — wire ids', () => {
  it('re-emits the wire id an imported entity carries', () => {
    const ids = createExportIds([carrying('object-a', '42')])
    expect(ids.wireId(carrying('object-a', '42'))).toBe('42')
  })

  it('mints an id for an entity created in MapleSpire, and keeps giving the same one', () => {
    const ids = createExportIds([carrying('object-a')])
    const first = ids.wireId(carrying('object-a'))
    expect(first).not.toBe('')
    expect(ids.wireId(carrying('object-a'))).toBe(first)
    expect(ids.peekWireId('object-a')).toBe(first)
  })

  it('never mints an id another entity carries, whichever order they are asked in', () => {
    // "1" is what a naive counter hands out first, and it is exactly the id the
    // second entity carries. Reserving carried ids only when their owner is
    // reached would collide here — and upstream a duplicate id is not an error:
    // the TreeSet keeps the incumbent and drops the other silently.
    const entities = [carrying('minted'), carrying('imported', '1')]
    const ids = createExportIds(entities)

    const minted = ids.wireId(entities[0]!)
    const imported = ids.wireId(entities[1]!)

    expect(imported).toBe('1')
    expect(minted).not.toBe('1')
    expect(minted).not.toBe(imported)
  })

  it('gives every entity a distinct id across a mixed batch', () => {
    const entities = [
      carrying('a', '3'),
      carrying('b'),
      carrying('c', '1'),
      carrying('d'),
      carrying('e', '2'),
      carrying('f'),
    ]
    const ids = createExportIds(entities)
    const allocated = entities.map((entity) => ids.wireId(entity))
    expect(new Set(allocated).size).toBe(entities.length)
    expect(allocated[0]).toBe('3')
    expect(allocated[2]).toBe('1')
    expect(allocated[4]).toBe('2')
  })

  it('re-mints for the second of two entities carrying the same wire id, and reports it', () => {
    // Duplicating an imported shape in MapleSpire copies its properties, so two
    // shapes can claim one wire id. Both must reach the file.
    const original = carrying('original', '7')
    const copy = carrying('copy', '7')
    const ids = createExportIds([original, copy])

    expect(ids.wireId(original)).toBe('7')
    const copied = ids.wireId(copy)
    expect(copied).not.toBe('7')
    expect(ids.reMinted).toEqual([{ entityId: 'copy', carried: '7', minted: copied }])
  })

  it('treats a blank carried id as no id at all', () => {
    const blank: WireIdBearer = { id: 'blank', properties: { 'structurizr.id': '   ' } }
    const ids = createExportIds([blank])
    expect(ids.wireId(blank)).not.toBe('')
    expect(ids.wireId(blank).trim()).toBe(ids.wireId(blank))
    expect(ids.reMinted).toEqual([])
  })
})

describe('ExportIds — view keys', () => {
  const diagram = (id: string, name: string, sourceViewKey?: string) => ({
    id,
    name,
    ...(sourceViewKey === undefined ? {} : { sourceViewKey }),
  })

  it('keeps the key a diagram was imported under', () => {
    const ids = createExportIds([])
    expect(ids.viewKey(diagram('d1', 'Containers of X', 'Containers'))).toBe('Containers')
  })

  it('slugs a name that was never a Structurizr view, and stays stable', () => {
    const ids = createExportIds([])
    const key = ids.viewKey(diagram('d1', 'Payments / Core'))
    expect(key).toBe('Payments-Core')
    expect(ids.viewKey(diagram('d1', 'Payments / Core'))).toBe(key)
  })

  it('never emits a key containing a slash', () => {
    // Structurizr's own setter rewrites `/` to `_`; doing it here means the key
    // we emit is the key `defaultView` later points at.
    const ids = createExportIds([])
    expect(ids.viewKey(diagram('d1', 'x', 'Team/Containers'))).toBe('Team_Containers')
  })

  it('separates keys that differ only in case', () => {
    // View.compareTo compares keys case-insensitively, so same-order keys
    // differing only in case lose one to a TreeSet before validation runs.
    const ids = createExportIds([])
    expect(ids.viewKey(diagram('d1', 'x', 'Containers'))).toBe('Containers')
    expect(ids.viewKey(diagram('d2', 'x', 'containers'))).toBe('containers-2')
  })
})
