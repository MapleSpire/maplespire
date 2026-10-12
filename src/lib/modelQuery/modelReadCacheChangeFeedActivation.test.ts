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
 * Change-feed activation follows the summary contract at runtime.
 *
 * `main.tsx` calls `installModelReadCacheChangeFeed()` at module evaluation, so
 * it runs BEFORE any workspace root has been read. A tier guard at install time
 * would give a client with none of the Vite flags a no-op disposer for the
 * entire page life — and that is exactly the client the summary contract exists
 * for: it enters the server tier later, from its root, and its "Available
 * offline" copy must still be kept fresh.
 *
 * Deliberately its OWN file: `modelReadCacheChangeFeed.test.ts` mocks
 * `./tierFlag` to a constant `true`, which is the right call for testing the
 * feed's mechanics and makes activation untestable there. Here the real
 * predicate runs, driven through `summaryTier` the way the bridge drives it.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef } from '../automerge/workspace'
import { setWorkspaceSummaryActive } from './summaryTier'
import { isServerReadModelEnabled } from './tierFlag'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  storageStatus: vi.fn(),
  upsertObjects: vi.fn(),
  upsertConnections: vi.fn(),
  deleteEntities: vi.fn(),
  commitServerGeneration: vi.fn(),
  downloadWorkspaceForOffline: vi.fn(),
  subscribeCurrentWorkspaceInvalidations: vi.fn(),
}))

vi.mock('../api/http', () => ({ apiFetch: mocks.apiFetch, workspaceApiFetch: mocks.apiFetch }))
vi.mock('./modelReadCacheBootstrap', () => ({
  downloadWorkspaceForOffline: mocks.downloadWorkspaceForOffline,
}))
vi.mock('./workspaceInvalidation', () => ({
  subscribeCurrentWorkspaceInvalidations: mocks.subscribeCurrentWorkspaceInvalidations,
}))
vi.mock('./workerClient', () => ({
  getModelReadCacheWorker: () => ({
    storageStatus: mocks.storageStatus,
    upsertObjects: mocks.upsertObjects,
    upsertConnections: mocks.upsertConnections,
    deleteEntities: mocks.deleteEntities,
    commitServerGeneration: mocks.commitServerGeneration,
  }),
}))

import {
  __resetModelReadCacheChangeFeedForTests,
  installModelReadCacheChangeFeed,
} from './modelReadCacheChangeFeed'

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

/** A pinned, COMPLETE offline copy — the only shape the durable feed serves. */
const fullMeta = {
  workspaceKey: 'summary-ws/current',
  activeGeneration: 5,
  serverGeneration: 10,
  coverage: 'full',
  pinned: true,
  lastAccessAt: 0,
  objectCount: 100,
  connectionCount: 200,
  accountedBytes: {},
  generationStats: {},
}

const changeFeedCalls = () => mocks.apiFetch.mock.calls
  .filter(([url]) => String(url).includes('/api/model/cache/changes'))

describe('the read-cache change feed and the summary contract', () => {
  let dispose: (() => void) | null = null

  beforeEach(() => {
    __resetModelReadCacheChangeFeedForTests()
    setActiveWorkspaceRef({ landscapeId: 'summary-ws', versionId: 'current' })
    localStorage.clear()
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.storageStatus.mockResolvedValue([fullMeta])
    mocks.subscribeCurrentWorkspaceInvalidations.mockReturnValue(() => undefined)
    mocks.apiFetch.mockImplementation(async () => json({
      projectionGeneration: 10,
      events: [],
      nextGeneration: 10,
      hasMore: false,
      resetRequired: false,
    }))
    vi.useFakeTimers()
  })

  afterEach(() => {
    dispose?.()
    dispose = null
    vi.useRealTimers()
    setWorkspaceSummaryActive(false)
    setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
    localStorage.clear()
  })

  it('the read-cache change feed starts when the summary contract activates after page load', async () => {
    // Anti-void: this must be the flagless client, or the "before" half below
    // would pass for the wrong reason.
    expect(isServerReadModelEnabled()).toBe(false)

    dispose = installModelReadCacheChangeFeed()

    // BEFORE — installed at page load, tier off, so nothing runs. (It is the
    // no-op DISPOSER that the mutant returns here; both look identical from
    // outside, which is why the "after" half is the discriminating one.)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.storageStatus).not.toHaveBeenCalled()
    expect(changeFeedCalls()).toHaveLength(0)

    // The bridge boots a workspace whose ROOT declares registrySummaryOnly and
    // publishes the contract — long after this module was evaluated.
    setWorkspaceSummaryActive(true)
    expect(isServerReadModelEnabled()).toBe(true)

    // AFTER — the very next tick of the already-installed timers picks it up.
    // Mutant: restore the install-time `|| !isServerReadModelEnabled()` guard →
    // `installModelReadCacheChangeFeed` returned before arming any timer, so no
    // amount of advancing produces a call and this fails.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(changeFeedCalls().length).toBeGreaterThan(0)
    expect(mocks.subscribeCurrentWorkspaceInvalidations).toHaveBeenCalled()
  })

  it('leaving the contract stops the feed again, without a re-install', async () => {
    // The symmetric half: the guard is dynamic in BOTH directions, so a
    // workspace switch back to a classic workspace (stopBridge →
    // setWorkspaceSummaryActive(false)) stops polling a server tier that is no
    // longer in play — no leaked 30 s request loop per page.
    dispose = installModelReadCacheChangeFeed()
    setWorkspaceSummaryActive(true)
    await vi.advanceTimersByTimeAsync(2_000)
    const whileActive = changeFeedCalls().length
    expect(whileActive).toBeGreaterThan(0)

    setWorkspaceSummaryActive(false)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(changeFeedCalls()).toHaveLength(whileActive)
  })
})
