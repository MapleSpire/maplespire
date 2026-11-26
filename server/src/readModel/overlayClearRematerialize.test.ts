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
import * as A from '@automerge/automerge'
import { OVERLAY_CLEAR_MESSAGE, clearedEntryEdits, liveObjects, rematerializedEntity } from './overlayClearRematerialize.js'

type Seg = { objects: Record<string, Record<string, unknown>> }
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

/** A segment holding entry `x`, a copy of it in Marie's offline browser
 * edited there, and the server's clear — merged as her reconnect merges them. */
function offlineEditThenClear(opts: { message?: string | null; edit?: (o: Record<string, unknown>) => void } = {}) {
  let server = A.from<Seg>({ objects: { x: { id: 'x', name: 'old', properties: { k1: 'v1' } }, y: { id: 'y', name: 'kept' } } })
  let marie = A.clone(server)
  marie = A.change(marie, (d) => {
    if (opts.edit) opts.edit(d.objects.x)
    else { d.objects.x.name = 'hers'; (d.objects.x.properties as Record<string, unknown>).k2 = 'v2' }
  })
  const message = opts.message === undefined ? OVERLAY_CLEAR_MESSAGE : opts.message
  server = A.change(server, message === null ? {} : { message }, (d) => { delete d.objects.x })
  return A.merge(server, marie)
}

describe('clearedEntryEdits (G4-16k)', () => {
  it('finds an offline edit inside an entry the clear deleted, with what the clear saw', () => {
    const doc = offlineEditThenClear()
    expect(doc.objects.x).toBeUndefined()
    const found = clearedEntryEdits(doc, null)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ collection: 'objects', id: 'x' })
    expect(json(found[0].mine)).toEqual({ id: 'x', name: 'hers', properties: { k1: 'v1', k2: 'v2' } })
    expect(json(found[0].seen)).toEqual({ id: 'x', name: 'old', properties: { k1: 'v1' } })
  })

  it('leaves a delete that is not the compaction clear alone (a colleague deleted it)', () => {
    expect(clearedEntryEdits(offlineEditThenClear({ message: null }), null)).toEqual([])
    expect(clearedEntryEdits(offlineEditThenClear({ message: 'something else' }), null)).toEqual([])
  })

  it('finds nothing when the clear saw every edit (an ordinary clear)', () => {
    let doc = A.from<Seg>({ objects: { x: { id: 'x', name: 'old' } } })
    doc = A.change(doc, (d) => { d.objects.x.name = 'seen' })
    doc = A.change(doc, { message: OVERLAY_CLEAR_MESSAGE }, (d) => { delete d.objects.x })
    expect(clearedEntryEdits(doc, null)).toEqual([])
  })

  it('reads only the changes after `since`: a scanned late edit is not found again', () => {
    const doc = offlineEditThenClear()
    expect(clearedEntryEdits(doc, A.getHeads(doc))).toEqual([])
    // Heads the document does not know: the whole history is read.
    expect(clearedEntryEdits(doc, ['0'.repeat(64)])).toHaveLength(1)
  })

  it('a late edit arriving after an earlier scan is found from that scan', () => {
    let server = A.from<Seg>({ objects: { x: { id: 'x', name: 'old' } } })
    let marie = A.clone(server)
    server = A.change(server, { message: OVERLAY_CLEAR_MESSAGE }, (d) => { delete d.objects.x })
    const scanned = A.getHeads(server)
    marie = A.change(marie, (d) => { d.objects.x.description = 'offline' })
    server = A.merge(server, marie)
    const found = clearedEntryEdits(server, scanned)
    expect(found).toHaveLength(1)
    expect((found[0].mine as Record<string, unknown>).description).toBe('offline')
  })

  it('a string field\'s text object is live: an ordinary rename is never a candidate', () => {
    let doc = A.from<Seg>({ objects: { x: { id: 'x', name: 'a', properties: { k: 'v' } } } })
    doc = A.change(doc, (d) => { d.objects.x.name = 'b'; (d.objects.x.properties as Record<string, unknown>).k = 'w' })
    const live = liveObjects(doc)
    const rename = A.decodeChange(A.getLastLocalChange(doc)!)
    expect(rename.ops.length).toBeGreaterThan(0)
    expect(rename.ops.every((op) => live.has(op.obj))).toBe(true)
  })

  it('a colleague\'s delete concurrent with the clear: left deleted, whichever sorts first', () => {
    let server = A.from<Seg>({ objects: { x: { id: 'x', name: 'old' } } })
    let marie = A.clone(server)
    let paul = A.clone(server)
    marie = A.change(marie, (d) => { d.objects.x.name = 'hers' })
    paul = A.change(paul, (d) => { delete d.objects.x })
    server = A.change(server, { message: OVERLAY_CLEAR_MESSAGE }, (d) => { delete d.objects.x })
    server = A.merge(A.merge(server, paul), marie)
    expect(clearedEntryEdits(server, null)).toEqual([])
  })

  it('split delivery: an earlier scan\'s late change is the PREVIOUS value, the new one is hers', () => {
    let server = A.from<Seg>({ objects: { x: { id: 'x', name: 'old' } } })
    let marie = A.clone(server)
    server = A.change(server, { message: OVERLAY_CLEAR_MESSAGE }, (d) => { delete d.objects.x })
    marie = A.change(marie, (d) => { d.objects.x.name = 'first' })
    const firstOnly = A.clone(marie)
    marie = A.change(marie, (d) => { d.objects.x.name = 'second' })
    server = A.merge(server, firstOnly)
    const scanned = A.getHeads(server)
    expect(json(clearedEntryEdits(server, null)[0].mine)).toMatchObject({ name: 'first' })
    server = A.merge(server, marie)
    const found = clearedEntryEdits(server, scanned)
    expect(found).toHaveLength(1)
    expect(json(found[0].mine)).toMatchObject({ name: 'second' })
    expect(json(found[0].previous)).toMatchObject({ name: 'first' })
  })

  it('cost: a first scan of a cleared segment of 1 500 entries with 80 late edits stays bounded', () => {
    // The first version made every cleared entry a group with its own views:
    // 108 s on this segment (measured 17/11/2026); 0.19 s after.
    let doc = A.from<Seg>({ objects: {} })
    for (let i = 0; i < 1500; i += 25) {
      doc = A.change(doc, (d) => {
        for (let j = i; j < i + 25; j++) d.objects[`o${j}`] = { id: `o${j}`, name: `fill-${j}`, properties: {}, position: { x: 0, y: 0 } }
      })
    }
    let marie = A.clone(doc)
    doc = A.change(doc, { message: OVERLAY_CLEAR_MESSAGE }, (d) => { for (const k of Object.keys(d.objects)) delete d.objects[k] })
    marie = A.change(marie, (d) => { for (let j = 0; j < 80; j++) d.objects[`o${j}`].name = `edited-${j}` })
    doc = A.merge(doc, marie)
    const started = performance.now()
    const found = clearedEntryEdits(doc, null)
    const ms = performance.now() - started
    expect(found).toHaveLength(80)
    expect(ms).toBeLessThan(10_000)
  }, 60_000)

  it('finds an edit of a map nested inside the deleted entry', () => {
    const doc = offlineEditThenClear({ edit: (o) => { (o.properties as Record<string, unknown>).k1 = 'nested' } })
    const found = clearedEntryEdits(doc, null)
    expect(found).toHaveLength(1)
    expect(json(found[0].mine)).toMatchObject({ properties: { k1: 'nested' } })
  })
})

describe('rematerializedEntity (G4-16k)', () => {
  const seen = { id: 'x', name: 'old', description: 'd', properties: { k1: 'v1' } }
  const mine = { id: 'x', name: 'hers', description: 'd', properties: { k1: 'v1', k2: 'v2' } }

  it('writes her fields over the folded copy', () => {
    expect(rematerializedEntity(mine, seen, { ...seen })).toEqual({ ...mine })
  })

  it('a later write of a field wins; a nested key goes in beside a colleague one', () => {
    const current = { id: 'x', name: 'colleague', description: 'd', properties: { k1: 'v1', k3: 'v3' } }
    expect(rematerializedEntity(mine, seen, current)).toEqual({
      id: 'x', name: 'colleague', description: 'd', properties: { k1: 'v1', k2: 'v2', k3: 'v3' },
    })
  })

  it('owes nothing once her fields are there (her browser rescued them)', () => {
    expect(rematerializedEntity(mine, seen, { ...mine })).toBeNull()
  })

  it('over its own earlier write (PREVIOUS) hers goes in; over a colleague\'s later one it does not', () => {
    const previous = { ...seen, name: 'first' }
    const second = { ...seen, name: 'second' }
    expect(rematerializedEntity(second, seen, { ...previous }, previous)).toMatchObject({ name: 'second' })
    expect(rematerializedEntity(second, seen, { ...seen, name: 'paul' }, previous)).toBeNull()
    // She set it back to what the clear saw, after the first write: hers again.
    expect(rematerializedEntity({ ...seen }, seen, { ...previous }, previous)).toMatchObject({ name: 'old' })
  })

  it('a field she removed is removed', () => {
    const { description: _dropped, ...withoutDescription } = mine
    expect(rematerializedEntity(withoutDescription, seen, { ...seen })).toEqual({ id: 'x', name: 'hers', properties: { k1: 'v1', k2: 'v2' } })
  })
})
