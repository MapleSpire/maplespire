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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setWorkspaceNavigator } from '../appNavigate'
import { useModelStore } from '../../stores/modelStore'
import { currentWorkspaceRef, DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef } from './workspace'
import { recoverWorkspaceProjection, resetWorkspaceProjection } from './workspaceProjection'

describe('workspace projection reset', () => {
  afterEach(() => {
    setWorkspaceNavigator(() => undefined)
    resetWorkspaceProjection()
    setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
  })

  it('parks only the requested diagram while clearing the previous workspace', () => {
    useModelStore.setState({
      objects: [{ id: 'old-object', type: 'system', name: 'Old', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } as never],
      diagrams: [{
        id: 'old-diagram', name: 'Old diagram', type: 'context',
        objectIds: ['old-object'], connectionIds: [], groupIds: [],
      }],
      currentDiagramId: 'old-diagram',
      selectedItems: [{ id: 'old-object', type: 'object' }],
    })

    resetWorkspaceProjection('deep-link-diagram')

    expect(useModelStore.getState()).toMatchObject({
      objects: [],
      diagrams: [],
      currentDiagramId: 'deep-link-diagram',
      selectedItems: [],
    })
  })

  it('moves the durable active ref and clears a dangling Draft projection together', () => {
    setActiveWorkspaceRef({ landscapeId: 'enterprise', versionId: 'deleted-draft' })
    useModelStore.setState({
      diagrams: [{
        id: 'draft-diagram', name: 'Draft diagram', type: 'context',
        objectIds: [], connectionIds: [], groupIds: [],
      }],
      currentDiagramId: 'draft-diagram',
    })

    const fallback = { landscapeId: 'starter', versionId: 'current' }
    const navigate = vi.fn()
    setWorkspaceNavigator(navigate)
    recoverWorkspaceProjection(fallback)

    expect(currentWorkspaceRef()).toEqual(fallback)
    expect(useModelStore.getState().diagrams).toEqual([])
    expect(useModelStore.getState().currentDiagramId).toBeNull()
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith(fallback)
  })
})
