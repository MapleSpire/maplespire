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

// The 3D board's group platforms and platform drag (QA lens, 2026-10-25: none of
// the 3D side of the nesting and drag-carry change had a test; every mutant of it
// survived the suite).

import { describe, expect, it } from 'vitest'
import type { C4Object, Group } from '../types'
import { groupDragMoves, groupPlatformRect, startGroupDrag } from './groupPlatform'

const object = (id: string, x: number, y: number): C4Object =>
  ({ id, type: 'app', name: id, position: { x, y }, size: { width: 100, height: 60 } }) as unknown as C4Object
const group = (id: string, objectIds: string[], extra: Partial<Group> = {}): Group =>
  ({ id, name: id, color: '#fff', objectIds, ...extra }) as Group

const objects = [object('a', 0, 200), object('b', 0, 320), object('c', 200, 200)]
const onDiagram = new Set(objects.map((o) => o.id))
const inner = group('inner', ['a', 'b'], { autoSize: false, position: { x: -30, y: 150 }, size: { width: 160, height: 260 } })
const outer = group('outer', ['a', 'b', 'c'])
const groups = [outer, inner]

describe('groupPlatformRect — the 2D group-box contract on the board', () => {
  it('keeps a stored platform exactly as stored', () => {
    expect(groupPlatformRect(inner, groups, objects, onDiagram)).toEqual({ x: -30, y: 150, w: 160, h: 260 })
  })

  it('draws an auto-sized platform around the stored platform nested in it', () => {
    const o = groupPlatformRect(outer, groups, objects, onDiagram)
    const i = groupPlatformRect(inner, groups, objects, onDiagram)
    expect(o.x).toBeLessThan(i.x)
    expect(o.y).toBeLessThan(i.y)
    expect(o.x + o.w).toBeGreaterThan(i.x + i.w)
    expect(o.y + o.h).toBeGreaterThan(i.y + i.h)
  })
})

describe('groupDragMoves — what a platform drag writes', () => {
  const start = startGroupDrag(outer, groupPlatformRect(outer, groups, objects, onDiagram), groups, objects, onDiagram)

  it('carries the stored group nested in the dragged one', () => {
    expect([...start.carried]).toEqual([['inner', { x: -30, y: 150 }]])
  })

  it('moves the members and the carried group by the drag delta', () => {
    const to = { x: start.rect.x + 500, y: start.rect.y + 40 }
    const moves = groupDragMoves('outer', start, to)
    expect(moves.objects).toEqual([['a', { x: 500, y: 240 }], ['b', { x: 500, y: 360 }], ['c', { x: 700, y: 240 }]])
    expect(moves.groups).toEqual([['inner', { x: 470, y: 190 }]])
  })

  it('snaps everything it moves at the drop, the carried group included', () => {
    const snap = (p: { x: number; y: number }) => ({ x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 })
    const moves = groupDragMoves('outer', start, { x: start.rect.x + 503, y: start.rect.y + 44 }, snap)
    expect(moves.groups).toEqual([['inner', { x: 470, y: 190 }]])
    expect(moves.objects[0]).toEqual(['a', { x: 500, y: 240 }])
  })

  // Review lens, 2026-10-25: snapping each piece on its own rounded them by
  // different amounts, so a member and a nested box drifted apart on every drop.
  it('snaps everything by ONE correction, so pieces off the grid keep their offsets', () => {
    const offGrid = [object('p', 3, 207), object('q', 3, 327)]
    const box = group('box', ['p', 'q'], { autoSize: false, position: { x: -26, y: 156 }, size: { width: 160, height: 260 } })
    const host = group('host', ['p', 'q'], { autoSize: undefined })
    const on = new Set(['p', 'q'])
    const s = startGroupDrag(host, groupPlatformRect(host, [host, box], offGrid, on), [host, box], offGrid, on)
    const snap = (p: { x: number; y: number }) => ({ x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 })
    const moves = groupDragMoves('host', s, { x: s.rect.x + 500, y: s.rect.y }, snap)
    const at = new Map([...moves.objects, ...moves.groups])
    expect(at.get('p')).toEqual({ x: 500, y: 210 })
    expect({ x: at.get('box')!.x - at.get('p')!.x, y: at.get('box')!.y - at.get('p')!.y }).toEqual({ x: -29, y: -51 })
    expect(at.get('q')!.y - at.get('p')!.y).toBe(120)
  })

  it('keeps on-grid members on the grid even when the group\'s stored position is off it', () => {
    const host = group('host', ['a', 'b'], { position: { x: -30, y: 154 } })
    const s = startGroupDrag(host, groupPlatformRect(host, [host], objects, onDiagram), [host], objects, onDiagram)
    const snap = (p: { x: number; y: number }) => ({ x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 })
    const moves = groupDragMoves('host', s, { x: s.rect.x + 533, y: s.rect.y + 17 }, snap)
    for (const [id, p] of moves.objects) expect([p.x % 10, p.y % 10], id).toEqual([0, 0])
  })

  it('moves the dragged group\'s own stored position, and an empty group to the pointer', () => {
    const stored = group('s', ['c'], { position: { x: 180, y: 150 } })
    const s = startGroupDrag(stored, { x: 150, y: 154, w: 160, h: 106 }, [stored], objects, onDiagram)
    expect(groupDragMoves('s', s, { x: 250, y: 154 }).groups).toEqual([['s', { x: 280, y: 150 }]])
    const empty = group('e', [])
    const e = startGroupDrag(empty, { x: 0, y: 0, w: 240, h: 160 }, [empty], objects, onDiagram)
    expect(groupDragMoves('e', e, { x: 40, y: 60 }).groups).toEqual([['e', { x: 40, y: 60 }]])
  })
})
