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

import { beforeEach, describe, expect, it, vi } from 'vitest'

const usage = vi.hoisted(() => ({
  openFlowInDiagram: vi.fn(),
  openEntityInDiagram: vi.fn(),
  loadObjectDiagramUsage: vi.fn(async () => null),
  loadEntityDiagramUsage: vi.fn(async () => null),
}))
vi.mock('../entityUsage', async (importOriginal) => ({ ...(await importOriginal<typeof import('../entityUsage')>()), ...usage }))

import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { openSpotlightResult } from './spotlightCommands'

// A server hit is an entity the store does not hold, so opening it can only use
// what the row carried (`SpotlightOpenHint`). QA lens, 2026-10-25: these hints
// were consumed by no test.
describe('opening a result the store does not hold (a server hit)', () => {
  beforeEach(() => {
    useModelStore.setState({ objects: [], connections: [], groups: [], diagrams: [], flows: [], decisionRecords: [] })
    useUIStore.setState({ currentView: 'diagram', modelObjectsSearchQuery: '', connectionsSearchQuery: '' })
    for (const f of Object.values(usage)) f.mockClear()
  })

  it('reveals a server object in Model objects by the name it carried', () => {
    openSpotlightResult('system', 'far', 'meta', { name: 'Payment ledger' })
    expect(useUIStore.getState()).toMatchObject({ currentView: 'model-objects', modelObjectsSearchQuery: 'Payment ledger' })
  })

  it('reveals a server connection in Model connections by the label it carried', () => {
    openSpotlightResult('connection', 'c9', 'meta', { name: 'Reads orders' })
    expect(useUIStore.getState()).toMatchObject({ currentView: 'connections', connectionsSearchQuery: 'Reads orders' })
  })

  it('opens a server flow in the diagram the hit named', () => {
    openSpotlightResult('flow', 'f9', 'none', { name: 'Refunds', diagramId: 'd9' })
    expect(usage.openFlowInDiagram).toHaveBeenCalledWith('d9', 'f9')
  })
})
