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
import type { C4Object, Connection, Flow, Group } from '../../types'
import { CanvasEngine } from './CanvasEngine'
import type { SpatialGridIndex } from './spatialGrid'

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

interface PerformanceInternals {
  getVisibleObjects: (padding?: number) => C4Object[]
  getVisibleGroups: (padding?: number) => Group[]
  getVisibleConnections: (padding?: number) => Connection[]
  getConnectionGeometry: (connection: Connection) => { isHighlighted: boolean } | null
  render: () => void
  usesLowZoomLod: () => boolean
  getGridSpacing: (scale: number) => number
  renderGridWorld: (...args: unknown[]) => void
  renderConnectionSourceAnchors: (...args: unknown[]) => void
  renderConnectionArrowheads: (...args: unknown[]) => void
  renderConnectionDestinationAnchors: (...args: unknown[]) => void
  renderConnectionWaypoints: (...args: unknown[]) => void
  renderExpandIcon: (...args: unknown[]) => void
  renderPlusIcon: (...args: unknown[]) => void
  hoveredId: string | null
  isClickOnExpandIndicator: (object: C4Object, worldX: number, worldY: number) => boolean
  connectionSpatialIndex: SpatialGridIndex<number> | null
  connectionGeometryCache: Map<string, unknown>
  lastFrameStats: {
    objectsDrawn: number
    groupsDrawn: number
    connectionsDrawn: number
    lowZoomLod: boolean
  }
}

let contextSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('Path2D', class Path2D {})
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context())
})

afterEach(() => {
  contextSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('CanvasEngine dense-scene rendering', () => {
  it('fits and centers content inside viewport insets', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600
    canvas.height = 900
    const engine = new CanvasEngine(canvas, callbacks())
    engine.setData([object('left', 0), object('right', 1040)], [], [])

    engine.zoomToFit()
    const full = engine.getViewport()
    engine.zoomToFit({ left: 340, right: 340 })
    const betweenPanels = engine.getViewport()
    expect(betweenPanels.scale).toBeLessThan(full.scale)

    engine.zoomToFit({ left: 340 })
    const leftPanelOnly = engine.getViewport()
    const worldCenterX = 600
    expect(worldCenterX * leftPanelOnly.scale + leftPanelOnly.x).toBeCloseTo(970, 5)
  })

  // The share viewer keeps both 312 px panels open on a phone. Fitting into
  // the sliver they leave (or none: 375 - 680 < 0) used to be clamped to 1 px,
  // shrinking the diagram to a dot that stayed a dot once the panels closed.
  it('ignores panels that leave no usable span on an axis', () => {
    const fitAt = (width: number, insets: { left?: number; right?: number }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = 800
      const engine = new CanvasEngine(canvas, callbacks())
      engine.setData([object('left', 0), object('right', 1040)], [], [])
      engine.zoomToFit(insets)
      const fit = engine.getViewport()
      engine.focusOnFlowStep({ id: 'f', name: 'f', diagramId: 'd', steps: [{ id: 'i', order: 0, title: '', type: 'introduction' }] }, 0, insets)
      expect(engine.getViewport(), 'a flow step frames like the fit').toEqual(fit)
      return fit
    }
    const both = { left: 340, right: 340 }

    expect(fitAt(375, both)).toEqual(fitAt(375, {}))
    // 1024 - 680 = 344 px is still a usable span: the panels are honoured.
    const tablet = fitAt(1024, both)
    expect(600 * tablet.scale + tablet.x).toBeCloseTo(340 + 344 / 2, 5)
  })

  // Defect 2026-10-16: playing a flow with the left sidebar open framed the
  // introduction and conclusion steps on the WHOLE canvas, so the diagram's
  // left part (the actors) sat under the 312 px sidebar. Every step type must
  // centre its subject inside the visible rect, as the Fit button does.
  it('frames every flow step type inside the viewport insets', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600
    canvas.height = 900
    const engine = new CanvasEngine(canvas, callbacks())
    const left = object('left', 0)
    const right = object('right', 1040)
    const connection = { id: 'l-r', fromId: left.id, toId: right.id, type: 'solid' } as Connection
    engine.setData([left, right], [connection], [])
    const base = { order: 0, title: '' }
    const flow: Flow = {
      id: 'flow',
      name: 'flow',
      diagramId: 'd',
      steps: [
        { ...base, id: 'intro', type: 'introduction' },
        { ...base, id: 'process', type: 'process', objectId: left.id },
        { ...base, id: 'message', type: 'message', fromObjectId: left.id, toObjectId: right.id, connectionId: connection.id },
        { ...base, id: 'fallback', type: 'message', fromObjectId: left.id, toObjectId: right.id, connectionId: '' },
        { ...base, id: 'info', type: 'information' },
        { ...base, id: 'outro', type: 'conclusion' },
      ],
    }
    // World x-extent of each step's subject: the whole diagram, one shape, or
    // the two shapes a message joins.
    const subject: Record<string, [number, number]> = {
      intro: [0, 1200], process: [0, 160], message: [0, 1200], fallback: [0, 1200], info: [0, 1200], outro: [0, 1200],
    }
    const insets = { left: 340, right: 120 }
    const visibleCenterX = 340 + (1600 - 340 - 120) / 2

    flow.steps.forEach((step, index) => {
      engine.focusOnFlowStep(flow, index, insets)
      const v = engine.getViewport()
      const [minX, maxX] = subject[step.id]
      expect(((minX + maxX) / 2) * v.scale + v.x, step.id).toBeCloseTo(visibleCenterX, 5)
      // The whole subject clears both panels, not just its centre.
      expect(minX * v.scale + v.x, `${step.id} left edge`).toBeGreaterThanOrEqual(340)
      expect(maxX * v.scale + v.x, `${step.id} right edge`).toBeLessThanOrEqual(1600 - 120)
    })

    // Without insets the step still centres on the whole canvas (share export,
    // panel-less callers).
    engine.focusOnFlowStep(flow, 0)
    const full = engine.getViewport()
    expect(600 * full.scale + full.x).toBeCloseTo(800, 5)
  })

  it('queries object, group and connection candidates from the visible scene', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1000
    canvas.height = 800
    const engine = new CanvasEngine(canvas, callbacks())
    const nearA = object('near-a', 0)
    const nearB = object('near-b', 300)
    const farA = object('far-a', 10_000)
    const farB = object('far-b', 10_300)
    const connections = [
      { id: 'near', fromId: nearA.id, toId: nearB.id, type: 'solid' } as Connection,
      { id: 'far', fromId: farA.id, toId: farB.id, type: 'solid' } as Connection,
    ]
    const groups = [
      { id: 'near-group', name: 'Near', objectIds: [nearA.id], autoSize: true } as Group,
      { id: 'far-group', name: 'Far', objectIds: [farA.id], autoSize: true } as Group,
    ]
    engine.setData([nearA, nearB, farA, farB], connections, groups)
    const internals = engine as unknown as PerformanceInternals

    expect(internals.getVisibleObjects()).toEqual([nearA, nearB])
    expect(internals.getVisibleGroups().map((group) => group.id)).toEqual(['near-group'])
    expect(internals.getVisibleConnections().map((connection) => connection.id)).toEqual(['near'])
    internals.render()
    expect(internals.lastFrameStats).toEqual({
      objectsDrawn: 2,
      groupsDrawn: 1,
      connectionsDrawn: 1,
      lowZoomLod: false,
    })
    engine.destroy()
  })

  it('retains static connection geometry across frames and invalidates only touched endpoints', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1000
    canvas.height = 800
    const engine = new CanvasEngine(canvas, callbacks())
    const a = object('a', 0)
    const b = object('b', 300)
    const unrelated = object('unrelated', 600)
    const connection = { id: 'a-b', fromId: a.id, toId: b.id, type: 'solid' } as Connection
    engine.setData([a, b, unrelated], [connection])
    const internals = engine as unknown as PerformanceInternals

    const initial = internals.getConnectionGeometry(connection)
    internals.render()
    expect(internals.getConnectionGeometry(connection)).toBe(initial)
    const spatialIndex = internals.connectionSpatialIndex
    expect(spatialIndex).not.toBeNull()

    engine.setSelectedItems([{ type: 'object', id: a.id }])
    const selected = internals.getConnectionGeometry(connection)
    expect(selected).toBe(initial)
    expect(selected?.isHighlighted).toBe(true)

    engine.updatePlacements({ objects: [{ id: unrelated.id, position: { x: 650, y: 0 } }] })
    expect(internals.getConnectionGeometry(connection)).toBe(initial)
    expect(internals.connectionSpatialIndex).toBe(spatialIndex)

    engine.updatePlacements({ objects: [{ id: a.id, position: { x: 20, y: 0 } }] })
    expect(internals.getConnectionGeometry(connection)).not.toBe(initial)
    expect(internals.connectionSpatialIndex).toBe(spatialIndex)
    engine.destroy()
  })

  it('indexes a 500-shape / 20k-connection scene once and keeps viewport queries bounded', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1200
    canvas.height = 900
    const engine = new CanvasEngine(canvas, callbacks())
    const objects = Array.from({ length: 500 }, (_, index) => (
      object(`dense-${index}`, (index % 25) * 240, Math.floor(index / 25) * 160)
    ))
    const connections = Array.from({ length: 20_000 }, (_, index) => {
      const source = index % objects.length
      const pass = Math.floor(index / objects.length)
      const shift = 1 + ((pass * 37) % (objects.length - 1))
      return {
        id: `dense-connection-${index}`,
        fromId: objects[source].id,
        toId: objects[(source + shift) % objects.length].id,
        type: 'solid',
        shape: index % 4 === 0 ? 'straight' : 'curved',
      } as Connection
    })
    engine.setData(objects, connections)
    const internals = engine as unknown as PerformanceInternals
    const geometry = vi.spyOn(internals, 'getConnectionGeometry')

    const firstStartedAt = performance.now()
    const firstVisible = internals.getVisibleConnections(100)
    const firstDurationMs = performance.now() - firstStartedAt
    const firstCalls = geometry.mock.calls.length
    const index = internals.connectionSpatialIndex

    geometry.mockClear()
    const warmStartedAt = performance.now()
    const warmVisible = internals.getVisibleConnections(100)
    const warmDurationMs = performance.now() - warmStartedAt

    expect(index).not.toBeNull()
    expect(internals.connectionSpatialIndex).toBe(index)
    expect(internals.connectionGeometryCache).toHaveLength(20_000)
    expect(firstVisible.length).toBeGreaterThan(0)
    expect(warmVisible).toEqual(firstVisible)
    expect(firstCalls).toBeGreaterThanOrEqual(20_000)
    expect(geometry.mock.calls.length).toBeLessThan(20_000)
    // Generous regression ceilings: real-browser long-task and p95 gates remain
    // authoritative, while these catch accidental quadratic/full-scan paths.
    expect(firstDurationMs).toBeLessThan(1_500)
    expect(warmDurationMs).toBeLessThan(100)
    engine.destroy()
  }, 10_000)

  it('uses low-detail rendering only below the readable zoom threshold', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1000
    canvas.height = 800
    const engine = new CanvasEngine(canvas, callbacks())
    const internals = engine as unknown as PerformanceInternals

    engine.setZoom(0.25)
    expect(internals.usesLowZoomLod()).toBe(true)
    expect(internals.getGridSpacing(0.25)).toBe(80)
    engine.setZoom(0.35)
    expect(internals.usesLowZoomLod()).toBe(false)
    expect(internals.getGridSpacing(1)).toBe(20)
    engine.destroy()
  })

  it('omits illegible text at fit-all zoom and restores it at readable zoom', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1000
    canvas.height = 800
    const engine = new CanvasEngine(canvas, callbacks())
    engine.setData([object('visible', 0)], [])
    const internals = engine as unknown as PerformanceInternals
    const drawing = canvas.getContext('2d')!
    const fillText = drawing.fillText as unknown as ReturnType<typeof vi.fn>

    engine.setZoom(0.25)
    internals.render()
    expect(fillText).not.toHaveBeenCalled()

    fillText.mockClear()
    engine.setZoom(0.5)
    internals.render()
    expect(fillText).toHaveBeenCalled()
    engine.destroy()
  })

  it('hides editing aids but keeps connection arrowheads in readonly mode', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1000
    canvas.height = 800
    const engine = new CanvasEngine(canvas, callbacks())
    const a = object('a', 0)
    const b = object('b', 300)
    const connection = {
      id: 'a-b',
      fromId: a.id,
      toId: b.id,
      type: 'solid',
      waypoints: [{ x: 230, y: 45 }],
    } as Connection
    engine.setData([a, b], [connection])
    engine.setSelectedItems([{ type: 'connection', id: connection.id }])
    engine.setShowGrid(true)
    const internals = engine as unknown as PerformanceInternals
    const grid = vi.spyOn(internals, 'renderGridWorld')
    const sourceAnchors = vi.spyOn(internals, 'renderConnectionSourceAnchors')
    const arrowheads = vi.spyOn(internals, 'renderConnectionArrowheads')
    const destinationAnchors = vi.spyOn(internals, 'renderConnectionDestinationAnchors')
    const waypoints = vi.spyOn(internals, 'renderConnectionWaypoints')

    internals.render()
    expect(grid).toHaveBeenCalled()
    expect(sourceAnchors).toHaveBeenCalled()
    expect(arrowheads).toHaveBeenCalled()
    expect(destinationAnchors).toHaveBeenCalled()
    expect(waypoints).toHaveBeenCalled()

    vi.clearAllMocks()
    engine.setReadonly(true)
    internals.render()
    expect(grid).not.toHaveBeenCalled()
    expect(sourceAnchors).not.toHaveBeenCalled()
    expect(arrowheads).toHaveBeenCalled()
    expect(destinationAnchors).not.toHaveBeenCalled()
    expect(waypoints).not.toHaveBeenCalled()
    engine.destroy()
  })

  it('keeps expand visible for related diagrams and reveals create only on editable shape hover', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1000
    canvas.height = 800
    const engine = new CanvasEngine(canvas, callbacks())
    const internals = engine as unknown as PerformanceInternals
    const expand = vi.spyOn(internals, 'renderExpandIcon')
    const plus = vi.spyOn(internals, 'renderPlusIcon')
    const shape = object('shape', 0)

    engine.setData([shape], [], [], [], [], new Set())
    internals.render()
    expect(plus).not.toHaveBeenCalled()
    expect(expand).not.toHaveBeenCalled()

    internals.hoveredId = shape.id
    internals.render()
    expect(plus).toHaveBeenCalled()
    expect(expand).not.toHaveBeenCalled()
    expect(internals.isClickOnExpandIndicator(shape, 155, 10)).toBe(true)

    vi.clearAllMocks()
    engine.setReadonly(true)
    internals.render()
    expect(plus).not.toHaveBeenCalled()
    expect(expand).not.toHaveBeenCalled()
    expect(internals.isClickOnExpandIndicator(shape, 155, 10)).toBe(false)

    vi.clearAllMocks()
    engine.setData([shape], [], [], [], [], new Set([shape.id]))
    internals.render()
    expect(expand).toHaveBeenCalled()
    expect(plus).not.toHaveBeenCalled()
    expect(internals.isClickOnExpandIndicator(shape, 155, 10)).toBe(true)
    engine.destroy()
  })
})
