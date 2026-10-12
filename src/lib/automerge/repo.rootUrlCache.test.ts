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
 * The root-url offline cache's "materialized only" contract, pinned
 * against the REAL repo.ts (the module Repo, the real getRootHandle /
 * fetchRootUrl / rememberMaterializedRootUrl chain; only the HTTP fetch and
 * the network-route step are seam-injected).
 *
 * The regression this kills: re-adding the cache write AT FETCH TIME. After a
 * set-default repoint the url fetch succeeds instantly with the NEW root while
 * its graph may never arrive (server still warming up); writing the cache at
 * that point destroys the only locally-bootable root the workspace key has
 * — and the boot fallback then has nothing DIFFERENT to fall back to.
 *
 * The route seam matters for fidelity, not just isolation: with a network
 * adapter attached and no peer connected, `repo.find()` never settles
 * on its own, so these tests keep the adapter detached and get the fast
 * "is unavailable" rejection instead of a wall-clock hang.
 */

// @vitest-environment jsdom
// jsdom for localStorage — the cache under test lives there. jsdom has no
// indexedDB, so the module Repo runs storage-less: a find for an unknown
// document rejects in milliseconds instead of hanging.

import { generateAutomergeUrl } from '@automerge/automerge-repo'
import { afterEach, describe, expect, it } from 'vitest'
import {
  repo,
  getRootHandle,
  cachedRootUrlFor,
  lastAttemptedRootUrlFor,
  preferCachedRootForNextResolve,
  abandonPreferredCachedRoot,
  forgetWorkspaceHandles,
  __setRootUrlFetchForTest,
  __setWorkspaceNetworkRouteForTest,
} from './repo'
import { DocumentTemporarilyUnavailableError } from './documentResolution'
import { workspaceRefKey, type WorkspaceRef } from './workspace'
import type { RootDoc } from './types'

/** Per-ref localStorage key, mirroring repo.ts's non-default shape. */
function cacheKeyOf(ref: WorkspaceRef): string {
  return `maplespire:rootUrl:${workspaceRefKey(ref)}`
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  __setRootUrlFetchForTest(null)
  __setWorkspaceNetworkRouteForTest(null)
})

function useRef(landscapeId: string): WorkspaceRef {
  const ref: WorkspaceRef = { landscapeId, versionId: 'v1' }
  cleanups.push(() => {
    forgetWorkspaceHandles(ref)
    localStorage.removeItem(cacheKeyOf(ref))
  })
  return ref
}

describe('root url offline cache (materialized-only contract)', () => {
  it('a 200 for a NEVER-materialized root leaves the cached url untouched (U7)', async () => {
    const ref = useRef('u7-poison')
    const oldUrl = generateAutomergeUrl()
    const newUrl = generateAutomergeUrl()
    localStorage.setItem(cacheKeyOf(ref), oldUrl)
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    let fetches = 0
    __setRootUrlFetchForTest(async () => {
      fetches += 1
      return jsonOk({ url: newUrl })
    })

    // The fetch answers 200 instantly (the repoint scenario), but the document
    // itself never resolves: the bounded boot resolution surfaces a retryable
    // failure.
    await expect(getRootHandle(ref)).rejects.toBeInstanceOf(DocumentTemporarilyUnavailableError)

    expect(fetches).toBe(1)
    // THE contract: the cache still names the OLD (last materialized) root —
    // the poison mutant rewrites it to newUrl at fetch time and dies here.
    expect(cachedRootUrlFor(ref)).toBe(oldUrl)
    // While the fallback comparator saw the attempt, so it can tell "cached
    // differs from attempted" and re-enter from the old root.
    expect(lastAttemptedRootUrlFor(ref)).toBe(newUrl)
  }, 15_000)

  it('materialization — and only materialization — records the url', async () => {
    const ref = useRef('u7-materialized')
    // A document the module repo actually holds: resolving it IS materializing.
    const handle = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    let capturedInit: { signal: AbortSignal } | undefined
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async (_endpoint, init) => {
      capturedInit = init
      return jsonOk({ url: handle.url })
    })

    expect(cachedRootUrlFor(ref)).toBeNull()
    const resolved = await getRootHandle(ref)

    expect(resolved.url).toBe(handle.url)
    expect(cachedRootUrlFor(ref)).toBe(handle.url)
    // The boot root-url fetch runs under a wall-clock AbortSignal — a
    // server that accepts the request and never answers cannot hold the boot
    // pipeline hostage. (Presence pinned here; the 10s duration is not
    // fake-timer reachable because AbortSignal.timeout uses internal timers.)
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal)
  }, 15_000)

  it('preferCachedRootForNextResolve is consumed exactly once (U10)', async () => {
    const ref = useRef('u10-oneshot')
    const handle = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    localStorage.setItem(cacheKeyOf(ref), handle.url)
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    let fetches = 0
    __setRootUrlFetchForTest(async () => {
      fetches += 1
      return jsonOk({ url: handle.url })
    })

    preferCachedRootForNextResolve(ref)
    await getRootHandle(ref)
    // The armed one-shot answered from the cache — no server round trip.
    expect(fetches).toBe(0)

    forgetWorkspaceHandles(ref)
    await getRootHandle(ref)
    // The NEXT resolve asks the server again: the flag was CONSUMED, not
    // merely observed (the delete→has mutant leaves it armed forever and the
    // fallback session would silently never re-check the server).
    expect(fetches).toBe(1)
  }, 15_000)

  it('abandonPreferredCachedRoot drops an armed, unconsumed preference (n3)', async () => {
    // The re-entry's own terminal cleanup: an armed preference it never got
    // to consume must not leak into a later, unrelated resolve. (Only the
    // re-entry may call this — bridgeBootFallback.test.ts pins WHO; this pins
    // WHAT the call does.)
    const ref = useRef('n3-abandon')
    const handle = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    localStorage.setItem(cacheKeyOf(ref), handle.url)
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    let fetches = 0
    __setRootUrlFetchForTest(async () => {
      fetches += 1
      return jsonOk({ url: handle.url })
    })

    preferCachedRootForNextResolve(ref)
    abandonPreferredCachedRoot(ref)
    await getRootHandle(ref)
    // The abandoned preference no longer short-circuits the server.
    expect(fetches).toBe(1)
  }, 15_000)
})
