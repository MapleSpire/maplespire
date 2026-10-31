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
import { workspaceSearchParams, workspaceSearchParamsFor, withWorkspaceParams } from './workspaceParams'
import { setActiveWorkspaceRef, DEFAULT_WORKSPACE_REF } from '../automerge/workspace'
import {
  __resetResolvedWorkspacesForTest,
  adoptBindingAsBasis,
  holdWorkspaceOn,
  installSessionRootUrlSource,
  rememberResolvedWorkspace,
} from '../automerge/workspaceBinding'

afterEach(() => {
  holdWorkspaceOn(null)
  installSessionRootUrlSource(() => null)
  __resetResolvedWorkspacesForTest()
  setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
})

const ALIAS = { landscapeId: 'ls-1', versionId: 'current' }
const V1_ROOT = 'automerge:v1-root'

describe('workspaceSearchParams — the workspace the session\'s documents belong to', () => {
  // The defect, measured 2026-10-28: a `current` tab booted from V1's cached
  // root, the default repointed to V2, and every read asked `current` — the
  // canvas drew V2's objects over V1's documents.
  it('a `current` session holding V1\'s root asks about V1, not the alias', () => {
    setActiveWorkspaceRef(ALIAS)
    installSessionRootUrlSource(() => V1_ROOT)
    expect(workspaceSearchParams().get('versionId')).toBe('current') // liveness: no basis yet
    rememberResolvedWorkspace(ALIAS, { landscapeId: 'ls-1', versionId: 'v1' }, { from: 'root-fetch', rootUrl: V1_ROOT })
    const p = workspaceSearchParams()
    expect(p.get('landscapeId')).toBe('ls-1')
    expect(p.get('versionId')).toBe('v1')
  })

  it('a basis restored from the root cache counts, for the root it was stored with', () => {
    setActiveWorkspaceRef(ALIAS)
    installSessionRootUrlSource(() => V1_ROOT)
    rememberResolvedWorkspace(ALIAS, { landscapeId: 'ls-1', versionId: 'v1' }, { from: 'root-cache', rootUrl: V1_ROOT })
    expect(workspaceSearchParams().get('versionId')).toBe('v1')
  })

  it('a basis beside ANOTHER root names nothing: the alias is asked, as before', () => {
    setActiveWorkspaceRef(ALIAS)
    installSessionRootUrlSource(() => V1_ROOT)
    rememberResolvedWorkspace(ALIAS, { landscapeId: 'ls-1', versionId: 'v2' }, { from: 'root-fetch', rootUrl: 'automerge:v2-root' })
    expect(workspaceSearchParams().get('versionId')).toBe('current')
  })

  it('a basis self-armed from a socket binding names nothing either', () => {
    setActiveWorkspaceRef(ALIAS)
    installSessionRootUrlSource(() => V1_ROOT)
    adoptBindingAsBasis(ALIAS, { landscapeId: 'ls-1', versionId: 'v2' })
    expect(workspaceSearchParams().get('versionId')).toBe('current')
  })

  it('with no session root the alias is asked — boot has not got that far', () => {
    setActiveWorkspaceRef(ALIAS)
    rememberResolvedWorkspace(ALIAS, { landscapeId: 'ls-1', versionId: 'v1' }, { from: 'root-fetch', rootUrl: V1_ROOT })
    expect(workspaceSearchParams().get('versionId')).toBe('current')
  })

  it('a hold still reaches the reads when the basis was self-armed', () => {
    setActiveWorkspaceRef(ALIAS)
    installSessionRootUrlSource(() => V1_ROOT)
    adoptBindingAsBasis(ALIAS, { landscapeId: 'ls-1', versionId: 'v2' })
    holdWorkspaceOn({ landscapeId: 'ls-1', versionId: 'v-held' })
    expect(workspaceSearchParams().get('versionId')).toBe('v-held')
  })
})

describe('workspaceSearchParams — through the HOLD', () => {
  it('a held `current` tab asks about the HELD version, not the alias', () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-1', versionId: 'current' })
    expect(workspaceSearchParams().get('versionId')).toBe('current') // liveness: no hold yet
    holdWorkspaceOn({ landscapeId: 'ls-1', versionId: 'v-held' })
    const p = workspaceSearchParams()
    expect(p.get('landscapeId')).toBe('ls-1')
    expect(p.get('versionId')).toBe('v-held')
  })

  it('workspaceSearchParamsFor names exactly the workspace given, hold or not', () => {
    holdWorkspaceOn({ landscapeId: 'ls-1', versionId: 'v-held' })
    const p = workspaceSearchParamsFor({ landscapeId: 'ls-1', versionId: 'v-asked' })
    expect(p.get('landscapeId')).toBe('ls-1')
    expect(p.get('versionId')).toBe('v-asked')
    // The only input the hold could rewrite is the alias of the held landscape;
    // a concrete ref alone cannot tell "given" from "given, then held".
    expect(workspaceSearchParamsFor({ landscapeId: 'ls-1', versionId: 'current' }).get('versionId')).toBe('current')
  })
})

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
