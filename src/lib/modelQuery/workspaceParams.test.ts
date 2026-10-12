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
import { workspaceSearchParams, withWorkspaceParams } from './workspaceParams'
import { setActiveWorkspaceRef, DEFAULT_WORKSPACE_REF } from '../automerge/workspace'

afterEach(() => setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF))

describe('workspaceSearchParams', () => {
  it('emits the default workspace by default', () => {
    const p = workspaceSearchParams()
    expect(p.get('landscapeId')).toBe('default')
    expect(p.get('versionId')).toBe('current')
  })

  it('emits the active workspace after a switch', () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-1', versionId: 'v-2' })
    const p = workspaceSearchParams()
    expect(p.get('landscapeId')).toBe('ls-1')
    expect(p.get('versionId')).toBe('v-2')
  })
})

describe('withWorkspaceParams', () => {
  it('appends workspace params onto an existing query string', () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-1', versionId: 'v-2' })
    const q = withWorkspaceParams('focus=A')
    const params = new URLSearchParams(q)
    expect(params.get('focus')).toBe('A')
    expect(params.get('landscapeId')).toBe('ls-1')
    expect(params.get('versionId')).toBe('v-2')
  })

  it('produces a valid query string when the base is empty', () => {
    const q = withWorkspaceParams('')
    const params = new URLSearchParams(q)
    expect(params.get('landscapeId')).toBe('default')
    expect(params.get('versionId')).toBe('current')
  })
})
