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
 * The clipboard rows of the canvas context menus, rendered against a real store.
 * The thing worth proving is the selection hand-off: a right-click does not
 * select, so the single-shape and group menus must make their subject the
 * selection BEFORE the command runs.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasContextMenu, GroupContextMenu, MultiSelectContextMenu } from './CanvasView'
import { CanvasBackgroundContextMenu } from './CanvasBackgroundContextMenu'
import { useModelStore } from '../../stores/modelStore'
import type { C4Object, Diagram, Group } from '../../types'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))

const noop = () => undefined

const obj = (id: string): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 10, height: 10 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
})
const grp = (id: string): Group => ({
  id, name: id, objectIds: [], color: '#000000', position: { x: 0, y: 0 },
  size: { width: 100, height: 100 }, tagAssignments: {}, tagOrder: [],
})
const dg = (id: string, over: Partial<Diagram> = {}): Diagram => ({
  id, name: id, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over,
})

beforeEach(() => {
  useModelStore.setState({
    objects: [obj('a'), obj('b')],
    groups: [grp('g')],
    connections: [],
    diagrams: [dg('here', { objectIds: ['a', 'b'], groupIds: ['g'] })],
    domains: [], flows: [], currentDiagramId: 'here',
    // The user had selected `b`, then right-clicked `a`.
    selectedItems: [{ id: 'b', type: 'object' }],
  })
})
afterEach(cleanup)

const shapeMenu = (clipboard: Parameters<typeof CanvasContextMenu>[0]['clipboard']) => (
  <CanvasContextMenu
    x={0} y={0} objectId="a" groups={[]} currentDiagramId="here"
    onClose={noop} onAddToGroup={noop} onRemoveFromGroup={noop}
    onRemoveFromDiagram={noop} onDeleteFromModel={noop} onCopySize={noop} onCopyStyle={noop}
    clipboard={clipboard}
  />
)

describe('clipboard rows on the shape, group and multi-select menus', () => {
  it('renders Cut, Copy, Duplicate and Paste (when available) with shortcuts', () => {
    render(shapeMenu({ mac: false, canPaste: true, run: noop }))
    for (const id of ['ctx-cut', 'ctx-copy', 'ctx-paste', 'ctx-duplicate']) {
      expect(screen.queryByTestId(id)).not.toBeNull()
    }
    expect(screen.getByTestId('ctx-copy').textContent).toContain('Ctrl+C')
  })

  it('omits Paste when nothing was copied', () => {
    render(shapeMenu({ mac: false, canPaste: false, run: noop }))
    expect(screen.queryByTestId('ctx-paste')).toBeNull()
    expect(screen.queryByTestId('ctx-copy')).not.toBeNull()
  })

  it('selects the right-clicked shape BEFORE running copy', () => {
    const seen: string[][] = []
    const run = vi.fn(() => {
      seen.push(useModelStore.getState().selectedItems.map((s) => s.id))
    })
    render(shapeMenu({ mac: false, canPaste: false, run }))

    fireEvent.click(screen.getByTestId('ctx-copy'))

    expect(run).toHaveBeenCalledWith('copy')
    expect(seen).toEqual([['a']])
  })

  it('selects the right-clicked group before running duplicate', () => {
    const seen: string[][] = []
    const run = vi.fn(() => {
      seen.push(useModelStore.getState().selectedItems.map((s) => s.id))
    })
    render(
      <GroupContextMenu
        x={0} y={0} groupId="g" currentDiagramId="here"
        onClose={noop} onRemoveFromDiagram={noop} onDeleteFromModel={noop}
        onCopySize={noop} onCopyStyle={noop}
        clipboard={{ mac: false, canPaste: false, run }}
      />,
    )

    fireEvent.click(screen.getByTestId('ctx-duplicate'))

    expect(run).toHaveBeenCalledWith('duplicate')
    expect(seen).toEqual([['g']])
  })

  it('leaves the selection alone on the multi-select menu', () => {
    const run = vi.fn()
    const onClose = vi.fn()
    render(
      <MultiSelectContextMenu
        x={0} y={0}
        selectedItems={[{ id: 'a', type: 'object' }, { id: 'b', type: 'object' }]}
        currentDiagramId="here"
        onClose={onClose} onRemoveFromDiagram={noop} onDeleteFromModel={noop}
        onCopySize={noop} onCopyStyle={noop}
        clipboard={{ mac: false, canPaste: false, run }}
      />,
    )

    fireEvent.click(screen.getByTestId('ctx-cut'))

    expect(run).toHaveBeenCalledWith('cut')
    expect(onClose).toHaveBeenCalled()
    expect(useModelStore.getState().selectedItems.map((s) => s.id)).toEqual(['b'])
  })
})

describe('the empty-canvas menu', () => {
  it('renders its rows, with Undo and Redo disabled when there is nothing to undo', () => {
    render(<CanvasBackgroundContextMenu x={0} y={0} mac={false} onClose={noop} run={noop} />)

    expect(screen.queryByTestId('ctx-canvas-paste-here')).not.toBeNull()
    expect(screen.queryByTestId('ctx-canvas-select-all')).not.toBeNull()
    expect((screen.getByTestId('ctx-canvas-undo') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('ctx-canvas-redo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('runs Paste here and Select all through the injected runner, then closes', () => {
    const run = vi.fn()
    const onClose = vi.fn()
    render(<CanvasBackgroundContextMenu x={0} y={0} mac={false} onClose={onClose} run={run} />)

    fireEvent.click(screen.getByTestId('ctx-canvas-paste-here'))
    fireEvent.click(screen.getByTestId('ctx-canvas-select-all'))

    expect(run.mock.calls.map((c) => c[0])).toEqual(['paste', 'selectAll'])
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
