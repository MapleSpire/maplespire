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
import {
  __resetRoutedRetriesForTest,
  fetchRetryable,
  routedRetriesInFlight,
} from '../../lib/api/retryable'
import {
  ShellRightPanel,
  WorkspaceShell,
} from './WorkspaceShell'

const mocks = vi.hoisted(() => ({
  setWorkspaceNavOpen: vi.fn(),
  setRightSidebarOpen: vi.fn(),
  setCurrentView: vi.fn(),
  setSettingsOpen: vi.fn(),
  setShareOpen: vi.fn(),
  automergeStatus: 'ready',
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: unknown) => unknown) => selector({
    workspaceNavOpen: true,
    setWorkspaceNavOpen: mocks.setWorkspaceNavOpen,
    rightSidebarOpen: true,
    setRightSidebarOpen: mocks.setRightSidebarOpen,
    aiAssistOpen: false,
    aiAssistWidth: 360,
    setCurrentView: mocks.setCurrentView,
    setSettingsOpen: mocks.setSettingsOpen,
    setShareOpen: mocks.setShareOpen,
  }),
}))

// `importOriginal` rather than a bare object: only the STORE is faked here.
// `effectiveSyncStatus` stays the real function, so the badge arms below
// exercise the shipped derivation instead of a stand-in that cannot be wrong.
vi.mock('../../stores/automergeStatusStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/automergeStatusStore')>()),
  useAutomergeStatus: (selector: (state: unknown) => unknown) => selector({ status: mocks.automergeStatus, error: null }),
}))

vi.mock('./OrgSwitcherMenu', () => ({ OrgSwitcherMenu: () => <button>Workspace</button> }))
vi.mock('../auth/AccountBadge', () => ({ AccountBadge: () => null }))
vi.mock('../model-viewer/ViewerGlyph', () => ({ ViewerGlyph: () => null }))

beforeEach(() => {
  localStorage.clear()
  mocks.automergeStatus = 'ready'
})
afterEach(cleanup)
// A retry counter left above zero would make every later arm see 'saving'.
afterEach(__resetRoutedRetriesForTest)

describe('WorkspaceShell right details panel', () => {
  it('shows Saving instead of Synced while PostgreSQL acknowledgement is pending', () => {
    mocks.automergeStatus = 'saving'
    render(<WorkspaceShell active="decision-records"><span>Content</span></WorkspaceShell>)
    expect(screen.getByTestId('ws-sync-status').getAttribute('data-status')).toBe('saving')
    expect(screen.getByText('layoutNav.shell.syncSaving')).toBeTruthy()
    expect(screen.queryByText('layoutNav.shell.syncSynced')).toBeNull()
  })

  it('does NOT say Synced while a routed read is being retried through a move (T-MA)', async () => {
    // `status` is a DURABILITY latch and is legitimately 'ready' during a
    // workspace move — nothing is unsaved, the reads are simply being refused
    // with `503 {retryable: true}` — so the badge must not claim "Synced" over
    // a page that has nothing on it.
    // NO `rerender` anywhere below, deliberately: a rerender forces React to
    // re-read `getSnapshot`, which would let the arm pass with an inert
    // `useSyncExternalStore` subscription (the thing production relies on).
    mocks.automergeStatus = 'ready'
    render(<WorkspaceShell active="decision-records"><span>Content</span></WorkspaceShell>)
    expect(screen.getByText('layoutNav.shell.syncSynced')).toBeTruthy()

    // Drive the REAL fetch layer, not a stubbed counter: the badge and the
    // retry must share one source of truth, and a fake here would pass even if
    // they were wired to two.
    let released: (() => void) | undefined
    const refusal = () => new Response(JSON.stringify({ retryable: true }), { status: 503 })
    const inFlight = fetchRetryable('/api/model/dependencies/page', {}, {
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(refusal())
        .mockResolvedValue(new Response('{}', { status: 200 })) as unknown as typeof fetch,
      sleep: () => new Promise<void>((resolve) => { released = resolve }),
    })
    await waitFor(() => expect(routedRetriesInFlight()).toBe(1))

    // The badge must move on the SUBSCRIPTION alone.
    await waitFor(() => {
      expect(screen.getByTestId('ws-sync-status').getAttribute('data-status')).toBe('saving')
    })
    expect(screen.queryByText('layoutNav.shell.syncSynced')).toBeNull()

    released?.()
    await inFlight
    // …and it goes BACK. Without this the arm passes against a badge that got
    // stuck on 'saving' for the rest of the session.
    await waitFor(() => expect(screen.getByText('layoutNav.shell.syncSynced')).toBeTruthy())
  })

  it('resizes by dragging and restores the saved width from localStorage', () => {
    const renderShell = () => render(
      <WorkspaceShell
        active="decision-records"
        rightResizable
        right={<ShellRightPanel title="Decision record"><span>Body</span></ShellRightPanel>}
      >
        <span>Content</span>
      </WorkspaceShell>,
    )

    const first = renderShell()
    const handle = screen.getByTestId('workspace-right-panel-resize-handle')
    fireEvent.pointerDown(handle, { clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 450 })
    fireEvent.pointerUp(window)

    expect(screen.getByTestId('workspace-right-panel-shell').style.width).toBe('362px')
    expect(localStorage.getItem('maplespire:decision-records:rightPanelWidth')).toBe('362')

    first.unmount()
    renderShell()
    expect(screen.getByTestId('workspace-right-panel-shell').style.width).toBe('362px')
  })

  it('places the collapse control before the panel title', () => {
    render(<ShellRightPanel title="Decision record"><span>Body</span></ShellRightPanel>)

    const title = screen.getByText('Decision record')
    const header = title.parentElement
    expect(header?.firstElementChild?.tagName).toBe('BUTTON')
    expect(header?.lastElementChild).toBe(title)
  })
})
