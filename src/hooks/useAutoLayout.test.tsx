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
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Diagram } from '../types'
import { useModelStore } from '../stores/modelStore'
import { useUIStore } from '../stores/uiStore'
import { optimizeDiagram } from '../lib/layout'
import { useAutoLayout } from './useAutoLayout'

vi.mock('../lib/layout', () => ({ optimizeDiagram: vi.fn() }))

const diagram = (id: string): Diagram => ({
  id,
  name: id,
  type: 'context',
  objectIds: ['object-1'],
  connectionIds: [],
  groupIds: [],
  layouts: {},
})

describe('useAutoLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useModelStore.setState({
      objects: [],
      connections: [],
      groups: [],
      diagrams: [diagram('A'), diagram('B')],
      currentDiagramId: 'A',
    })
    useUIStore.setState({ canvasViewMode: '2d' })
  })

  it('does not apply a delayed result to a diagram after the user navigated away', async () => {
    let resolveLayout!: (value: {
      layouts: Record<string, never>
      connPatches: Record<string, never>
    }) => void
    vi.mocked(optimizeDiagram).mockReturnValue(new Promise((resolve) => {
      resolveLayout = resolve
    }) as ReturnType<typeof optimizeDiagram>)
    const applyDiagramLayout = vi.fn()
    useModelStore.setState({ applyDiagramLayout })
    const { result } = renderHook(() => useAutoLayout())

    let run!: Promise<void>
    act(() => { run = result.current.autoLayout() })
    await waitFor(() => expect(optimizeDiagram).toHaveBeenCalledOnce())
    act(() => useModelStore.setState({ currentDiagramId: 'B' }))
    resolveLayout({ layouts: {}, connPatches: {} })
    await act(async () => { await run })

    expect(applyDiagramLayout).not.toHaveBeenCalled()
  })
})
