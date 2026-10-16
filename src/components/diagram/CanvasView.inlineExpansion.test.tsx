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
 * The WIRES between CanvasView and the inline-expansion pieces. Every piece has
 * its own tests; what they cannot see is CanvasView handing the hook the right
 * expansions and registry, folding the hook's contents into the planner's
 * lookup, re-syncing when they land, and the collapse click passing the
 * orphans. The hook is replaced by a hand-driven fake so the contents are the
 * test's to choose; the planner, uiStore and the model store are real.
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { C4Object, Diagram } from '../../types'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { inlineWrapperId } from '../../lib/diagrams/expandInline'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../../lib/automerge/switchWorkspace', () => ({
  reloadWorkspace: vi.fn(async () => undefined),
  switchWorkspace: vi.fn(async () => undefined),
}))
vi.mock('../presence/RemoteCursorOverlay', () => ({ RemoteCursorOverlay: () => null }))

const engine = vi.hoisted(() => ({
  callbacks: null as null | Record<string, (...args: unknown[]) => void>,
  setData: [] as unknown[][],
}))
vi.mock('../../canvas/engine/CanvasEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../canvas/engine/CanvasEngine')>()),
  CanvasEngine: class {
    constructor(_canvas: unknown, callbacks: Record<string, (...args: unknown[]) => void>) {
      engine.callbacks = callbacks
      const answers: Record<string, (...args: unknown[]) => unknown> = {
        getZoom: () => 1,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        screenToWorld: () => ({ x: 0, y: 0 }),
        worldToScreen: () => ({ x: 0, y: 0 }),
        computeConnectionAnchors: () => [],
        getConnectionLabelBounds: () => null,
        getGroupBoundsById: () => null,
        getObjectSizeById: () => null,
        setData: (...args: unknown[]) => { engine.setData.push(args) },
      }
      return new Proxy(this, {
        get: (_target, property) => (typeof property === 'string'
          ? (answers[property] ?? (() => undefined))
          : undefined),
      })
    }
  },
}))

// The hook, driven by hand: records what CanvasView passes it, and publishes
// whatever contents the test chooses, bumping the version as the real one does.
const hook = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ expansions: Record<string, string>; registry: unknown }>,
    ref: { current: { objects: new Map(), connections: new Map(), layouts: new Map() } } as {
      current: { objects: Map<string, unknown>; connections: Map<string, unknown>; layouts: Map<string, unknown> }
    },
    version: 0,
    listeners: new Set<() => void>(),
  }
  return state
})
vi.mock('./useInlineExpansionContents', () => ({
  useInlineExpansionContents: (expansions: Record<string, string>, registry: unknown) => {
    hook.calls.push({ expansions, registry })
    const version = useSyncExternalStore(
      (fn) => { hook.listeners.add(fn); return () => hook.listeners.delete(fn) },
      () => hook.version,
    )
    return { contentsRef: hook.ref, version }
  },
}))
function publish(
  objects: C4Object[],
  layouts: Record<string, unknown> | null,
  connections: Array<{ id: string }> = [],
  diagramId = 'B',
) {
  hook.ref.current = {
    objects: new Map(objects.map((o) => [o.id, o])),
    connections: new Map(connections.map((c) => [c.id, c])),
    layouts: new Map([[diagramId, layouts]]),
  }
  act(() => {
    hook.version += 1
    for (const fn of hook.listeners) fn()
  })
}

const related = vi.hoisted(() => vi.fn(async (ids: string[]) => ids.slice(0, 0)))
vi.mock('../../lib/modelQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/modelQuery')>()
  return {
    ...actual,
    getModelQuery: () => new Proxy(actual.getModelQuery(), {
      get: (target, property) => (property === 'relatedDiagramObjectIds' ? related : Reflect.get(target, property)),
    }),
  }
})

class NoopObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver

const { CanvasView } = await import('./CanvasView')

const obj = (id: string, x = 0, y = 0): C4Object => ({
  id, name: id, type: 'container', scope: 'internal', position: { x, y }, size: { width: 160, height: 90 },
} as unknown as C4Object)
const diagram = (id: string, objectIds: string[]): Diagram => ({
  id, name: id, level: 'container', objectIds, connectionIds: [], groupIds: [],
} as unknown as Diagram)
const PLACED = {
  inner: { position: { x: 500, y: 300 }, size: { width: 160, height: 90 } },
  inner2: { position: { x: 800, y: 300 }, size: { width: 160, height: 90 } },
}

const lastDrawnIds = () => {
  const last = engine.setData.at(-1)
  return last ? (last[0] as C4Object[]).map((o) => o.id) : []
}
const lastGroupIds = () => {
  const last = engine.setData.at(-1)
  return last ? (last[2] as Array<{ id: string }>).map((g) => g.id) : []
}

beforeEach(() => {
  engine.callbacks = null
  engine.setData.length = 0
  hook.calls.length = 0
  hook.ref.current = { objects: new Map(), connections: new Map(), layouts: new Map() }
  related.mockClear()
  useAutomergeStatus.setState({ status: 'ready', ready: true, visualReady: true, editReady: true, error: null })
  useModelStore.setState({
    objects: [obj('host'), obj('peer', 400)],
    connections: [],
    groups: [],
    diagrams: [diagram('A', ['host', 'peer']), diagram('B', ['inner', 'inner2']), diagram('C', ['deep'])],
    currentDiagramId: 'A',
  })
  useUIStore.setState({ inlineExpansions: {}, inlineExpansionsDiagramId: null })
})
afterEach(cleanup)

describe('CanvasView ↔ inline expansion wires', () => {
  it('hands the hook the expansions only on their own diagram, and the diagram registry', () => {
    useUIStore.getState().expandInline('A', 'host', 'B')
    render(<CanvasView />)
    expect(hook.calls.at(-1)!.expansions).toEqual({ host: 'B' })
    // The registry is what makes the hook re-read a target whose composition
    // changed; `null` there never changes.
    expect(hook.calls.at(-1)!.registry).toBe(useModelStore.getState().diagrams)

    act(() => { useUIStore.setState({ inlineExpansionsDiagramId: 'other' }) })
    expect(hook.calls.at(-1)!.expansions).toEqual({})
  })

  it('draws the target\'s shapes from the hook\'s contents, once they land', () => {
    useUIStore.getState().expandInline('A', 'host', 'B')
    render(<CanvasView />)
    // Nothing loaded yet: the host stays a shape (pending).
    expect(lastDrawnIds()).toContain('host')
    expect(lastDrawnIds()).not.toContain('inner')

    publish([obj('inner'), obj('inner2')], PLACED)
    expect(lastDrawnIds()).toEqual(expect.arrayContaining(['peer', 'inner', 'inner2']))
    expect(lastDrawnIds()).not.toContain('host')
    expect(lastGroupIds()).toContain(inlineWrapperId('host'))
    // In the TARGET's arrangement: 300 apart, as laid out over there.
    const drawn = new Map((engine.setData.at(-1)![0] as C4Object[]).map((o) => [o.id, o.position]))
    expect(drawn.get('inner2')!.x - drawn.get('inner')!.x).toBe(300)
  })

  it('draws the target\'s connections from the hook\'s contents', () => {
    useModelStore.setState({
      diagrams: [diagram('A', ['host', 'peer']), { ...diagram('B', ['inner', 'inner2']), connectionIds: ['c-in'] }],
    })
    useUIStore.getState().expandInline('A', 'host', 'B')
    render(<CanvasView />)
    publish([obj('inner'), obj('inner2')], PLACED, [{ id: 'c-in', fromId: 'inner', toId: 'inner2' } as never])
    const drawnConnections = (engine.setData.at(-1)![1] as Array<{ id: string }>).map((c) => c.id)
    expect(drawnConnections).toContain('c-in')
  })

  it('asks for the related-diagram ⤢ of the shapes an expansion pulled in', async () => {
    useUIStore.getState().expandInline('A', 'host', 'B')
    render(<CanvasView />)
    related.mockClear()
    publish([obj('inner'), obj('inner2')], PLACED)
    await act(async () => {})
    expect(related).toHaveBeenCalled()
    expect(related.mock.calls.at(-1)![0]).toEqual(expect.arrayContaining(['inner', 'inner2']))
  })

  it('opens the expand menu on a shape that only an expansion pulled in', () => {
    useUIStore.getState().expandInline('A', 'host', 'B')
    render(<CanvasView />)
    publish([obj('inner'), obj('inner2')], PLACED)
    act(() => { engine.callbacks!.onExpandClick('inner', 10, 10) })
    expect(screen.queryByTestId('expand-menu')).not.toBeNull()
  })

  // QA round 2: kills the lookups going back to snapshot-first, and either one
  // dropping a source. `inner` is in BOTH (the index copy is live, the hook's is
  // a snapshot); `inner2` only in the index; `inner3` only in the snapshot.
  it('prefers the live index copy of a pulled shape, and falls back to the snapshot', () => {
    const live = (id: string, name: string) => ({ ...obj(id), name }) as C4Object
    useModelStore.setState({
      objects: [obj('host'), obj('peer', 400), live('inner', 'Live'), live('inner2', 'Live')],
      connections: [{ id: 'c-in', fromId: 'inner', toId: 'inner2', label: 'Live' } as never],
      diagrams: [
        diagram('A', ['host', 'peer']),
        { ...diagram('B', ['inner', 'inner2', 'inner3']), connectionIds: ['c-in'] },
      ],
    })
    useUIStore.getState().expandInline('A', 'host', 'B')
    render(<CanvasView />)
    const placed = {
      ...PLACED,
      inner3: { position: { x: 1100, y: 300 }, size: { width: 160, height: 90 } },
    }
    publish(
      [live('inner', 'Stale'), live('inner3', 'Snapshot')],
      placed,
      [{ id: 'c-in', fromId: 'inner', toId: 'inner2', label: 'Stale' } as never],
    )
    const drawn = new Map((engine.setData.at(-1)![0] as C4Object[]).map((o) => [o.id, o.name]))
    expect(drawn.get('inner')).toBe('Live')
    expect(drawn.get('inner2')).toBe('Live')
    expect(drawn.get('inner3')).toBe('Snapshot')
    const lines = new Map((engine.setData.at(-1)![1] as Array<{ id: string; label?: string }>).map((c) => [c.id, c.label]))
    expect(lines.get('c-in')).toBe('Live')
  })

  it('collapsing a shape drops the expansions nested inside it, and keeps the rest', () => {
    const ui = useUIStore.getState()
    ui.expandInline('A', 'host', 'B')
    ui.expandInline('A', 'inner', 'C')
    ui.expandInline('A', 'peer', 'C')
    render(<CanvasView />)
    act(() => { engine.callbacks!.onGroupExpandClick('host', 10, 10) })
    expect(useUIStore.getState().inlineExpansions).toEqual({ peer: 'C' })
  })

  // Not a collapse: the host leaves the diagram (deleted, or removed from it).
  it('drops the entries whose host left the diagram, nested ones included', () => {
    const ui = useUIStore.getState()
    ui.expandInline('A', 'host', 'B')
    ui.expandInline('A', 'inner', 'C')
    ui.expandInline('A', 'peer', 'C')
    render(<CanvasView />)
    expect(useUIStore.getState().inlineExpansions).toEqual({ host: 'B', inner: 'C', peer: 'C' })

    act(() => {
      useModelStore.setState({
        objects: [obj('peer', 400)],
        diagrams: [diagram('A', ['peer']), diagram('B', ['inner', 'inner2']), diagram('C', ['deep'])],
      })
    })
    expect(useUIStore.getState().inlineExpansions).toEqual({ peer: 'C' })
  })
})
