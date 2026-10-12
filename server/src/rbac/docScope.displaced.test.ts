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
 * The `displaced` branch of the route gate.
 *
 * The repoint shape: a client minted document ids while its landscape's
 * default version was V1, worked offline through a `setDefaultVersion(L, V2)`,
 * and reconnected on a socket the server canonicalised to V2. The MAC verdict
 * for those ids on that socket is a mismatch; treating every mismatch as
 * `foreign` (a hard deny with no index fallback, no repair path and no lift)
 * would make the user's offline work permanently unsyncable.
 *
 * The split: inter-landscape stays `foreign` (the security boundary,
 * answered-not-consulted). Intra-landscape becomes `displaced`, and the gate
 * consults the durable first-owner-wins table — an existing row for a sibling
 * version keeps the transport isolation (deny, lifted by reconnecting on the
 * owning route); no row means this socket's canonical route is the first
 * presenter, so the document is claimed for it and admitted.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import {
  WorkspaceDocIndex, buildWorkspaceRouteCheck, notifyWorkspaceCreated,
  VERIFIED_CLAIM_RETRY_BACKOFF_MS, type WorkspaceKey,
} from './docScope.js'
import { mintDocumentIdBytes } from './documentIdMint.js'

const SECRET = 'displaced-gate-secret'
const L = 'L-rp'
const V1: WorkspaceKey = { landscapeId: L, versionId: 'V-rp1' }
const V2: WorkspaceKey = { landscapeId: L, versionId: 'V-rp2' }
const V3: WorkspaceKey = { landscapeId: L, versionId: 'V-rp3' }

let saved: string | undefined
beforeEach(() => { saved = process.env.AUTH_SECRET; process.env.AUTH_SECRET = SECRET })
afterEach(() => {
  if (saved === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = saved
})

/** Produced the way the client produces them: through `create2`. */
async function mintedId(workspace: WorkspaceKey): Promise<string> {
  const repo = new Repo({ idFactory: async () => mintDocumentIdBytes(workspace) })
  return String((await repo.create2({ made: 'offline' })).documentId)
}

type DurableRow = { landscape_id: string; version_id: string }

/**
 * A fake pool over ONE shared durable table, so two index instances can model
 * two server processes racing on the same database. Implements exactly the
 * statements the displaced branch is allowed to issue: the version list, the
 * versions-row read, the first-owner-wins INSERT and the winner SELECT — all
 * SQL, never a document resolution.
 */
function poolOver(
  table: Map<string, DurableRow>,
  versions: Array<{ id: string; landscape_id: string }>,
  counters?: { inserts?: string[]; versionLists?: string[] },
): pg.Pool {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (/SELECT id FROM versions WHERE landscape_id/.test(sql)) {
        counters?.versionLists?.push(String(params[0]))
        return { rows: versions.filter((v) => v.landscape_id === params[0]).map((v) => ({ id: v.id })) }
      }
      if (/SELECT root_url FROM versions/.test(sql)) {
        const hit = versions.find((v) => v.landscape_id === params[0] && v.id === params[1])
        return { rows: hit ? [{ root_url: `automerge:root-${hit.id}` }] : [] }
      }
      if (/INSERT INTO automerge_document_workspace/.test(sql)) {
        const [documentId, landscapeId, versionId] = params as string[]
        counters?.inserts?.push(documentId)
        // Derives from the versions row, like production: a deleted version
        // inserts nothing and wins nothing.
        if (!versions.some((v) => v.landscape_id === landscapeId && v.id === versionId)) {
          return { rows: [], rowCount: 0 }
        }
        if (table.has(documentId)) return { rows: [], rowCount: 0 }
        table.set(documentId, { landscape_id: landscapeId, version_id: versionId })
        return { rows: [{ document_id: documentId }], rowCount: 1 }
      }
      if (/SELECT landscape_id, version_id/.test(sql)) {
        const row = table.get(String(params[0]))
        return { rows: row ? [row] : [] }
      }
      if (/SELECT d\.landscape_id/.test(sql)) {
        const row = table.get(String(params[0]))
        return {
          rows: row
            ? [{ ...row, root_url: `automerge:root-${row.version_id}`, static_source: null, static_allowed: true }]
            : [],
        }
      }
      return { rows: [] }
    },
  } as unknown as pg.Pool
}

const keyOf = (k: WorkspaceKey) => `${k.landscapeId}/${k.versionId}`

describe('route gate — displaced verdict', () => {
  // The repoint admission.
  it('repoint: a V1-minted id on a V2-routed socket with NO durable row is ADMITTED and claimed for V2', async () => {
    const table = new Map<string, DurableRow>()
    const index = new WorkspaceDocIndex(new Repo({}), poolOver(table, [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]))
    const announced: string[] = []
    index.onWorkspaceIndexRepaired = (key) => { announced.push(keyOf(key)) }
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)

    const id = await mintedId(V1)
    expect(await gate('peer', id)).toBe(true)

    // Claimed for the SOCKET's canonical route, not for the version the id
    // was minted under — the document ends up owned by the workspace the
    // user is actually on.
    expect(table.get(id)).toEqual({ landscape_id: L, version_id: V2.versionId })

    // ...and the claim ANNOUNCED. A deny for this document may already be
    // pinned per (document, peer); without the announcement it would never be
    // lifted.
    expect(announced).toContain(keyOf(V2))

    // Release witness: the verified-claim single-flight map returns to empty
    // once the flight settles — asserted on the release, not on having
    // called what releases.
    expect(index._verifiedClaimsInFlightCountForTests()).toBe(0)
  })

  // Transport isolation survives the refinement: `displaced` consults the
  // table, it does not bypass it. Mutant this must kill: admit-by-landscape —
  // any displaced id admitted without the durable consultation.
  it('a displaced id with a durable V1 row is REFUSED on a V2 socket', async () => {
    const table = new Map<string, DurableRow>()
    const index = new WorkspaceDocIndex(new Repo({}), poolOver(table, [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]))
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)

    const id = await mintedId(V1)
    // The document was already presented — and claimed — on its home route.
    table.set(id, { landscape_id: L, version_id: V1.versionId })

    // Denied. Lift: the peer reconnecting routed to V1 (a fresh peerId gets a
    // virgin share-policy cache), same as the legacy version-mismatch deny.
    expect(await gate('peer', id)).toBe(false)
    // First-owner-wins: the row did not move.
    expect(table.get(id)).toEqual({ landscape_id: L, version_id: V1.versionId })
  })

  // The mirror of the case above, which the other rows in this file cannot
  // reach: every one of them routes the peer to V2.
  //
  // The rule is `resolveDocumentPlacement`'s: "the index answer wins; the mint
  // only fills a HOLE". The `bound` branch must consult the index, not admit on
  // the MAC alone.
  it('after a repoint claims a V1-minted id for V2, a socket still routed to V1 is REFUSED', async () => {
    const table = new Map<string, DurableRow>()
    const index = new WorkspaceDocIndex(new Repo({}), poolOver(table, [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]))
    const onV2 = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)
    const onV1 = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V1 }, true)

    const id = await mintedId(V1)

    // Step 1 is the repoint admission asserted at the top of this file: the
    // document ends up durably owned by V2, the workspace the user is on.
    expect(await onV2('peer-v2', id)).toBe(true)
    await vi.waitFor(() => {
      expect(table.get(id)).toEqual({ landscape_id: L, version_id: V2.versionId })
    })

    // Step 2: the MAC still verifies `bound` for V1 — the id WAS minted there.
    // Admitting would serve a V1-scoped peer a document durably owned by V2,
    // the merge `WorkspaceNetworkRouter`'s one-adapter-per-workspace exists to
    // make impossible. (First-owner-wins is not at stake here — only the
    // verdict is.)
    expect(await onV1('peer-v1', id)).toBe(false)

    // NEGATIVE CONTROL: a re-presentation on the OWNING route must still be
    // admitted. Without it, the mutant `if (placed) return false` — deny every
    // document the index knows — survives everything in this file.
    expect(await onV2('peer-v2b', id)).toBe(true)

    // And the row did not move. The V1 peer's lift is the ordinary one —
    // reconnecting routed to V2, whose fresh peerId gets a virgin share-policy
    // cache. NAMED LIMIT: a client pinned to an explicit V1 URL never
    // canonicalises to V2 and therefore never gets that lift. The refusal stays
    // correct; it is simply permanent, exactly like the sibling
    // version-mismatch deny in `buildAccessCheck`.
    expect(table.get(id)).toEqual({ landscape_id: L, version_id: V2.versionId })
  })

  // THE COLD PROCESS — the shape production actually restarts into, and the one
  // the case above structurally cannot reach.
  //
  // Above, `onV2` runs first and `runVerifiedClaim` calls `ensureEntry(V2)` as a
  // side effect, so `byWorkspace` happens to know V2. Here nothing ever routes a
  // peer to V2: the durable row was written by another process, or before this
  // one restarted. `byDoc` learns the winner from the losing claim — and the
  // three loser paths write a key string WITHOUT creating its entry, because
  // they hold no `rootUrl`. So `peekDocWorkspace` must reconstruct the key from
  // `byDoc`; reading it through `byWorkspace` would answer null here and admit
  // both presentations.
  it('COLD: a durable row this process never walked still refuses a foreign-routed socket', async () => {
    const table = new Map<string, DurableRow>()
    const index = new WorkspaceDocIndex(new Repo({}), poolOver(table, [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]))
    const onV1 = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V1 }, true)

    const id = await mintedId(V1)
    // Written by somebody else. This index has never seen V2 and never will.
    table.set(id, { landscape_id: L, version_id: V2.versionId })

    // Presentation 1 is admitted, and that is a NAMED limit rather than a bug
    // to fix here: a cache-only read cannot see a durable row nobody has read.
    // At stage 'on' the composed check denies it anyway (`buildAccessCheck`
    // resolves durable-first); what this gate owes is the second presentation.
    expect(await onV1('peer-v1', id)).toBe(true)
    // The losing claim resolves the winner into `byDoc` — without an entry.
    await vi.waitFor(() => { expect(index.peekDocWorkspace(id)).not.toBeNull() })

    expect(index.peekDocWorkspace(id)).toEqual(V2)
    expect(await onV1('peer-v1', id)).toBe(false)
  })

  // Two processes race the first presentation of one displaced id from two
  // sibling routes. Exactly one may win; the loser must DENY — and must
  // ANNOUNCE for the winner's workspace, whose peers may be sitting on denies
  // pinned before the row existed.
  it('the losing claim of a displaced race is refused AND announces the winner', async () => {
    const table = new Map<string, DurableRow>()
    const versions = [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
      { id: V3.versionId, landscape_id: L },
    ]
    // Two INDEX INSTANCES over one durable table — two server processes; the
    // in-process single-flight cannot serialise them, only the table can.
    const indexA = new WorkspaceDocIndex(new Repo({}), poolOver(table, versions))
    const indexB = new WorkspaceDocIndex(new Repo({}), poolOver(table, versions))
    const announcedA: string[] = []
    const announcedB: string[] = []
    indexA.onWorkspaceIndexRepaired = (key) => { announcedA.push(keyOf(key)) }
    indexB.onWorkspaceIndexRepaired = (key) => { announcedB.push(keyOf(key)) }
    const gateA = buildWorkspaceRouteCheck(indexA, { workspaceForPeer: () => V2 }, true)
    const gateB = buildWorkspaceRouteCheck(indexB, { workspaceForPeer: () => V3 }, true)

    const id = await mintedId(V1)
    const [admittedOnV2, admittedOnV3] = await Promise.all([gateA('peerA', id), gateB('peerB', id)])

    // First-owner-wins: exactly one admission.
    expect([admittedOnV2, admittedOnV3].sort()).toEqual([false, true])
    const winner = admittedOnV2 ? V2 : V3
    const loserAnnouncements = admittedOnV2 ? announcedB : announcedA
    const winnerAnnouncements = admittedOnV2 ? announcedA : announcedB

    // The table holds the winner...
    expect(table.get(id)).toEqual({ landscape_id: L, version_id: winner.versionId })
    // ...the winning claim announced its own admission...
    expect(winnerAnnouncements).toContain(keyOf(winner))
    // ...and the LOSING claim, which just learned the durable winner, announced
    // for the winner's workspace rather than staying silent on its deny.
    expect(loserAnnouncements).toContain(keyOf(winner))
  })

  // The single-flight map is evicted in
  // the starter's `finally`, which only runs when the flight SETTLES — and a
  // wedged INSERT settles never. Unbounded, the dead flight would pin the map
  // entry for the life of the process: every later presentation joins it,
  // denies at the gate deadline, and pool recovery changes nothing. The
  // per-flight ceiling turns the hang into a rejection, the rejection runs
  // the finally, and the NEXT presentation claims fresh.
  it('a wedged claim flight is evicted at its ceiling — the map never pins a dead flight', async () => {
    const table = new Map<string, DurableRow>()
    const versions = [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]
    let wedgeInserts = true
    const base = poolOver(table, versions) as unknown as {
      query: (sql: string, params?: unknown[]) => Promise<unknown>
    }
    const pool = {
      query: (sql: string, params: unknown[] = []) => {
        if (wedgeInserts && /INSERT INTO automerge_document_workspace/.test(sql)) {
          // The wedged-pool shape: a statement that never settles.
          return new Promise(() => {})
        }
        return base.query(sql, params)
      },
    } as unknown as pg.Pool
    const index = new WorkspaceDocIndex(new Repo({}), pool, { verifiedClaimDeadlineMs: 100 })
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true, {
      displacedScanDeadlineMs: 50,
    })
    const id = await mintedId(V1)

    // Gate 1: fault verdict at the gate's own deadline — fail closed, boolean.
    expect(await gate('peer', id)).toBe(false)
    // The flight leaves the map when ITS ceiling fires, not never.
    await vi.waitFor(() => {
      expect(index._verifiedClaimsInFlightCountForTests()).toBe(0)
    }, { timeout: 2_000 })

    // The pool recovers, and NOTHING else happens — no restart, no reconnect.
    wedgeInserts = false
    expect(await gate('peer', id), 'a fresh presentation must start a fresh flight').toBe(true)
    expect(table.get(id)).toEqual({ landscape_id: L, version_id: V2.versionId })
  })

  // The version list is cached per landscape for the TTL — a
  // burst of displaced presentations must not re-run the list per document.
  it('sequential displaced scans of one landscape share one version-list query', async () => {
    const table = new Map<string, DurableRow>()
    const counters = { versionLists: [] as string[] }
    const index = new WorkspaceDocIndex(new Repo({}), poolOver(table, [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ], counters))
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)

    expect(await gate('peer', await mintedId(V1))).toBe(true)
    expect(await gate('peer', await mintedId(V1))).toBe(true)
    expect(counters.versionLists, 'the second scan must be served from the TTL cache').toHaveLength(1)
  })

  // A sibling version created IN-PROCESS is visible to the very
  // next scan — `notifyWorkspaceCreated` invalidates the cache, or an id
  // minted for the new version reads `foreign` for a whole TTL.
  it('a sibling version created in-process is visible to the very next scan', async () => {
    const table = new Map<string, DurableRow>()
    const versions = [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]
    const index = new WorkspaceDocIndex(new Repo({}), poolOver(table, versions))
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)

    // Prime the cache with [V1, V2].
    expect(await gate('peer', await mintedId(V1))).toBe(true)
    // createVersion's shape: the row exists, then notifyWorkspaceCreated fires.
    versions.push({ id: V3.versionId, landscape_id: L })
    notifyWorkspaceCreated({ landscapeId: L, versionId: V3.versionId, rootUrl: `automerge:root-${V3.versionId}` })
    // An id minted for the NEW version must be displaced on the V2 route,
    // which requires V3 in the candidate list — a stale cache answers foreign.
    expect(await gate('peer', await mintedId(V3))).toBe(true)
  })

  // The epoch guard. The case above covers the ORDERED case (invalidate, then
  // fetch); this is the RACED one: a list fetch already in flight when the
  // invalidation lands resolves after it, carrying the pre-invalidation
  // catalog. The flight's answer is still served to its joiners —
  // single-flight semantics, the flight may be stale — but the CACHE
  // must stay empty, or the scan misses the brand-new version for up to a
  // further TTL. Mutant killed: caching the result without checking the epoch
  // observed before the fetch → the second scan below is served [V1, V2] from
  // cache, the V3-minted id reads foreign, and the query count stays at 1.
  it('an invalidation racing an in-flight list fetch keeps the cache empty', async () => {
    const table = new Map<string, DurableRow>()
    const versions = [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]
    let versionListQueries = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const base = poolOver(table, versions) as unknown as {
      query: (sql: string, params?: unknown[]) => Promise<unknown>
    }
    const pool = {
      query: (sql: string, params: unknown[] = []) => {
        if (/SELECT id FROM versions WHERE landscape_id/.test(sql)) {
          versionListQueries += 1
          // Snapshot SYNCHRONOUSLY at call time — the staleness under test is
          // the fetch's, not an artifact of the fake reading `versions` late.
          const rows = versions
            .filter((v) => v.landscape_id === params[0])
            .map((v) => ({ id: v.id }))
          if (versionListQueries === 1) return held.then(() => ({ rows }))
          return Promise.resolve({ rows })
        }
        return base.query(sql, params)
      },
    } as unknown as pg.Pool
    const index = new WorkspaceDocIndex(new Repo({}), pool)

    // The fetch takes off with [V1, V2]...
    const inFlight = index.listLandscapeVersionIds(L)
    // ...the invalidation lands while it is in the air (createVersion's shape:
    // row first, then the hook)...
    versions.push({ id: V3.versionId, landscape_id: L })
    notifyWorkspaceCreated({ landscapeId: L, versionId: V3.versionId, rootUrl: `automerge:root-${V3.versionId}` })
    release()

    // ...and the flight's joiners get the flight's (stale) answer — accepted.
    await expect(inFlight).resolves.toEqual([V1.versionId, V2.versionId])

    // The very next scan must RE-FETCH, not read the raced cache: an id minted
    // for the new version is displaced on the V2 route only if V3 is in the
    // candidate list.
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)
    expect(await gate('peer', await mintedId(V3))).toBe(true)
    expect(versionListQueries, 'the post-invalidation scan must re-fetch, not join the raced cache').toBe(2)
  })

  // ======================================================================
  // Background retry after a flight evicted WITHOUT a verdict. The eviction
  // answers everyone `false` with no announcement, so the per-(document, peer)
  // deny would stay pinned until the denyLedger's ~30 s reconcile or a
  // reconnection. Hence ONE detached background retry, only for CEILING
  // evictions, whose success announces — bounding both the lift latency and
  // the cost, without touching any verdict.
  // ======================================================================

  /** A pool whose claim INSERTs hang while `wedged()` — counting every
   * attempt, including the wedged ones the base pool never sees. */
  function wedgeablePool(
    table: Map<string, DurableRow>,
    versions: Array<{ id: string; landscape_id: string }>,
    wedged: () => boolean,
    attempts: { inserts: number },
  ): pg.Pool {
    const base = poolOver(table, versions) as unknown as {
      query: (sql: string, params?: unknown[]) => Promise<unknown>
    }
    return {
      query: (sql: string, params: unknown[] = []) => {
        if (/INSERT INTO automerge_document_workspace/.test(sql)) {
          attempts.inserts += 1
          if (wedged()) return new Promise(() => {})
        }
        return base.query(sql, params)
      },
    } as unknown as pg.Pool
  }

  it('a flight evicted at its ceiling schedules ONE background retry whose success announces', async () => {
    const table = new Map<string, DurableRow>()
    const versions = [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]
    let wedgeInserts = true
    const attempts = { inserts: 0 }
    const pool = wedgeablePool(table, versions, () => wedgeInserts, attempts)
    const index = new WorkspaceDocIndex(new Repo({}), pool, {
      verifiedClaimDeadlineMs: 60,
      verifiedClaimRetryBackoffMs: 100,
    })
    const announced: string[] = []
    index.onWorkspaceIndexRepaired = (key) => { announced.push(keyOf(key)) }
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true, {
      displacedScanDeadlineMs: 30,
    })
    const id = await mintedId(V1)

    // The gate faults closed at its own ceiling; ONE insert is in the air.
    expect(await gate('peer', id)).toBe(false)
    expect(attempts.inserts).toBe(1)
    // The gate-fault path already requested a re-evaluation for the route —
    // count those now so the retry's OWN announce is discriminable below.
    const announcedBefore = announced.filter((k) => k === keyOf(V2)).length

    // The pool recovers BEFORE the flight's eviction even fires (the wedged
    // statement stays wedged — only new statements see the recovery), so the
    // sequencing below is deterministic: eviction at ~60 ms schedules the
    // retry, the retry fires at ~160 ms against a live pool.
    wedgeInserts = false

    // No new presentation, no reconnection — the retry alone must claim...
    await vi.waitFor(() => {
      expect(table.get(id)).toEqual({ landscape_id: L, version_id: V2.versionId })
    }, { timeout: 3_000 })
    // ...announce (the deny-pairing half the eviction had dropped)...
    await vi.waitFor(() => {
      expect(announced.filter((k) => k === keyOf(V2)).length).toBeGreaterThan(announcedBefore)
    }, { timeout: 3_000 })
    // ...and be EXACTLY ONE attempt beyond the wedged original.
    expect(attempts.inserts, 'one background retry, never a rush').toBe(2)
    await vi.waitFor(() => {
      expect(index._verifiedClaimRetryPendingCountForTests()).toBe(0)
    }, { timeout: 3_000 })
  })

  it('a legitimately refused claim schedules NO background retry', async () => {
    const table = new Map<string, DurableRow>()
    const versions = [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]
    const attempts = { inserts: 0 }
    const pool = wedgeablePool(table, versions, () => false, attempts)
    const index = new WorkspaceDocIndex(new Repo({}), pool, {
      verifiedClaimDeadlineMs: 60,
      verifiedClaimRetryBackoffMs: 10,
    })
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)
    const id = await mintedId(V1)
    // The document already has its durable owner: the flight RESOLVES false —
    // a first-owner-wins refusal, not an eviction. Its lift is the owning
    // route's reconnection; a retry could decide nothing new.
    table.set(id, { landscape_id: L, version_id: V1.versionId })

    expect(await gate('peer', id)).toBe(false)
    expect(index._verifiedClaimRetryPendingCountForTests(), 'a refusal must schedule nothing').toBe(0)
    const insertsAfterVerdict = attempts.inserts
    // Let any wrongly-scheduled timer (backoff 10 ms) fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(attempts.inserts).toBe(insertsAfterVerdict)
    expect(index._verifiedClaimRetryPendingCountForTests()).toBe(0)
  })

  // The THIRD arm of the discrimination, pinned from the
  // rejection side. The retry pairs with the CEILING eviction only: a raw SQL
  // rejection already has its lift (gateFault's re-evaluation + the
  // denyLedger), so retrying it would couple background SQL attempts to every
  // database blip. Mutant killed: `error instanceof DeadlineExceededError`
  // widened to `instanceof Error` — the rejection below then schedules, and
  // the pending witness reads 1 the moment the claim settles.
  it('a raw SQL rejection schedules NO background retry', async () => {
    const table = new Map<string, DurableRow>()
    const versions = [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]
    const attempts = { inserts: 0 }
    const base = poolOver(table, versions) as unknown as {
      query: (sql: string, params?: unknown[]) => Promise<unknown>
    }
    const pool = {
      query: (sql: string, params: unknown[] = []) => {
        if (/INSERT INTO automerge_document_workspace/.test(sql)) {
          attempts.inserts += 1
          // A rejection, not a hang: the pool answered, and the answer is an
          // error — the shape a failover or a killed backend produces.
          return Promise.reject(new Error('connection terminated unexpectedly'))
        }
        return base.query(sql, params)
      },
    } as unknown as pg.Pool
    const index = new WorkspaceDocIndex(new Repo({}), pool, {
      verifiedClaimDeadlineMs: 60,
      verifiedClaimRetryBackoffMs: 10,
    })
    const id = await mintedId(V1)

    // The raw rejection reaches claimVerifiedDocument's own catch — no gate
    // in front to swallow it into a verdict.
    await expect(index.claimVerifiedDocument(V2, id)).rejects.toThrow('connection terminated unexpectedly')

    // The schedule is synchronous inside that catch, so zero RIGHT NOW is the
    // discriminating assertion, not an eventually.
    expect(index._verifiedClaimRetryPendingCountForTests(), 'a SQL rejection must schedule nothing').toBe(0)
    expect(attempts.inserts).toBe(1)
    // Belt: several backoff windows later, still only the original attempt.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(attempts.inserts, 'no background attempt may follow a SQL rejection').toBe(1)
    expect(index._verifiedClaimRetryPendingCountForTests()).toBe(0)
  })

  // A deliberate VALUE PIN. Every behavioural test above injects its own
  // backoff, so nothing else constrains the default — yet 0 re-queues the
  // retry in the SAME tick, onto the very pool whose wedging the eviction
  // just proved, and anything
  // reconcile-scale (~30 s) forfeits the lift the retry exists to provide.
  it('the production retry backoff is 500 ms — never same-tick, never reconcile-scale', () => {
    expect(VERIFIED_CLAIM_RETRY_BACKOFF_MS).toBe(500)
  })

  it('a permanently dead pool stops after the bounded retries — the denyLedger stays the net', async () => {
    const table = new Map<string, DurableRow>()
    const versions = [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ]
    const attempts = { inserts: 0 }
    const pool = wedgeablePool(table, versions, () => true, attempts)
    const index = new WorkspaceDocIndex(new Repo({}), pool, {
      verifiedClaimDeadlineMs: 40,
      verifiedClaimRetryBackoffMs: 20,
    })
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true, {
      displacedScanDeadlineMs: 25,
    })
    const id = await mintedId(V1)

    expect(await gate('peer', id)).toBe(false)
    expect(attempts.inserts).toBe(1)

    // The single retry runs (attempt 2), its own flight evicts at ITS ceiling,
    // and the re-schedule is suppressed by the still-pending guard entry —
    // second failure, abandoned.
    await vi.waitFor(() => { expect(attempts.inserts).toBe(2) }, { timeout: 3_000 })
    await vi.waitFor(() => {
      expect(index._verifiedClaimRetryPendingCountForTests()).toBe(0)
    }, { timeout: 3_000 })

    // Several deadline+backoff windows later: still no third attempt. The
    // mutant that re-schedules from the retry's own eviction loops here.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(attempts.inserts, 'no third attempt without a new presentation').toBe(2)
  })

  // Belt for the deny-side consultation: a second presentation of a refused id
  // must not re-run SQL — the byDoc cache answers — and must stay refused.
  it('a refused displaced id stays refused from cache on re-presentation', async () => {
    const table = new Map<string, DurableRow>()
    const counters = { inserts: [] as string[] }
    const index = new WorkspaceDocIndex(new Repo({}), poolOver(table, [
      { id: V1.versionId, landscape_id: L },
      { id: V2.versionId, landscape_id: L },
    ], counters))
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => V2 }, true)
    const id = await mintedId(V1)
    table.set(id, { landscape_id: L, version_id: V1.versionId })

    expect(await gate('peer', id)).toBe(false)
    const insertsAfterFirst = counters.inserts.length
    expect(await gate('peer', id)).toBe(false)
    expect(counters.inserts.length, 'the second presentation must be answered from byDoc').toBe(insertsAfterFirst)
  })
})
