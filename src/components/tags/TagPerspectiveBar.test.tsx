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
import { useAuthStore } from '../../stores/authStore'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { listTagGroupPage, listTagPage, reorderCatalogTag } from '../../lib/tags/api'
import { TagPerspectiveBar } from './TagPerspectiveBar'
import { moveRelative, resolvePerspectiveBarLayout } from './tagPerspectiveUtils'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({
      index,
      key: index,
      start: index * options.estimateSize(),
      size: options.estimateSize(),
    })),
    getTotalSize: () => options.count * options.estimateSize(),
  }),
}))

vi.mock('../../stores/workspaceStore', async () => {
  const { create } = await import('zustand')
  return {
    useWorkspaceStore: create(() => ({
      ref: { landscapeId: 'landscape-1', versionId: 'current' },
    })),
  }
})

vi.mock('../../lib/auth/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/auth/api')>(),
  myOrgs: vi.fn(async () => [{ id: 'org-1', name: 'Org', role: 'admin', status: 'active', defaultLandscapeId: null, isCurrent: true }]),
}))

vi.mock('../../lib/orgAdmin/api', () => ({
  getTeams: vi.fn(async () => ({
    teams: [{ id: 'team-platform', name: 'Platform', archivedAt: null, memberCount: 2 }],
    nextCursor: null,
  })),
}))

vi.mock('../../lib/tags/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/tags/api')>(),
  getTagSettings: vi.fn(async () => ({
    allowMemberTagCreation: true,
    allowEditorTagGroupCreation: false,
    version: 1,
    updatedAt: null,
    updatedBy: null,
  })),
  listTagGroupPage: vi.fn(async () => ({
    items: [
      {
        id: 'risk', orgId: 'org-1', name: 'Risk', description: null, iconKey: null,
        lifecycleStatus: 'active', version: 1, createdAt: '', updatedAt: '', tagCount: 2,
      },
      {
        id: 'cost', orgId: 'org-1', name: 'Cost', description: null, iconKey: null,
        lifecycleStatus: 'active', version: 1, createdAt: '', updatedAt: '', tagCount: 0,
      },
    ],
    nextCursor: null,
    source: 'network',
  })),
  listTagPage: vi.fn(async () => ({
    items: [
      { id: 'risk-high', orgId: 'org-1', groupId: 'risk', groupName: 'Risk', value: 'High', color: '#B42318', lifecycleStatus: 'active', canonicalTagId: null, version: 1, createdAt: '', updatedAt: '' },
      { id: 'risk-low', orgId: 'org-1', groupId: 'risk', groupName: 'Risk', value: 'Low', color: '#067647', lifecycleStatus: 'active', canonicalTagId: null, version: 1, createdAt: '', updatedAt: '' },
    ],
    nextCursor: null,
    source: 'network',
  })),
  reorderCatalogTag: vi.fn(async (_orgId, source) => ({ ...source, version: source.version + 1 })),
  reorderCatalogTagGroup: vi.fn(async (_orgId, source) => ({ ...source, version: source.version + 1 })),
}))

describe('TagPerspectiveBar', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({
      orgId: 'org-1',
      user: { id: 'admin', email: 'admin@example.test', isPlatformAdmin: false },
    })
    useModelStore.setState({
      workspaceReadOnly: false,
      currentDiagramId: 'diagram-1',
      diagrams: [{
        id: 'diagram-1',
        name: 'Current diagram',
        type: 'context',
        objectIds: ['object-1'],
        connectionIds: [],
        groupIds: [],
      }],
      objects: [{
        id: 'object-1',
        type: 'app',
        name: 'In diagram',
        position: { x: 0, y: 0 },
        size: { width: 180, height: 96 },
        tagAssignments: { 'risk-high': { tagId: 'risk-high' } },
        tagOrder: ['risk-high'],
        scope: 'internal',
        status: 'live',
        properties: {},
      }],
      groups: [],
      tags: [{
        tagId: 'risk-high',
        value: 'High',
        color: '#B42318',
        groupId: 'risk',
        groupName: 'Risk',
        catalogRevision: 1,
      }],
    })
    useWorkspaceStore.setState({ ref: { landscapeId: 'landscape-1', versionId: 'current' } })
    useUIStore.setState({
      bottomTab: null,
      activeTagGroupId: null,
      hoveredTagId: null,
      pinnedTagIds: [],
      focusedTagId: null,
      hiddenTagIds: [],
      managedPerspectiveInteractions: {
        technology: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: [] },
        status: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: [] },
        teams: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: [] },
      },
      leftSidebarOpen: true,
    })
  })

  it('pages one active Group, then exposes pin, focus and hide as separate states', async () => {
    render(<TagPerspectiveBar />)
    fireEvent.click(screen.getByTestId('bottom-tab-tags'))

    expect(await screen.findByText('Risk')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Risk' }))
    const high = await screen.findByTestId('tag-value-risk-high')
    expect(useUIStore.getState().activeTagGroupId).toBe('risk')
    expect(vi.mocked(listTagPage)).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ groupIds: ['risk'], limit: 50 }),
      expect.any(AbortSignal),
    )

    fireEvent.mouseEnter(high)
    expect(useUIStore.getState().hoveredTagId).toBe('risk-high')
    fireEvent.click(high)
    expect(useUIStore.getState().pinnedTagIds).toEqual(['risk-high'])

    fireEvent.click(screen.getByRole('button', { name: 'Focus on High' }))
    expect(useUIStore.getState().focusedTagId).toBe('risk-high')
    fireEvent.click(screen.getByRole('button', { name: 'Hide High' }))
    expect(useUIStore.getState().hiddenTagIds).toEqual(['risk-high'])
  })

  it('shows only Tag groups and values referenced by the current diagram', async () => {
    render(<TagPerspectiveBar />)
    fireEvent.click(screen.getByTestId('bottom-tab-tags'))

    const risk = await screen.findByTestId('tag-group-risk')
    expect(risk.textContent).toContain('Risk')
    expect(risk.textContent).toContain('1')
    expect(screen.queryByTestId('tag-group-cost')).toBeNull()
    expect(await screen.findByTestId('tag-value-risk-high')).toBeTruthy()
    expect(screen.queryByTestId('tag-value-risk-low')).toBeNull()
  })

  it('shows every diagram Tag by default and toggles a Group filter off', async () => {
    useModelStore.setState((state) => ({
      objects: state.objects.map((object) => object.id === 'object-1' ? {
        ...object,
        tagAssignments: {
          'risk-high': { tagId: 'risk-high' },
          'deployment-blue': { tagId: 'deployment-blue' },
        },
        tagOrder: ['risk-high', 'deployment-blue'],
      } : object),
      tags: [
        ...state.tags,
        {
          tagId: 'deployment-blue',
          value: 'Blue',
          color: '#175CD3',
          groupId: 'deployment',
          groupName: 'Deployment',
          catalogRevision: 1,
        },
      ],
    }))

    render(<TagPerspectiveBar />)
    fireEvent.click(screen.getByTestId('bottom-tab-tags'))

    const riskHigh = await screen.findByTestId('tag-value-risk-high')
    const deploymentBlue = await screen.findByTestId('tag-value-deployment-blue')
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy()
    expect(riskHigh.getAttribute('title')).toBe('Pin High (Risk)')
    expect(deploymentBlue.getAttribute('title')).toBe('Pin Blue (Deployment)')
    expect(useUIStore.getState().activeTagGroupId).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Risk' }))
    expect(useUIStore.getState().activeTagGroupId).toBe('risk')
    expect((await screen.findByTestId('tag-value-risk-high')).getAttribute('title')).toBe('Pin High')
    expect(screen.queryByTestId('tag-value-deployment-blue')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Risk' }))
    expect(useUIStore.getState().activeTagGroupId).toBeNull()
    expect(await screen.findByTestId('tag-value-deployment-blue')).toBeTruthy()
  })

  it('never shows Synchronisé while durability is pending (status saving)', async () => {
    // 'saving' must not fall through to the synced label on this surface: with
    // the entity-intent journal holding unflushed work, the most visible sync
    // indicator would falsely claim "Synced".
    const { useAutomergeStatus } = await import('../../stores/automergeStatusStore')
    useAutomergeStatus.setState({ status: 'saving' })
    try {
      const { container } = render(<TagPerspectiveBar />)
      const sync = container.querySelector('#sync-status')
      expect(sync?.getAttribute('data-status')).toBe('saving')
      // Locale-agnostic: the saving label in whichever catalog the test env
      // loaded, and NEVER the synced label in either language.
      expect(['Saving…', 'Enregistrement…']).toContain(sync?.textContent)
      expect(sync?.textContent).not.toMatch(/Synced|Synchronisé/)
    } finally {
      useAutomergeStatus.setState({ status: 'connecting' })
    }
  })

  it('keeps current-diagram Tags visible when the catalog pages are empty', async () => {
    vi.mocked(listTagGroupPage).mockResolvedValueOnce({ items: [], nextCursor: null, source: 'network' })

    render(<TagPerspectiveBar />)
    fireEvent.click(screen.getByTestId('bottom-tab-tags'))

    expect(await screen.findByTestId('tag-group-risk')).toBeTruthy()
    expect(await screen.findByTestId('tag-value-risk-high')).toBeTruthy()
  })

  it('lists teams and people responsible for diagram shapes and focuses their matches', async () => {
    useModelStore.setState((state) => ({
      objects: state.objects.map((object) => ({
        ...object,
        ownerTeamIds: ['team-platform'],
        ownerAssignments: {
          'user:alice': {
            id: 'user:alice',
            kind: 'person',
            source: 'platform',
            catalogId: 'alice',
            name: 'Alice Martin',
            email: 'alice@example.test',
          },
        },
        ownerAssignmentOrder: ['user:alice'],
      })),
    }))

    render(<TagPerspectiveBar />)
    fireEvent.click(screen.getByTestId('bottom-tab-teams'))

    expect(await screen.findByTestId('teams-value-team-platform')).toBeTruthy()
    expect(await screen.findByTestId('teams-value-user:alice')).toBeTruthy()
    expect(await screen.findByText('Platform')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Focus on Alice Martin' }))
    expect(useUIStore.getState().managedPerspectiveInteractions.teams.focusedId).toBe('user:alice')
  })

  it('includes Tags assigned to groups that belong to the current diagram', async () => {
    useModelStore.setState((state) => ({
      diagrams: state.diagrams.map((diagram) => ({ ...diagram, groupIds: ['group-1'] })),
      groups: [{
        id: 'group-1',
        name: 'Diagram group',
        color: '#64748B',
        objectIds: ['object-1'],
        tagAssignments: { 'risk-low': { tagId: 'risk-low' } },
        tagOrder: ['risk-low'],
      }],
      tags: [
        ...state.tags,
        {
          tagId: 'risk-low',
          value: 'Low',
          color: '#067647',
          groupId: 'risk',
          groupName: 'Risk',
          catalogRevision: 1,
        },
      ],
    }))

    render(<TagPerspectiveBar />)
    fireEvent.click(screen.getByTestId('bottom-tab-tags'))

    expect(await screen.findByTestId('tag-value-risk-high')).toBeTruthy()
    expect(await screen.findByTestId('tag-value-risk-low')).toBeTruthy()
  })

  it('uses the compact full/line/fab Design System states', async () => {
    render(<TagPerspectiveBar />)
    const bar = await screen.findByTestId('tag-perspective-bar')
    expect(bar.style.width).toBe('fit-content')
    expect(bar.style.right).toBe('')
    expect(screen.getByRole('button', { name: 'Collapse to button' }).querySelector('.lucide-chevron-left')).toBeTruthy()
    expect(screen.queryByTestId('perspective-collapse-line')).toBeNull()

    fireEvent.click(screen.getByTestId('bottom-tab-tags'))
    await waitFor(() => expect(bar.style.width).toMatch(/px$/))
    expect(screen.getByTestId('perspective-collapse-line')).toBeTruthy()

    fireEvent.click(screen.getByTestId('perspective-collapse-line'))
    expect(screen.queryByTestId('perspective-collapse-line')).toBeNull()
    fireEvent.click(screen.getByTestId('bottom-tab-tags'))
    expect(useUIStore.getState().bottomTab).toBe('tags')
    expect(screen.getByTestId('perspective-collapse-line')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse to button' }))
    expect(screen.getByTestId('perspective-fab')).toBeTruthy()
    fireEvent.click(screen.getByTestId('perspective-fab'))
    await waitFor(() => expect(screen.getByTestId('tag-perspective-bar')).toBeTruthy())
  })

  it('persists keyboard reordering by relative stable IDs', async () => {
    useModelStore.setState((state) => ({
      objects: state.objects.map((object) => object.id === 'object-1' ? {
        ...object,
        tagAssignments: {
          'risk-high': { tagId: 'risk-high' },
          'risk-low': { tagId: 'risk-low' },
        },
        tagOrder: ['risk-high', 'risk-low'],
      } : object),
      tags: [
        ...state.tags,
        {
          tagId: 'risk-low',
          value: 'Low',
          color: '#067647',
          groupId: 'risk',
          groupName: 'Risk',
          catalogRevision: 1,
        },
      ],
    }))
    render(<TagPerspectiveBar />)
    fireEvent.click(screen.getByTestId('bottom-tab-tags'))
    await screen.findByRole('button', { name: 'New group' })
    fireEvent.click(await screen.findByRole('button', { name: 'Risk' }))
    await waitFor(() => expect(vi.mocked(listTagPage)).toHaveBeenCalled())
    const handle = await screen.findByRole('button', { name: 'Reorder High' })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })

    await waitFor(() => expect(vi.mocked(reorderCatalogTag)).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ id: 'risk-high', version: 1 }),
      { afterId: 'risk-low' },
    ))
    const strip = screen.getByTestId('tag-value-strip')
    expect(strip.textContent?.indexOf('Low')).toBeLessThan(strip.textContent?.indexOf('High') ?? -1)
  })

  it('maps mouse-wheel and trackpad gestures to horizontal virtual-strip scrolling', async () => {
    const parentWheel = vi.fn()
    render(<div onWheel={parentWheel}><TagPerspectiveBar /></div>)
    fireEvent.click(screen.getByTestId('bottom-tab-tags'))
    const strip = await screen.findByTestId('tag-group-strip')
    Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 })
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 900 })
    strip.scrollLeft = 40

    fireEvent.wheel(strip, { deltaX: 0, deltaY: 120, deltaMode: 0 })
    expect(strip.scrollLeft).toBe(160)
    expect(parentWheel).not.toHaveBeenCalled()
    expect(await screen.findByTestId('tag-group-strip-scroll-indicator')).toBeTruthy()

    fireEvent.wheel(strip, { deltaX: 45, deltaY: 5, deltaMode: 0 })
    expect(strip.scrollLeft).toBe(205)
    expect(strip.className).toContain('perspective-strip-scrollbar')
  })
})

describe('moveRelative', () => {
  it('moves without changing stable item identity', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(moveRelative(items, 'a', 'b', false).map((item) => item.id)).toEqual(['b', 'a', 'c'])
    expect(moveRelative(items, 'c', 'a', true).map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('resolvePerspectiveBarLayout', () => {
  it('reserves the canvas controls instead of overlapping them', () => {
    expect(resolvePerspectiveBarLayout(1283, true, true, '2d')).toMatchObject({
      left: 340,
      right: 570,
      availableWidth: 373,
      bottom: 14,
      stacked: false,
      compact: true,
    })
  })

  it('stacks above the controls and falls back to a FAB when sidebars leave too little room', () => {
    expect(resolvePerspectiveBarLayout(1024, true, true, '2d')).toMatchObject({
      right: 338,
      availableWidth: 346,
      bottom: 70,
      stacked: true,
      compact: true,
      forcedFab: false,
    })
    expect(resolvePerspectiveBarLayout(800, true, true, '3d')).toMatchObject({
      bottom: 116,
      forcedFab: true,
    })
  })
})
