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
 * T-DIAGDEF-2 (B) — a boot whose root request got NO answer, for a workspace
 * this browser has no copy of, ends in an error that says so — and asks the
 * server nothing more.
 *
 * Before: the transport failure reached `startBridge`'s catch as a bare
 * `TypeError` (or the timeout's `DOMException`), which is not "retryable", so
 * the AUTH-on rebound for DANGLING references ran: `resolveBootWorkspaceRef`,
 * i.e. `listLandscapes()` and maybe `checkWorkspaceReadAccess()` against the
 * same unreachable server, with no bound of their own. Behind a server that
 * accepts and never answers, that held the switch for good; when it refuses,
 * the screen said "the workspace was still syncing".
 *
 * The REAL repo chain (`getRootHandle` → `fetchRootUrl`, only the HTTP fetch
 * and the network route seam-injected — `repo.rootUrlCache.test.ts`'s
 * pattern) under the REAL bridge.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setRootUrlFetchForTest, __setWorkspaceNetworkRouteForTest, forgetWorkspaceHandles } from './repo'
import * as repoModule from './repo'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useAuthStore } from '../../stores/authStore'
import type { WorkspaceRef } from './workspace'

const kv = new Map<string, unknown>()
vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async (key: string) => kv.get(key),
    set: async (key: string, value: unknown) => { kv.set(key, value) },
    del: async (key: string) => { kv.delete(key) },
    update: async (key: string, fn: (value: unknown) => unknown) => { kv.set(key, fn(kv.get(key))) },
  }),
}))

const rebound = vi.hoisted(() => ({
  // The dangling-ref rebound's resolution, against a server that never answers.
  resolveBootWorkspaceRef: vi.fn(() => new Promise<never>(() => {})),
}))
vi.mock('./bootRef', () => ({ resolveBootWorkspaceRef: rebound.resolveBootWorkspaceRef }))

const NEVER_OPENED: WorkspaceRef = { landscapeId: 'never-opened-here', versionId: 'current' }

/** `startBridge`, or 'still running' after `ms`. */
async function bootWithin(ms: number): Promise<'ended' | 'still running'> {
  const { startBridge } = await import('./bridge')
  return Promise.race([
    startBridge(NEVER_OPENED).then(() => 'ended' as const),
    new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), ms)),
  ])
}

describe('T-DIAGDEF-2 (B) — the root unreachable, no local copy', () => {
  beforeEach(async () => {
    kv.clear()
    localStorage.clear()
    vi.clearAllMocks()
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    forgetWorkspaceHandles(NEVER_OPENED)
    useAuthStore.setState({
      config: { stage: 'on' } as never,
      user: { id: 'u1', email: 'paul@example.test' } as never,
      orgId: 'org-1',
    } as never)
    useAutomergeStatus.setState({ status: 'connecting', error: null, errorCause: null, visualReady: false })
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    __setRootUrlFetchForTest(null)
    __setWorkspaceNetworkRouteForTest(null)
    vi.restoreAllMocks()
  })

  for (const [shape, failure] of [
    ['refused', () => new TypeError('Failed to fetch')],
    ['unanswered (the boot read timed out)', () => new DOMException('The operation timed out.', 'TimeoutError')],
  ] as const) {
    it(`${shape}: an error naming the server, and no rebound`, async () => {
      __setRootUrlFetchForTest(async () => { throw failure() })
      expect(await bootWithin(3_000), 'the boot is still asking the server').toBe('ended')
      expect(useAutomergeStatus.getState().status).toBe('error')
      expect(useAutomergeStatus.getState().errorCause).toBe('server-unreachable')
      expect(rebound.resolveBootWorkspaceRef).not.toHaveBeenCalled()
    }, 10_000)
  }

  it('control: a refusal FROM the server (an HTTP answer) is not an unreachable server', async () => {
    __setRootUrlFetchForTest(async () => new Response('{"error":"gone"}', { status: 410, headers: { 'content-type': 'application/json' } }))
    rebound.resolveBootWorkspaceRef.mockImplementationOnce(async () => NEVER_OPENED as never)
    expect(await bootWithin(3_000)).toBe('ended')
    expect(useAutomergeStatus.getState().status).toBe('error')
    expect(useAutomergeStatus.getState().errorCause ?? null).toBeNull()
    // The dangling-ref rebound still runs for an authoritative answer.
    expect(rebound.resolveBootWorkspaceRef).toHaveBeenCalledTimes(1)
  }, 10_000)
})
