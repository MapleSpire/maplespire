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
 * Restore must carry the restored name AND type to the store: the registry
 * meta, not the DiagramDoc, decides what the canvas shows, and only the store
 * write reaches the meta (e2e/sync.spec.ts "History & revert" is the
 * end-to-end regression; it checks the name only). Under boot-from-server the
 * store write is withheld — its flush would reconcile the active doc from the
 * pre-restore store (two review lenses, 2026-10-18).
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'

const fakeHandle = { on: vi.fn(), off: vi.fn() }
let bootFromServer = false

vi.mock('../../lib/automerge/bridge', () => ({
  getActiveDiagramHandle: () => fakeHandle,
  isBootFromServerActive: () => bootFromServer,
}))
vi.mock('../../lib/automerge/history', () => ({
  listHistory: () => [],
  listCheckpoints: () => [{ id: 'cp', label: 'CP', heads: ['h'], createdAt: new Date().toISOString() }],
  addCheckpoint: vi.fn(),
  removeCheckpoint: vi.fn(),
  previewAt: () => undefined,
  restoreTo: () => ({ name: 'BASE', type: 'context' }),
}))

import { DiagramHistoryPanel } from './DiagramHistoryPanel'

function restoreTheCheckpoint(): void {
  const { getByTestId } = render(<DiagramHistoryPanel />)
  fireEvent.click(within(getByTestId('checkpoint-list')).getByTestId('checkpoint-restore-cp'))
}

describe('DiagramHistoryPanel restore', () => {
  beforeEach(() => {
    bootFromServer = false
    useModelStore.setState({
      diagrams: [{
        id: 'd1', name: 'CHANGED', type: 'container',
        objectIds: [], connectionIds: [], groupIds: [], layouts: {},
      } as never],
      currentDiagramId: 'd1',
    })
    useUIStore.setState({ historyOpen: true } as never)
  })
  afterEach(cleanup)

  it('a resident session writes the restored name and type into the store', () => {
    restoreTheCheckpoint()
    const diagram = useModelStore.getState().diagrams.find((d) => d.id === 'd1')
    expect(diagram?.name).toBe('BASE')
    expect(diagram?.type).toBe('context')
  })

  it('a boot-from-server session leaves the store alone', () => {
    bootFromServer = true
    restoreTheCheckpoint()
    const diagram = useModelStore.getState().diagrams.find((d) => d.id === 'd1')
    expect(diagram?.name).toBe('CHANGED')
    expect(diagram?.type).toBe('container')
  })
})
