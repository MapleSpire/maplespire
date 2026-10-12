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
 * `pagedModelQuery.connectionPage`'s last rung must declare `'working-set'`
 * coverage, like `objectTreePage`/`objectSearchPage`/`dependencyPage` do for the
 * same shape of answer — never `'full'`.
 *
 * Under the summary contract nothing fills the IndexedDB index (`syncModelIndex`
 * is skipped for the whole session), so a `'full'` claim would let an offline
 * Model Connections page present an empty index as the complete model and
 * suppress the partial-offline warning.
 *
 * Two tests, because a coverage flag is only worth what it REACHES: the rung
 * produces it, and the table renders the warning off it.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { pagedModelQuery, __setPagedStoreForTest } from './paged'
import { __setModelQueryForTest } from './index'
import { createMemoryKvStore } from './kvStore'
import { buildModelIndex } from './modelIndex'
import { useModelStore } from '../../stores/modelStore'
import { ConnectionsTable } from '../../components/connections/ConnectionsTable'
import type { ModelQuery } from './types'

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('paged connectionPage coverage', () => {
  beforeEach(async () => {
    const store = createMemoryKvStore()
    __setPagedStoreForTest(store)
    await buildModelIndex(store, {
      objects: [
        { id: 'a', type: 'app', name: 'A', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} },
        { id: 'b', type: 'app', name: 'B', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} },
      ],
      groups: [],
      connections: [{ id: 'c1', fromId: 'a', toId: 'b', type: 'solid' }],
    })
    useModelStore.setState({ objects: [], connections: [], groups: [], diagrams: [], flows: [], selectedItems: [] })
  })

  afterEach(() => {
    cleanup()
    __setPagedStoreForTest(null)
    __setModelQueryForTest(null)
  })

  it('the local index rung reports a WORKING SET, never a complete model', async () => {
    // Mutant: restore `coverage: 'full'` → this test, and ONLY this one, fails.
    // Measured, not assumed: the render test below stands the query in, so it
    // covers the last hop and is deliberately blind to which flag the real rung
    // produces. Neither half kills the mutant alone in the way that matters —
    // this one names the lie, that one proves the lie would have been visible.
    const page = await pagedModelQuery.connectionPage({ limit: 50 })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.coverage).toBe('working-set')
  })

  it('the coverage flag reaches the partial-offline warning in Model Connections', async () => {
    // The last hop, asserted in the DOM rather than inferred: ConnectionsTable
    // renders its warning iff `cursorRows.coverage === 'working-set'`, and
    // `useCursorRows` carries the flag straight off the page. Stand the query in
    // so the test states one thing — what the table does with the flag.
    const working: ModelQuery = {
      ...pagedModelQuery,
      connectionPage: async () => ({
        items: [{
          connection: { id: 'c1', fromId: 'a', toId: 'b', type: 'solid' },
          fromName: 'A', toName: 'B', fromType: 'app', toType: 'app',
          diagramCount: 0, flowCount: 0,
        }],
        nextCursor: null,
        total: 1,
        projectionGeneration: 0,
        coverage: 'working-set',
      }),
    } as ModelQuery
    __setModelQueryForTest(working)

    render(<ConnectionsTable />)
    await waitFor(() => expect(screen.getByText('diagramChrome.addShape.partialOffline')).toBeTruthy())
  })
})
