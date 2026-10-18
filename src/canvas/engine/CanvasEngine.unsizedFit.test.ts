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
 * A fit or focus asked for while the canvas has NO SIZE used to commit a
 * degenerate viewport: visibleCanvasRect clamps the empty rect to 1 px, so a
 * fit landed at scale ≈0.0007 (seen once in the desktop browser pane,
 * 2026-10-17, with the readout stuck at its 10 % floor) — and CanvasView fits
 * each diagram only once, so nothing repaired it. The engine now holds the
 * request and replays it on the resize that gives the canvas a size.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { C4Object } from '../../types'
import { CanvasEngine } from './CanvasEngine'

function object(id: string, x: number, y = 0): C4Object {
  return {
    id,
    type: 'app',
    name: id,
    position: { x, y },
    size: { width: 160, height: 90 },
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    properties: {},
  } as C4Object
}

function context(): CanvasRenderingContext2D {
  const functions = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'measureText') return () => ({ width: 20 })
      if (key === 'createLinearGradient') return () => ({ addColorStop: vi.fn() })
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

function callbacks(onZoom: (zoom: number) => void = () => undefined) {
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
    onZoom,
    onCommentClick: () => undefined,
    onCommentMove: () => undefined,
    onContextMenu: () => undefined,
    onGroupSelect: () => undefined,
    onCopyApply: () => undefined,
    onExpandClick: () => undefined,
  }
}

let contextSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('Path2D', class Path2D {})
  vi.stubGlobal('devicePixelRatio', 1)
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context())
})

afterEach(() => {
  contextSpy.mockRestore()
  vi.unstubAllGlobals()
})

const INSETS = { left: 340, right: 340 }
const SCENE = [object('left', 0), object('right', 1040, 300)]

/** An engine whose canvas has the given size, holding SCENE. */
function engineSized(width: number, height: number, onZoom?: (zoom: number) => void): CanvasEngine {
  const canvas = document.createElement('canvas')
  const engine = new CanvasEngine(canvas, callbacks(onZoom))
  engine.resize(width, height)
  engine.setData(SCENE, [], [])
  return engine
}

describe('a fit asked for before the canvas has a size', () => {
  it('control: on a sized canvas the fit frames the scene at a sane scale', () => {
    const engine = engineSized(1600, 900)
    engine.zoomToFit(INSETS)
    expect(engine.getZoom()).toBeGreaterThan(0.3)
  })

  it('is held — not committed as a degenerate viewport — and replayed on the first real size', () => {
    const expected = engineSized(1600, 900)
    expected.zoomToFit(INSETS)

    const zooms: number[] = []
    const engine = engineSized(0, 0, (zoom) => zooms.push(zoom))
    const before = engine.getViewport()
    engine.zoomToFit(INSETS)
    expect(engine.getViewport()).toEqual(before) // nothing committed against an empty rect

    engine.resize(1600, 900)
    expect(engine.getViewport()).toEqual(expected.getViewport())
    // The readout follows the replayed fit, not the one it was asked for.
    expect(zooms.at(-1)).toBe(expected.getZoom())
  })

  it('a focus on a shape is held and replayed the same way', () => {
    const expected = engineSized(1600, 900)
    expect(expected.focusOnObject('right', undefined, INSETS)).toBe(true)

    const engine = engineSized(0, 0)
    engine.focusOnObject('right', undefined, INSETS)
    expect(engine.getZoom()).toBe(1)
    engine.resize(1600, 900)
    expect(engine.getViewport()).toEqual(expected.getViewport())
  })

  it('an explicit framing set while held wins over the replay', () => {
    const engine = engineSized(0, 0)
    engine.zoomToFit(INSETS)
    engine.setViewport({ x: 12, y: 34, scale: 2 })
    engine.resize(1600, 900)
    expect(engine.getViewport()).toEqual({ x: 12, y: 34, scale: 2 })
  })

  it('is replayed once: a later resize does not re-fit over the user', () => {
    const engine = engineSized(0, 0)
    engine.zoomToFit(INSETS)
    engine.resize(1600, 900)
    const replayed = engine.getViewport()
    // No viewport call in between on purpose: a user's pan writes the viewport
    // directly and clears nothing, so only the replay itself may drop the hold.
    // A second replay at this new size would re-frame, and the user's view with it.
    engine.resize(1700, 950)
    expect(engine.getViewport()).toEqual(replayed)
  })
})
