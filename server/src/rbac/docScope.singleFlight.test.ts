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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import type { SessionClaims } from '../auth/tokens.js'
import {
  _clearAllowedWorkspaceKeysCacheForTests, allowedWorkspaceKeys,
  WorkspaceDocIndex, buildWorkspaceRouteCheck, type WorkspaceKey,
} from './docScope.js'
import { mintDocumentIdBytes } from './documentIdMint.js'

const claims: SessionClaims = {
  userId: 'platform-admin-1',
  orgId: null,
  isPlatformAdmin: true,
  epoch: 1,
}

afterEach(() => {
  _clearAllowedWorkspaceKeysCacheForTests()
})

describe('allowed workspace cold-cache admission', () => {
  it('runs one authorization query for a concurrent socket burst', async () => {
    let release!: (value: { rows: Array<{ id: string; landscape_id: string }> }) => void
    const pending = new Promise<{ rows: Array<{ id: string; landscape_id: string }> }>((resolve) => {
      release = resolve
    })
    const pool = { query: vi.fn().mockReturnValue(pending) }

    const burst = Array.from({ length: 50 }, () => allowedWorkspaceKeys(pool as never, claims))
    expect(pool.query).toHaveBeenCalledTimes(1)
    release({ rows: [{ id: 'V1', landscape_id: 'L1' }] })

    const results = await Promise.all(burst)
    expect(results.every((keys) => keys.has('L1/V1'))).toBe(true)
    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('does not cache an authorization result invalidated while its query is running', async () => {
    let release!: (value: { rows: Array<{ id: string; landscape_id: string }> }) => void
    const first = new Promise<{ rows: Array<{ id: string; landscape_id: string }> }>((resolve) => {
      release = resolve
    })
    const pool = {
      query: vi.fn()
        .mockReturnValueOnce(first)
        .mockResolvedValue({ rows: [{ id: 'V2', landscape_id: 'L1' }] }),
    }

    const admitted = allowedWorkspaceKeys(pool as never, claims)
    _clearAllowedWorkspaceKeysCacheForTests()
    release({ rows: [{ id: 'V1', landscape_id: 'L1' }] })

    await expect(admitted).resolves.toEqual(new Set(['L1/V2']))
    expect(pool.query).toHaveBeenCalledTimes(2)
  })
})

// The verified-claim single flight. A freshly created
// document arrives as a BURST: every message naming it passes the route gate,
// and each pass fires `claimVerifiedDocument`. Without the per-documentId
// flight map that is N identical INSERT round trips racing each other on the
// admission path.
describe('verified-claim single flight', () => {
  const SECRET = 'single-flight-mint-secret'
  const L = 'L-sf'
  const V1: WorkspaceKey = { landscapeId: L, versionId: 'V-sf1' }
  const V2: WorkspaceKey = { landscapeId: L, versionId: 'V-sf2' }
  const V3: WorkspaceKey = { landscapeId: L, versionId: 'V-sf3' }

  let saved: string | undefined
  beforeEach(() => { saved = process.env.AUTH_SECRET; process.env.AUTH_SECRET = SECRET })
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = saved
  })

  function countingPool(counters: { inserts: number; versionLists: number; rootReads: number }): pg.Pool {
    const table = new Map<string, { landscape_id: string; version_id: string }>()
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (/SELECT id FROM versions WHERE landscape_id/.test(sql)) {
          counters.versionLists += 1
          return { rows: [{ id: V1.versionId }, { id: V2.versionId }, { id: V3.versionId }] }
        }
        if (/SELECT root_url FROM versions/.test(sql)) {
          counters.rootReads += 1
          return { rows: [{ root_url: 'automerge:root-sf' }] }
        }
        if (/INSERT INTO automerge_document_workspace/.test(sql)) {
          counters.inserts += 1
          const [documentId, landscapeId, versionId] = params as string[]
          if (table.has(documentId)) return { rows: [], rowCount: 0 }
          table.set(documentId, { landscape_id: landscapeId, version_id: versionId })
          return { rows: [{ document_id: documentId }], rowCount: 1 }
        }
        if (/SELECT landscape_id, version_id/.test(sql)) {
          const row = table.get(String(params[0]))
          return { rows: row ? [row] : [] }
        }
        return { rows: [] }
      },
    } as unknown as pg.Pool
  }

  async function mintedId(workspace: WorkspaceKey): Promise<string> {
    const repo = new Repo({ idFactory: async () => mintDocumentIdBytes(workspace) })
    return String((await repo.create2({ burst: true })).documentId)
  }

  it('N concurrent gate calls for a fresh displaced id issue ONE claim INSERT', async () => {
    const counters = { inserts: 0, versionLists: 0, rootReads: 0 }
    const index = new WorkspaceDocIndex(new Repo({}), countingPool(counters))
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)
    const id = await mintedId(V1)

    const verdicts = await Promise.all(Array.from({ length: 25 }, () => gate('peer', id)))

    // Every caller is admitted — joiners re-test byDoc after the flight and
    // find the winner is their own route...
    expect(verdicts).toEqual(Array.from({ length: 25 }, () => true))
    // ...on the back of exactly one durable claim, one versions-row read and
    // one version-list fetch: the flight map and the resolver's single flight.
    expect(counters.inserts).toBe(1)
    expect(counters.rootReads).toBe(1)
    expect(counters.versionLists).toBe(1)
  })

  // The other half of "re-test byDoc after the awaits": the flight map is
  // keyed per documentId, so a joiner may be joining a flight STARTED UNDER
  // ANOTHER ROUTE'S KEY. Its boolean answers that key, not the joiner's —
  // adopting it verbatim would admit one displaced id on two sibling routes at
  // once, an in-process cross-version capture the durable table never sees.
  it('a same-process cross-route race admits exactly one route', async () => {
    const counters = { inserts: 0, versionLists: 0, rootReads: 0 }
    const index = new WorkspaceDocIndex(new Repo({}), countingPool(counters))
    const gateV2 = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)
    const gateV3 = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V3 }, true)
    const id = await mintedId(V1)

    const verdicts = await Promise.all([gateV2('peer-2', id), gateV3('peer-3', id)])

    expect([...verdicts].sort()).toEqual([false, true])
    expect(counters.inserts).toBe(1)
  })

  it('a burst on the BOUND fast path also collapses to one INSERT', async () => {
    const counters = { inserts: 0, versionLists: 0, rootReads: 0 }
    const index = new WorkspaceDocIndex(new Repo({}), countingPool(counters))
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)
    const id = await mintedId(V2)

    // The bound path answers from the MAC alone and fires the claim without
    // awaiting it, so the verdicts settle before the INSERT necessarily has.
    expect(await Promise.all(Array.from({ length: 25 }, () => gate('peer', id))))
      .toEqual(Array.from({ length: 25 }, () => true))
    await vi.waitFor(() => { expect(counters.inserts).toBe(1) })
    // Nothing new to claim on the next sighting either.
    expect(await gate('peer', id)).toBe(true)
    expect(counters.inserts).toBe(1)
  })
})
