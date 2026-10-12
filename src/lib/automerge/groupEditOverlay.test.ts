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
import type { Group } from '../../types'
import { GroupEditOverlay } from './groupEditOverlay'

function group(id: string, name: string): Group {
  return {
    id,
    name,
    color: '#D97A3D',
    objectIds: [],
    position: { x: 0, y: 0 },
    size: { width: 200, height: 150 },
    tagAssignments: {},
    tagOrder: [],
  }
}

describe('GroupEditOverlay', () => {
  it('keeps a rename that a projection would otherwise revert', () => {
    // The reported defect, reduced: the user has typed "Bill" but the snapshot
    // the projection carries still holds the pre-edit name, because the
    // debounced ModelMeta flush has not run yet.
    const overlay = new GroupEditOverlay()
    const projected = [group('g1', 'Payments')]
    overlay.rebaseline(projected)

    overlay.captureLocalEdits([group('g1', 'Bill')])

    expect(overlay.apply([group('g1', 'Payments')]).map((g) => g.name)).toEqual(['Bill'])
  })

  it('survives a burst of projections, one per keystroke', () => {
    const overlay = new GroupEditOverlay()
    const stale = [group('g1', 'Payments')]
    overlay.rebaseline(stale)

    let latest: Group[] = stale
    for (const typed of ['B', 'Bi', 'Bil', 'Bill', 'Billi', 'Billin', 'Billing']) {
      overlay.captureLocalEdits([group('g1', typed)])
      // Every projection carries the same pre-edit snapshot, because nothing
      // has flushed during the burst.
      latest = overlay.apply([group('g1', 'Payments')])
    }

    expect(latest.map((g) => g.name)).toEqual(['Billing'])
  })

  it('leaves untouched groups exactly as projected', () => {
    const overlay = new GroupEditOverlay()
    overlay.rebaseline([group('g1', 'Payments'), group('g2', 'Ledger')])
    overlay.captureLocalEdits([group('g1', 'Billing')])

    const remote = [group('g1', 'Payments'), group('g2', 'Ledger renamed remotely')]
    expect(overlay.apply(remote).map((g) => g.name)).toEqual(['Billing', 'Ledger renamed remotely'])
  })

  it('does not capture a group the projection itself produced', () => {
    const overlay = new GroupEditOverlay()
    const projected = [group('g1', 'Payments')]
    overlay.rebaseline(projected)

    // Same references the projection rendered: no local edit happened.
    overlay.captureLocalEdits(projected)
    expect(overlay.size).toBe(0)
  })

  it('stops overriding once the edit is durable, so a later remote change wins', () => {
    const overlay = new GroupEditOverlay()
    overlay.rebaseline([group('g1', 'Payments')])
    const local = group('g1', 'Billing')
    overlay.captureLocalEdits([local])
    expect(overlay.size).toBe(1)

    // writeSmallCollections reconciled this exact ref into ModelMeta.
    overlay.retireDurable([local])
    expect(overlay.size).toBe(0)

    // A teammate renames it afterwards — that must now come through, which is
    // exactly what an overlay held forever would block.
    expect(overlay.apply([group('g1', 'Renamed by a teammate')]).map((g) => g.name))
      .toEqual(['Renamed by a teammate'])
  })

  it('retires only the exact reference that was written', () => {
    const overlay = new GroupEditOverlay()
    overlay.rebaseline([group('g1', 'Payments')])
    overlay.captureLocalEdits([group('g1', 'Billing')])

    // The flush wrote an older snapshot; the user has typed since. A value
    // match would wrongly drop the newer edit, so identity is the test.
    overlay.retireDurable([group('g1', 'Billing')])
    expect(overlay.size).toBe(1)
    expect(overlay.apply([group('g1', 'Payments')]).map((g) => g.name)).toEqual(['Billing'])
  })

  it('keeps an edited group the projection has not caught up to yet', () => {
    const overlay = new GroupEditOverlay()
    overlay.rebaseline([])
    overlay.captureLocalEdits([group('g1', 'Brand new group')])

    expect(overlay.apply([]).map((g) => g.name)).toEqual(['Brand new group'])
  })

  it('drops everything on a workspace switch', () => {
    const overlay = new GroupEditOverlay()
    overlay.rebaseline([group('g1', 'Payments')])
    overlay.captureLocalEdits([group('g1', 'Billing')])

    overlay.clear()

    expect(overlay.size).toBe(0)
    // The other workspace's group must not acquire the previous one's name, and
    // a staged-but-absent group must not be re-added to it.
    expect(overlay.apply([group('g9', 'Other workspace group')]).map((g) => g.name))
      .toEqual(['Other workspace group'])
  })

  it('returns the projection untouched when nothing is staged', () => {
    const overlay = new GroupEditOverlay()
    const projected = [group('g1', 'Payments')]
    expect(overlay.apply(projected)).toBe(projected)
  })
})
