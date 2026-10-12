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
 * Regression cover for "Import → New landscape imported NOTHING".
 *
 * Two independent defects produced one empty landscape, and each is pinned here:
 *
 *  1. Every store-led workspace switch released its `busy` guard BEFORE the address bar
 *     moved. WorkspaceRoute's URL→store effect stands down only while `busy` is true, so
 *     it woke in that window, compared the already-new `currentWorkspaceRef()` against
 *     the still-old URL params, and switched the workspace BACK to the previous
 *     landscape — then forward again once the router committed. Two extra bridge
 *     stop/starts, two extra `resetWorkspaceProjection()` wipes of the model store.
 *
 *  2. The import waited on the GLOBAL `useAutomergeStatus.ready` latch. The bounce
 *     above flipped it true on the previous workspace's behalf, and it never flips for
 *     a brand-new landscape at all (fresh documents keep the status at 'saving').
 *
 * Both are exercised end to end in the last test with a stand-in for WorkspaceRoute
 * that reproduces the real guard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWorkspaceStore } from './workspaceStore'
import { useModelStore } from './modelStore'
import { useAutomergeStatus } from './automergeStatusStore'
import { setWorkspaceNavigator } from '../lib/appNavigate'
import { awaitWorkspaceProjection } from '../lib/automerge/awaitWorkspaceProjection'
import { resetWorkspaceProjection } from '../lib/automerge/workspaceProjection'
import {
  currentWorkspaceRef,
  setActiveWorkspaceRef,
  workspaceRefKey,
  type WorkspaceRef,
} from '../lib/automerge/workspace'

vi.mock('../lib/automerge/switchWorkspace', () => ({
  switchWorkspace: vi.fn(async () => undefined),
  reloadWorkspace: vi.fn(async () => undefined),
}))
vi.mock('../lib/landscapes/api', () => ({
  listLandscapes: vi.fn(async () => []),
  createLandscape: vi.fn(async (name: string) => ({
    id: `ls-${name}`,
    name,
    defaultVersionId: null,
    createdAt: '',
    versions: [],
  })),
  createVersion: vi.fn(),
  setDefaultVersion: vi.fn(),
  renameLandscape: vi.fn(),
  renameVersion: vi.fn(),
  deleteLandscape: vi.fn(),
  deleteVersion: vi.fn(),
}))

const { switchWorkspace } = await import('../lib/automerge/switchWorkspace')

const OLD: WorkspaceRef = { landscapeId: 'old-landscape', versionId: 'current' }

/**
 * What the bridge does to the status store for one workspace boot.
 * `durable` mirrors the real bridge behaviour: an established workspace settles on
 * 'ready' (nothing pending), a freshly created one settles on 'saving' because its own
 * new documents are not PostgreSQL-durable yet.
 */
function bootWorkspace(ref: WorkspaceRef, durable: boolean): void {
  const status = useAutomergeStatus.getState()
  status.beginWorkspaceSwitch()
  resetWorkspaceProjection()
  setActiveWorkspaceRef(ref)
  status.setStatus(durable ? 'ready' : 'saving')
  status.markWorkspaceProjected(workspaceRefKey(ref))
}

beforeEach(() => {
  vi.mocked(switchWorkspace).mockImplementation(async (ref: WorkspaceRef) => {
    bootWorkspace(ref, false)
  })
  setWorkspaceNavigator(() => undefined)
  setActiveWorkspaceRef(OLD)
  useAutomergeStatus.setState({
    status: 'ready',
    ready: true,
    visualReady: true,
    editReady: true,
    projectedWorkspace: workspaceRefKey(OLD),
    error: null,
  })
  useWorkspaceStore.setState({ ref: OLD, busy: false, error: null, landscapes: [] })
  useModelStore.setState({ objects: [], connections: [], groups: [], diagrams: [], domains: [] })
})

describe('store-led workspace switches hold `busy` until the address bar moves', () => {
  it('newLandscape navigates while still busy, and only then releases the guard', async () => {
    const busyAtNavigate: boolean[] = []
    setWorkspaceNavigator(async () => {
      busyAtNavigate.push(useWorkspaceStore.getState().busy)
      await Promise.resolve()
      busyAtNavigate.push(useWorkspaceStore.getState().busy)
    })

    const ref = await useWorkspaceStore.getState().newLandscape('Imported')

    expect(ref).toEqual({ landscapeId: 'ls-Imported', versionId: 'current' })
    // WorkspaceRoute must find the store busy for the WHOLE navigation, not just its
    // synchronous prefix — that window is where the bounce happened.
    expect(busyAtNavigate).toEqual([true, true])
    expect(useWorkspaceStore.getState().busy).toBe(false)
  })

  it('switchTo navigates while still busy', async () => {
    const busyAtNavigate: boolean[] = []
    setWorkspaceNavigator(async () => {
      busyAtNavigate.push(useWorkspaceStore.getState().busy)
    })

    await useWorkspaceStore.getState().switchTo('other-landscape', 'current')

    expect(busyAtNavigate).toEqual([true])
    expect(useWorkspaceStore.getState().ref.landscapeId).toBe('other-landscape')
  })

  it('reports the created ref instead of leaving callers to read a moving store field', async () => {
    const ref = await useWorkspaceStore.getState().newLandscape('Reported')
    expect(ref).toEqual({ landscapeId: 'ls-Reported', versionId: 'current' })
    expect(await useWorkspaceStore.getState().newLandscape('   ')).toBeNull()
  })
})

describe('import into a NEW landscape lands in that landscape', () => {
  /**
   * Stand-in for WorkspaceRoute's URL→store effect (router.tsx). The real guard is
   * `if (!bridgeBooted || busy || access !== 'granted') return`, so this only acts when
   * the store is not busy — and when it does act it uses the params of the URL that is
   * still on screen, i.e. the workspace we just left.
   */
  function installRouteSyncBounce(): { bounced: WorkspaceRef[] } {
    const bounced: WorkspaceRef[] = []
    setWorkspaceNavigator((target) => {
      if (useWorkspaceStore.getState().busy) return
      // A React effect runs in a LATER task than the store write that woke it, which is
      // why the bounce landed after the caller had already moved on.
      setTimeout(() => {
        bounced.push(OLD)
        bootWorkspace(OLD, true) // "correction" back to the stale URL — old docs are durable
        bootWorkspace(target, false) // and forward again once the router commits
      }, 0)
    })
    return { bounced }
  }

  /** Let anything the switch left scheduled actually run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('keeps the imported content when a stale route effect could bounce the workspace', async () => {
    const bounce = installRouteSyncBounce()

    const ref = await useWorkspaceStore.getState().newLandscape('Big Bank plc')
    expect(ref).not.toBeNull()
    await awaitWorkspaceProjection(ref!, { timeoutMs: 500, pollMs: 1 })

    useModelStore.getState().importModel({
      objects: [
        {
          id: 'o1',
          type: 'system',
          name: 'Internet Banking System',
          position: { x: 0, y: 0 },
          size: { width: 160, height: 90 },
          tagAssignments: {},
          tagOrder: [],
          links: [],
          scope: 'internal',
          status: 'live',
          properties: {},
        },
      ],
      connections: [],
      groups: [],
      diagrams: [
        { id: 'd1', name: 'SystemContext', type: 'context', objectIds: ['o1'], connectionIds: [], groupIds: [] },
      ],
    })

    await settle()

    // The import is still there rather than wiped by a re-projection — the whole point.
    expect(useModelStore.getState().objects).toHaveLength(1)
    expect(useModelStore.getState().diagrams.map((d) => d.name)).toContain('SystemContext')
    // …in the landscape it was created for…
    expect(currentWorkspaceRef()).toEqual(ref)
    expect(useAutomergeStatus.getState().projectedWorkspace).toBe(workspaceRefKey(ref!))
    // …because the guard held and no bounce ever ran.
    expect(bounce.bounced).toEqual([])
  })

  it('does not open the gate on the previous workspace being ready mid-switch', async () => {
    // Pin the readiness semantics independently of the ordering fix: even if a bounce
    // DOES run and leaves the old workspace fully ready, a wait for the new ref must
    // not be satisfied by it.
    bootWorkspace(OLD, true)
    expect(useAutomergeStatus.getState().ready).toBe(true)

    const target: WorkspaceRef = { landscapeId: 'ls-Target', versionId: 'current' }
    await expect(
      awaitWorkspaceProjection(target, { timeoutMs: 20, pollMs: 1 }),
    ).rejects.toMatchObject({ reason: 'timeout' })
  })
})
