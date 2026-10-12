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
import { useAuthStore } from '../../stores/authStore'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { ModelObjectsView } from './ModelObjectsView'

const mocks = vi.hoisted(() => ({
  modelObjectFacets: vi.fn(),
  listSelectableTechnologies: vi.fn(),
  resolveSelectableTechnologies: vi.fn(),
}))

vi.mock('../../lib/modelQuery', () => ({
  getModelQuery: () => ({ modelObjectFacets: mocks.modelObjectFacets }),
}))

vi.mock('../../lib/technologies/api', () => ({
  listSelectableTechnologies: mocks.listSelectableTechnologies,
  resolveSelectableTechnologies: mocks.resolveSelectableTechnologies,
  TECHNOLOGY_SELECTOR_PAGE_SIZE: 50,
}))

vi.mock('../layout/WorkspaceShell', () => ({
  WorkspaceShell: ({ pill, children }: { pill?: React.ReactNode; children: React.ReactNode }) => <>{pill}{children}</>,
  WorkspacePill: ({ filter }: { filter: { panel: React.ReactNode } }) => <>{filter.panel}</>,
  PillFilterPopover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('./ModelObjectsTable', () => ({ ModelObjectsTable: () => null }))
vi.mock('../layout/RightSidebar', () => ({ RightSidebar: () => null }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('ModelObjectsView team facets', () => {
  beforeEach(() => {
    mocks.modelObjectFacets.mockReset().mockResolvedValue({ teamIds: ['team-off-window'] })
    mocks.listSelectableTechnologies.mockReset().mockResolvedValue({ source: 'network', technologies: [], hasMore: false })
    mocks.resolveSelectableTechnologies.mockReset().mockResolvedValue({ source: 'network', technologies: [] })
    useAuthStore.setState({ orgId: null })
    useUIStore.setState({
      modelObjectsSearchQuery: '', modelObjectsFilter: { types: [], tagIds: [] }, modelObjectsDomainId: null,
    })
    useModelStore.setState({
      objects: [{
        id: 'visible', type: 'app', name: 'Visible', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
        tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ownerTeamIds: ['team-window-only'],
      }],
      groups: [], domains: [], tags: [], selectedItems: [], workspaceReadOnly: true,
    })
  })

  afterEach(cleanup)

  it('renders the complete backend facet instead of deriving options from the resident window', async () => {
    render(<ModelObjectsView />)
    expect(await screen.findByText('team-off-window')).toBeTruthy()
    expect(screen.queryByText('team-window-only')).toBeNull()
    expect(mocks.modelObjectFacets).toHaveBeenCalledTimes(1)
  })
})
