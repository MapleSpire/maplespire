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
import { useModelStore } from '../../stores/modelStore'
import { FocusPicker } from './FocusPicker'

const mocks = vi.hoisted(() => ({ objectSearchPage: vi.fn(), lookupMany: vi.fn() }))

vi.mock('../../lib/modelQuery', () => ({
  getModelQuery: () => ({
    objectSearchPage: mocks.objectSearchPage,
    lookupMany: mocks.lookupMany,
  }),
  residentModelQuery: {},
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../common/VirtualList', () => ({
  useVirtualRows: ({ count }: { count: number }) => ({
    virtualItems: Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 32 })),
    totalSize: count * 32,
    measureElement: () => undefined,
  }),
}))

describe('FocusPicker offline browse contract', () => {
  beforeEach(() => {
    useModelStore.setState({ objects: [], groups: [] })
    mocks.lookupMany.mockReset().mockResolvedValue(new Map())
    mocks.objectSearchPage.mockReset().mockResolvedValue({
      projectionGeneration: 7,
      items: [{
        id: 'app-1', name: 'Checkout app', kind: 'object', type: 'app',
        parentId: null, childCount: 0, hasChildren: false, canAcceptChildren: true,
        appCount: 0, storeCount: 0, componentCount: 0, connectionCount: 0,
        diagramCount: 0, inDiagram: false, breadcrumb: [],
      }],
      nextCursor: null,
      total: 1,
      coverage: 'full',
    })
  })

  afterEach(cleanup)

  it('browses the Worker-capable unfiltered page when opened with an empty query', async () => {
    render(<FocusPicker focusId={null} />)
    fireEvent.click(screen.getByTestId('focus-picker-trigger'))

    expect(await screen.findByTestId('focus-picker-option-app-1')).toBeTruthy()
    await waitFor(() => expect(mocks.objectSearchPage).toHaveBeenCalled())
    const request = mocks.objectSearchPage.mock.calls[0][0]
    expect(request).toMatchObject({ query: '', cursor: null, limit: 50 })
    expect(request).not.toHaveProperty('filter')
  })
})
