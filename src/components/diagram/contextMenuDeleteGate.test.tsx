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
 * The only-in-this-diagram gate, tested where it is actually WIRED.
 *
 * `deleteCommands` is handed a `canDeleteFromModel` verdict and does as it is
 * told, so testing it proves only that a boolean flows downhill. The thing that
 * can go wrong is upstream: each of the four menus computes that verdict itself,
 * from a different store predicate. Passing a literal `true` there — or reading
 * `isObjectOnlyInDiagram` for a group — offers a one-click, undo-less delete of
 * an entity other diagrams are still drawing, and nothing else in the suite
 * would notice.
 *
 * So these render the real menus against a real store and assert on whether the
 * destructive row exists.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CanvasContextMenu,
  ConnectionContextMenu,
  GroupContextMenu,
  MultiSelectContextMenu,
} from './CanvasView'
import { useModelStore } from '../../stores/modelStore'
import type { C4Object, Connection, Diagram, Group } from '../../types'

// Partial: importing CanvasView drags in the app's i18n bootstrap, which needs
// the real `initReactI18next`. Only the hook is stubbed, so labels read back as
// their keys and these tests assert on structure rather than on wording.
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
const conn = (id: string, fromId: string, toId: string): Connection => ({
  id, fromId, toId, type: 'solid',
})
const dg = (id: string, over: Partial<Diagram> = {}): Diagram => ({
  id, name: id, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over,
})

/** `here` is the menu's diagram; `elsewhere` is the one that makes it shared. */
function seed(here: Partial<Diagram>, elsewhere: Partial<Diagram> = {}) {
  useModelStore.setState({
    objects: [obj('local'), obj('shared'), obj('from'), obj('to')],
    groups: [grp('payments')],
    connections: [conn('link', 'from', 'to')],
    diagrams: [dg('here', here), dg('elsewhere', elsewhere)],
    domains: [], flows: [], currentDiagramId: 'here', selectedItems: [],
  })
}

afterEach(cleanup)

describe('the only-in-this-diagram gate, as the menus wire it', () => {
  beforeEach(() => {
    useModelStore.setState({
      objects: [], groups: [], connections: [], diagrams: [], selectedItems: [], currentDiagramId: null,
    })
  })

  const objectMenu = (
    <CanvasContextMenu
      x={0} y={0} objectId="local" groups={[]} currentDiagramId="here"
      onClose={noop} onAddToGroup={noop} onRemoveFromGroup={noop}
      onRemoveFromDiagram={noop} onDeleteFromModel={noop} onCopySize={noop} onCopyStyle={noop}
    />
  )

  it('offers a model delete for a shape that lives only here', () => {
    seed({ objectIds: ['local'] })
    render(objectMenu)
    expect(screen.queryByTestId('ctx-object-delete-from-model')).not.toBeNull()
  })

  it('withholds it once the same shape is drawn on another diagram', () => {
    // Deleting it from the model here would silently gut the other diagram.
    seed({ objectIds: ['local'] }, { objectIds: ['local'] })
    render(objectMenu)
    expect(screen.queryByTestId('ctx-object-delete-from-model')).toBeNull()
    expect(screen.queryByTestId('ctx-object-remove-from-diagram')).not.toBeNull()
  })

  const groupMenu = (
    <GroupContextMenu
      x={0} y={0} groupId="payments" currentDiagramId="here"
      onClose={noop} onRemoveFromDiagram={noop} onDeleteFromModel={noop}
      onCopySize={noop} onCopyStyle={noop}
    />
  )

  it('gates a group on the GROUP predicate, not the object one', () => {
    seed({ groupIds: ['payments'] })
    render(groupMenu)
    expect(screen.queryByTestId('ctx-group-delete-from-model')).not.toBeNull()
    cleanup()

    seed({ groupIds: ['payments'] }, { groupIds: ['payments'] })
    render(groupMenu)
    expect(screen.queryByTestId('ctx-group-delete-from-model')).toBeNull()
  })

  const connectionMenu = (
    <ConnectionContextMenu
      x={0} y={0} connectionId="link" currentDiagramId="here"
      onClose={noop} onRemoveFromDiagram={noop} onDeleteFromModel={noop}
    />
  )

  it('gates a connection on the CONNECTION predicate', () => {
    seed({ connectionIds: ['link'] })
    render(connectionMenu)
    expect(screen.queryByTestId('ctx-connection-delete-from-model')).not.toBeNull()
    cleanup()

    seed({ connectionIds: ['link'] }, { connectionIds: ['link'] })
    render(connectionMenu)
    expect(screen.queryByTestId('ctx-connection-delete-from-model')).toBeNull()
  })

  const multiMenu = (
    <MultiSelectContextMenu
      x={0} y={0}
      selectedItems={[{ id: 'local', type: 'object' }, { id: 'shared', type: 'object' }]}
      currentDiagramId="here"
      onClose={noop} onRemoveFromDiagram={noop} onDeleteFromModel={noop}
      onCopySize={noop} onCopyStyle={noop}
    />
  )

  // All-or-nothing on purpose: `deleteSelectedItems` reads the whole selection
  // and there is no `deleteObjects(ids)` action, so the only partial rendering
  // available is a row promising to delete 2 shapes while deleting 1 — worse
  // than offering nothing.
  it('withholds the model delete when ONE shape of the selection is shared', () => {
    seed({ objectIds: ['local', 'shared'] })
    render(multiMenu)
    expect(screen.queryByTestId('ctx-multi-delete-from-model')).not.toBeNull()
    cleanup()

    seed({ objectIds: ['local', 'shared'] }, { objectIds: ['shared'] })
    render(multiMenu)
    expect(screen.queryByTestId('ctx-multi-delete-from-model')).toBeNull()
    expect(screen.queryByTestId('ctx-multi-remove-from-diagram')).not.toBeNull()
  })

  it('routes each row to its own command, not to one branch on a boolean', () => {
    seed({ objectIds: ['local'] })
    const onRemoveFromDiagram = vi.fn()
    const onDeleteFromModel = vi.fn()
    render(
      <CanvasContextMenu
        x={0} y={0} objectId="local" groups={[]} currentDiagramId="here"
        onClose={noop} onAddToGroup={noop} onRemoveFromGroup={noop}
        onRemoveFromDiagram={onRemoveFromDiagram} onDeleteFromModel={onDeleteFromModel}
        onCopySize={noop} onCopyStyle={noop}
      />,
    )

    fireEvent.click(screen.getByTestId('ctx-object-remove-from-diagram'))
    expect(onRemoveFromDiagram).toHaveBeenCalledTimes(1)
    expect(onDeleteFromModel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('ctx-object-delete-from-model'))
    expect(onDeleteFromModel).toHaveBeenCalledTimes(1)
    expect(onRemoveFromDiagram).toHaveBeenCalledTimes(1)
  })

  // The destructive row must not sit next to the "remove from <group>" rows,
  // which carry the same error colour: one row's overshoot separates an
  // irreversible model delete from a harmless un-grouping.
  it('puts the shape menu\'s delete rows after the groups section', () => {
    seed({ objectIds: ['local'], groupIds: ['payments'] })
    render(
      <CanvasContextMenu
        x={0} y={0} objectId="local" groups={[grp('payments')]} currentDiagramId="here"
        onClose={noop} onAddToGroup={noop} onRemoveFromGroup={noop}
        onRemoveFromDiagram={noop} onDeleteFromModel={noop} onCopySize={noop} onCopyStyle={noop}
      />,
    )

    const rows = Array.from(document.querySelectorAll('button'))
    const destructive = rows.findIndex((b) => b.dataset.testid === 'ctx-object-delete-from-model')
    const lastGroupRow = rows.map((b) => b.textContent).lastIndexOf('payments')
    expect(destructive).toBeGreaterThan(lastGroupRow)
    expect(destructive).toBe(rows.length - 1)
  })
})
