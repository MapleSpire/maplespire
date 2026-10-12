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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../../stores/authStore'
import { useModelStore } from '../../stores/modelStore'
import type { ObjectExplorerPage, ObjectExplorerRow } from '../../lib/modelQuery/types'
import { AddShapePanel } from './AddShapePanel'

const mocks = vi.hoisted(() => ({
  objectTreePage: vi.fn(),
  objectSearchPage: vi.fn(),
  allObjects: vi.fn(),
  listSelectableTechnologies: vi.fn(),
  resolveSelectableTechnologies: vi.fn(),
}))
const noMetrics = { appCount: 0, storeCount: 0, componentCount: 0, connectionCount: 0, diagramCount: 0 }

vi.mock('../../lib/modelQuery', () => ({
  getModelQuery: () => ({
    objectTreePage: mocks.objectTreePage,
    objectSearchPage: mocks.objectSearchPage,
    allObjects: mocks.allObjects,
  }),
}))

vi.mock('../../lib/technologies/api', () => ({
  listSelectableTechnologies: mocks.listSelectableTechnologies,
  resolveSelectableTechnologies: mocks.resolveSelectableTechnologies,
  TECHNOLOGY_SELECTOR_PAGE_SIZE: 50,
}))

vi.mock('../../lib/automerge/bridge', () => ({
  tombstoneObjectOffWindow: vi.fn(),
}))

vi.mock('../common/VirtualList', () => ({
  useVirtualRows: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => string }) => ({
    virtualItems: Array.from({ length: count }, (_, index) => ({
      index, key: getItemKey(index), start: index * 34,
    })),
    totalSize: count * 34,
    measureElement: vi.fn(),
  }),
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('AddShapePanel shared model filters', () => {
  beforeEach(() => {
    mocks.objectTreePage.mockReset().mockResolvedValue({ projectionGeneration: 1, items: [], nextCursor: null })
    mocks.objectSearchPage.mockReset().mockResolvedValue({ projectionGeneration: 1, items: [], nextCursor: null })
    mocks.allObjects.mockReset()
    mocks.listSelectableTechnologies.mockReset().mockResolvedValue({
      source: 'network',
      hasMore: false,
      technologies: [{
        id: 'tech-angular', scope: 'public', lifecycleStatus: 'active', orgState: 'enabled', orgOverride: null,
        revision: {
          revision: 1, status: 'approved', privateApproved: true, name: 'Angular', description: null,
          aliases: [], iconLightPath: null, iconDarkPath: null,
        },
      }],
    })
    mocks.resolveSelectableTechnologies.mockReset().mockResolvedValue({
      source: 'network', technologies: [],
    })
    useAuthStore.setState({ orgId: 'org-1' })
    useModelStore.setState({ objects: [], groups: [], diagrams: [], currentDiagramId: null })
  })

  afterEach(cleanup)

  it('debounces and composes search/type/scope/Technology through the bounded explorer', async () => {
    render(<AddShapePanel />)
    await waitFor(() => expect(mocks.objectTreePage).toHaveBeenCalled())

    fireEvent.change(screen.getByTestId('add-shape-search'), { target: { value: 'payments' } })
    fireEvent.click(screen.getByTestId('add-shape-filter-button'))

    const systemLabel = screen.getByText('diagramChrome.addShape.type.system').closest('label')
    const scopeLabel = screen.getByText('diagramChrome.addShape.scope.internal').closest('label')
    fireEvent.click(systemLabel!.querySelector('input')!)
    fireEvent.click(scopeLabel!.querySelector('input')!)
    fireEvent.click(await screen.findByTestId('technology-filter-tech-angular'))

    await waitFor(() => {
      expect(mocks.objectSearchPage).toHaveBeenLastCalledWith({
        query: 'payments',
        diagramId: null,
        filter: {
          types: ['system'],
          scope: 'internal',
          technologyIds: ['tech-angular'],
        },
        cursor: null,
        limit: 50,
      }, expect.any(AbortSignal))
    })
    expect(mocks.listSelectableTechnologies).toHaveBeenCalledWith('org-1', '', expect.any(AbortSignal))
    expect(mocks.allObjects).not.toHaveBeenCalled()
  })

  it('shows a chevron only for rows that actually have children', async () => {
    const emptySystem: ObjectExplorerRow = {
      id: 'empty-system', name: 'Empty system', kind: 'object', type: 'system', parentId: null,
      childCount: 0, hasChildren: false, canAcceptChildren: true, ...noMetrics, inDiagram: false, breadcrumb: [],
    }
    mocks.objectTreePage.mockResolvedValue({ projectionGeneration: 1, items: [emptySystem], nextCursor: null })

    render(<AddShapePanel />)

    const row = await screen.findByTestId('tree-node-empty-system')
    expect(within(row).queryByTestId('tree-node-expand-empty-system')).toBeNull()
  })

  it('expands a parent with children and renders the queried child rows', async () => {
    const parent: ObjectExplorerRow = {
      id: 'system', name: 'System', kind: 'object', type: 'system', parentId: null,
      childCount: 1, hasChildren: true, canAcceptChildren: true, ...noMetrics, inDiagram: false, breadcrumb: [],
    }
    const child: ObjectExplorerRow = {
      id: 'app', name: 'App', kind: 'object', type: 'app', parentId: 'system',
      childCount: 0, hasChildren: false, canAcceptChildren: true, ...noMetrics, inDiagram: false, breadcrumb: [],
    }
    mocks.objectTreePage.mockImplementation(({ parentId }: { parentId?: string | null }) => Promise.resolve({
      projectionGeneration: 1, items: parentId === 'system' ? [child] : [parent], nextCursor: null,
    } satisfies ObjectExplorerPage))

    render(<AddShapePanel />)
    fireEvent.click(await screen.findByTestId('tree-node-expand-system'))

    expect(await screen.findByTestId('tree-node-app')).not.toBeNull()
    await waitFor(() => expect(mocks.objectTreePage).toHaveBeenCalledWith(expect.objectContaining({
      parentId: 'system', cursor: null, limit: 50,
    }), expect.any(AbortSignal)))
  })

  it('keeps tree disclosure state while search uses a flat breadcrumb result', async () => {
    const parent: ObjectExplorerRow = {
      id: 'system', name: 'System', kind: 'object', type: 'system', parentId: null,
      childCount: 1, hasChildren: true, canAcceptChildren: true, ...noMetrics, inDiagram: false, breadcrumb: [],
    }
    const matchingChild: ObjectExplorerRow = {
      id: 'matching-app', name: 'Matching app', kind: 'object', type: 'app', parentId: 'system',
      childCount: 0, hasChildren: false, canAcceptChildren: true, ...noMetrics, inDiagram: false,
      breadcrumb: [{ id: 'system', name: 'System' }], matchKind: 'prefix',
    }
    mocks.objectTreePage.mockImplementation(({ parentId }: { parentId?: string | null }) => Promise.resolve({
      projectionGeneration: 1, items: parentId === 'system' ? [matchingChild] : [parent], nextCursor: null,
    } satisfies ObjectExplorerPage))
    mocks.objectSearchPage.mockResolvedValue({ projectionGeneration: 1, items: [matchingChild], nextCursor: null })

    render(<AddShapePanel />)
    fireEvent.click(await screen.findByTestId('tree-node-expand-system'))
    expect(await screen.findByTestId('tree-node-matching-app')).toBeTruthy()
    fireEvent.change(screen.getByTestId('add-shape-search'), { target: { value: 'matching' } })
    await waitFor(() => expect(mocks.objectSearchPage).toHaveBeenCalled())
    expect(await screen.findByText('System')).toBeTruthy()
    expect(screen.queryByTestId('tree-node-expand-matching-app')).toBeNull()
    fireEvent.change(screen.getByTestId('add-shape-search'), { target: { value: '' } })
    await waitFor(() => expect(screen.getByTestId('tree-node-expand-system').getAttribute('aria-expanded')).toBe('true'))
    expect(screen.getByTestId('tree-node-matching-app')).toBeTruthy()
  })
})
