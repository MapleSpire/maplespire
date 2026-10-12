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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'

const mocks = vi.hoisted(() => ({
  editReady: false,
  toggleLeftSidebar: vi.fn(),
  setRightSidebarOpen: vi.fn(),
  setShopOpen: vi.fn(),
  currentView: 'diagram',
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: unknown) => unknown) => selector({
    currentView: mocks.currentView,
    leftSidebarOpen: true,
    toggleLeftSidebar: mocks.toggleLeftSidebar,
    rightSidebarOpen: true,
    setRightSidebarOpen: mocks.setRightSidebarOpen,
    shopOpen: false,
    setShopOpen: mocks.setShopOpen,
  }),
}))

vi.mock('../../stores/automergeStatusStore', () => ({
  useAutomergeStatus: (selector: (state: unknown) => unknown) => selector({ editReady: mocks.editReady }),
}))

vi.mock('./LeftSidebar', () => ({ LeftSidebar: () => <nav data-testid="left-sidebar" /> }))
vi.mock('./RightSidebar', () => ({ RightSidebar: () => <aside data-testid="right-sidebar" /> }))
vi.mock('./BottomBar', () => ({ BottomBar: () => <section data-testid="bottom-bar" /> }))
vi.mock('../diagram/EditorToolPill', () => ({
  EditorToolPill: ({ editReady }: { editReady: boolean }) => (
    <nav data-testid="editor-pill" data-edit-ready={String(editReady)} />
  ),
}))
vi.mock('../ai-assist/AIAssistPanel', () => ({ AIAssistPanel: () => <div data-testid="ai-assist" /> }))
vi.mock('../diagram/CreateShapePalette', () => ({ CreateShapePalette: () => <div data-testid="shape-palette" /> }))
vi.mock('../AutomergeBridge', () => ({ AutomergeBridge: () => null }))
vi.mock('../presence/DiagramPresenceBridge', () => ({ DiagramPresenceBridge: () => null }))
vi.mock('../ShareAutoPublisher', () => ({ ShareAutoPublisher: () => null }))
vi.mock('../modals/SearchModal', () => ({ SearchModal: () => null }))
vi.mock('../modals/SettingsModal', () => ({ SettingsModal: () => null }))
vi.mock('../modals/ShareModal', () => ({ ShareModal: () => null }))
vi.mock('../drafts/MergeChangesModal', () => ({ MergeChangesModal: () => null }))
vi.mock('../history/DiagramHistoryPanel', () => ({ DiagramHistoryPanel: () => null }))
vi.mock('../shop/ShopModal', () => ({ ShopModal: () => null }))

beforeEach(() => {
  mocks.currentView = 'diagram'
  mocks.editReady = false
})

afterEach(cleanup)

describe('AppShell loading chrome', () => {
  it('keeps navigation chrome mounted and interactive while diagram editing boots', () => {
    render(<AppShell><div data-testid="canvas" /></AppShell>)

    const leftShell = screen.getByTestId('left-sidebar-shell')
    const rightShell = screen.getByTestId('right-sidebar-shell')
    expect(leftShell.className).not.toContain('pointer-events-none')
    expect(rightShell.className).not.toContain('pointer-events-none')
    expect(leftShell.getAttribute('aria-busy')).toBe('true')
    expect(rightShell.getAttribute('aria-busy')).toBe('true')

    expect(screen.getByTestId('editor-pill').getAttribute('data-edit-ready')).toBe('false')
    expect(screen.getByTestId('bottom-bar')).toBeTruthy()
    expect(screen.queryByTestId('ai-assist')).toBeNull()
    expect(screen.queryByTestId('shape-palette')).toBeNull()
  })

  it('mounts AI Assist on the decision-records page without editor-only chrome', () => {
    mocks.currentView = 'decision-records'
    mocks.editReady = true

    render(<AppShell><div data-testid="decision-records" /></AppShell>)

    expect(screen.getByTestId('ai-assist')).toBeTruthy()
    expect(screen.queryByTestId('left-sidebar')).toBeNull()
    expect(screen.queryByTestId('editor-pill')).toBeNull()
    expect(screen.queryByTestId('bottom-bar')).toBeNull()
  })
})
