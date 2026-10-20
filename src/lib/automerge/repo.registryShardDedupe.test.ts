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
 * Two tabs publishing the same held registry shard leave its url twice in
 * root.shardUrls: each tab's `includes()` sees only its own copy, and two
 * concurrent list inserts both survive the merge. `getRegistryShardHandles`
 * must resolve ONE handle per url, or every diagram of that shard is
 * projected twice (found in review, 2026-10-19).
 *
 * Against the REAL repo.ts: only the root-url fetch and the network route are
 * seam-injected (repo.rootUrlCache.test.ts's pattern).
 */

// @vitest-environment jsdom

import { generateAutomergeUrl } from '@automerge/automerge-repo'
import { afterEach, describe, expect, it } from 'vitest'
import {
  repo,
  getRegistryShardHandles,
  findHeldRegistryShardHandle,
  forgetWorkspaceHandles,
  __setRootUrlFetchForTest,
  __setWorkspaceNetworkRouteForTest,
} from './repo'
import { workspaceRefKey, type WorkspaceRef } from './workspace'
import type { RegistryShard, RootDoc } from './types'

const ref: WorkspaceRef = { landscapeId: 'dedupe-registry', versionId: 'v1' }

afterEach(() => {
  forgetWorkspaceHandles(ref)
  localStorage.removeItem(`maplespire:rootUrl:${workspaceRefKey(ref)}`)
  __setRootUrlFetchForTest(null)
  __setWorkspaceNetworkRouteForTest(null)
})

describe('getRegistryShardHandles', () => {
  it('resolves a url the root lists twice to ONE handle, in first-listed order', async () => {
    const a = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
    const b = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
    const root = repo.create<RootDoc>({ modelUrl: '', shardUrls: [a.url, b.url, a.url] })
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => new Response(JSON.stringify({ url: root.url }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))

    const handles = await getRegistryShardHandles(ref)

    expect(handles.map((handle) => handle.url)).toEqual([a.url, b.url])
  }, 15_000)
})

describe('findHeldRegistryShardHandle', () => {
  it('gives up on a shard missing from this browser within the held bound', async () => {
    // A LITERAL bound, not one derived from HELD_SHARD_RESOLUTION: a test that
    // reads the constant agrees with any value it is given.
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    const missing = generateAutomergeUrl()
    const started = Date.now()
    await expect(findHeldRegistryShardHandle(missing)).rejects.toBeDefined()
    expect(Date.now() - started).toBeLessThan(3_500)
  }, 90_000)
})
