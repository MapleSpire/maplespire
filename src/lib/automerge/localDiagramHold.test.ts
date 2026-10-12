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
import { LocalDiagramHold } from './localDiagramHold'
import type { Diagram } from '../../types'

const dg = (id: string, name = id): Diagram => ({
  id, name, type: 'container', objectIds: [], connectionIds: [], groupIds: [],
})

describe('LocalDiagramHold', () => {
  it('keeps a just-created diagram that the projection dropped', () => {
    // The defect: `buildDiagramsArray` rebuilds the list from registry metas,
    // and a diagram created 15ms ago has none yet — created, then gone on the
    // very next projection.
    const hold = new LocalDiagramHold()
    const resident = [dg('a'), dg('new')]
    hold.noteCreated(resident, [dg('a')])

    expect(hold.apply([dg('a')], resident).map((d) => d.id)).toEqual(['a', 'new'])
  })

  it('takes the RESIDENT value, so an edit in the same window is not reverted', () => {
    const hold = new LocalDiagramHold()
    hold.noteCreated([dg('new', 'Draft')], [])
    // The user renamed it before the flush.
    const renamed = hold.apply([], [dg('new', 'Renamed')])
    expect(renamed[0].name).toBe('Renamed')
  })

  it('leaves an ordinary projection untouched', () => {
    const hold = new LocalDiagramHold()
    const projected = [dg('a'), dg('b')]
    expect(hold.apply(projected, projected)).toBe(projected)
  })

  it('does not duplicate a held diagram once the projection includes it', () => {
    const hold = new LocalDiagramHold()
    const resident = [dg('new')]
    hold.noteCreated(resident, [])
    expect(hold.apply([dg('new')], resident).map((d) => d.id)).toEqual(['new'])
  })

  it('releases the hold once a registry shard carries the meta', () => {
    const hold = new LocalDiagramHold()
    const resident = [dg('new')]
    hold.noteCreated(resident, [])
    hold.retire(['new'], resident)

    expect(hold.size).toBe(0)
    // A later projection that legitimately drops it (deleted elsewhere) must
    // now be respected rather than resurrected.
    expect(hold.apply([], resident)).toEqual([])
  })

  it('releases a diagram deleted before it was ever written', () => {
    // Otherwise the id is held forever and every projection re-scans for it.
    const hold = new LocalDiagramHold()
    hold.noteCreated([dg('new')], [])
    hold.retire([], [])
    expect(hold.size).toBe(0)
  })

  it('holds several creations from one store change', () => {
    const hold = new LocalDiagramHold()
    const resident = [dg('a'), dg('b'), dg('c')]
    expect(hold.noteCreated(resident, [dg('a')]).map((d) => d.id)).toEqual(['b', 'c'])
    expect(hold.apply([dg('a')], resident).map((d) => d.id)).toEqual(['a', 'b', 'c'])
  })

  it('reports only the diagrams that are actually new', () => {
    const hold = new LocalDiagramHold()
    expect(hold.noteCreated([dg('a')], [dg('a')])).toEqual([])
    expect(hold.size).toBe(0)
  })

  it('retires only what is durable, keeping the rest held', () => {
    const hold = new LocalDiagramHold()
    const resident = [dg('one'), dg('two')]
    hold.noteCreated(resident, [])
    hold.retire(['one'], resident)

    expect(hold.has('one')).toBe(false)
    expect(hold.has('two')).toBe(true)
    expect(hold.apply([], resident).map((d) => d.id)).toEqual(['two'])
  })

  it('clears everything on workspace teardown', () => {
    const hold = new LocalDiagramHold()
    const resident = [dg('new')]
    hold.noteCreated(resident, [])
    hold.clear()
    expect(hold.apply([], resident)).toEqual([])
  })
})
