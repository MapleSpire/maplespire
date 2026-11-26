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
 * T-DIAGDEF-2 (B): `fetchRootUrl` types a root request that got NO answer
 * (`WorkspaceRootUnreachableError`), and only that — a `TypeError` thrown
 * while reading an answer is a defect of the code, not an unreachable server,
 * and must keep its own type. The cached root still answers first. The REAL
 * repo chain (`repo.rootUrlCache.test.ts`'s seams).
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { repo, getRootHandle, forgetWorkspaceHandles, __setRootUrlFetchForTest, __setWorkspaceNetworkRouteForTest } from './repo'
import { WorkspaceRootHttpError, WorkspaceRootUnreachableError } from './rootFetchPolicy'
import { workspaceRefKey, type WorkspaceRef } from './workspace'
import type { RootDoc } from './types'

let n = 0
function freshRef(): WorkspaceRef {
  n += 1
  return { landscapeId: `root-unreachable-${n}`, versionId: 'current' }
}

afterEach(() => {
  __setRootUrlFetchForTest(null)
  __setWorkspaceNetworkRouteForTest(null)
  localStorage.clear()
})

describe('T-DIAGDEF-2 (B) — the root request got no answer', () => {
  for (const [shape, failure] of [
    ['refused', () => new TypeError('Failed to fetch')],
    ['timed out', () => new DOMException('The operation timed out.', 'TimeoutError')],
  ] as const) {
    it(`${shape}, no cached root: WorkspaceRootUnreachableError, carrying the cause`, async () => {
      const ref = freshRef()
      __setWorkspaceNetworkRouteForTest(async () => undefined)
      const cause = failure()
      __setRootUrlFetchForTest(async () => { throw cause })
      const error = await getRootHandle(ref).then(() => null, (e: unknown) => e)
      forgetWorkspaceHandles(ref)
      expect(error).toBeInstanceOf(WorkspaceRootUnreachableError)
      expect((error as Error).cause).toBe(cause)
    })
  }

  it('a gateway\'s UNMARKED 502 (a dead backend behind the proxy) is an unreachable server too', async () => {
    const ref = freshRef()
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => new Response('<html>Bad Gateway</html>', { status: 502 }))
    const error = await getRootHandle(ref).then(() => null, (e: unknown) => e)
    forgetWorkspaceHandles(ref)
    expect(error).toBeInstanceOf(WorkspaceRootUnreachableError)
    expect((error as Error).cause).toBeInstanceOf(WorkspaceRootHttpError)
  })

  it('control: a 503 the SERVER marked retryable stays the server\'s answer', async () => {
    const ref = freshRef()
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => new Response('{"retryable":true}', { status: 503, headers: { 'content-type': 'application/json' } }))
    const error = await getRootHandle(ref).then(() => null, (e: unknown) => e)
    forgetWorkspaceHandles(ref)
    expect(error).toBeInstanceOf(WorkspaceRootHttpError)
    expect(error).not.toBeInstanceOf(WorkspaceRootUnreachableError)
  }, 15_000)

  it('a TypeError thrown while READING the answer keeps its type', async () => {
    const ref = freshRef()
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new TypeError('a defect reading the body') },
    }) as unknown as Response)
    const error = await getRootHandle(ref).then(() => null, (e: unknown) => e)
    forgetWorkspaceHandles(ref)
    expect(error).not.toBeInstanceOf(WorkspaceRootUnreachableError)
    expect(error).toBeInstanceOf(TypeError)
  })

  it('control: with a materialized root cached, the boot still takes it', async () => {
    const ref = freshRef()
    const cached = repo.create<RootDoc>({ modelUrl: '', shardUrls: [] })
    localStorage.setItem(`maplespire:rootUrl:${workspaceRefKey(ref)}`, cached.url)
    __setWorkspaceNetworkRouteForTest(async () => undefined)
    __setRootUrlFetchForTest(async () => { throw new TypeError('Failed to fetch') })
    const handle = await getRootHandle(ref)
    forgetWorkspaceHandles(ref)
    expect(handle.url).toBe(cached.url)
  }, 15_000)
})
