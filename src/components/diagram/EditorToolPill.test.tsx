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
import { EditorToolPill } from './EditorToolPill'

const mocks = vi.hoisted(() => ({
  setToolMode: vi.fn(),
  setCanvasViewMode: vi.fn(),
  requestCameraReset: vi.fn(),
  toggleLeftSidebar: vi.fn(),
  setHistoryOpen: vi.fn(),
  setSearchOpen: vi.fn(),
  setSettingsOpen: vi.fn(),
  setShopOpen: vi.fn(),
  setCurrentView: vi.fn(),
  setChangesDropdownOpen: vi.fn(),
  switchTo: vi.fn(),
  loadDrafts: vi.fn(),
  loadChanges: vi.fn(),
  clearChanges: vi.fn(),
  addDiagram: vi.fn(() => 'diagram-new'),
  setCurrentDiagram: vi.fn(),
  clearSelection: vi.fn(),
  createDraft: vi.fn(),
  clearDraftError: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: unknown) => unknown) => selector({
    toolMode: 'select',
    setToolMode: mocks.setToolMode,
    canvasViewMode: '2d',
    setCanvasViewMode: mocks.setCanvasViewMode,
    requestCameraReset: mocks.requestCameraReset,
    leftSidebarOpen: true,
    toggleLeftSidebar: mocks.toggleLeftSidebar,
    setHistoryOpen: mocks.setHistoryOpen,
    setSearchOpen: mocks.setSearchOpen,
    setSettingsOpen: mocks.setSettingsOpen,
    setShopOpen: mocks.setShopOpen,
    setCurrentView: mocks.setCurrentView,
    changesDropdownOpen: false,
    setChangesDropdownOpen: mocks.setChangesDropdownOpen,
  }),
}))

vi.mock('../../stores/modelStore', () => {
  const useModelStore = (selector: (state: unknown) => unknown) => selector({
    currentDiagramId: 'diagram-1',
    domains: [{ id: 'domain-1' }],
    workspaceReadOnly: false,
    addDiagram: mocks.addDiagram,
    setCurrentDiagram: mocks.setCurrentDiagram,
    clearSelection: mocks.clearSelection,
  })
  useModelStore.subscribe = vi.fn(() => () => undefined)
  return { useModelStore }
})

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({
    ref: { landscapeId: 'landscape-1', versionId: 'current' },
    bootResolved: false,
    switchTo: mocks.switchTo,
  }),
}))

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ config: { stage: 'on' } }),
}))

vi.mock('../../stores/draftsStore', () => ({
  useDraftsStore: (selector: (state: unknown) => unknown) => selector({
    drafts: [],
    load: mocks.loadDrafts,
    changes: null,
    changesFor: null,
    loadChanges: mocks.loadChanges,
    clearChanges: mocks.clearChanges,
    create: mocks.createDraft,
    busy: false,
    error: null,
    clearError: mocks.clearDraftError,
  }),
}))

vi.mock('../drafts/ChangesDropdown', () => ({ ChangesDropdown: () => null }))
vi.mock('../modals/ImportModal', () => ({
  ImportModal: ({ open }: { open: boolean }) => open ? <div data-testid="import-modal" /> : null,
}))

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('EditorToolPill loading behavior', () => {
  it('keeps navigation menus usable but disables diagram mutations until ready', () => {
    render(<EditorToolPill editReady={false} />)

    expect((screen.getByTestId('tool-select') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('view-2d') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('view-3d') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('add-shape-button') as HTMLButtonElement).disabled).toBe(true)

    const search = screen.getByTestId('search-button')
    const drafts = screen.getByTestId('draft-button')
    const settings = screen.getByTitle('diagramChrome.toolPill.settings')
    expect((search as HTMLButtonElement).disabled).toBe(false)
    expect((drafts as HTMLButtonElement).disabled).toBe(false)
    expect((settings as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(search)
    fireEvent.click(drafts)
    fireEvent.click(settings)
    expect(mocks.setSearchOpen).toHaveBeenCalledWith(true)
    expect(mocks.setCurrentView).toHaveBeenCalledWith('drafts')
    expect(mocks.setSettingsOpen).toHaveBeenCalledWith(true)
  })

  it('opens the create menu even when the shapes sidebar is already open', () => {
    render(<EditorToolPill />)

    fireEvent.click(screen.getByTestId('add-shape-button'))

    expect(screen.getByTestId('editor-add-menu')).toBeTruthy()
    expect(screen.getByTestId('add-draft-option')).toBeTruthy()
    expect(screen.getByTestId('add-blank-diagram-option')).toBeTruthy()
    expect(screen.getByTestId('add-import-option')).toBeTruthy()
    expect(mocks.toggleLeftSidebar).not.toHaveBeenCalled()
  })

  it('creates and selects a blank context diagram', () => {
    render(<EditorToolPill />)

    fireEvent.click(screen.getByTestId('add-shape-button'))
    fireEvent.click(screen.getByTestId('add-blank-diagram-option'))

    expect(mocks.addDiagram).toHaveBeenCalledWith({
      name: 'diagramChrome.toolPill.addMenu.blankDefaultName',
      type: 'context',
      objectIds: [],
      connectionIds: [],
      groupIds: [],
      domainId: 'domain-1',
    })
    expect(mocks.setCurrentDiagram).toHaveBeenCalledWith('diagram-new')
    expect(mocks.clearSelection).toHaveBeenCalled()
    expect(mocks.setCurrentView).toHaveBeenCalledWith('diagram')
  })

  it('opens the existing import flow from the create menu', () => {
    render(<EditorToolPill />)

    fireEvent.click(screen.getByTestId('add-shape-button'))
    fireEvent.click(screen.getByTestId('add-import-option'))

    expect(screen.getByTestId('import-modal')).toBeTruthy()
    expect(screen.queryByTestId('editor-add-menu')).toBeNull()
  })

  it('creates a named draft from the create menu', async () => {
    mocks.createDraft.mockResolvedValueOnce({ id: 'draft-new' })
    render(<EditorToolPill />)

    fireEvent.click(screen.getByTestId('add-shape-button'))
    fireEvent.click(screen.getByTestId('add-draft-option'))
    fireEvent.change(screen.getByLabelText('diagramChrome.toolPill.addMenu.draftName'), {
      target: { value: 'Payments redesign' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'diagramChrome.toolPill.addMenu.createDraft' }))

    await waitFor(() => expect(mocks.createDraft).toHaveBeenCalledWith('landscape-1', 'Payments redesign'))
    expect(screen.queryByTestId('editor-add-menu')).toBeNull()
  })
})
