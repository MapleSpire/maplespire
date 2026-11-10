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

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasEngine } from './CanvasEngine'
import type { C4Object, Connection } from '../../types'
import type { SkinConfig } from '../../skins/types'
import { defaultSkin } from '../../skins/defaultSkin'
import { studioSkin } from '../../skins/studioSkin'
import { slateSkin } from '../../skins/slateSkin'
import { cyberpunkSkin } from '../../skins/cyberpunkSkin'
import { eightBitSkin } from '../../skins/eightBitSkin'
import { graffitiSkin } from '../../skins/graffitiSkin'
import { c4Skin } from '../../skins/c4Skin'
import { c4SkinDark } from '../../skins/c4SkinDark'
import { personContains, personGeometry, personLinkIndicator } from '../personShape'

/**
 * The C4 theme draws actors as the person figure (`renderStyle.actorShape`).
 * Connections must land ON the figure — the crown, the shoulders, the sides —
 * never in the empty corners of the box beside the head; and every other theme
 * must route exactly as before (the card).
 */

type Edge = { x: number; y: number; face: string }
interface Internals {
  render: () => void
  getConnectionGeometry: (conn: Connection) => { fromEdge: Edge; toEdge: Edge } | null
  getConnectionEndpoint: (id: string, anchor?: number) => { cx: number; cy: number; face?: string } | null
  hitTestShapeAnchor: (id: string, x: number, y: number) => { shapeId: string; anchorIndex: number } | null
  isClickOnLinkIndicator: (obj: C4Object, x: number, y: number) => boolean
  renderLinkIcon: (ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string) => void
}

function object(id: string, type: C4Object['type'], x: number, y: number, over: Partial<C4Object> = {}): C4Object {
  return {
    id,
    type,
    name: id,
    position: { x, y },
    size: { width: 160, height: 100 },
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    properties: {},
    ...over,
  } as C4Object
}

function context(): CanvasRenderingContext2D {
  const functions = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'measureText') return (text: string) => ({ width: String(text).length * 6 })
      if (key === 'createLinearGradient') return () => ({ addColorStop: vi.fn() })
      let fn = functions.get(key)
      if (!fn) { fn = vi.fn(); functions.set(key, fn) }
      return fn
    },
    set() { return true },
  })
}

type TestEngine = Internals & Pick<CanvasEngine, 'setSkin' | 'setSelectedItems' | 'getObjectTextBounds'>

function engineWith(objects: C4Object[], connections: Connection[], skin: SkinConfig): TestEngine {
  const canvas = document.createElement('canvas')
  const noop = () => undefined
  const engine = new CanvasEngine(canvas, {
    onObjectSelect: noop,
    onPlacementsCommit: noop,
    onObjectDoubleClick: noop,
    onGroupDoubleClick: noop,
    onConnectionSelect: noop,
    onConnectionDoubleClick: noop,
    onConnectionLabelMove: noop,
    onConnectionWaypointsChange: noop,
    onConnectionStart: noop,
    onConnectionEnd: noop,
    onConnectionAnchorMove: noop,
    onZoom: noop,
    onCommentClick: noop,
    onCommentMove: noop,
    onContextMenu: noop,
    onGroupSelect: noop,
    onCopyApply: () => true,
    onExpandClick: noop,
  })
  engine.setData(objects, connections)
  engine.setSkin(skin)
  return engine as unknown as TestEngine
}

let contextSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  // jsdom has no Path2D; the link icon builds one
  vi.stubGlobal('Path2D', class {})
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context())
})

afterEach(() => {
  contextSpy.mockRestore()
  vi.unstubAllGlobals()
})

// The user sits up and to the left of the web app: the free connection leaves
// the user toward the app centre, i.e. down-right through the right shoulder.
const USER = object('user', 'actor', 0, 0)
const WEB = object('web', 'app', 400, 120)
// A target straight above-left of the user's box corner: the free route aims
// through the empty top-left corner of the box.
const ABOVE = object('above', 'system', -260, -260)
const conn = (id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection =>
  ({ id, fromId, toId, type: 'solid', ...over }) as Connection

const PERSON = personGeometry(0, 0, 160, 100)
/** On the outline: inside half a pixel toward the box centre, outside half a pixel beyond. */
function onFigure(p: { x: number; y: number }): boolean {
  const len = Math.hypot(p.x - 80, p.y - 50)
  const ux = (p.x - 80) / len
  const uy = (p.y - 50) / len
  return personContains(PERSON, p.x - ux * 0.5, p.y - uy * 0.5) && !personContains(PERSON, p.x + ux * 0.5, p.y + uy * 0.5)
}

describe('CanvasEngine — C4 person figure: connections land on the figure', () => {
  for (const [name, skin] of [['light', c4Skin], ['dark', c4SkinDark]] as const) {
    it(`${name}: a free connection toward a corner target lands on the shoulder, not the empty box corner`, () => {
      const engine = engineWith([USER, ABOVE], [conn('c', 'user', 'above')], skin)
      const g = engine.getConnectionGeometry(conn('c', 'user', 'above'))!
      expect(onFigure(g.fromEdge)).toBe(true)
      // the card would have exited through the box corner region (y ≈ 0)
      expect(g.fromEdge.y).toBeGreaterThan(10)
    })
  }

  it('a connection INTO the person ends on the figure as well', () => {
    const engine = engineWith([USER, WEB], [conn('c', 'web', 'user')], c4Skin)
    const g = engine.getConnectionGeometry(conn('c', 'web', 'user'))!
    expect(onFigure(g.toEdge)).toBe(true)
  })

  it('anchored ends: the top anchors sit on the shoulders and the crown, side anchors below the shoulders', () => {
    const engine = engineWith([USER, WEB], [], c4Skin)
    const top = [0, 1, 2].map((i) => engine.getConnectionEndpoint('user', i)!)
    expect(top[1].cy).toBeCloseTo(0, 9) // crown of the head
    for (const p of top) expect(personContains(PERSON, p.cx, p.cy + 0.5)).toBe(true)
    for (const p of top) expect(personContains(PERSON, p.cx, p.cy - 0.5)).toBe(false)
    for (const i of [3, 4, 5, 9, 10, 11]) {
      expect(engine.getConnectionEndpoint('user', i)!.cy).toBeGreaterThanOrEqual(PERSON.bodyY + PERSON.shoulderR - 1e-6)
    }
    // the anchor a user drags to is found where it is drawn
    const left = engine.getConnectionEndpoint('user', 10)!
    expect(engine.hitTestShapeAnchor('user', left.cx, left.cy)).toEqual({ shapeId: 'user', anchorIndex: 10 })
  })

  it('the text sits in the body under the chin and wraps to the body, not the box', () => {
    const engine = engineWith([USER], [], c4Skin)
    engine.render()
    const bounds = engine.getObjectTextBounds('user')!
    expect(bounds.title.y).toBeGreaterThanOrEqual(PERSON.bodyY + 6)
    expect(bounds.title.y).toBeGreaterThanOrEqual(PERSON.headCy + PERSON.headR + 2 - 0.5)
    expect(bounds.title).toMatchObject({ x: PERSON.bodyX + 8, width: PERSON.bodyW - 16 })
    expect(bounds.description).toMatchObject({ x: PERSON.bodyX + 8, width: PERSON.bodyW - 16 })
  })

  it('the link indicator floats beside the head, in a canvas colour (the element ink would vanish there)', () => {
    const user = object('user', 'actor', 0, 0, { links: [{ url: 'https://example.com', label: 'x' }] })
    for (const skin of [c4Skin, c4SkinDark]) {
      const engine = engineWith([user], [], skin)
      const icon = vi.fn()
      engine.renderLinkIcon = icon
      engine.render()
      const at = personLinkIndicator(PERSON, 0)
      expect(icon).toHaveBeenCalledTimes(1)
      const [, cx, cy, , color] = icon.mock.calls[0]
      expect(cx).toBeCloseTo(at.left + 6, 9)
      expect(cy).toBeCloseTo(at.cy, 9)
      expect(color).toBe(skin.groups.linkColor)
      expect(color).not.toBe(skin.objects.actor.iconExternal)
      // the click lands where it is drawn — and not in the empty box corner
      expect(engine.isClickOnLinkIndicator(user, at.left + 6, at.cy)).toBe(true)
      expect(engine.isClickOnLinkIndicator(user, at.left + 38, at.cy)).toBe(true)
      expect(engine.isClickOnLinkIndicator(user, 5, at.cy)).toBe(false) // the empty box corner
    }
    // a card keeps its top-left indicator in its own ink
    const card = object('card', 'system', 0, 0, { links: [{ url: 'https://example.com', label: 'x' }] })
    const engine = engineWith([card], [], c4Skin)
    const icon = vi.fn()
    engine.renderLinkIcon = icon
    engine.render()
    expect(icon.mock.calls[0][1]).toBeCloseTo(4 + 6, 9)
    expect(icon.mock.calls[0][4]).toBe(c4Skin.objects.system.iconExternal)
  })

  it('a big figure with a long description still starts its text below the head', () => {
    // 320×250: the head reaches its 44 px cap; the card's centring (icon slot
    // included) would put the title at y ≈ 69, inside the head.
    const long = 'Places orders, tracks deliveries and manages their account. '.repeat(7)
    const big = object('big', 'actor', 0, 0, { size: { width: 320, height: 250 }, shortDescription: long })
    const engine = engineWith([big], [], c4Skin)
    engine.render()
    const fig = personGeometry(0, 0, 320, 250)
    expect(engine.getObjectTextBounds('big')!.title.y).toBeGreaterThanOrEqual(fig.bodyY + 6)
  })

  it('switching to the C4 theme re-routes a connection already computed for the card', () => {
    const engine = engineWith([USER, ABOVE], [conn('c', 'user', 'above')], defaultSkin)
    const before = engine.getConnectionGeometry(conn('c', 'user', 'above'))!.fromEdge
    engine.setSkin(c4Skin)
    const after = engine.getConnectionGeometry(conn('c', 'user', 'above'))!.fromEdge
    expect(after).not.toEqual(before)
    expect(onFigure(after)).toBe(true)
  })

  it('renders every element type, selected and external, without throwing', () => {
    const objects = (['actor', 'system', 'app', 'store', 'component'] as const).flatMap((type, i) => [
      object(`${type}-i`, type, i * 200, 0),
      object(`${type}-e`, type, i * 200, 200, { scope: 'external' }),
    ])
    for (const skin of [c4Skin, c4SkinDark]) {
      const engine = engineWith(objects, [conn('c', 'actor-i', 'app-e')], skin)
      engine.setSelectedItems([{ id: 'actor-i', type: 'object' }, { id: 'store-i', type: 'object' }])
      expect(() => engine.render()).not.toThrow()
    }
  })
})

describe('CanvasEngine — every other theme still routes to the card', () => {
  for (const skin of [defaultSkin, studioSkin, slateSkin, cyberpunkSkin, eightBitSkin, graffitiSkin]) {
    it(`${skin.id}: actors keep the rectangle edge and the box-edge anchors`, () => {
      const engine = engineWith([USER, ABOVE, WEB], [conn('c', 'user', 'above')], skin)
      const g = engine.getConnectionGeometry(conn('c', 'user', 'above'))!
      // the ray toward the far upper-left target leaves the box through its
      // top or left edge (the card), not on an inner figure
      const onBoxEdge = Math.abs(g.fromEdge.y - 0) < 1e-6 || Math.abs(g.fromEdge.x - 0) < 1e-6
      // or on its 8px corner arc
      const onCorner = Math.hypot(g.fromEdge.x - 8, g.fromEdge.y - 8) <= 8 + 1e-6
      expect(onBoxEdge || onCorner).toBe(true)
      // the top anchors are on the box's top edge
      for (const i of [0, 1, 2]) expect(engine.getConnectionEndpoint('user', i)!.cy).toBe(0)
      // the side anchors keep the card's distribution
      expect(engine.getConnectionEndpoint('user', 9)!.cy).toBeCloseTo(8 + 0.2 * 84, 9)
    })
  }
})
