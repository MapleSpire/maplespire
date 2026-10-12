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

import { describe, it, expect, afterEach } from 'vitest'
import {
  DEFAULT_LANDSCAPE_ID,
  CURRENT_VERSION_ID,
  DEFAULT_WORKSPACE_REF,
  workspaceRefKey,
  workspaceRefEquals,
  isDefaultWorkspaceRef,
  currentWorkspaceRef,
  setActiveWorkspaceRef,
  subscribeWorkspaceRef,
  type WorkspaceRef,
} from './workspace'

describe('WorkspaceRef seam', () => {
  it('DEFAULT_WORKSPACE_REF is the default landscape at the current version', () => {
    expect(DEFAULT_WORKSPACE_REF).toEqual({
      landscapeId: DEFAULT_LANDSCAPE_ID,
      versionId: CURRENT_VERSION_ID,
    })
  })

  it('currentWorkspaceRef() returns the default ref today (single injection point)', () => {
    expect(currentWorkspaceRef()).toEqual(DEFAULT_WORKSPACE_REF)
    expect(isDefaultWorkspaceRef(currentWorkspaceRef())).toBe(true)
  })

  it('workspaceRefKey is stable and value-based (same ids → same key)', () => {
    const a: WorkspaceRef = { landscapeId: 'l1', versionId: 'v1' }
    const b: WorkspaceRef = { landscapeId: 'l1', versionId: 'v1' }
    expect(workspaceRefKey(a)).toBe(workspaceRefKey(b))
    expect(workspaceRefKey(DEFAULT_WORKSPACE_REF)).toBe('default/current')
  })

  it('workspaceRefKey is collision-free across distinct landscape/version pairs', () => {
    const keys = [
      workspaceRefKey({ landscapeId: 'l1', versionId: 'v1' }),
      workspaceRefKey({ landscapeId: 'l1', versionId: 'v2' }),
      workspaceRefKey({ landscapeId: 'l2', versionId: 'v1' }),
      workspaceRefKey({ landscapeId: 'l2', versionId: 'v2' }),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('workspaceRefEquals compares by value', () => {
    expect(
      workspaceRefEquals({ landscapeId: 'l', versionId: 'v' }, { landscapeId: 'l', versionId: 'v' })
    ).toBe(true)
    expect(
      workspaceRefEquals({ landscapeId: 'l', versionId: 'v' }, { landscapeId: 'l', versionId: 'w' })
    ).toBe(false)
  })

  it('isDefaultWorkspaceRef only matches the single implicit workspace', () => {
    expect(isDefaultWorkspaceRef(DEFAULT_WORKSPACE_REF)).toBe(true)
    expect(isDefaultWorkspaceRef({ landscapeId: 'other', versionId: 'current' })).toBe(false)
    expect(isDefaultWorkspaceRef({ landscapeId: 'default', versionId: 'v2' })).toBe(false)
  })
})

describe('active workspace ref (Phase 0c)', () => {
  // Reset the module-level active ref so other suites see the default.
  afterEach(() => setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF))

  it('defaults to DEFAULT_WORKSPACE_REF', () => {
    expect(currentWorkspaceRef()).toEqual(DEFAULT_WORKSPACE_REF)
  })

  it('reflects setActiveWorkspaceRef', () => {
    const ref: WorkspaceRef = { landscapeId: 'ls-1', versionId: 'v-9' }
    setActiveWorkspaceRef(ref)
    expect(currentWorkspaceRef()).toEqual(ref)
    expect(isDefaultWorkspaceRef(currentWorkspaceRef())).toBe(false)
  })

  it('notifies active-ref subscribers only when the value changes', () => {
    const seen: WorkspaceRef[] = []
    const unsubscribe = subscribeWorkspaceRef((ref) => seen.push(ref))
    const ref = { landscapeId: 'ls-events', versionId: 'v1' }
    setActiveWorkspaceRef(ref)
    setActiveWorkspaceRef({ ...ref })
    unsubscribe()
    setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
    expect(seen).toEqual([ref])
  })
})
