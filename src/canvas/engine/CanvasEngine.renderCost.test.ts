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

/**
 * Per-frame cost guards for the 2D engine: object-card text is fitted once per
 * (text, size, font) and not on every frame, and an idle selection animates by
 * re-compositing frozen layers instead of repainting the whole scene.
 *
 * The visual side of both (pixel parity with the previous renderer across every
 * skin and highlight style) and their measured cost are covered by the browser
 * bench in `bench/canvas2d/`; these tests pin the mechanisms in jsdom.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { C4Object, Connection } from '../../types'
import { defaultSkin } from '../../skins/defaultSkin'
import { CanvasEngine, DATA_RENDER_MAX_GAP_MS, DATA_RENDER_SLOW_FRAME_MS } from './CanvasEngine'

function object(id: string, x: number, extra: Partial<C4Object> = {}): C4Object {
  return {
    id,
    type: 'app',
    name: `${id} title`,
    shortDescription: `${id} description words`,
    position: { x, y: 0 },
    size: { width: 220, height: 140 },
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    properties: {},
    ...extra,
  } as C4Object
}

const measured: string[] = []
const drawImage = vi.fn()

function context(): CanvasRenderingContext2D {
  const functions = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'measureText') {
        return (text: string) => {
          measured.push(text)
          return { width: text.length * 6 }
        }
      }
      if (key === 'createLinearGradient') return () => ({ addColorStop: vi.fn() })
      if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      if (key === 'drawImage') return drawImage
      let fn = functions.get(key)
      if (!fn) {
        fn = vi.fn()
        functions.set(key, fn)
      }
      return fn
    },
    set() {
      return true
    },
  })
}

function callbacks() {
  return {
    onObjectSelect: () => undefined,
    onObjectDoubleClick: () => undefined,
    onGroupDoubleClick: () => undefined,
    onConnectionSelect: () => undefined,
    onConnectionDoubleClick: () => undefined,
    onConnectionLabelMove: () => undefined,
    onConnectionWaypointsChange: () => undefined,
    onConnectionStart: () => undefined,
    onConnectionEnd: () => undefined,
    onConnectionAnchorMove: () => undefined,
    onZoom: () => undefined,
    onCommentClick: () => undefined,
    onCommentMove: () => undefined,
    onContextMenu: () => undefined,
    onGroupSelect: () => undefined,
    onCopyApply: () => undefined,
    onExpandClick: () => undefined,
  }
}

interface Internals {
  render: () => void
  renderLoop: () => void
  renderAnimationFrame: () => void
  rafId: number
  animLayersValid: boolean
  animEffects: unknown[]
}

let contextSpy: ReturnType<typeof vi.spyOn>
let fonts: EventTarget

beforeEach(() => {
  measured.length = 0
  drawImage.mockClear()
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('Path2D', class Path2D {})
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context())
  fonts = new EventTarget()
  Object.defineProperty(document, 'fonts', { value: fonts, configurable: true })
})

afterEach(() => {
  contextSpy.mockRestore()
  vi.unstubAllGlobals()
  delete (document as unknown as { fonts?: unknown }).fonts
})

function engineWith(objects: C4Object[], connections: Connection[] = []) {
  const canvas = document.createElement('canvas')
  canvas.width = 1600
  canvas.height = 900
  const engine = new CanvasEngine(canvas, callbacks())
  engine.setData(objects, connections)
  engine.setViewport({ x: 20, y: 200, scale: 1 })
  return { engine, internals: engine as unknown as Internals }
}

describe('object card text layout cache', () => {
  it('fits a card once and does not re-measure its text on later frames', () => {
    const card = object('card', 0)
    const { engine, internals } = engineWith([card])

    internals.render()
    expect(measured).toContain(card.name)
    expect(measured.some((text) => text.includes('description'))).toBe(true)

    measured.length = 0
    internals.render()
    internals.render()
    expect(measured).not.toContain(card.name)
    expect(measured.some((text) => text.includes('description'))).toBe(false)
    engine.destroy()
  })

  it('re-fits when the name or the box size changes', () => {
    const card = object('card', 0)
    const { engine, internals } = engineWith([card])
    internals.render()

    measured.length = 0
    engine.updatePlacements({ objects: [{ id: card.id, position: card.position, size: { width: 160, height: 140 } }] })
    internals.render()
    expect(measured).toContain(card.name)

    measured.length = 0
    const renamed = { ...card, name: 'renamed card' }
    engine.setData([renamed], [])
    internals.render()
    expect(measured).toContain('renamed card')
    engine.destroy()
  })

  it('drops measured layouts when a web font finishes loading', () => {
    const card = object('card', 0)
    const { engine, internals } = engineWith([card])
    internals.render()

    measured.length = 0
    fonts.dispatchEvent(new Event('loadingdone'))
    internals.render()
    expect(measured).toContain(card.name)

    // Unsubscribed on destroy: a later font load must not reach a dead engine.
    engine.destroy()
    measured.length = 0
    fonts.dispatchEvent(new Event('loadingdone'))
    expect(measured).toEqual([])
  })
})

function move(x: number, y: number): MouseEvent {
  const event = new MouseEvent('mousemove', { clientX: x, clientY: y })
  Object.defineProperty(event, 'offsetX', { value: x })
  Object.defineProperty(event, 'offsetY', { value: y })
  return event
}

interface HoverInternals {
  onMouseMove: (event: MouseEvent) => void
  hitTestShapeAnchor: (...args: unknown[]) => unknown
  hitTestConnectionLabel: (x: number, y: number) => Connection | null
  hoveredId: string | null
  hoveredAnchorIndex: number | null
}

describe('hover hit-testing off the shapes', () => {
  it('still finds an anchor just outside a shape, across an index cell boundary', () => {
    // The card's right edge is x = 511, the last unit of the first 512-unit
    // shape-index cell; the cursor 7 units further right is in the next cell.
    const card = object('card', 291)
    const { engine } = engineWith([card])
    engine.setViewport({ x: 0, y: 0, scale: 1 })
    const internals = engine as unknown as HoverInternals
    // Right-centre anchor of the 220×140 card: (511, 70).
    internals.onMouseMove(move(518, 70))
    expect(internals.hoveredId).toBe(card.id)
    expect(internals.hoveredAnchorIndex).not.toBeNull()
    engine.destroy()
  })

  it('tests only the shapes near the cursor, not the whole diagram', () => {
    const objects = Array.from({ length: 2_000 }, (_, i) => ({
      ...object(`o${i}`, 0),
      position: { x: (i % 50) * 320, y: Math.floor(i / 50) * 240 },
    }))
    const { engine } = engineWith(objects)
    engine.setViewport({ x: 0, y: 0, scale: 1 })
    const internals = engine as unknown as HoverInternals
    const anchorTests = vi.spyOn(internals, 'hitTestShapeAnchor')
    // In the gap between four cards: nothing to hover, every scan comes up empty.
    internals.onMouseMove(move(270, 195))
    expect(internals.hoveredId).toBeNull()
    expect(anchorTests.mock.calls.length).toBeLessThan(20)
    engine.destroy()
  })

  it('finds a label pushed out of its path\'s grid cell by its offset', () => {
    // A vertical path at x = 250 lies in the first 256-unit index cell; a −40
    // offset puts its short label's box at x ≈ 276–304, in the next cell.
    const top = object('top', 140)
    const bottom = { ...object('bottom', 140), position: { x: 140, y: 600 } }
    const link = { id: 'v', fromId: top.id, toId: bottom.id, type: 'solid', label: 'ab', labelOffset: -40 } as Connection
    const { engine } = engineWith([top, bottom], [link])
    const internals = engine as unknown as HoverInternals
    const label = engine.getConnectionLabelBounds(link.id)!
    expect(engine.getExportConnectionGeometries()[0].fromEdge.x).toBe(250)
    expect(label.x).toBeGreaterThan(256)
    expect(internals.hitTestConnectionLabel(label.x + label.width / 2, label.y + label.height / 2)?.id).toBe(link.id)
    engine.destroy()
  })
})

describe('selection highlight animation', () => {
  function selectedPair() {
    const a = object('a', 0)
    const b = object('b', 400)
    const link = { id: 'a-b', fromId: a.id, toId: b.id, type: 'solid' } as Connection
    const setup = engineWith([a, b], [link])
    setup.engine.setSelectedItems([{ type: 'object', id: a.id }])
    return setup
  }

  it('repaints only the animated effects while nothing else changes', () => {
    const { engine, internals } = selectedPair()
    const render = vi.spyOn(internals, 'render')
    const animate = vi.spyOn(internals, 'renderAnimationFrame')

    internals.renderLoop()
    expect(render).toHaveBeenCalledTimes(1)
    expect(internals.animLayersValid).toBe(true)
    expect(internals.animEffects).toHaveLength(1)

    drawImage.mockClear()
    internals.renderLoop()
    internals.renderLoop()
    expect(render).toHaveBeenCalledTimes(1)
    expect(animate).toHaveBeenCalledTimes(2)
    // Under + over layer per animation frame.
    expect(drawImage).toHaveBeenCalledTimes(4)
    expect(internals.rafId).not.toBe(0)
    engine.destroy()
  })

  it('returns to a full repaint as soon as anything else changes', () => {
    const { engine, internals } = selectedPair()
    internals.renderLoop()
    const render = vi.spyOn(internals, 'render')

    engine.setViewport({ x: 40, y: 200, scale: 1 })
    internals.renderLoop()
    expect(render).toHaveBeenCalledTimes(1)

    engine.setSelectedItems([])
    internals.renderLoop()
    expect(render).toHaveBeenCalledTimes(2)
    expect(internals.animLayersValid).toBe(false)
    engine.destroy()
  })

  it('goes idle when the selection has no visible animated connection', () => {
    const lonely = object('lonely', 0)
    const { engine, internals } = engineWith([lonely])
    engine.setSelectedItems([{ type: 'object', id: lonely.id }])
    const render = vi.spyOn(internals, 'render')

    internals.renderLoop()
    expect(render).toHaveBeenCalledTimes(1)
    expect(internals.rafId).toBe(0)
    engine.destroy()
  })

  it('still draws the effects and keeps repainting when no layer can be created', () => {
    const mainContext = context()
    contextSpy.mockImplementation(function (this: HTMLCanvasElement) {
      return this.dataset.main === 'yes' ? mainContext : null
    } as unknown as typeof HTMLCanvasElement.prototype.getContext)
    const a = object('a', 0)
    const b = object('b', 400)
    const canvas = document.createElement('canvas')
    canvas.dataset.main = 'yes'
    canvas.width = 1600
    canvas.height = 900
    const engine = new CanvasEngine(canvas, callbacks())
    engine.setData([a, b], [{ id: 'a-b', fromId: a.id, toId: b.id, type: 'solid' } as Connection])
    engine.setViewport({ x: 20, y: 200, scale: 1 })
    engine.setSelectedItems([{ type: 'object', id: a.id }])
    const internals = engine as unknown as Internals & {
      renderConnectionHighlightEffect: (...args: unknown[]) => void
    }
    const effect = vi.spyOn(internals, 'renderConnectionHighlightEffect')
    const render = vi.spyOn(internals, 'render')

    internals.renderLoop()
    internals.renderLoop()
    expect(effect).toHaveBeenCalledTimes(2)
    expect(render).toHaveBeenCalledTimes(2)
    expect(internals.animLayersValid).toBe(false)
    engine.destroy()
  })

  it('keeps repainting the whole scene for a skin whose selection glow pulses with time', () => {
    const { engine, internals } = selectedPair()
    engine.setSkin({
      ...defaultSkin,
      renderStyle: { ...defaultSkin.renderStyle, neonGlow: { enabled: true, pulseSpeed: 4000, intensity: 1 } },
    })
    const render = vi.spyOn(internals, 'render')
    const animate = vi.spyOn(internals, 'renderAnimationFrame')

    internals.renderLoop()
    internals.renderLoop()
    expect(render).toHaveBeenCalledTimes(2)
    expect(animate).not.toHaveBeenCalled()
    engine.destroy()
  })
})

describe('data paints after a slow frame', () => {
  afterEach(() => { vi.useRealTimers() })

  it('a new data set after a SLOW frame is painted at most once per twice that frame — an interaction is not delayed; after a fast frame, at once', () => {
    expect(DATA_RENDER_SLOW_FRAME_MS).toBe(50)
    expect(DATA_RENDER_MAX_GAP_MS).toBe(1_000)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { engine, internals } = engineWith([object('a', 0)])
    const raf = vi.mocked(requestAnimationFrame)
    const slow = engine as unknown as { lastFrameMs: number; lastFrameEndedAt: number }
    // The last frame took 400 ms and just ended.
    internals.rafId = 0
    slow.lastFrameMs = 400
    slow.lastFrameEndedAt = performance.now()
    raf.mockClear()
    engine.setData([object('a', 10)], [])
    engine.setData([object('a', 20)], [])
    expect(raf).not.toHaveBeenCalled()
    vi.advanceTimersByTime(700)
    expect(raf).not.toHaveBeenCalled()
    // One paint for both data sets, 800 ms after the slow frame.
    vi.advanceTimersByTime(150)
    expect(raf).toHaveBeenCalledTimes(1)
    // An interaction's render is never held back.
    internals.rafId = 0
    raf.mockClear()
    slow.lastFrameEndedAt = performance.now()
    engine.setViewport({ x: 0, y: 0, scale: 1.2 })
    expect(raf).toHaveBeenCalledTimes(1)
    // A fast last frame: painted at once.
    internals.rafId = 0
    raf.mockClear()
    slow.lastFrameMs = 10
    engine.setData([object('a', 30)], [])
    expect(raf).toHaveBeenCalledTimes(1)
    engine.destroy()
  })

  it('a THROTTLE, not a debounce — data sets every 40 ms for 2 s after slow frames are painted every 800 ms, never held for the whole stream', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { engine, internals } = engineWith([object('a', 0)])
    const raf = vi.mocked(requestAnimationFrame)
    const slow = engine as unknown as { lastFrameMs: number; lastFrameEndedAt: number }
    const frame = () => { internals.rafId = 0; slow.lastFrameMs = 400; slow.lastFrameEndedAt = performance.now() }
    frame()
    raf.mockClear()
    let paints = 0
    for (let t = 0; t < 2_000; t += 40) {
      engine.setData([object('a', t)], [])
      vi.advanceTimersByTime(40)
      if (raf.mock.calls.length > 0) { paints += 1; raf.mockClear(); frame() }
    }
    expect(paints).toBe(2)
    engine.destroy()
  })

  it('the gap is CAPPED at 1 s (a 900 ms frame waits 1 s, not 1.8); destroy() cancels a pending paint', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { engine, internals } = engineWith([object('a', 0)])
    const raf = vi.mocked(requestAnimationFrame)
    const slow = engine as unknown as { lastFrameMs: number; lastFrameEndedAt: number }
    internals.rafId = 0
    slow.lastFrameMs = 900
    slow.lastFrameEndedAt = performance.now()
    raf.mockClear()
    engine.setData([object('a', 10)], [])
    vi.advanceTimersByTime(990)
    expect(raf).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(raf).toHaveBeenCalledTimes(1)
    // A paint pending at destroy() never runs.
    internals.rafId = 0
    slow.lastFrameEndedAt = performance.now()
    raf.mockClear()
    engine.setData([object('a', 20)], [])
    engine.destroy()
    vi.advanceTimersByTime(3_000)
    expect(raf).not.toHaveBeenCalled()
  })
})
