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
// jsdom for localStorage. jsdom has no indexedDB, so repo.ts runs storage-less.

import { generateAutomergeUrl } from '@automerge/automerge-repo'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_NAMESPACE_KEY } from './accountNamespace'

// QA (2026-10-11): accountNamespace.test.ts pins the NAME functions, and the
// drift detector pins every IndexedDB open — but nothing pinned the three
// localStorage POINTER sites that call accountStorageKey. Dropping the suffix
// from any one of them left the whole client suite green, and a stale
// un-scoped `maplespire:workspaceRef` is exactly what pointed the new account
// at the previous account's landscape in the original defect. These arms
// drive the REAL modules on a page frozen on user-a and assert both halves:
// the pointer is written under user-a's key, and a pointer left by another
// account (or by the legacy un-namespaced build) is never read.

const USER = 'user-a'

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(ACCOUNT_NAMESPACE_KEY, USER)
  // Fresh modules: accountNamespace's frozen value and each store's module
  // state are per module instance.
  vi.resetModules()
})
afterEach(() => {
  localStorage.clear()
})

describe('per-user localStorage pointers', () => {
  it('workspace.ts: the last-open landscape is written and read under the user\'s key only', async () => {
    const ws = await import('../automerge/workspace')
    // The previous account (and the legacy build) left pointers on this browser.
    localStorage.setItem('maplespire:workspaceRef:org-1', JSON.stringify({ landscapeId: 'legacy-l', versionId: 'current' }))
    localStorage.setItem('maplespire:workspaceRef:org-1@user-b', JSON.stringify({ landscapeId: 'b-l', versionId: 'current' }))

    const persisted = ws.setWorkspaceOrgScope('org-1')
    expect(persisted.landscapeId).not.toBe('legacy-l')
    expect(persisted.landscapeId).not.toBe('b-l')

    ws.setActiveWorkspaceRef({ landscapeId: 'mine', versionId: 'current' })
    expect(JSON.parse(localStorage.getItem(`maplespire:workspaceRef:org-1@${USER}`) ?? 'null'))
      .toEqual({ landscapeId: 'mine', versionId: 'current' })
    // Never overwrites the shared pointers either.
    expect(JSON.parse(localStorage.getItem('maplespire:workspaceRef:org-1') ?? 'null').landscapeId).toBe('legacy-l')

    // And the next page for the same user reads it back.
    expect(ws.setWorkspaceOrgScope('org-1')).toEqual({ landscapeId: 'mine', versionId: 'current' })
  })

  it('workspace.ts: the org-less (AUTH stage boot) pointer is per user too', async () => {
    const ws = await import('../automerge/workspace')
    ws.setWorkspaceOrgScope(null)
    ws.setActiveWorkspaceRef({ landscapeId: 'mine', versionId: 'current' })
    expect(localStorage.getItem(`maplespire:workspaceRef@${USER}`)).not.toBeNull()
    expect(localStorage.getItem('maplespire:workspaceRef')).toBeNull()
  })

  it('repo.ts: the cached root url of another account (or the legacy build) is never a boot fallback', async () => {
    const repo = await import('../automerge/repo')
    const ref = { landscapeId: 'keysite-l', versionId: 'v1' }
    const { workspaceRefKey, DEFAULT_WORKSPACE_REF } = await import('../automerge/workspace')
    const theirs = generateAutomergeUrl()
    localStorage.setItem(`maplespire:rootUrl:${workspaceRefKey(ref)}`, theirs)
    localStorage.setItem('maplespire:rootUrl', theirs)
    expect(repo.cachedRootUrlFor(ref)).toBeNull()
    expect(repo.cachedRootUrlFor(DEFAULT_WORKSPACE_REF)).toBeNull()

    const mine = generateAutomergeUrl()
    localStorage.setItem(`maplespire:rootUrl:${workspaceRefKey(ref)}@${USER}`, mine)
    localStorage.setItem(`maplespire:rootUrl@${USER}`, mine)
    expect(repo.cachedRootUrlFor(ref)).toBe(mine)
    expect(repo.cachedRootUrlFor(DEFAULT_WORKSPACE_REF)).toBe(mine)
  })

  it('uiStore.ts: the per-diagram 2D/3D memory is written and read under the user\'s key only', async () => {
    const { useUIStore } = await import('../../stores/uiStore')
    localStorage.setItem('maplespire:view3d:d-shared', '3d:tilt')
    useUIStore.getState().restoreCanvasViewFor('d-shared')
    expect(useUIStore.getState().canvasViewMode).toBe('2d')

    useUIStore.getState().setCanvasViewMode('3d', 'd-mine')
    expect(localStorage.getItem(`maplespire:view3d:d-mine@${USER}`)).toMatch(/^3d:/)
    expect(localStorage.getItem('maplespire:view3d:d-mine')).toBeNull()
  })
})

describe('the read-cache Worker opens the PAGE\'s account (page → Worker hand-off)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('workerClient.ts names the Worker so that the Worker resolves the same account', async () => {
    const created: Array<{ name?: string }> = []
    class FakeWorker {
      onmessage: unknown = null
      onerror: unknown = null
      constructor(_url: URL, options: { name?: string } = {}) { created.push(options) }
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker)
    const { ModelReadCacheWorkerClient } = await import('../modelQuery/workerClient')
    new ModelReadCacheWorkerClient()
    expect(created).toHaveLength(1)
    const workerName = created[0].name

    // Now be the Worker: no localStorage, only `self.name`.
    vi.resetModules()
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('name', workerName)
    const inWorker = await import('./accountNamespace')
    expect(inWorker.accountDatabaseName('maplespire-model-read-cache')).toBe(`maplespire-model-read-cache@${USER}`)
  })
})

describe('main.tsx installs the cross-tab listener (static wire check)', () => {
  it('calls installAccountNamespaceListener() at module scope, outside comments', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(__dirname, '..', '..', 'main.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(source).toMatch(/^(?:const\s+\w+\s*=\s*)?installAccountNamespaceListener\(\)/m)
  })
})
