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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { insetsClearing, measureCanvasSafeInsets } from './canvasSafeArea'

describe('measureCanvasSafeInsets (hit-tested chrome)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  const rect = (left: number, top: number, right: number, bottom: number) =>
    ({ left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) }) as DOMRect

  it('widens a scrolled list row to its panel, not to the row (the list content is taller than the canvas)', () => {
    // 1280x720 editor (view3d-perf "LOD hides nothing", 2026-10-09): the
    // outline's inner list is ~1600 px tall — its WHOLE box is over half the
    // canvas area, the part on the canvas is not
    const canvas = document.createElement('canvas')
    const panel = document.createElement('div')
    const list = document.createElement('div')
    const rows = Array.from({ length: 12 }, () => document.createElement('div'))
    document.body.append(canvas, panel)
    panel.append(list)
    list.append(...rows)
    const boxes = new Map<Element, DOMRect>([
      [canvas, rect(0, 0, 1280, 720)],
      [panel, rect(14, 14, 326, 706)],
      [list, rect(23, 177, 317, 1777)],
    ])
    rows.forEach((row, i) => boxes.set(row, rect(23, 177 + i * 40, 317, 217 + i * 40)))
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return boxes.get(this) ?? rect(0, 0, 0, 0)
    })
    document.elementFromPoint = (x: number, y: number) => {
      for (const row of rows) {
        const b = boxes.get(row)!
        if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) return row
      }
      const p = boxes.get(panel)!
      if (x >= p.left && x < p.right && y >= p.top && y < p.bottom) return panel
      return canvas
    }
    // the panel is cleared from the left; no row may claim the top or bottom
    expect(measureCanvasSafeInsets(canvas)).toEqual({ left: 326, right: 0, top: 0, bottom: 0 })
  })
})

describe('insetsClearing', () => {
  // the editor at 1600x1000 (view3d quality loop 2, round 2 city-wide.png)
  const canvas = { left: 0, top: 0, right: 1600, bottom: 1000 }

  it('clears each floating chrome from its cheapest side', () => {
    const insets = insetsClearing(canvas, [
      { left: 14, top: 14, right: 326, bottom: 986 }, // left panel
      { left: 1274, top: 14, right: 1586, bottom: 986 }, // properties panel
      { left: 502, top: 14, right: 1098, bottom: 62 }, // tool pill
      { left: 338, top: 360, right: 388, bottom: 640 }, // left tool rail
      { left: 340, top: 938, right: 835, bottom: 986 }, // bottom bar
      { left: 962, top: 898, right: 1262, bottom: 940 }, // camera controls
      { left: 1046, top: 944, right: 1262, bottom: 986 }, // zoom cluster
    ])
    expect(insets).toEqual({ left: 388, right: 326, top: 62, bottom: 102 })
  })

  it('ignores what does not overlap the canvas and clips what straddles it', () => {
    const insets = insetsClearing({ left: 100, top: 50, right: 900, bottom: 650 }, [
      { left: 0, top: 0, right: 90, bottom: 700 }, // beside the canvas
      { left: 850, top: 0, right: 1000, bottom: 700 }, // straddles the right edge
    ])
    expect(insets).toEqual({ left: 0, right: 50, top: 0, bottom: 0 })
  })
})
