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
 * Offline under the SUMMARY contract, the diagram list must not render an empty
 * grid plus "Unable to load diagrams" while the bridge holds a perfectly good
 * local window (`summaryRegistryMetas`, projected into the store). Being offline
 * is exactly when a user needs to see the diagrams they DO have.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { useModelStore } from '../../stores/modelStore'
import type { Diagram } from '../../types'

const mocks = vi.hoisted(() => ({
  fetchDiagramListPage: vi.fn(),
  isRegistrySummaryOnlyActive: vi.fn(),
  isServerReadModelEnabled: vi.fn(),
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../../lib/modelQuery/diagrams', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/modelQuery/diagrams')>(),
  fetchDiagramListPage: mocks.fetchDiagramListPage,
}))
// The bridge is a very large module with a live repo; the list only asks it one
// question, so answer that question directly.
vi.mock('../../lib/automerge/bridge', () => ({
  isRegistrySummaryOnlyActive: mocks.isRegistrySummaryOnlyActive,
}))
vi.mock('../../lib/modelQuery/tierFlag', () => ({
  isServerReadModelEnabled: mocks.isServerReadModelEnabled,
}))

import { DiagramsListView } from './DiagramsListView'

function windowDiagram(id: string, name: string): Diagram {
  return { id, name, type: 'context', objectIds: [], connectionIds: [], groupIds: [] }
}

describe('the summary diagram list, offline', () => {
  beforeEach(() => {
    mocks.isRegistrySummaryOnlyActive.mockReturnValue(true)
    mocks.isServerReadModelEnabled.mockReturnValue(true)
    mocks.fetchDiagramListPage.mockRejectedValue(new Error('offline'))
    // What the bridge projects under the summary contract: the bounded window,
    // not the whole registry.
    useModelStore.setState({
      diagrams: [windowDiagram('d-local', 'Local window diagram')],
      domains: [], objects: [], connections: [], groups: [], flows: [], comments: [],
      currentDiagramId: null, workspaceReadOnly: false,
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('falls back to the local window with an honest partial message, not the failure screen', async () => {
    // Mutant: drop the `localWindowFallback` fallback → the grid is empty and
    // `loadFailed` renders instead, which is the pre-fold behaviour.
    render(<DiagramsListView />)

    await waitFor(() => expect(screen.getByTestId('diagram-list-partial-offline')).toBeTruthy())
    // The grid itself is virtualised and jsdom measures every box at 0, so the
    // CARDS are not a usable witness here. The placeholder is: the view renders
    // exactly one of loading / loadFailed / empty when `filtered.length === 0`,
    // so all three being absent proves the local window populated the list.
    expect(screen.queryByText('dataViewsB.diagrams.loadFailed')).toBeNull()
    expect(screen.queryByText('dataViewsB.diagrams.empty')).toBeNull()
    expect(screen.queryByText('dataViewsB.diagrams.loading')).toBeNull()
  })

  it('a CLASSIC server-paged list keeps the failure screen — the window is only summary-shaped', async () => {
    // The other server-paged mode (a View-grant session on a classic workspace)
    // has a COMPLETE resident registry, so a server failure there is a real
    // failure and the honest answer is still "unable to load". This is also the
    // guard against the fallback quietly widening into a mode where it would
    // mean something different.
    mocks.isRegistrySummaryOnlyActive.mockReturnValue(false)
    useModelStore.setState({ workspaceReadOnly: true })

    render(<DiagramsListView />)

    await waitFor(() => expect(screen.getByText('dataViewsB.diagrams.loadFailed')).toBeTruthy())
    expect(screen.queryByTestId('diagram-list-partial-offline')).toBeNull()
  })
})
