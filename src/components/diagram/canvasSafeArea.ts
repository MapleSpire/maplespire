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

/**
 * What of the 3D canvas is actually visible: the editor's chrome FLOATS over
 * the WebGL canvas (side panels, the tool pill, the left tool rail, the
 * bottom bar, the zoom cluster, the camera controls), so a fit-to-screen
 * against the canvas rect — or against a nominal 340-px panel width with
 * nothing for the toolbars — leaves content under them (view3d quality loop
 * 2, round 2: the Ingest card under the properties panel, the Log store's
 * name tag on the STYLE 3D toolbar). The chrome is measured from the DOM at
 * fit time instead of being listed: whatever is hit-tested above the canvas
 * IS the obstruction, including chrome added after this was written.
 */

export interface SafeInsets {
  left: number
  right: number
  top: number
  bottom: number
}

export interface ClientRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Insets (css px from each canvas edge) that clear every obstruction rect.
 * Each obstruction is cleared from the ONE side that costs the least — a
 * full-height side panel from its side, the top pill from the top, a
 * bottom toolbar from the bottom, the floating left rail from the left. */
export function insetsClearing(canvas: ClientRect, obstructions: readonly ClientRect[]): SafeInsets {
  const out: SafeInsets = { left: 0, right: 0, top: 0, bottom: 0 }
  for (const o of obstructions) {
    const x0 = Math.max(canvas.left, o.left)
    const x1 = Math.min(canvas.right, o.right)
    const y0 = Math.max(canvas.top, o.top)
    const y1 = Math.min(canvas.bottom, o.bottom)
    if (x1 <= x0 || y1 <= y0) continue // not over the canvas
    const cost: [keyof SafeInsets, number][] = [
      ['left', x1 - canvas.left],
      ['right', canvas.right - x0],
      ['top', y1 - canvas.top],
      ['bottom', canvas.bottom - y0],
    ]
    cost.sort((a, b) => a[1] - b[1])
    const [side, inset] = cost[0]
    out[side] = Math.max(out[side], inset)
  }
  return out
}

/** Sample a grid over the canvas and collect the chrome hit-tested above it.
 * Each hit is widened to its outermost ancestor that is still chrome: it
 * does not contain the canvas and covers under half of it (a full-size
 * layer is a container, not an obstruction).
 *
 * "Covers" is the part of the element ON the canvas, not its whole box: the
 * outline's scrolled list content is far taller than the panel showing it.
 * Measured 2026-10-09 at 1280x720 (view3d-perf "LOD hides nothing"): the
 * list's inner box (294 x ~1600 px) passed half the canvas area, the walk
 * stopped at each ROW, and rows cleared from the top or the bottom — insets
 * top 295 / bottom 306 left an 87-px band, and the fit framed an 8-card
 * board at 44 px per card (4 of 28 texts visible). */
export function measureObstructions(canvas: HTMLElement, step = 40): ClientRect[] {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return []
  const r = canvas.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return []
  const canvasArea = r.width * r.height
  const roots = new Set<Element>()
  const coveredArea = (b: DOMRect): number =>
    Math.max(0, Math.min(b.right, r.right) - Math.max(b.left, r.left)) *
    Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top))
  const chromeRoot = (hit: Element): Element | null => {
    let best: Element | null = null
    for (let el: Element | null = hit; el && el !== document.body; el = el.parentElement) {
      if (el === canvas || el.contains(canvas)) break
      if (coveredArea(el.getBoundingClientRect()) >= canvasArea * 0.5) break
      best = el
    }
    return best
  }
  for (let y = r.top + step / 2; y < r.bottom; y += step) {
    for (let x = r.left + step / 2; x < r.right; x += step) {
      const hit = document.elementFromPoint(x, y)
      if (!hit || hit === canvas) continue
      const root = chromeRoot(hit)
      if (root) roots.add(root)
    }
  }
  return [...roots].map((el) => {
    const b = el.getBoundingClientRect()
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
  })
}

/** The insets that keep fit-to-screen content off every floating chrome. */
export function measureCanvasSafeInsets(canvas: HTMLElement): SafeInsets {
  const r = canvas.getBoundingClientRect()
  return insetsClearing({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, measureObstructions(canvas))
}
