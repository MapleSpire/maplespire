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
 * The connection context menu's "Lock to anchors / Unlock" row, for a derived
 * (`kind: 'lower'`) connection. A lower's routing is its DIAGRAM's
 * (`Diagram.lowerRouting`, src/lib/diagrams/lowerRouting.ts), not the shared
 * lower object's. The menu read the raw object, so after Auto-layout locked a
 * lower the row offered "Lock" and clicking it wrote `true` over `true`: the
 * lock could not be removed from the menu (architect lens, 2026-10-22).
 *
 * Rendered against the real store, the pattern of contextMenuDeleteGate.test.tsx.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectionContextMenu } from './CanvasView'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import type { C4Object, Diagram } from '../../types'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))

const noop = () => undefined

const obj = (id: string, parentId?: string): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 10, height: 10 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  ...(parentId ? { parentId } : {}),
})

const here = (): Diagram => useModelStore.getState().diagrams.find((d) => d.id === 'here')!

afterEach(cleanup)

describe('the connection menu reads a lower\'s lock as its diagram draws it', () => {
  beforeEach(() => {
    useUIStore.setState({ canvasViewMode: '2d' })
    useModelStore.setState({
      objects: [obj('S'), obj('P'), obj('s1', 'S'), obj('p1', 'P')],
      groups: [],
      connections: [
        { id: 'c1', fromId: 's1', toId: 'p1', type: 'solid', kind: 'direct' },
        { id: 'lower:S→P', fromId: 'S', toId: 'P', type: 'dashed', kind: 'lower', label: '' },
      ],
      diagrams: [{
        id: 'here', name: 'here', type: 'context', objectIds: ['S', 'P'], connectionIds: ['lower:S→P'], groupIds: [],
        // What Auto-layout leaves: the diagram locks the lower; the object says nothing.
        lowerRouting: { 'S→P': { fromAnchor: 4, toAnchor: 10, lockedToAnchors: true } },
      }],
      domains: [], flows: [], currentDiagramId: 'here', selectedItems: [],
    })
  })

  const menu = (
    <ConnectionContextMenu
      x={0} y={0} connectionId="lower:S→P" currentDiagramId="here"
      onClose={noop} onRemoveFromDiagram={noop} onDeleteFromModel={noop}
    />
  )

  it('offers "Unlock" for a lower its diagram locked, and the click unlocks it', () => {
    render(menu)
    const row = screen.getByText('canvasViewChrome.contextMenu.unlockFromAnchors')
    fireEvent.click(row)
    expect(here().lowerRouting?.['S→P']?.lockedToAnchors).toBe(false)
  })
})
