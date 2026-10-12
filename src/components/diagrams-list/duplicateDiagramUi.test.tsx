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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Diagram } from '../../types'

const mocks = vi.hoisted(() => ({
  loadDiagramDuplicateSource: vi.fn(),
}))

vi.mock('../../lib/diagrams/duplicateSource', () => ({
  loadDiagramDuplicateSource: mocks.loadDiagramDuplicateSource,
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.name ? `${key}:${String(vars.name)}` : key,
  }),
}))
// The shell renders the page chrome (nav, search pill, right panel); none of it
// is under test and it drags in routing.
vi.mock('../layout/WorkspaceShell', () => ({
  WorkspaceShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WorkspacePill: () => null,
  PillFilterPopover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ShellRightPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ShellFieldRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('../modals/ImportModal', () => ({ ImportModal: () => null }))
// VirtualGrid measures with ResizeObserver; render every item instead.
vi.mock('../common/VirtualGrid', () => ({
  VirtualGrid: <T,>({ items, renderItem }: { items: T[]; renderItem: (item: T) => React.ReactNode }) => (
    <div>{items.map((item) => renderItem(item))}</div>
  ),
}))
vi.mock('../../lib/automerge/bridge', () => ({ isRegistrySummaryOnlyActive: () => false }))
vi.mock('../../lib/modelQuery/tierFlag', () => ({ isServerReadModelEnabled: () => false }))

const { DiagramsListView } = await import('./DiagramsListView')
const { useModelStore } = await import('../../stores/modelStore')

const source: Diagram = {
  id: 'dg1',
  name: 'Containers',
  type: 'container',
  objectIds: ['o1'],
  connectionIds: [],
  groupIds: [],
  layouts: { o1: { position: { x: 10, y: 20 }, size: { width: 160, height: 90 } } },
}

const openDuplicate = () => {
  fireEvent.click(screen.getByLabelText('dataViewsB.diagrams.card.menu.label:Containers'))
  return screen.getByTestId('diagram-duplicate')
}

beforeEach(() => {
  vi.clearAllMocks()
  useModelStore.setState({
    diagrams: [source],
    objects: [],
    connections: [],
    groups: [],
    domains: [],
    flows: [],
    currentDiagramId: 'dg1',
    workspaceReadOnly: false,
    selectedItems: [],
  })
})
afterEach(cleanup)

describe('duplicating a diagram from the list', () => {
  it('adds the copy without touching the model', async () => {
    mocks.loadDiagramDuplicateSource.mockResolvedValue({ diagram: source, flows: [], via: 'store' })
    render(<DiagramsListView />)
    fireEvent.click(openDuplicate())

    await waitFor(() => expect(useModelStore.getState().diagrams).toHaveLength(2))
    const copy = useModelStore.getState().diagrams.find((d) => d.id !== 'dg1')!
    expect(copy.objectIds).toEqual(['o1'])
    expect(copy.layouts).toEqual(source.layouts)
    expect(useModelStore.getState().objects).toEqual([])
  })

  it('shows the refusal instead of a copy when the source cannot be resolved', async () => {
    // The banner is the whole point of returning null: a duplicate built from a
    // layout-less stub would look successful and open as a pile at 0,0.
    mocks.loadDiagramDuplicateSource.mockResolvedValue(null)
    render(<DiagramsListView />)
    fireEvent.click(openDuplicate())

    const banner = await screen.findByTestId('diagram-duplicate-error')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('dataViewsB.diagrams.duplicateFailed:Containers')
    expect(useModelStore.getState().diagrams).toHaveLength(1)
  })

  it('lets the user dismiss the refusal', async () => {
    mocks.loadDiagramDuplicateSource.mockResolvedValue(null)
    render(<DiagramsListView />)
    fireEvent.click(openDuplicate())

    await screen.findByTestId('diagram-duplicate-error')
    fireEvent.click(screen.getByLabelText('common.close'))
    expect(screen.queryByTestId('diagram-duplicate-error')).toBeNull()
  })

  it('keeps the menu open and busy while the source loads', async () => {
    // Closing the menu first made `duplicating` an unreachable string: the click
    // had no visible effect whatsoever until the new card appeared.
    let release!: (value: null) => void
    mocks.loadDiagramDuplicateSource.mockReturnValue(new Promise((resolve) => { release = resolve }))
    render(<DiagramsListView />)
    fireEvent.click(openDuplicate())

    const busy = screen.getByTestId('diagram-duplicate') as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.textContent).toContain('dataViewsB.diagrams.card.menu.duplicating')

    release(null)
    await waitFor(() => expect(screen.queryByTestId('diagram-duplicate')).toBeNull())
  })

  it('does not switch the active diagram', async () => {
    mocks.loadDiagramDuplicateSource.mockResolvedValue({ diagram: source, flows: [], via: 'store' })
    render(<DiagramsListView />)
    fireEvent.click(openDuplicate())

    await waitFor(() => expect(useModelStore.getState().diagrams).toHaveLength(2))
    expect(useModelStore.getState().currentDiagramId).toBe('dg1')
  })

  it('closes the menu on Escape', () => {
    render(<DiagramsListView />)
    openDuplicate()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('diagram-duplicate')).toBeNull()
  })

  it('hides the whole menu for a view-only session', () => {
    useModelStore.setState({ workspaceReadOnly: true })
    render(<DiagramsListView />)
    expect(screen.queryByLabelText('dataViewsB.diagrams.card.menu.label:Containers')).toBeNull()
  })
})
