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
import {
  __resetResolvedWorkspacesForTest,
  adoptBindingAsBasis,
  documentsWorkspaceFor,
  rememberResolvedWorkspace,
  resolvedWorkspaceFor,
} from './workspaceBinding'
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

/**
 * The durability witness asks about `documentsWorkspaceFor(ref,
 * rootHandle.url)` — the bridge composes exactly that, with the root handle its
 * session holds. The basis is written HERE, by the real fetchRootUrl, beside
 * the url it came with. A `current` tab that fetched its root online must get
 * its concrete version; one that booted from the cache must get nothing, even
 * with an older basis still on record.
 */
describe('the root fetch names the documents\' workspace for the durability witness', () => {
  afterEach(() => __resetResolvedWorkspacesForTest())

  function useAlias(landscapeId: string): WorkspaceRef {
    const ref: WorkspaceRef = { landscapeId, versionId: 'current' }
    cleanups.push(() => {
      forgetWorkspaceHandles(ref)
      localStorage.removeItem(cacheKeyOf(ref))
    })
    return ref
  }

  /** Boot the root as the bridge does, then ask what the bridge asks. */
  async function bootAndName(ref: WorkspaceRef): Promise<WorkspaceRef | null> {
    const rootHandle = await getRootHandle(ref)
    return documentsWorkspaceFor(ref, rootHandle.url)
  }

  it('an online root fetch names the concrete version beside the root it booted', async () => {
    const ref = useAlias('dw-online')
    const handle = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => jsonOk({ url: handle.url, landscapeId: 'dw-online', versionId: 'v-7' }))

    expect(await bootAndName(ref)).toEqual({ landscapeId: 'dw-online', versionId: 'v-7' })
  }, 15_000)

  it('a server that reports no key leaves the witness without a workspace', async () => {
    const ref = useAlias('dw-legacy')
    const handle = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => jsonOk({ url: handle.url, landscapeId: null, versionId: null }))

    expect(await bootAndName(ref)).toBeNull()
    // …and records NO basis at all. The witness above is also saved by its
    // landscape check, but the repoint detector (`resolvedWorkspaceFor`) is
    // not: a recorded {null, null} would read every socket binding as a
    // repoint. The server answers keyless on every legacy fallback.
    expect(resolvedWorkspaceFor(ref)).toBeNull()
  }, 15_000)

  it('a session booted from the PREFERRED cached root gets nothing, though an older basis is on record', async () => {
    const ref = useAlias('dw-preferred')
    const fetched = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    const cached = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => jsonOk({ url: fetched.url, landscapeId: 'dw-preferred', versionId: 'v-7' }))
    // Control: the online session HAD a witness workspace.
    expect(await bootAndName(ref)).toEqual({ landscapeId: 'dw-preferred', versionId: 'v-7' })

    // Another tab materialized a different root under the same key; the boot
    // fallback re-enters from it.
    localStorage.setItem(cacheKeyOf(ref), cached.url)
    forgetWorkspaceHandles(ref)
    preferCachedRootForNextResolve(ref)

    expect(await bootAndName(ref)).toBeNull()
    expect(lastAttemptedRootUrlFor(ref)).toBe(cached.url)
  }, 15_000)

  it('a session that fell back to the cached root after a FAILED fetch gets nothing', async () => {
    const ref = useAlias('dw-offline')
    const fetched = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    const cached = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => jsonOk({ url: fetched.url, landscapeId: 'dw-offline', versionId: 'v-7' }))
    expect(await bootAndName(ref)).toEqual({ landscapeId: 'dw-offline', versionId: 'v-7' })

    localStorage.setItem(cacheKeyOf(ref), cached.url)
    forgetWorkspaceHandles(ref)
    __setRootUrlFetchForTest(async () => { throw new TypeError('Failed to fetch') })

    expect(await bootAndName(ref)).toBeNull()
    expect(lastAttemptedRootUrlFor(ref)).toBe(cached.url)
  }, 15_000)
})

/**
 * A LATER page that boots the cached root without the server. Measured
 * 2026-10-28: such a boot knew nothing about its version, the first socket
 * binding was adopted as the basis, and a repoint made while the tab was away
 * went undetected — the reads were answered about the new default and the
 * documents were refused `workspace-mismatch`. The key the root fetch reported
 * is now persisted beside the materialized root and restored for that root.
 *
 * Every test here drops the in-memory basis between the two boots
 * (`__resetResolvedWorkspacesForTest`), as a page load does: otherwise the
 * first boot's `root-fetch` basis, beside the same url, answers on its own and
 * the test passes with the restore deleted.
 */
describe('a cached-root boot names the version that root was fetched for', () => {
  afterEach(() => __resetResolvedWorkspacesForTest())

  function aliasRef(landscapeId: string): WorkspaceRef {
    const ref: WorkspaceRef = { landscapeId, versionId: 'current' }
    cleanups.push(() => {
      forgetWorkspaceHandles(ref)
      localStorage.removeItem(cacheKeyOf(ref))
      localStorage.removeItem(`${cacheKeyOf(ref)}:workspace`)
    })
    return ref
  }

  async function bootAndName(ref: WorkspaceRef): Promise<WorkspaceRef | null> {
    const rootHandle = await getRootHandle(ref)
    return documentsWorkspaceFor(ref, rootHandle.url)
  }

  /** An online boot that materializes `root`, then a fresh page. */
  async function materializeOnlineThenReload(ref: WorkspaceRef, url: string, versionId: string | null): Promise<void> {
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => jsonOk({ url, landscapeId: versionId ? ref.landscapeId : null, versionId }))
    await getRootHandle(ref)
    expect(cachedRootUrlFor(ref)).toBe(url)
    forgetWorkspaceHandles(ref)
    __resetResolvedWorkspacesForTest()
  }

  it('offline: the failed fetch falls back to the cached root AND its version, as a root-cache basis', async () => {
    const ref = aliasRef('rc-offline')
    const root = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    await materializeOnlineThenReload(ref, root.url, 'v-1')
    __setRootUrlFetchForTest(async () => { throw new TypeError('Failed to fetch') })

    expect(await bootAndName(ref)).toEqual({ landscapeId: 'rc-offline', versionId: 'v-1' })
    // The repoint detector compares the first binding against THIS, instead of
    // adopting the binding (bridge.ts's self-arm runs only with no basis).
    expect(resolvedWorkspaceFor(ref)).toEqual({ landscapeId: 'rc-offline', versionId: 'v-1' })
  }, 15_000)

  it('the boot fallback: the preferred cached root comes back with its version too', async () => {
    const ref = aliasRef('rc-preferred')
    const root = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    await materializeOnlineThenReload(ref, root.url, 'v-1')
    let fetches = 0
    __setRootUrlFetchForTest(async () => { fetches += 1; throw new Error('must not be asked') })
    preferCachedRootForNextResolve(ref)

    expect(await bootAndName(ref)).toEqual({ landscapeId: 'rc-preferred', versionId: 'v-1' })
    expect(fetches).toBe(0)
  }, 15_000)

  it('a record stored beside ANOTHER root is not restored for this one', async () => {
    const ref = aliasRef('rc-other-root')
    const first = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    const other = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    await materializeOnlineThenReload(ref, first.url, 'v-1')
    // Another tab (an older build) cached a different root, and wrote no key.
    localStorage.setItem(cacheKeyOf(ref), other.url)
    __setRootUrlFetchForTest(async () => { throw new TypeError('Failed to fetch') })

    expect(await bootAndName(ref)).toBeNull()
    expect(resolvedWorkspaceFor(ref)).toBeNull()
  }, 15_000)

  it('a server that reported no key stores no record, so the cached boot names nothing', async () => {
    const ref = aliasRef('rc-keyless')
    const root = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    await materializeOnlineThenReload(ref, root.url, null)
    expect(localStorage.getItem(`${cacheKeyOf(ref)}:workspace`)).toBeNull()
    __setRootUrlFetchForTest(async () => { throw new TypeError('Failed to fetch') })

    expect(await bootAndName(ref)).toBeNull()
  }, 15_000)

  it('a record naming another landscape, or no version, or not JSON, is ignored', async () => {
    const ref = aliasRef('rc-garbage')
    const root = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    localStorage.setItem(cacheKeyOf(ref), root.url)
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => { throw new TypeError('Failed to fetch') })
    const records = [
      JSON.stringify({ rootUrl: root.url, landscapeId: 'someone-else', versionId: 'v-1' }),
      JSON.stringify({ rootUrl: root.url, landscapeId: 'rc-garbage', versionId: '' }),
      JSON.stringify({ rootUrl: root.url, landscapeId: 'rc-garbage' }),
      '{not json',
    ]
    for (const record of records) {
      localStorage.setItem(`${cacheKeyOf(ref)}:workspace`, record)
      forgetWorkspaceHandles(ref)
      __resetResolvedWorkspacesForTest()
      expect(await bootAndName(ref), record).toBeNull()
      expect(resolvedWorkspaceFor(ref), record).toBeNull()
    }
    // Control: the same harness with a well-formed record restores it.
    localStorage.setItem(`${cacheKeyOf(ref)}:workspace`, JSON.stringify({ rootUrl: root.url, landscapeId: 'rc-garbage', versionId: 'v-1' }))
    forgetWorkspaceHandles(ref)
    __resetResolvedWorkspacesForTest()
    expect(await bootAndName(ref)).toEqual({ landscapeId: 'rc-garbage', versionId: 'v-1' })
  }, 15_000)

  it('the restore REPLACES a basis already in memory — a stale root fetch, or a self-armed binding', async () => {
    // A Retry (or any re-resolve after forgetWorkspaceHandles) keeps the module
    // state: a basis for another root, or a binding adopted meanwhile, must not
    // outlive the cached boot, or the detector compares against the wrong version.
    for (const stale of ['root-fetch', 'socket-binding'] as const) {
      const ref = aliasRef(`rc-replace-${stale}`)
      const root = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
      await materializeOnlineThenReload(ref, root.url, 'v-1')
      if (stale === 'root-fetch') {
        rememberResolvedWorkspace(ref, { landscapeId: ref.landscapeId, versionId: 'v-2' }, { from: 'root-fetch', rootUrl: 'automerge:elsewhere' })
      } else {
        adoptBindingAsBasis(ref, { landscapeId: ref.landscapeId, versionId: 'v-2' })
      }
      __setRootUrlFetchForTest(async () => { throw new TypeError('Failed to fetch') })

      expect(await bootAndName(ref), stale).toEqual({ landscapeId: ref.landscapeId, versionId: 'v-1' })
      expect(resolvedWorkspaceFor(ref), stale).toEqual({ landscapeId: ref.landscapeId, versionId: 'v-1' })
    }
  }, 15_000)

  it('the record follows the root: a NEW root materializing for the ref replaces it', async () => {
    // After a follow to V2 the cached root is V2's; a record left at V1's url
    // would miss the url check and every later cached boot would self-arm again.
    const ref = aliasRef('rc-refresh')
    const first = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    const second = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    await materializeOnlineThenReload(ref, first.url, 'v-1')
    await materializeOnlineThenReload(ref, second.url, 'v-2')
    __setRootUrlFetchForTest(async () => { throw new TypeError('Failed to fetch') })

    const rootHandle = await getRootHandle(ref)
    expect(rootHandle.url).toBe(second.url)
    expect(documentsWorkspaceFor(ref, rootHandle.url)).toEqual({ landscapeId: 'rc-refresh', versionId: 'v-2' })
  }, 15_000)

  it('a concrete ref names its own version: nothing is written beside its root', async () => {
    const ref = useRef('rc-concrete')
    const root = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    cleanups.push(() => localStorage.removeItem(`${cacheKeyOf(ref)}:workspace`))
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => jsonOk({ url: root.url, landscapeId: 'rc-concrete', versionId: 'v1' }))
    await getRootHandle(ref)
    expect(cachedRootUrlFor(ref)).toBe(root.url) // liveness: the root did materialize
    expect(localStorage.getItem(`${cacheKeyOf(ref)}:workspace`)).toBeNull()
  }, 15_000)

  it('a basis self-armed from a binding is never written down as the root\'s version', async () => {
    const ref = aliasRef('rc-self-armed')
    const root = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    localStorage.setItem(cacheKeyOf(ref), root.url)
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => { throw new TypeError('Failed to fetch') })
    // The bridge's self-arm, landing before the root materializes.
    adoptBindingAsBasis(ref, { landscapeId: 'rc-self-armed', versionId: 'v-repointed' })
    await getRootHandle(ref)
    expect(localStorage.getItem(`${cacheKeyOf(ref)}:workspace`)).toBeNull()
  }, 15_000)
})
