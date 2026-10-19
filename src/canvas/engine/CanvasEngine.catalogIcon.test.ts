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
 * Regression, defect 2026-10-17: a shape carrying a catalog `icon` name but no
 * `iconAssignment` (written by the AI tools and the Structurizr import before
 * they wrote assignments) drew a generated letter badge instead of its logo.
 * The engine must resolve the catalog artwork by name for such shapes, keep
 * the letter badge for names truly absent from the catalog, and never let the
 * catalog override an assignment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { C4Object } from '../../types'
import { CanvasEngine } from './CanvasEngine'
import { loadIconCatalog, resetIconCatalogForTests } from '../../lib/technologies/shapeIconArtwork'
import { getIconByName } from '../../lib/techIcons'

// From the catalog itself: the artwork files differ between distributions.
const REACT_LIGHT = getIconByName('React')!.iconLight!
const REACT_DARK = getIconByName('React')!.iconDark!

function object(id: string, extra: Partial<C4Object> = {}): C4Object {
  return {
    id,
    type: 'app',
    name: `${id} title`,
    position: { x: 0, y: 0 },
    size: { width: 220, height: 140 },
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    properties: {},
    ...extra,
  } as C4Object
}

const drawImage = vi.fn()
const fillText = vi.fn()

function context(): CanvasRenderingContext2D {
  const functions = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6 })
      if (key === 'createLinearGradient') return () => ({ addColorStop: vi.fn() })
      if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      if (key === 'drawImage') return drawImage
      if (key === 'fillText') return fillText
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

class FakeImage {
  static created: FakeImage[] = []
  src = ''
  crossOrigin = ''
  complete = false
  naturalWidth = 0
  naturalHeight = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeImage.created.push(this)
  }
  load(width = 64, height = 64) {
    this.complete = true
    this.naturalWidth = width
    this.naturalHeight = height
    this.onload?.()
  }
}

const noop = () => undefined
const callbacks = {
  onObjectSelect: noop, onObjectDoubleClick: noop, onGroupDoubleClick: noop, onConnectionSelect: noop,
  onConnectionDoubleClick: noop, onConnectionLabelMove: noop, onConnectionWaypointsChange: noop,
  onConnectionStart: noop, onConnectionEnd: noop, onConnectionAnchorMove: noop, onZoom: noop,
  onCommentClick: noop, onCommentMove: noop, onContextMenu: noop, onGroupSelect: noop, onCopyApply: noop,
  onExpandClick: noop,
}

let contextSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetIconCatalogForTests()
  drawImage.mockClear()
  fillText.mockClear()
  FakeImage.created = []
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('Path2D', class Path2D {})
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context())
  Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true })
})

afterEach(() => {
  contextSpy.mockRestore()
  vi.unstubAllGlobals()
  delete (document as unknown as { fonts?: unknown }).fonts
})

function engineWith(objects: C4Object[], theme: 'light' | 'dark' = 'light') {
  const canvas = document.createElement('canvas')
  canvas.width = 1600
  canvas.height = 900
  const engine = new CanvasEngine(canvas, callbacks)
  engine.setResolvedTheme(theme)
  engine.setData(objects, [])
  engine.setViewport({ x: 20, y: 200, scale: 1 })
  const render = () => (engine as unknown as { render: () => void }).render()
  return { engine, render }
}

describe('2D technology icon: catalog artwork for a bare icon name', () => {
  it('draws the catalog logo for an `icon` with no assignment, once the catalog has loaded', async () => {
    expect(REACT_LIGHT).toMatch(/^\/icons\//)
    expect(REACT_DARK).toMatch(/^\/icons\//)
    const { engine, render } = engineWith([object('web', { icon: 'React' })])
    render() // first frame: catalog not loaded yet → letter badge, load requested
    expect(fillText).toHaveBeenCalledWith('R', expect.any(Number), expect.any(Number))
    await loadIconCatalog()

    render() // catalog available → the logo is requested
    const image = FakeImage.created.find((img) => img.src === REACT_LIGHT)
    expect(image, `requested: ${FakeImage.created.map((i) => i.src).join(', ')}`).toBeDefined()
    image!.load()
    drawImage.mockClear()
    render()
    expect(drawImage).toHaveBeenCalledWith(image, expect.any(Number), expect.any(Number), 20, 20)
    engine.destroy()
  })

  // Regression, defect 2026-10-18: drawImage(img, x, y, 20, 20) stretched a
  // non-square logo into the square. It must be aspect-fit and centred.
  it('draws a non-square logo aspect-fit and centred in the 20 px box, never stretched', async () => {
    await loadIconCatalog()
    const { engine, render } = engineWith([object('web', { icon: 'React' })])
    render()
    const image = FakeImage.created.find((img) => img.src === REACT_LIGHT)!
    image.load(200, 50) // 4:1, as a wide wordmark upload
    drawImage.mockClear()
    render()
    expect(drawImage).toHaveBeenCalledTimes(1)
    const [drawn, x, y, width, height] = drawImage.mock.calls[0] as [unknown, number, number, number, number]
    expect(drawn).toBe(image)
    expect(width).toBe(20)
    expect(height).toBe(5)

    image.load(50, 200) // 1:4, tall
    drawImage.mockClear()
    render()
    const [, tx, ty, tw, th] = drawImage.mock.calls[0] as [unknown, number, number, number, number]
    expect([tw, th]).toEqual([5, 20])
    // Both fits share the box centre: the wide one is centred vertically, the
    // tall one horizontally.
    expect(x + width / 2).toBeCloseTo(tx + tw / 2)
    expect(y + height / 2).toBeCloseTo(ty + th / 2)
    expect(tx - x).toBeCloseTo(7.5)
    expect(y - ty).toBeCloseTo(7.5)
    engine.destroy()
  })

  it('uses the dark variant on a dark canvas', async () => {
    await loadIconCatalog()
    const { engine, render } = engineWith([object('web', { icon: 'React' })], 'dark')
    render()
    expect(FakeImage.created.map((img) => img.src)).toContain(REACT_DARK)
    engine.destroy()
  })

  it('keeps the letter badge for a name that is truly not in the catalog', async () => {
    await loadIconCatalog()
    const { engine, render } = engineWith([object('x', { icon: 'NotARealIconXYZ' })])
    render()
    expect(FakeImage.created).toHaveLength(0)
    expect(drawImage).not.toHaveBeenCalled()
    expect(fillText).toHaveBeenCalledWith('N', expect.any(Number), expect.any(Number))
    engine.destroy()
  })

  it('never lets the catalog override an assignment, even one without artwork', async () => {
    await loadIconCatalog()
    const { engine, render } = engineWith([object('svc', {
      icon: 'React',
      iconAssignment: { source: 'technology', mode: 'automatic', displayName: 'React', technologyUsageId: 'tu_1' },
    })])
    render()
    expect(FakeImage.created).toHaveLength(0)
    engine.destroy()
  })
})
