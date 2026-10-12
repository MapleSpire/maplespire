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

import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { describe, expect, it, vi } from 'vitest'
import { ensureHealthyWorkspaceRoot } from './workspaceRootGuard.js'
import { LifecycleApplyRefusedError } from './lifecycleApplyLock.js'

describe('workspace root integrity guard', () => {
  it('returns a healthy root without running repair', async () => {
    const repo = new Repo({ network: [] })
    const meta = repo.create({ objectShardUrls: [], connectionShardUrls: [] })
    const registry = repo.create({ diagrams: {} })
    const root = repo.create({ modelMetaUrl: meta.url, shardUrls: [registry.url] })
    await Promise.all([meta, registry, root].map((handle) => handle.whenReady()))
    const repair = vi.fn()

    await expect(ensureHealthyWorkspaceRoot(
      {} as never,
      repo,
      { landscapeId: 'land', versionId: 'version' },
      root.url,
      { repair: repair as never },
    )).resolves.toBe(root.url)
    expect(repair).not.toHaveBeenCalled()
  })

  it('single-flights concurrent repair and publishes exactly one replacement URL', async () => {
    const repo = new Repo({ network: [] })
    const damaged = repo.create({})
    const replacement = repo.create({
      modelMetaUrl: 'automerge:3Xb7FRNfh1SUKHLrgbJADtWN75zk',
      shardUrls: ['automerge:2dAXDzyxSuQwSs9Qe7dPT8C34Q3A'],
    })
    await Promise.all([damaged, replacement].map((handle) => handle.whenReady()))
    const rotation = {
      landscapeId: 'land', versionId: 'version',
      oldRootUrl: damaged.url, newRootUrl: replacement.url,
    }
    const repair = vi.fn(async () => ({
      reportOnly: false,
      safeToApply: true,
      workspaces: [{}],
      repaired: 1,
      rotations: [rotation],
      refused: [],
    }))
    const onRotated = vi.fn()

    const urls = await Promise.all(Array.from({ length: 25 }, () => ensureHealthyWorkspaceRoot(
      {} as never,
      repo,
      { landscapeId: 'land', versionId: 'version' },
      damaged.url,
      { repair: repair as never, onRotated },
    )))

    expect(new Set(urls)).toEqual(new Set([replacement.url as AutomergeUrl]))
    expect(repair).toHaveBeenCalledOnce()
    expect(onRotated).toHaveBeenCalledOnce()
  })

  it('fails closed when the mapped graph has no deterministic repair plan', async () => {
    const repo = new Repo({ network: [] })
    const damaged = repo.create({})
    await damaged.whenReady()
    const repair = vi.fn(async () => ({
      reportOnly: false,
      safeToApply: false,
      workspaces: [{ issues: ['model-meta-cardinality:0'] }],
      repaired: 0,
      rotations: [],
      refused: [],
    }))

    await expect(ensureHealthyWorkspaceRoot(
      {} as never,
      repo,
      { landscapeId: 'unsafe', versionId: 'draft' },
      damaged.url,
      { repair: repair as never },
    )).rejects.toThrow('model-meta-cardinality:0')
  })

  it('reports a REFUSAL as transient, not as an unsafe plan', async () => {
    // Drives `refused` non-empty, so both deleting the `refused` branch and
    // replacing its `LifecycleApplyRefusedError` with a plain `Error` fail
    // here. A refusal must not send an operator looking for a structural
    // defect that is not there.
    //
    // The distinction is the whole point: `safeToApply` is TRUE on a refusal.
    // The plan was fine; a sibling lifecycle door held the workspace key. That
    // is 503 + `retryable`, and the arm below asserts the type and the code
    // rather than the message, because the message is what a plain `Error`
    // could also have carried.
    const repair = async () => ({
      reportOnly: false,
      safeToApply: true,
      workspaces: [{ issues: [] }],
      repaired: 0,
      rotations: [],
      refused: [{ landscapeId: 'landscape', versionId: 'version' }],
    })
    const repo = new Repo({ network: [] })
    const damaged = repo.create<Record<string, unknown>>({})
    await damaged.whenReady()

    const thrown = await ensureHealthyWorkspaceRoot(
      {} as never,
      repo,
      { landscapeId: 'landscape', versionId: 'version' },
      damaged.url,
      { repair: repair as never },
    ).then(() => null, (error: unknown) => error)

    expect(thrown).toBeInstanceOf(LifecycleApplyRefusedError)
    expect((thrown as LifecycleApplyRefusedError).code).toBe('lock-unavailable')
    // NOT the structural message — that is the misdiagnosis this exists to stop.
    expect((thrown as Error).message).not.toMatch(/unsafe/)

    // CONTROL: the SAME guard, on a result whose plan really is unsafe, still
    // reports the structural failure. Without it, "not unsafe" is satisfied by
    // a guard that never says unsafe about anything.
    const unsafe = async () => ({
      reportOnly: false,
      safeToApply: false,
      workspaces: [{ issues: ['model-meta-cardinality:0'] }],
      repaired: 0,
      rotations: [],
      refused: [],
    })
    await expect(ensureHealthyWorkspaceRoot(
      {} as never,
      repo,
      { landscapeId: 'landscape', versionId: 'version' },
      damaged.url,
      { repair: unsafe as never },
    )).rejects.toThrow('model-meta-cardinality:0')
  })
})
