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

import { Repo } from '@automerge/automerge-repo'
import * as Automerge from '@automerge/automerge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFreshStaticOverlayHead,
  appendUniqueOverlayRoute,
  mergeStaticOverlaySegments,
  StaticDeltaProjector,
  updateStaticOverlaySegment,
} from './staticDeltaProjector.js'
import { isAppendOnlyOverlayOrder } from './overlayHistoryProtocol.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import {
  isWorkspaceCoveredLocally,
  noteCoveredLocally,
  _resetWorkspaceClaimCoverageForTests,
} from '../rbac/claimCoverage.js'

const running: StaticDeltaProjector[] = []

/** The PLANE check — `isStaticReadModelWorkspace`, asked on the pool before the
 * generation bump and again inside the transaction under the projection mutex.
 *
 * Every fixture in this file is a static workspace by premise, so a fake that
 * let this fall through to its empty default would be modelling a DEMOTED
 * workspace and the projection would correctly refuse. Shared by all fakes.
 */
// A statement about the AUTHORITY ALONE. The exclusion is part of the predicate
// on purpose: the descriptor SELECT joins the same table, so a match on the
// bare table name would also count that statement — as a plane check in the
// assertions here, and as the yes/no ANSWER in the harness fake below, which
// would return `{ present }` to a caller expecting document rows.
//
// Do NOT narrow to `SELECT EXISTS`: the plane is asked in two forms —
// `isStaticReadModelWorkspace`'s `SELECT EXISTS … AS present` and
// `assertReadModelPlane`'s `SELECT … FOR KEY SHARE` — and a fake that answers
// only the first leaves the second reading zero rows, i.e. reporting a lost
// plane.
/**
 * A fake that is a POOL, which is what production passes.
 *
 * `this.db` is a `pg.Pool`, and paths that need a transaction borrow a client
 * from it; a `{ query }`-only fake fails with `this.db.connect is not a
 * function` — a fixture failure that reads as a production one. The borrowed
 * client shares the same `query` spy, so statement assertions are unaffected.
 */
const poolLike = (query: unknown) => ({
  query,
  connect: async () => ({ query, release: () => undefined }),
})

const isPlaneCheck = (sql: string) =>
  String(sql).includes('read_model_static_workspaces')
  && !String(sql).includes('read_model_static_documents')
/** PARAMS-SENSITIVE. A fake that answers `present: true` for ANY parameters
 * cannot distinguish a correctly-threaded workspace key from a mis-threaded
 * one. The fixtures here are `land/version` (and `land/draft`); anything else
 * is, correctly, not a static workspace. */
const STATIC_FIXTURE_WORKSPACES = new Set(['land/version', 'land/draft'])
const planeAnswer = (params?: unknown[]) => {
  const asked = (params ?? []) as string[]
  // A SET rather than one pair: this file's fixtures include a sparse-draft
  // workspace (`land/draft`) as well as the ordinary one, and both are static
  // by premise. Anything else — notably a mis-threaded key such as `{x, y}`
  // — is correctly not a static workspace, which is the whole point of
  // answering from the parameters instead of returning a constant.
  return { rows: [{ present: STATIC_FIXTURE_WORKSPACES.has(`${asked[0]}/${asked[1]}`) }], rowCount: 1 }
}

/**
 * The overlay-rotation advisory lock (`pg_try_advisory_lock`) RETURNS a
 * verdict, so every fake that drives a rotation or a fold has to answer it: a
 * row-less fall-through reads as `refused`.
 *
 * PARAMS-SENSITIVE for the same reason as `planeAnswer`: the key text is the
 * WIRE FORMAT OF AN EXCLUSION, so a fake that answers `locked: true` to any
 * argument cannot tell a correctly-minted key from one built out of the wrong
 * workspace or the wrong collection.
 */
const isOverlayRotationLock = (sql: string) => String(sql).includes('pg_try_advisory_lock')
  || String(sql).includes('pg_advisory_unlock')
const overlayRotationLockAnswer = (sql: string, params?: unknown[]) => {
  // THE UNLOCK IS ANSWERED TOO. Left to fall through to the row-less default,
  // `releaseOverlayRotationLock` would read "this session did not hold the
  // key", report broken bookkeeping on every HEALTHY release and destroy the
  // connection for it — the fixture manufacturing the fault the code exists to
  // report.
  if (String(sql).includes('pg_advisory_unlock')) return { rows: [{ released: true }], rowCount: 1 }
  const parsed = /^overlay-rotation:([^:]+):([^:]+):(object|connection)$/
    .exec(String((params ?? [])[0] ?? ''))
  return {
    rows: [{ locked: parsed !== null && STATIC_FIXTURE_WORKSPACES.has(`${parsed[1]}/${parsed[2]}`) }],
    rowCount: 1,
  }
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((projector) => projector.stop()))
  vi.useRealTimers()
})

describe('StaticDeltaProjector', () => {
  it('activates an empty appended head without rebuilding retained history', () => {
    const historicalIds = Array.from({ length: 1_000 }, (_, index) => `historical-${index}`)
    const segments = new Map(historicalIds.map((documentId, index) => [
      documentId,
      { [`object-${index}`]: { id: `object-${index}` } },
    ]))
    const retainedFirstSegment = segments.get(historicalIds[0])

    expect(appendFreshStaticOverlayHead(
      historicalIds,
      [...historicalIds, 'fresh-head'],
      segments,
      'fresh-head',
    )).toBe(true)
    expect(segments.size).toBe(1_001)
    expect(segments.get(historicalIds[0])).toBe(retainedFirstSegment)
    expect(segments.get('fresh-head')).toEqual({})
  })

  it('refuses the fast head activation path when retained history is incomplete', () => {
    const segments = new Map<string, Record<string, { id: string }>>([
      ['historical-a', { object: { id: 'object' } }],
    ])

    expect(appendFreshStaticOverlayHead(
      ['historical-a', 'historical-missing'],
      ['historical-a', 'historical-missing', 'fresh-head'],
      segments,
      'fresh-head',
    )).toBe(false)
    expect(segments.has('fresh-head')).toBe(false)
  })
  it('coalesces a burst of overlay heads and projects only the latest snapshot', async () => {
    vi.useFakeTimers()
    const repo = new Repo({})
    const handle = repo.create({ objects: {}, sequence: 0 })
    await handle.whenReady()
    const projector = new StaticDeltaProjector(repo, poolLike(vi.fn()) as never)
    running.push(projector)
    const descriptor = {
      landscapeId: 'land', versionId: 'version', documentId: handle.documentId,
      kind: 'object-overlay', entityId: null, orgId: 'org',
    }
    const internal = projector as unknown as {
      trigger(value: typeof descriptor, valueHandle: typeof handle): void
      project(value: typeof descriptor, valueHandle: typeof handle): Promise<void>
    }
    const projectedSequences: number[] = []
    vi.spyOn(internal, 'project').mockImplementation(async (_descriptor, valueHandle) => {
      projectedSequences.push(valueHandle.doc()!.sequence)
    })

    for (let sequence = 1; sequence <= 20; sequence += 1) {
      handle.change((doc) => { doc.sequence = sequence })
      internal.trigger(descriptor, handle)
      await vi.advanceTimersByTimeAsync(25)
    }
    expect(projectedSequences).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(projectedSequences).toEqual([20])
  })

  it('does not project intermediate heads during a sustained enterprise burst', async () => {
    vi.useFakeTimers()
    const repo = new Repo({})
    const handle = repo.create({ objects: {}, sequence: 0 })
    await handle.whenReady()
    const projector = new StaticDeltaProjector(repo, poolLike(vi.fn()) as never)
    running.push(projector)
    const descriptor = {
      landscapeId: 'land', versionId: 'version', documentId: handle.documentId,
      kind: 'object-overlay', entityId: null, orgId: 'org',
    }
    const internal = projector as unknown as {
      trigger(value: typeof descriptor, valueHandle: typeof handle): void
      project(value: typeof descriptor, valueHandle: typeof handle): Promise<void>
    }
    const projectedSequences: number[] = []
    vi.spyOn(internal, 'project').mockImplementation(async (_descriptor, valueHandle) => {
      projectedSequences.push(valueHandle.doc()!.sequence)
    })

    for (let sequence = 1; sequence <= 20; sequence += 1) {
      handle.change((doc) => { doc.sequence = sequence })
      internal.trigger(descriptor, handle)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(projectedSequences).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(projectedSequences).toEqual([20])
  })

  it('appends an overlay route without recreating the existing Automerge list', () => {
    const existing = Array.from({ length: 200 }, (_, index) => `automerge:segment-${index}`)
    const before = Automerge.from({ editsObjectShardUrls: existing })
    const beforeOps = Automerge.stats(before).numOps
    const after = Automerge.change(before, (meta) => {
      appendUniqueOverlayRoute(meta, 'editsObjectShardUrls', 'automerge:segment-200')
    })

    expect(after.editsObjectShardUrls).toHaveLength(201)
    // One list insert plus its scalar value stays constant as the retained
    // history grows. A whole-array assignment adds hundreds of operations.
    expect(Automerge.stats(after).numOps - beforeOps).toBeLessThan(64)
  })

  it('reconstructs an already-projected ModelMeta without rewriting enterprise metadata', async () => {
    const repo = new Repo({})
    const historical = repo.create({ objects: { o1: { id: 'o1', name: 'Historical' } } })
    const current = repo.create({ objects: {} })
    await Promise.all([historical.whenReady(), current.whenReady()])
    const meta = {
      editsObjectShardUrls: [historical.url, current.url],
      editsObjectShardUrl: current.url,
      editsConnectionShardUrls: [],
      groups: { g1: { id: 'g1', name: 'Platform' } },
      decisionRecords: { adr1: { id: 'adr1', title: 'Use events' } },
    }
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT document_id, last_projected_snapshot')) {
        return {
          rows: [
            { document_id: historical.documentId, last_projected_snapshot: historical.doc()!.objects },
            { document_id: current.documentId, last_projected_snapshot: {} },
          ],
          rowCount: 2,
        }
      }
      if (sql.includes('projected_revision >= $4')) {
        return { rows: [{ projected: true }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const projector = new StaticDeltaProjector(repo, poolLike(query) as never)
    running.push(projector)
    const descriptor = (documentId: string) => ({
      landscapeId: 'land', versionId: 'version', documentId,
      kind: 'object-overlay', entityId: null, orgId: 'org',
    })
    const internal = projector as unknown as {
      descriptors: Map<string, ReturnType<typeof descriptor>>
      projectMeta(
        value: ReturnType<typeof descriptor>,
        metaValue: typeof meta,
        revision: number,
      ): Promise<void>
    }
    internal.descriptors.set(historical.documentId, descriptor(historical.documentId))
    internal.descriptors.set(current.documentId, descriptor(current.documentId))

    await internal.projectMeta({ ...descriptor('meta'), kind: 'model-meta' }, meta, 7)

    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM ro_groups'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('RETURNING observed_generation'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO read_model_static_documents'))).toBe(false)
  })

  it('keeps the newest segment authoritative when an older segment changes later', () => {
    const oldest = { shared: { id: 'shared', name: 'oldest changed again' } }
    const middle = { shared: { id: 'shared', name: 'middle' } }
    const newest = { shared: { id: 'shared', name: 'newest' } }
    expect(mergeStaticOverlaySegments([oldest, middle, newest])).toEqual([
      { id: 'shared', name: 'newest' },
    ])
    expect(mergeStaticOverlaySegments([oldest, middle, newest], new Set(['shared']))).toEqual([])
  })

  it('projects only changed effective ids after the initial overlay snapshot', () => {
    const segments = new Map<string, Record<string, { id: string; name: string }>>()
    const effective = new Map<string, { fingerprint: string; value: { id: string; name: string } }>()
    expect(updateStaticOverlaySegment(
      ['old', 'new'], segments, effective, 'old',
      { shared: { id: 'shared', name: 'old' }, stable: { id: 'stable', name: 'stable' } },
      new Set(),
    ).ready).toBe(false)
    const initial = updateStaticOverlaySegment(
      ['old', 'new'], segments, effective, 'new',
      { shared: { id: 'shared', name: 'new' } }, new Set(),
    )
    expect(initial.upserts.map((item) => item.id).sort()).toEqual(['shared', 'stable'])

    const shadowed = updateStaticOverlaySegment(
      ['old', 'new'], segments, effective, 'old',
      { shared: { id: 'shared', name: 'old changed' }, stable: segments.get('old')!.stable },
      new Set(),
    )
    expect(shadowed).toMatchObject({ ready: true, upserts: [], deleteIds: [] })
  })

  it('retains projector state when a new current head is appended', () => {
    expect(isAppendOnlyOverlayOrder(['old', 'current'], ['old', 'current', 'next'])).toBe(true)
    expect(isAppendOnlyOverlayOrder(['old', 'current'], ['old', 'next'])).toBe(false)
  })

  it('does not convert an emptied retired auto-layout segment into model tombstones', async () => {
    const repo = new Repo({})
    const routedConnections = Object.fromEntries(Array.from({ length: 89 }, (_, index) => {
      const id = `perf-c-${String(index).padStart(6, '0')}`
      return [id, {
        id,
        fromId: `perf-o-${String(index).padStart(6, '0')}`,
        toId: `perf-o-${String(index + 1).padStart(6, '0')}`,
        type: 'solid',
        waypoints: [{ x: index * 10, y: index * 5 }],
      }]
    }))
    type RoutedConnection = (typeof routedConnections)[string]
    const retired = repo.create({
      connections: routedConnections,
      writeHeadVersion: 2,
      writeBatchIds: ['auto-layout-89'],
    })
    const current = repo.create({
      connections: {},
      writeHeadVersion: 2,
      writeBatchIds: [] as string[],
      forwardedBatchIds: [] as string[],
    })
    const meta = repo.create({
      staticBaseline: true,
      editsConnectionShardUrls: [retired.url, current.url],
      editsConnectionShardUrl: current.url,
      deletedConnectionIds: [] as string[],
    })
    await Promise.all([retired.whenReady(), current.whenReady(), meta.whenReady()])

    const query = vi.fn(async (sql: string, planeParams?: unknown[]) => {
      // The PLANE check — rotation, fold and historical forwarding consult
      // it at their ENTRY, so a fake that lets it fall through models a DEMOTED
      // workspace and the whole path is (correctly) refused.
      if (isOverlayRotationLock(sql)) return overlayRotationLockAnswer(sql, planeParams)
      if (isPlaneCheck(sql)) return planeAnswer(planeParams)
      if (sql.includes('SELECT last_projected_snapshot FROM read_model_overlay_segments')) {
        return { rows: [{ last_projected_snapshot: routedConnections }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const projector = new StaticDeltaProjector(repo, poolLike(query) as never)
    const retiredDescriptor = {
      landscapeId: 'land', versionId: 'draft', documentId: retired.documentId,
      kind: 'connection-overlay', entityId: null, orgId: 'org',
    }
    const metaDescriptor = {
      ...retiredDescriptor,
      documentId: meta.documentId,
      kind: 'model-meta',
    }
    const effectiveConnections = new Map(Object.entries(routedConnections).map(([id, value]) => [
      id,
      { fingerprint: JSON.stringify(value), value },
    ]))
    const internals = projector as unknown as {
      descriptors: Map<string, typeof retiredDescriptor>
      forwardHistoricalOverlay(
        descriptor: typeof retiredDescriptor,
        kind: 'connection',
        snapshot: { connections: Record<string, RoutedConnection>; writeBatchIds: string[] },
        sourceRevision: number,
        orderedIds: string[],
        currentDocumentId: string,
        state: {
          objectDocumentIds: string[]
          connectionDocumentIds: string[]
          deletedObjectIds: Set<string>
          deletedConnectionIds: Set<string>
          objectSegments: Map<string, Record<string, never>>
          connectionSegments: Map<string, Record<string, RoutedConnection>>
          effectiveObjects: Map<string, never>
          effectiveConnections: typeof effectiveConnections
        },
        conflicts: Map<string, Record<string, unknown[]>>,
      ): Promise<void>
    }
    internals.descriptors.set(meta.documentId, metaDescriptor)

    // This is the production failure shape: the segment was projected with all
    // 89 auto-layout connection patches, rotated, then a degenerate/stale peer
    // published that retired document as empty. Model deletion is represented
    // exclusively by ModelMeta tombstones, not by absence from an old segment.
    await internals.forwardHistoricalOverlay(
      retiredDescriptor,
      'connection',
      { connections: {}, writeBatchIds: ['auto-layout-89'] },
      2,
      [retired.documentId, current.documentId],
      current.documentId,
      {
        objectDocumentIds: [],
        connectionDocumentIds: [retired.documentId, current.documentId],
        deletedObjectIds: new Set(),
        deletedConnectionIds: new Set(),
        objectSegments: new Map(),
        connectionSegments: new Map([
          [retired.documentId, routedConnections],
          [current.documentId, {}],
        ]),
        effectiveObjects: new Map(),
        effectiveConnections,
      },
      new Map(),
    )

    expect(meta.doc()?.deletedConnectionIds).toEqual([])
    expect(Object.keys(current.doc()?.connections ?? {})).toHaveLength(0)
    expect(current.doc()?.writeBatchIds).toEqual([])
    expect(current.doc()?.forwardedBatchIds).toEqual(['auto-layout-89'])

    // The SAME call on a DEMOTED workspace must not reach any of that. This
    // path ends `currentHandle.change` → `metaHandle.change` → `repo.flush` and
    // only THEN calls `acknowledgeOnly`, where the SQL gate lives — so the plane
    // gate must sit at the entry, or the CRDT write would land and flush for a
    // workspace whose `read_model_static_workspaces` row is gone.
    //
    // The arm above is the liveness witness: identical arguments, identical
    // fixture, and it demonstrably wrote. The only difference here is the
    // answer to one primary-key lookup.
    const refusing = vi.fn(async () => ({ rows: [{ present: false }], rowCount: 1 }))
    const demoted = new StaticDeltaProjector(repo, poolLike(refusing) as never)
    running.push(demoted)
    const demotedInternals = demoted as unknown as typeof internals
    demotedInternals.descriptors.set(meta.documentId, metaDescriptor)
    const forwardedBefore = [...(current.doc()?.forwardedBatchIds ?? [])]

    await demotedInternals.forwardHistoricalOverlay(
      retiredDescriptor, 'connection',
      { connections: {}, writeBatchIds: ['auto-layout-90'] },
      3, [retired.documentId, current.documentId], current.documentId,
      {
        objectDocumentIds: [],
        connectionDocumentIds: [retired.documentId, current.documentId],
        deletedObjectIds: new Set(),
        deletedConnectionIds: new Set(),
        objectSegments: new Map(),
        connectionSegments: new Map([[retired.documentId, routedConnections], [current.documentId, {}]]),
        effectiveObjects: new Map(),
        effectiveConnections,
      },
      new Map(),
    )

    // Exactly ONE statement — the plane check itself — and no CRDT change. An
    // assertion on the statement COUNT rather than on any single absent write:
    // this path has several irreversible acts and a per-write assertion would
    // have to enumerate them all correctly to be worth anything.
    expect(refusing).toHaveBeenCalledTimes(1)
    expect(String(refusing.mock.calls[0]?.[0])).toContain('read_model_static_workspaces')
    expect(current.doc()?.forwardedBatchIds).toEqual(forwardedBefore)
  })

  it('does not attribute tombstoned conflicts from an earlier run to a later forwarded batch', async () => {
    const repo = new Repo({})
    const retired = repo.create({
      objects: {
        deleted: { id: 'deleted', name: 'Prior run', hot: 'selected-conflict' },
        fresh: { id: 'fresh', name: 'Later run' },
      },
      writeHeadVersion: 2,
      writeBatchIds: ['later-seed'],
    })
    const current = repo.create({
      objects: {},
      writeHeadVersion: 2,
      writeBatchIds: [] as string[],
      forwardedBatchIds: [] as string[],
    })
    const meta = repo.create({
      staticBaseline: true,
      editsObjectShardUrls: [retired.url, current.url],
      editsObjectShardUrl: current.url,
      deletedObjectIds: ['deleted'],
    })
    await Promise.all([retired.whenReady(), current.whenReady(), meta.whenReady()])

    const base = {
      deleted: { id: 'deleted', name: 'Prior run', hot: 'base' },
    }
    const query = vi.fn(async (sql: string, planeParams?: unknown[]) => {
      if (isOverlayRotationLock(sql)) return overlayRotationLockAnswer(sql, planeParams)
      if (isPlaneCheck(sql)) return planeAnswer(planeParams)
      if (sql.includes('SELECT last_projected_snapshot FROM read_model_overlay_segments')) {
        return { rows: [{ last_projected_snapshot: base }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const projector = new StaticDeltaProjector(repo, poolLike(query) as never)
    const retiredDescriptor = {
      landscapeId: 'land', versionId: 'version', documentId: retired.documentId,
      kind: 'object-overlay', entityId: null, orgId: 'org',
    }
    const metaDescriptor = {
      ...retiredDescriptor,
      documentId: meta.documentId,
      kind: 'model-meta',
    }
    const internals = projector as unknown as {
      descriptors: Map<string, typeof retiredDescriptor>
      forwardHistoricalOverlay(
        descriptor: typeof retiredDescriptor,
        kind: 'object',
        snapshot: {
          objects: Record<string, { id: string; name: string; hot?: string }>
          writeBatchIds: string[]
        },
        sourceRevision: number,
        orderedIds: string[],
        currentDocumentId: string,
        state: {
          objectDocumentIds: string[]
          connectionDocumentIds: string[]
          deletedObjectIds: Set<string>
          deletedConnectionIds: Set<string>
          objectSegments: Map<string, Record<string, { id: string; name: string; hot?: string }>>
          connectionSegments: Map<string, Record<string, never>>
          effectiveObjects: Map<string, never>
          effectiveConnections: Map<string, never>
        },
        conflicts: Map<string, Record<string, unknown[]>>,
      ): Promise<void>
    }
    internals.descriptors.set(meta.documentId, metaDescriptor)

    await internals.forwardHistoricalOverlay(
      retiredDescriptor,
      'object',
      retired.doc()!,
      42,
      [retired.documentId, current.documentId],
      current.documentId,
      {
        objectDocumentIds: [retired.documentId, current.documentId],
        connectionDocumentIds: [],
        deletedObjectIds: new Set(['deleted']),
        deletedConnectionIds: new Set(),
        objectSegments: new Map([
          [retired.documentId, base],
          [current.documentId, {}],
        ]),
        connectionSegments: new Map(),
        effectiveObjects: new Map(),
        effectiveConnections: new Map(),
      },
      new Map([['deleted', { hot: ['other-writer'] }]]),
    )

    expect(current.doc()?.objects).toEqual({ fresh: { id: 'fresh', name: 'Later run' } })
    expect(current.doc()?.forwardedBatchIds).toEqual(['later-seed'])
    expect(meta.doc()?.deletedObjectIds).toEqual(['deleted'])
    expect(query.mock.calls.some(([sql]) => String(sql).includes(
      'INSERT INTO read_model_overlay_conflicts',
    ))).toBe(false)
    const acknowledgement = query.mock.calls.find(([sql]) => String(sql).includes(
      'INSERT INTO read_model_overlay_batch_acks',
    ))
    expect(acknowledgement?.[1]?.[4]).toBe('forwarding')
  })

  it('projects only a resident allowed overlay and advances one transactional generation', async () => {
    const repo = new Repo({})
    const handle = repo.create({
      objects: {
        o1: { id: 'o1', type: 'component', name: 'Changed in overlay' },
      },
    })
    await handle.whenReady()
    const query = vi.fn(async (sql: string, planeParams?: unknown[]) => {
      if (isOverlayRotationLock(sql)) return overlayRotationLockAnswer(sql, planeParams)
      if (isPlaneCheck(sql)) return planeAnswer(planeParams)
      if (sql.includes('LEFT JOIN read_model_static_documents document')) {
        return {
          rows: [{
            landscape_id: 'land', version_id: 'version', document_id: handle.documentId,
            kind: 'object-overlay', entity_id: null, org_id: 'org',
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('RETURNING observed_generation')) {
        return { rows: [{ observed_generation: 2 }], rowCount: 1 }
      }
      if (sql.includes('WHERE queue.revision > queue.projected_revision')) {
        return { rows: [{ document_id: handle.documentId }], rowCount: 1 }
      }
      if (sql.includes('SELECT revision FROM read_model_static_document_queue')) {
        return { rows: [{ revision: 7 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const residency = new AutomergeResidencyLeases(repo)
    const flush = vi.spyOn(repo, 'flush')
    const projector = new StaticDeltaProjector(
      repo, poolLike(query) as never, 10, 60_000, () => true, undefined, residency,
    )
    running.push(projector)
    await projector.start()

    await expect.poll(() => query.mock.calls.some(([sql]) =>
      String(sql).includes('read_model_static_entity_deltas'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO ro_objects'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('read_model_change_events'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('projected_generation = GREATEST'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('projected_revision = GREATEST'))).toBe(true)
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('RETURNING observed_generation'))).toHaveLength(1)
    expect(flush).toHaveBeenCalledWith([handle.documentId])
    expect(projector.listenedCount()).toBe(1)
    await expect(residency.evict(handle.documentId)).resolves.toBe(true)
    expect(projector.listenedCount()).toBe(0)
  })

  it('cancels an in-flight projection immediately after ownership is lost during flush', async () => {
    const repo = new Repo({})
    const handle = repo.create({
      objects: { o1: { id: 'o1', type: 'component', name: 'Cancelled' } },
    })
    await handle.whenReady()
    let owns = true
    // Answers the PLANE check truthfully — this fixture is a static workspace —
    // and nothing else. `project()` asks it before the flush, so a fake that
    // let it fall through would make the projector refuse at the gate and never
    // reach the cancellation this test is about.
    const query = vi.fn(async (sql: string, planeParams?: unknown[]) => (
      isPlaneCheck(sql) ? planeAnswer(planeParams) : { rows: [], rowCount: 0 }
    ))
    vi.spyOn(repo, 'flush').mockImplementation(async () => { owns = false })
    const projector = new StaticDeltaProjector(
      repo, poolLike(query) as never, 60_000, 60_000, () => owns,
    )
    running.push(projector)
    const descriptor = {
      landscapeId: 'land', versionId: 'version', documentId: handle.documentId,
      kind: 'object-overlay', entityId: null, orgId: 'org',
    }

    await (projector as unknown as {
      project(value: typeof descriptor, valueHandle: typeof handle): Promise<void>
    }).project(descriptor, handle)

    expect(repo.flush).toHaveBeenCalledWith([handle.documentId])
    // The plane check and NOTHING else: an in-flight projection cancelled by a
    // lost lease publishes nothing. The plane gate asks one question ahead of
    // the flush, so the assertion names that one legitimate statement.
    expect(query).toHaveBeenCalledTimes(1)
    expect(isPlaneCheck(String(query.mock.calls[0]?.[0]))).toBe(true)
  })

  it('A8 — un espace DÉMOTÉ est arrêté au RÉPARTITEUR, avant tout écrit de document', async () => {
    // Why the gate belongs at `project()` rather than on N individual paths:
    // gating only the TIMER-driven paths would leave the CHANGE-driven ones
    // open, and two of those write the user's documents —
    // `pruneForwardedBatchIds` does `handle.change` + `repo.flush` from four
    // call sites in `projectEffectiveOverlay`, and
    // `healCurrentOverlayConflicts` reaches the plane through `transactionOnly`,
    // which SWALLOWS the refusal and returns normally, so its `handle.change`
    // would run regardless.
    //
    // Asserted at the dispatcher rather than on either path: one gate is what
    // makes BOTH unreachable, and pinning it here cannot be satisfied by
    // re-adding a per-path guard while the dispatcher stays open.
    const repo = new Repo({})
    const handle = repo.create({
      objects: { o1: { id: 'o1', type: 'component', name: 'X' } },
      writeHeadVersion: 2,
      forwardedBatchIds: ['stale-batch'],
    })
    await handle.whenReady()
    const descriptor = {
      landscapeId: 'land', versionId: 'version', documentId: handle.documentId,
      kind: 'object-overlay', entityId: null, orgId: 'org',
    }

    const run = async (isStatic: boolean) => {
      const query = vi.fn(async (sql: string) => (
        isPlaneCheck(sql)
          ? { rows: [{ present: isStatic }], rowCount: 1 }
          : { rows: [], rowCount: 1 }
      ))
      const flushed: string[] = []
      const projector = new StaticDeltaProjector(repo, poolLike(query) as never, 60_000, 60_000)
      running.push(projector)
      const flush = vi.spyOn(repo, 'flush').mockImplementation(async (ids) => {
        flushed.push(...((ids ?? []) as string[]))
      })
      let threw: unknown = null
      try {
        await (projector as unknown as {
          project(value: typeof descriptor, valueHandle: typeof handle): Promise<void>
        }).project(descriptor, handle)
      } catch (error) {
        // The LIVENESS arm is allowed to fail further downstream: this fixture
        // answers the plane and nothing else, so a projection that gets past
        // the gate runs into the first query the fake does not model. That is
        // fine and it is the point — what is being tested is where it STOPS,
        // and the two arms stop in different places. Captured rather than
        // swallowed, and asserted on below so a demoted arm that threw for some
        // unrelated reason cannot masquerade as a clean refusal.
        threw = error
      } finally {
        flush.mockRestore()
      }
      return { query, flushed, threw }
    }

    // LIVENESS: on a static workspace the dispatcher gets past the gate and
    // flushes the source document — the first thing it does, and the proof that
    // this driver reaches the code it is named after.
    const live = await run(true)
    expect(live.flushed).toContain(handle.documentId)
    expect(live.threw).not.toBeNull()

    // …and on a demoted one it stops AT the gate: one statement, no flush, so
    // nothing downstream of it can run at all.
    const demoted = await run(false)
    // A CLEAN refusal: returned, did not throw. A demoted arm that threw would
    // satisfy every assertion below while meaning something quite different.
    expect(demoted.threw).toBeNull()
    expect(demoted.flushed).toEqual([])
    expect(demoted.query).toHaveBeenCalledTimes(1)
    expect(isPlaneCheck(String(demoted.query.mock.calls[0]?.[0]))).toBe(true)
    // The document is untouched. `writeHeadVersion` is asserted so the negative
    // cannot pass on a document that was never a valid fixture in the first
    // place — an `undefined` field compares equal to an absent one.
    expect(handle.doc()?.writeHeadVersion).toBe(2)
    expect(handle.doc()?.forwardedBatchIds).toEqual(['stale-batch'])
  })

  it('does not replay caught-up historical overlays merely because they remain resident', async () => {
    const repo = new Repo({})
    const historical = repo.create({ objects: { old: { id: 'old', name: 'Historical' } } })
    const current = repo.create({ objects: { live: { id: 'live', name: 'Current' } } })
    await Promise.all([historical.whenReady(), current.whenReady()])
    const projector = new StaticDeltaProjector(repo, poolLike(vi.fn()) as never)
    const descriptor = (documentId: string) => ({
      landscapeId: 'land', versionId: 'version', documentId,
      kind: 'object-overlay', entityId: null, orgId: 'org',
    })
    const internal = projector as unknown as {
      descriptors: Map<string, ReturnType<typeof descriptor>>
      attachedWorkspaces: Map<string, ReturnType<typeof descriptor>>
      scanResidentHandles(): void
      trigger: ReturnType<typeof vi.fn>
    }
    internal.descriptors.set(historical.documentId, descriptor(historical.documentId))
    internal.descriptors.set(current.documentId, descriptor(current.documentId))
    // The workspace must be ATTACHED, not merely have descriptors.
    // `attach()` refuses otherwise, which is the fixed point that stops an
    // in-flight pass from resurrecting what `release()` removed. Setting
    // descriptors without it is a shortcut production never takes: every
    // producer of a descriptor (`reloadDescriptors`, `projectMeta`,
    // `projectRoot`, `activatePublishedOverlayHead`) runs for a workspace the
    // reload tick has already attached. The separator is `keyOf`'s, kept out of
    // this file by building the key the same way the class does.
    internal.attachedWorkspaces.set(
      `land${String.fromCharCode(0)}version`, descriptor(current.documentId),
    )
    const trigger = vi.spyOn(internal, 'trigger')

    internal.scanResidentHandles()

    expect(projector.listenedCount()).toBe(2)
    expect(trigger).not.toHaveBeenCalled()
  })

  it('retries a durable pending revision when the resident handle emitted no new change', async () => {
    const repo = new Repo({})
    const handle = repo.create({ objects: {}, writeHeadVersion: 2, writeBatchIds: [] as string[] })
    await handle.whenReady()
    let pendingScans = 0
    const query = vi.fn(async (sql: string, planeParams?: unknown[]) => {
      if (isOverlayRotationLock(sql)) return overlayRotationLockAnswer(sql, planeParams)
      if (isPlaneCheck(sql)) return planeAnswer(planeParams)
      if (sql.includes('LEFT JOIN read_model_static_documents document')) {
        return {
          rows: [{
            landscape_id: 'land', version_id: 'version', document_id: handle.documentId,
            kind: 'object-overlay', entity_id: null, org_id: 'org',
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('WHERE queue.revision > queue.projected_revision')) {
        pendingScans += 1
        return { rows: [{ document_id: handle.documentId }], rowCount: 1 }
      }
      if (sql.includes('SELECT revision FROM read_model_static_document_queue')) {
        return { rows: [{ revision: 9 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const projector = new StaticDeltaProjector(
      repo, poolLike(query) as never, 60_000, 10, () => true,
    )
    running.push(projector)
    await projector.start()

    await expect.poll(() => pendingScans).toBeGreaterThanOrEqual(2)
    await expect.poll(() => query.mock.calls.filter(([sql]) =>
      String(sql).includes('projected_revision = GREATEST')).length).toBeGreaterThanOrEqual(2)
  })

  it('retries admitted rotations after a delayed ownership acquisition', async () => {
    const repo = new Repo({})
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    const projector = new StaticDeltaProjector(
      repo, poolLike(query) as never, 60_000, 10, () => true,
    )
    const recovery = vi.spyOn(
      projector as unknown as { recoverAdmittedOverlayRotations(): Promise<void> },
      'recoverAdmittedOverlayRotations',
    ).mockResolvedValue(undefined)
    const rotationObligations = vi.spyOn(
      projector as unknown as { recoverCurrentOverlayRotationObligations(): Promise<void> },
      'recoverCurrentOverlayRotationObligations',
    ).mockResolvedValue(undefined)
    running.push(projector)

    await projector.start()
    expect(recovery).toHaveBeenCalledTimes(1)
    expect(rotationObligations).toHaveBeenCalledTimes(1)
    await expect.poll(() => recovery.mock.calls.length).toBeGreaterThanOrEqual(2)
    await expect.poll(() => rotationObligations.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('reconstructs an overfull current-head rotation obligation without a new change event', async () => {
    const repo = new Repo({})
    const current = repo.create({
      objects: {},
      writeHeadVersion: 2,
      writeBatchIds: Array.from({ length: 32 }, (_, index) => `durable-batch-${index}`),
    })
    await current.whenReady()
    const descriptor = {
      landscapeId: 'land', versionId: 'version', documentId: current.documentId,
      kind: 'object-overlay', entityId: null, orgId: 'org',
    }
    const projector = new StaticDeltaProjector(repo, poolLike(vi.fn()) as never)
    running.push(projector)
    const internal = projector as unknown as {
      descriptors: Map<string, typeof descriptor>
      listened: Map<string, { handle: typeof current; stop: () => void }>
      currentOverlayDocumentIds: Map<string, { object?: string }>
      scheduleOverlayRotation(descriptor: typeof descriptor, kind: 'object' | 'connection'): void
      recoverCurrentOverlayRotationObligations(): Promise<void>
    }
    internal.descriptors.set(current.documentId, descriptor)
    internal.listened.set(current.documentId, { handle: current, stop: () => undefined })
    internal.currentOverlayDocumentIds.set('land\u0000version', { object: current.documentId })
    const schedule = vi.spyOn(internal, 'scheduleOverlayRotation').mockImplementation(() => undefined)

    await internal.recoverCurrentOverlayRotationObligations()

    expect(schedule).toHaveBeenCalledOnce()
    expect(schedule).toHaveBeenCalledWith(descriptor, 'object')
  })

  it('closes admitted rotations that belong to terminal Drafts before recovery', async () => {
    const repo = new Repo({})
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const projector = new StaticDeltaProjector(
      repo, poolLike(query) as never, 60_000, 60_000, () => true,
    )
    running.push(projector)

    await projector.start()

    expect(query.mock.calls.some(([sql]) => {
      const statement = String(sql)
      return statement.includes('UPDATE read_model_overlay_rotations rotation')
        && statement.includes("version.status = 'active'")
        && statement.includes("SET status = 'superseded'")
    })).toBe(true)
    const cleanupIndex = query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('UPDATE read_model_overlay_rotations rotation'))
    const recoveryIndex = query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("WHERE status = 'admitted'"))
    expect(cleanupIndex).toBeGreaterThanOrEqual(0)
    expect(recoveryIndex).toBeGreaterThan(cleanupIndex)
  })

  it('drains an in-flight descriptor recovery before shutdown returns', async () => {
    const repo = new Repo({})
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    const projector = new StaticDeltaProjector(
      repo, poolLike(query) as never, 60_000, 10, () => true,
    )
    let releaseRecovery!: () => void
    const blockedRecovery = new Promise<void>((resolve) => { releaseRecovery = resolve })
    const recovery = vi.spyOn(
      projector as unknown as { recoverAdmittedOverlayRotations(): Promise<void> },
      'recoverAdmittedOverlayRotations',
    )
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => blockedRecovery)
    running.push(projector)

    await projector.start()
    await expect.poll(() => recovery.mock.calls.length).toBeGreaterThanOrEqual(2)
    let stopped = false
    const stopping = projector.stop().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stopped).toBe(false)
    releaseRecovery()
    await stopping
    expect(stopped).toBe(true)
  })

  it('keeps the current static write head resident while historical segments remain evictable', async () => {
    const repo = new Repo({})
    const root = repo.create({
      modelMetaUrl: '', shardUrls: [] as string[], registrySummaryOnly: true,
    })
    const historical = repo.create({ objects: { old: { id: 'old', name: 'Historical' } } })
    const current = repo.create({ objects: {} })
    await Promise.all([root.whenReady(), historical.whenReady(), current.whenReady()])
    const meta = repo.create({
      staticBaseline: true,
      editsObjectShardUrls: [historical.url, current.url],
      editsObjectShardUrl: current.url,
      editsConnectionShardUrls: [],
      groups: {},
      decisionRecords: {},
    })
    await meta.whenReady()
    const descriptors = [
      { landscape_id: 'land', version_id: 'version', document_id: root.documentId, kind: 'root', entity_id: null, org_id: 'org' },
      { landscape_id: 'land', version_id: 'version', document_id: meta.documentId, kind: 'model-meta', entity_id: null, org_id: 'org' },
      { landscape_id: 'land', version_id: 'version', document_id: historical.documentId, kind: 'object-overlay', entity_id: null, org_id: 'org' },
      { landscape_id: 'land', version_id: 'version', document_id: current.documentId, kind: 'object-overlay', entity_id: null, org_id: 'org' },
    ]
    const query = vi.fn(async (sql: string, planeParams?: unknown[]) => {
      // The PLANE check — `project()` asks it before anything else now.
      if (isOverlayRotationLock(sql)) return overlayRotationLockAnswer(sql, planeParams)
      if (isPlaneCheck(sql)) return planeAnswer(planeParams)
      if (sql.includes('LEFT JOIN read_model_static_documents document')) return { rows: descriptors, rowCount: descriptors.length }
      if (sql.includes('RETURNING observed_generation')) return { rows: [{ observed_generation: 2 }], rowCount: 1 }
      if (sql.includes('SELECT revision FROM read_model_static_document_queue')) return { rows: [{ revision: 1 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const residency = new AutomergeResidencyLeases(repo)
    const pinnedCore = new Map<string, string>()
    const projector = new StaticDeltaProjector(
      repo, poolLike(query) as never, 10, 60_000, () => true, undefined, residency,
      (owner, documentId) => {
        if (documentId) pinnedCore.set(owner, documentId)
        else pinnedCore.delete(owner)
      },
    )
    running.push(projector)
    await projector.start()

    await expect.poll(() => residency.isLeased(current.documentId)).toBe(true)
    expect(residency.isLeased(root.documentId)).toBe(true)
    expect(residency.isLeased(meta.documentId)).toBe(true)
    expect(residency.isLeased(historical.documentId)).toBe(false)
    expect([...pinnedCore.values()]).toContain(current.documentId)
    expect([...pinnedCore.values()]).toContain(root.documentId)
    expect([...pinnedCore.values()]).not.toContain(historical.documentId)
    await expect(residency.evict(current.documentId)).resolves.toBe(false)
    await expect(residency.evict(root.documentId)).resolves.toBe(false)
    await expect(residency.evict(historical.documentId)).resolves.toBe(true)
    await projector.stop()
    expect(pinnedCore.size).toBe(0)
  })

  it('releases peer requests for caught-up retired heads after the quiet window', async () => {
    const repo = new Repo({})
    const current = repo.create({ objects: {}, writeHeadVersion: 2, writeBatchIds: [] as string[] })
    await current.whenReady()
    const released: string[] = []
    const query = vi.fn(async (sql: string, planeParams?: unknown[]) => {
      if (isOverlayRotationLock(sql)) return overlayRotationLockAnswer(sql, planeParams)
      if (isPlaneCheck(sql)) return planeAnswer(planeParams)
      if (sql.includes('LEFT JOIN read_model_static_documents document')) {
        return {
          rows: [{
            landscape_id: 'land', version_id: 'version', document_id: current.documentId,
            kind: 'object-overlay', entity_id: null, org_id: 'org',
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('FROM read_model_overlay_segments segment')) {
        return {
          rows: [
            { landscape_id: 'land', version_id: 'version', document_id: 'retired-caught-up' },
            { landscape_id: 'foreign', version_id: 'version', document_id: 'foreign-retired' },
          ],
          rowCount: 2,
        }
      }
      if (sql.includes('SELECT revision FROM read_model_static_document_queue')) {
        return { rows: [{ revision: 1 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const projector = new StaticDeltaProjector(
      repo, poolLike(query) as never, 60_000, 60_000,
      (key) => key.landscapeId === 'land', undefined, undefined, undefined,
      (documentId) => released.push(documentId),
    )
    running.push(projector)
    await projector.start()

    expect(released).toEqual(['retired-caught-up'])
    expect(query.mock.calls.some(([sql]) => String(sql).includes(
      "queue.projected_at, segment.retired_at, segment.admitted_at",
    ))).toBe(true)
  })

  it('admits and flushes a bounded child before publishing a full write head', async () => {
    const repo = new Repo({})
    const events: string[] = []
    const current = repo.create({
      objects: {},
      writeHeadVersion: 1,
      writeBatchIds: Array.from({ length: 32 }, (_, index) => `batch-${index}`),
    })
    await current.whenReady()
    const meta = repo.create({
      staticBaseline: true,
      objectShardUrls: [current.url],
      connectionShardUrls: [] as string[],
      editsObjectShardUrls: [current.url],
      editsObjectShardUrl: current.url,
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    await meta.whenReady()
    const realFlush = repo.flush.bind(repo)
    vi.spyOn(repo, 'flush').mockImplementation(async (documentIds) => {
      if (documentIds?.includes(meta.documentId)) events.push('meta-flush')
      return realFlush(documentIds)
    })
    const descriptors = [
      { landscape_id: 'land', version_id: 'version', document_id: meta.documentId, kind: 'model-meta', entity_id: null, org_id: 'org' },
      { landscape_id: 'land', version_id: 'version', document_id: current.documentId, kind: 'object-overlay', entity_id: null, org_id: 'org' },
    ]
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      // The PLANE check — rotation, fold and historical forwarding consult
      // it at their ENTRY, so a fake that lets it fall through models a DEMOTED
      // workspace and the whole path is (correctly) refused.
      if (isOverlayRotationLock(sql)) return overlayRotationLockAnswer(sql, params)
      if (isPlaneCheck(sql)) return planeAnswer(params)
      const statement = sql.trim()
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        events.push(statement)
      }
      if (sql.includes('LEFT JOIN read_model_static_documents document')) return { rows: descriptors, rowCount: descriptors.length }
      if (sql.includes('SELECT document_id, last_projected_snapshot')) {
        return {
          rows: [{ document_id: current.documentId, last_projected_snapshot: {} }],
          rowCount: 1,
        }
      }
      // The rotation claims its new head at write; in production the
      // versions row exists by FK construction, so the fake answers the batch
      // INSERT as a clean first-owner win.
      if (sql.includes('INSERT INTO automerge_document_workspace')) {
        const ids = (Array.isArray(params?.[0]) ? params![0] as string[] : [String(params?.[0])])
        return { rows: ids.map((id) => ({ document_id: id })), rowCount: ids.length }
      }
      if (sql.includes('RETURNING observed_generation')) return { rows: [{ observed_generation: 2 }], rowCount: 1 }
      if (sql.includes('SELECT revision FROM read_model_static_document_queue')) return { rows: [{ revision: 1 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const client = { query, release: vi.fn() }
    const projector = new StaticDeltaProjector(
      repo, { query, connect: vi.fn(async () => client) } as never,
      10, 60_000, undefined, undefined, undefined, undefined, undefined,
      25, 250,
    )
    running.push(projector)
    await projector.start()

    await expect.poll(
      () => meta.doc()?.editsObjectShardUrl,
      { timeout: 3_000 },
    ).not.toBe(current.url)
    const nextUrl = meta.doc()!.editsObjectShardUrl!
    const nextDocumentId = nextUrl.replace('automerge:', '')
    expect(meta.doc()?.editsObjectShardUrls).toEqual([current.url, nextUrl])
    expect(meta.doc()?.objectShardUrls).toEqual([current.url, nextUrl])
    const activated = projector as unknown as {
      descriptors: Map<string, unknown>
      listened: Map<string, unknown>
      currentOverlayDocumentIds: Map<string, { object?: string }>
    }
    expect(activated.descriptors.has(nextDocumentId)).toBe(true)
    expect(activated.listened.has(nextDocumentId)).toBe(true)
    expect([...activated.currentOverlayDocumentIds.values()].some((entry) => entry.object === nextDocumentId)).toBe(true)
    // `pg_TRY_advisory_lock`, and the `try` is load-bearing in the assertion as
    // well as in the code: `'pg_try_advisory_lock'.includes('pg_advisory_lock')`
    // is FALSE, so matching on the blocking form would be quietly vacuous.
    expect(query.mock.calls.some(([sql]) => String(sql).includes('pg_try_advisory_lock'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('SELECT pg_advisory_lock('))).toBe(false)
    const admissions = query.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO read_model_static_documents'))
      .flatMap(([, params]) => JSON.parse(String(params?.[0])) as Array<{ documentId: string }>)
    expect(admissions.map((item) => item.documentId)).toContain(nextDocumentId)
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status = 'published'"))).toBe(true)
    const flushIndex = events.lastIndexOf('meta-flush')
    expect(flushIndex).toBeGreaterThan(0)
    expect(events.lastIndexOf('COMMIT', flushIndex)).toBeLessThan(flushIndex)
    expect(events.indexOf('BEGIN', flushIndex + 1)).toBeGreaterThan(flushIndex)
  })

  it('a failed rotation claim de-covers durably and NEVER touches the health row (U3/A7)', async () => {
    // The ONE creator site where a claim failure must not throw out of a loop
    // (design §5.2/4): rotation runs inside the projector's health machinery,
    // so the failure is folded — durable invalidation, local write-through —
    // and the pointer is NEVER published.
    //
    // The health row must NOT be marked `degraded`: this `catch` returns
    // before `BEGIN`, so nothing was published and the read model is intact.
    // A degraded mark would also be unliftable here —
    // `clearReadModelWorkspaceDegraded` has one call site, in the ordinary
    // projector, which the fleet refuses to attach to a static workspace — and
    // would block promotion, reference-integrity repair and `absenceProvable`
    // for ever, over a fault that heals on the next reload tick.
    //
    // The negative assertion below therefore needs a LIVENESS WITNESS, or
    // "the health row was not written" and "the claim path never ran" are the
    // same green. The de-cover is that witness: it is polled FIRST, and only
    // once it has been observed is the absence of a health write asserted.
    _resetWorkspaceClaimCoverageForTests()
    const repo = new Repo({})
    const current = repo.create({
      objects: {},
      writeHeadVersion: 1,
      writeBatchIds: Array.from({ length: 32 }, (_, index) => `batch-${index}`),
    })
    await current.whenReady()
    const meta = repo.create({
      staticBaseline: true,
      objectShardUrls: [current.url],
      connectionShardUrls: [] as string[],
      editsObjectShardUrls: [current.url],
      editsObjectShardUrl: current.url,
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    await meta.whenReady()
    const descriptors = [
      { landscape_id: 'land', version_id: 'version', document_id: meta.documentId, kind: 'model-meta', entity_id: null, org_id: 'org' },
      { landscape_id: 'land', version_id: 'version', document_id: current.documentId, kind: 'object-overlay', entity_id: null, org_id: 'org' },
    ]
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      // The PLANE check — rotation, fold and historical forwarding consult
      // it at their ENTRY, so a fake that lets it fall through models a DEMOTED
      // workspace and the whole path is (correctly) refused.
      if (isOverlayRotationLock(sql)) return overlayRotationLockAnswer(sql, params)
      if (isPlaneCheck(sql)) return planeAnswer(params)
      if (sql.includes('LEFT JOIN read_model_static_documents document')) return { rows: descriptors, rowCount: descriptors.length }
      if (sql.includes('SELECT document_id, last_projected_snapshot')) {
        return { rows: [{ document_id: current.documentId, last_projected_snapshot: {} }], rowCount: 1 }
      }
      // The rotated head's claim CONFLICTS: zero rows inserted…
      if (sql.includes('INSERT INTO automerge_document_workspace')) {
        return { rows: [], rowCount: 0 }
      }
      // …and the winner SELECT resolves every loser to a FOREIGN workspace.
      if (sql.includes('FROM automerge_document_workspace')) {
        const ids = Array.isArray(params?.[0]) ? params![0] as string[] : []
        return {
          rows: ids.map((id) => ({ document_id: id, landscape_id: 'intruder', version_id: 'other' })),
          rowCount: ids.length,
        }
      }
      if (sql.includes('RETURNING observed_generation')) return { rows: [{ observed_generation: 2 }], rowCount: 1 }
      if (sql.includes('SELECT revision FROM read_model_static_document_queue')) return { rows: [{ revision: 1 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const client = { query, release: vi.fn() }
    // The workspace believes itself covered before the failure — the fold
    // must retract that belief (write-through), not only write durably.
    noteCoveredLocally({ landscapeId: 'land', versionId: 'version' })
    const projector = new StaticDeltaProjector(
      repo, { query, connect: vi.fn(async () => client) } as never,
      10, 60_000, undefined, undefined, undefined, undefined, undefined,
      25, 250,
    )
    running.push(projector)
    await projector.start()

    // Durable de-cover — polled FIRST, because it is the liveness witness that
    // makes the negative assertion below mean anything. Unlike the health row
    // this signal has a real lift: `coverWorkspace` re-covers on a CAS against
    // the monotone `invalidations` counter after a repair walk.
    await expect.poll(
      () => query.mock.calls.some(([sql]) =>
        String(sql).includes('workspace_claim_coverage') && String(sql).includes('invalidated_reason')),
      { timeout: 3_000 },
    ).toBe(true)
    // …and now, in the same window, NO health-row write. `staticDeltaProjector`
    // is not a writer of that row: `projectorService` is the only one.
    // Asserted on the whole call log rather than a suffix, so a mark issued
    // BEFORE the de-cover is caught too.
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('degraded_kind'))).toEqual([])
    // Write-through observed: the local cache no longer serves "covered".
    expect(isWorkspaceCoveredLocally({ landscapeId: 'land', versionId: 'version' })).toBe(false)
    // And the pointer was never published: the head still names the old
    // overlay, and nothing was admitted for the stillborn child.
    expect(meta.doc()?.editsObjectShardUrl).toBe(current.url)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO read_model_static_documents'))).toBe(false)
  })
})

/**
 * Diagram tombstones, the SERVER half: `projectMeta` must HONOUR
 * `ModelMeta.deletedDiagramIds`.
 *
 * The client makes the tombstone durable; a tombstone nothing projects would
 * leave the diagram in `ro_diagrams`, on the paged list, in every global view,
 * and in the "linked diagrams" of every object it contained — while the user
 * has been told it is gone.
 *
 * The seam is the projector's `Queryable`, exactly as the suite above uses it:
 * with no `connect()`, `withReadModelProjectionTransaction` runs inline, so the
 * recorded SQL is the whole publication.
 */
describe('StaticDeltaProjector — les tombstones de diagramme (T6)', () => {
  const descriptorOf = (documentId: string) => ({
    landscapeId: 'land', versionId: 'version', documentId,
    kind: 'model-meta', entityId: null, orgId: 'org',
  })

  interface MetaLike {
    editsObjectShardUrls: string[]
    editsConnectionShardUrls: string[]
    groups: Record<string, unknown>
    decisionRecords: Record<string, unknown>
    deletedObjectIds?: string[]
    deletedConnectionIds?: string[]
    deletedDiagramIds?: string[]
  }

  function harness(options: {
    /** Answer `pg_try_advisory_lock` with `false` — another writer holds the
     * overlay-rotation key. Drives the refusal branches of the rotation and
     * fold paths, where a missing `return` would let a second writer proceed
     * through `repo.create`, a claim, two commits and a `repo.flush` with no
     * exclusion at all. */
    lockRefused?: boolean
    alreadyProjected?: () => boolean
    /** Reuse another harness's rows to model a projector RESTART against the
     * SAME database: the in-memory `overlayState` is gone, the SQL rows are
     * not. */
    rows?: Set<string>
    /** Connections the deleted diagrams carried a membership or a flow for.
     * The default harness answers that UNION with nothing, which makes
     * `refreshConnectionStats` return on its own empty-input guard — so a
     * stats refresh cannot be OBSERVED unless a fixture supplies them. */
    affectedConnections?: string[]
    /** Does `read_model_static_workspaces` still carry this workspace?
     *
     * DEFAULT TRUE, because every fixture here is a static workspace by
     * premise. It is answered explicitly rather than falling out of the empty
     * default so the premise is visible — and so a test can set it FALSE and
     * model a demoted workspace, which must not write `ro_*` rows into a plane
     * the ordinary projector has been handed back.
     *
     * A FUNCTION is allowed so ONE projector can be driven across a demote /
     * re-promote / demote cycle. A per-harness boolean would need a new
     * projector per state, and could therefore never exercise the purge site of
     * the memo that keeps the refusal from logging on every publication. */
    staticWorkspace?: boolean | (() => boolean)
    /** Make one statement fail with a chosen SQLSTATE. Used to play a mutex
     * that another writer holds (`55P03`), which the projector must treat as
     * transient and MUST NOT persist onto the other writer's health row. */
    throwOn?: { pattern: string; code: string }
    /** Rows for the admitted-rotation recovery SELECT. Without them that loop
     * body never executes, so any assertion about what it does — or refuses to
     * do — is vacuous. */
    admittedRotations?: Array<Record<string, string>>
    /** Ids `objectCacheNeighbourIds` finds (children of a deleted parent, …).
     * The default empty answer cannot show whether a publication lists them. */
    cacheNeighbours?: string[]
  } = {}) {
    const repo = new Repo({})
    const calls: Array<{ sql: string; params: unknown[] }> = []
    /** The rows a real `ro_diagrams` would still hold, so the mock's rowCount
     * is the truth the counter is adjusted by rather than a constant. */
    const deletedDiagramRows = options.rows ?? new Set<string>()
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      calls.push({ sql: text, params })
      if (options.throwOn && text.includes(options.throwOn.pattern)) {
        throw Object.assign(new Error(`injected ${options.throwOn.code}`), { code: options.throwOn.code })
      }
      if (isOverlayRotationLock(text)) {
        return options.lockRefused === true && text.includes('pg_try_advisory_lock')
          ? { rows: [{ locked: false }], rowCount: 1 }
          : overlayRotationLockAnswer(text, params)
      }
      if (text.includes('SELECT landscape_id, version_id, collection')) {
        const rows = options.admittedRotations ?? []
        return { rows, rowCount: rows.length }
      }
      // `metaSourceAlreadyProjected` — the queue watermark. Answering `true`
      // reproduces a revision another process (or an older build) already
      // acknowledged, which is what makes `projectMeta` short-circuit.
      if (text.includes('projected_revision >=')) {
        return { rows: [{ projected: options.alreadyProjected?.() ?? false }], rowCount: 1 }
      }
      // The PLANE check — which writer owns this workspace's `ro_*` rows.
      // Asked twice per publication on purpose: once on the pool before the
      // generation is bumped, once inside the transaction under the mutex,
      // where it is the actual gate. `isPlaneCheck` excludes statements naming
      // `read_model_static_documents`, so this cannot answer `{ present }` to
      // the descriptor SELECT, which joins the same table and wants document
      // rows.
      if (isPlaneCheck(text)) {
        const wanted = typeof options.staticWorkspace === 'function'
          ? options.staticWorkspace()
          : options.staticWorkspace ?? true
        // Params-sensitive for the same reason as `planeAnswer` above: a
        // constant answer cannot detect a mis-threaded workspace key.
        const asked = params as string[]
        const mine = asked[0] === 'land' && asked[1] === 'version'
        return { rows: [{ present: mine && wanted }], rowCount: 1 }
      }
      // The health machinery reads the generation back; an empty result there
      // throws before the publication under test ever runs.
      if (text.includes('observed_generation')) {
        return { rows: [{ observed_generation: 1 }], rowCount: 1 }
      }
      // A real deletion removed a row: the workspace counter is adjusted by
      // what actually went, so the mock has to report it REALISTICALLY. The
      // belt that protects against double-decrement is this row count, not the
      // delta against `overlayState`, so a mock that always claims a row was
      // removed could not detect a projector that replays the whole list.
      // The connections a deleted diagram carried, captured BEFORE the deletes
      // so their aggregate counters can be recomputed after.
      if (text.includes('SELECT group_id FROM ro_group_objects') && text.includes('parent_id = ANY')) {
        const rows = (options.cacheNeighbours ?? []).map((id) => ({ id }))
        return { rows, rowCount: rows.length }
      }
      if (text.includes('SELECT connection_id FROM ro_diagram_connections')) {
        return {
          rows: (options.affectedConnections ?? []).map((connectionId) => ({ connection_id: connectionId })),
          rowCount: (options.affectedConnections ?? []).length,
        }
      }
      if (text.includes('DELETE FROM ro_diagrams ')) {
        const ids = (params.find((param) => Array.isArray(param)) ?? []) as string[]
        const fresh = ids.filter((id) => !deletedDiagramRows.has(id))
        for (const id of fresh) deletedDiagramRows.add(id)
        return { rows: [], rowCount: fresh.length }
      }
      return { rows: [], rowCount: 0 }
    })
    const projector = new StaticDeltaProjector(repo, poolLike(query) as never)
    running.push(projector)
    const internal = projector as unknown as {
      projectMeta(
        value: ReturnType<typeof descriptorOf>,
        metaValue: MetaLike,
        revision: number,
      ): Promise<void>
    }
    const ran = (needle: string) => calls.some((call) => call.sql.includes(needle))
    /** "No overlay-rotation lock was taken", asked in a way no SPELLING can
     * answer for. `'pg_try_advisory_lock'.includes('pg_advisory_lock')` is
     * false, so a negative assertion naming one form stops noticing the other.
     * Both forms, one question. */
    const ranAnyOverlayLock = () => calls.some((call) =>
      call.sql.includes('pg_try_advisory_lock') || call.sql.includes('SELECT pg_advisory_lock('))
    const callsMatching = (needle: string) => calls.filter((call) => call.sql.includes(needle))
    // `repo` EXPOSED: a test that needs to reach past `resolveDocumentHandle`
    // needs a document that really resolves, and inventing a documentId gets a
    // `DocumentPermanentlyUnavailableError` before the code under test runs.
    return { internal, calls, ran, ranAnyOverlayLock, callsMatching, deletedDiagramRows, repo }
  }

  const baseMeta = (overrides: Partial<MetaLike> = {}): MetaLike => ({
    editsObjectShardUrls: [],
    editsConnectionShardUrls: [],
    groups: {},
    decisionRecords: {},
    deletedObjectIds: [],
    deletedConnectionIds: [],
    deletedDiagramIds: [],
    ...overrides,
  })

  it('a parent tombstone also publishes the children whose cached c4ParentId it moves', async () => {
    // The static projector publishes the ids it wrote. Deleting a parent
    // rewrites its children's c4_parent_id (refreshEffectiveParents) without
    // naming them, so an offline cache kept them on the deleted parent's
    // level: the publication must list them, read BEFORE the delete.
    const { internal, calls } = harness({ cacheNeighbours: ['child-a', 'child-b', 'parent'] })
    await internal.projectMeta(descriptorOf('meta'), baseMeta({ deletedObjectIds: ['parent'] }), 7)

    const neighbourRead = calls.findIndex((call) => call.sql.includes('SELECT group_id FROM ro_group_objects'))
    const objectDelete = calls.findIndex((call) => call.sql.includes('DELETE FROM ro_objects'))
    const event = calls.find((call) => call.sql.includes('INSERT INTO read_model_change_events'))
    expect(neighbourRead).toBeGreaterThanOrEqual(0)
    expect(objectDelete).toBeGreaterThan(neighbourRead)
    expect(event?.params[3]).toBe('objects')
    const payload = JSON.parse(String(event?.params[4])) as { upsertIds: string[]; deleteIds: string[] }
    expect(payload.deleteIds).toEqual(['parent'])
    // the children are listed; the deleted id is not "upserted" back
    expect([...payload.upsertIds].sort()).toEqual(['child-a', 'child-b'])
  })

  describe('A8 — le plan ro_* n\'a qu\'un écrivain à la fois', () => {
    it('un espace DÉMOTÉ n\'écrit plus une ligne, ni dans ro_*, ni dans la ligne de santé', async () => {
      // The LIVENESS WITNESS first, and it is what makes the negatives below
      // mean anything: the identical projection against a static workspace
      // writes. Without it, a projector broken in any other way would pass.
      const live = harness()
      await live.internal.projectMeta(
        descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
      )
      expect(live.ran('DELETE FROM ro_diagrams')).toBe(true)

      // …and now the same projection on a workspace whose
      // `read_model_static_workspaces` row is gone. That is a DEMOTE: it
      // deletes the row and hands the `ro_*` plane back to the ordinary
      // projector, while this projector keeps its descriptors and its document
      // listeners for the life of the process — `reloadDescriptors` is purely
      // additive and never prunes, and `release()` is reachable only through an
      // ownership coordinator that does not start unless SYNC_CELL_OWNERSHIP=on.
      // Without the plane gate every subsequent change would publish `ro_*`
      // rows into that plane, unserialized against the ordinary projector's
      // cold build, where a pure INSERT survives its blanket DELETE as a
      // phantom certified by the cold build's own watermark.
      const demoted = harness({ staticWorkspace: false })
      await demoted.internal.projectMeta(
        descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
      )

      expect(demoted.ran('DELETE FROM ro_diagrams')).toBe(false)
      expect(demoted.ran('ro_workspace_stats')).toBe(false)
      // A SEPARATE property from the rows, not a restatement of it:
      // `beginReadModelProjection` runs on the pool, outside the transaction,
      // so no rollback can undo its `observed_generation` bump. Every refused
      // attempt would otherwise walk the ORDINARY projector's healthy workspace
      // to `catching_up` — refusing `absenceProvable`, blocking compaction —
      // once per attempt, for ever.
      expect(demoted.ran('RETURNING observed_generation')).toBe(false)
      // And no failure telemetry onto a health row that now describes the other
      // writer. `projectorService` refuses the identical write for a lost
      // fence: it can walk a healthy workspace's ladder to `failed` from
      // outside, which is the same forgery as writing its rows, one table over.
      // The INCREMENT, not the column: `completeReadModelProjection` names
      // `consecutive_failures` too, to reset it, so the bare column name also
      // matches every successful pass.
      expect(demoted.ran('consecutive_failures + 1')).toBe(false)
      expect(live.ran('consecutive_failures + 1')).toBe(false)
    })

    it('perd le plan EN TRANSACTION et ne forge rien sur la ligne de l\'autre écrivain', async () => {
      // The window the pool-side pre-check cannot cover, and the ONLY one in
      // which the static side's anti-forgery branch is reachable at all: the
      // pre-check passes, the promotion lands, and the in-transaction check
      // under the mutex is what refuses — with a projection token already
      // issued, which is what makes `failReadModelProjection` reachable. This
      // is the static side's twin of the ordinary projector's mid-transaction
      // test.
      let asked = 0
      const { internal, ran } = harness({ staticWorkspace: () => { asked += 1; return asked === 1 } })

      await internal.projectMeta(
        descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
      )

      // LIVENESS WITNESS, and it is the assertion that separates this test from
      // the pre-check one above: the plane was asked TWICE, so the pass really
      // did get past the pre-check and into the transaction. With one ask, every
      // negative below would be about a branch that never ran.
      expect(asked).toBeGreaterThanOrEqual(2)
      // No failure telemetry onto a health row that now describes the ORDINARY
      // projector — the same forgery `runTracked` refuses for a lost fence.
      expect(ran('consecutive_failures + 1')).toBe(false)
      // And the projection rolled back rather than committing under a refusal.
      expect(ran('DELETE FROM ro_diagrams')).toBe(false)
    })

    it('un mutex tenu par un AUTRE écrivain est transitoire — jamais persisté sur sa ligne', async () => {
      // The liveness witness FIRST: the same projection with the mutex free
      // writes, so the negatives below are about the refusal and not about a
      // harness that projects nothing.
      const free = harness()
      await free.internal.projectMeta(
        descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
      )
      expect(free.ran('DELETE FROM ro_diagrams')).toBe(true)

      // …and now the mutex is held by somebody else. `lock_timeout` raises
      // 55P03, which must not fall through to `failReadModelProjection` —
      // that would stamp `consecutive_failures + 1` and `last_error_code` on
      // the health row of the writer that WON.
      const busy = harness({ throwOn: { pattern: 'pg_advisory_xact_lock', code: '55P03' } })
      await busy.internal.projectMeta(
        descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
      )

      expect(busy.ran('pg_advisory_xact_lock')).toBe(true)
      expect(busy.ran('consecutive_failures + 1')).toBe(false)
      expect(busy.ran('DELETE FROM ro_diagrams')).toBe(false)
      // NOT a plane loss: the workspace is still ours, the mutex simply was
      // not. Conflating the two would make a permanent refusal out of a
      // transient one, and the document would stop being retried.
      expect(busy.ran('degraded_kind')).toBe(false)
    })

    it('un espace DÉMOTÉ ne fait tourner NI rotation NI reprise — le plan documentaire aussi', async () => {
      // These paths ask the plane at their ENTRY: a gate at the END of the
      // write path would let them create Automerge documents, claim them,
      // re-INSERT the rows a demotion had just deleted, and flush the user's
      // ModelMeta before anything reached SQL.
      //
      // The DISCRIMINATOR is the code's own next step: `rotateOverlayHead`
      // looks for a ModelMeta descriptor immediately after the gate and throws
      // when there is none. So "refused" and "ran" are two different outcomes
      // of the same call, and neither is a shape assertion.
      const demoted = harness({ staticWorkspace: false })
      const internals = demoted.internal as unknown as {
        rotateOverlayHead(d: ReturnType<typeof descriptorOf>, kind: 'object'): Promise<void>
        foldOverlayChain(d: ReturnType<typeof descriptorOf>, kind: 'object'): Promise<void>
        recoverAdmittedOverlayRotations(): Promise<void>
      }
      await expect(internals.rotateOverlayHead(descriptorOf('head'), 'object')).resolves.toBeUndefined()
      expect(demoted.ranAnyOverlayLock()).toBe(false)
      expect(demoted.ran('INSERT INTO read_model_static_documents')).toBe(false)

      // LIVENESS: the identical call on a STATIC workspace gets past the gate
      // and reaches the very next statement, which throws for want of a
      // ModelMeta descriptor. Without this the assertion above would pass
      // against a projector that refuses everything.
      const live = harness()
      const liveInternals = live.internal as unknown as {
        rotateOverlayHead(d: ReturnType<typeof descriptorOf>, kind: 'object'): Promise<void>
      }
      await expect(liveInternals.rotateOverlayHead(descriptorOf('head'), 'object'))
        .rejects.toThrow('Overlay rotation requires ModelMeta')

      // The FOLD, same shape: refused it returns; admitted it walks on to
      // resolve ModelMeta, which this fixture does not have, and rejects.
      await expect(internals.foldOverlayChain(descriptorOf('meta'), 'object')).resolves.toBeUndefined()
      const liveFold = harness()
      const liveFoldInternals = liveFold.internal as unknown as {
        foldOverlayChain(d: ReturnType<typeof descriptorOf>, kind: 'object'): Promise<void>
      }
      await expect(liveFoldInternals.foldOverlayChain(descriptorOf('meta'), 'object')).rejects.toThrow()

      // The recovery loop skips per ROW rather than aborting the pass: it spans
      // every workspace, so one demoted workspace must not stop the others.
      //
      // It needs a ROW and a matching ModelMeta descriptor, or the loop body
      // never runs and "no advisory lock was taken" would be true for the
      // wrong reason.
      const admitted = [{
        landscape_id: 'land', version_id: 'version', collection: 'object',
        old_document_id: 'old-doc', new_document_id: 'new-doc',
        new_segment_url: 'automerge:new-doc',
      }]
      const recovering = harness({ staticWorkspace: false, admittedRotations: admitted })
      const recoveringInternals = recovering.internal as unknown as {
        descriptors: Map<string, ReturnType<typeof descriptorOf>>
        recoverAdmittedOverlayRotations(): Promise<void>
      }
      recoveringInternals.descriptors.set('meta', descriptorOf('meta'))
      await expect(recoveringInternals.recoverAdmittedOverlayRotations()).resolves.toBeUndefined()
      expect(recovering.ranAnyOverlayLock()).toBe(false)

      // LIVENESS, and the discriminator: the identical setup on a STATIC
      // workspace gets past the gate and goes on to resolve a ModelMeta this
      // fixture does not have, which rejects. So "refused" and "ran" are two
      // different outcomes of one call rather than a shape assertion.
      const liveRecovery = harness({ admittedRotations: admitted })
      const liveRecoveryInternals = liveRecovery.internal as unknown as {
        descriptors: Map<string, ReturnType<typeof descriptorOf>>
        recoverAdmittedOverlayRotations(): Promise<void>
      }
      liveRecoveryInternals.descriptors.set('meta', descriptorOf('meta'))
      await expect(liveRecoveryInternals.recoverAdmittedOverlayRotations()).rejects.toThrow()

      await expect(internals.recoverAdmittedOverlayRotations()).resolves.toBeUndefined()

      // Nothing durable, from any of the three. The advisory lock is the first
      // irreversible-ish act on all of them, and `read_model_static_documents`
      // is the row a demotion just deleted and these paths must not re-insert.
      expect(demoted.ranAnyOverlayLock()).toBe(false)
      expect(demoted.ran('INSERT INTO read_model_static_documents')).toBe(false)
      expect(demoted.ran('INSERT INTO automerge_document_workspace')).toBe(false)
    })

    it('une CLÉ TENUE arrête la ROTATION, et le mutant qui supprime le refus est tué', async () => {
      // Drives the refusal branch of `rotateOverlayHead` with a contended key.
      // Without its `return`, a second writer would go on through
      // `repo.create`, a claim, two commits and a `repo.flush` with no
      // exclusion at all — colliding on
      // `idx_read_model_overlay_segments_current`, which is the collision
      // `synchronizeOverlaySegments` names in its own comment.
      //
      // The DISCRIMINATOR is the same as the demoted case above: the code's own
      // next step. Past the lock, `rotateOverlayHead` looks for a ModelMeta
      // descriptor and throws for want of one, so "refused" and "ran" are two
      // different outcomes of one call rather than a shape assertion.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      /** A workspace whose ModelMeta really resolves and whose current object
       * head is `headId`. Everything before the lock — the plane read, the
       * ModelMeta lookup, `resolveDocumentHandle` — has to SUCCEED, or the test
       * asserts a refusal it never reached (e.g. a missing ModelMeta
       * descriptor, or a document id that resolves to nothing). */
      const rotatable = async (options: { lockRefused?: boolean } = {}) => {
        const built = harness(options)
        const head = built.repo.create({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
        await head.whenReady()
        const meta = built.repo.create({ editsObjectShardUrl: head.url, editsObjectShardUrls: [head.url] })
        await meta.whenReady()
        const internal = built.internal as unknown as {
          descriptors: Map<string, ReturnType<typeof descriptorOf>>
          rotateOverlayHead(d: ReturnType<typeof descriptorOf>, kind: 'object'): Promise<void>
        }
        internal.descriptors.set(meta.documentId, descriptorOf(meta.documentId))
        return { built, internal, headDescriptor: descriptorOf(head.documentId) }
      }

      const contended = await rotatable({ lockRefused: true })
      await expect(contended.internal.rotateOverlayHead(contended.headDescriptor, 'object'))
        .resolves.toBeUndefined()

      // The lock WAS asked for — without this the resolve above is equally true
      // of a projector that refused at the plane gate instead.
      expect(contended.built.ran('pg_try_advisory_lock')).toBe(true)
      // …and nothing else happened. No unlock (nothing was taken), no document
      // rows, no claim, no rotation row.
      expect(contended.built.ran('pg_advisory_unlock')).toBe(false)
      expect(contended.built.ran('INSERT INTO read_model_static_documents')).toBe(false)
      expect(contended.built.ran('INSERT INTO automerge_document_workspace')).toBe(false)
      expect(contended.built.ran('read_model_overlay_rotations')).toBe(false)

      // REPORTED, and by its own path name.
      const events = warn.mock.calls
        .map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown> } catch { return {} } })
        .filter((event) => event.event === 'read_model.overlay_rotation_lock_contended')
      expect(events.map((event) => event.path)).toEqual(['rotate'])
      expect(events[0]!.state).toBe('refused')

      // LIVENESS: with the key FREE the
      // IDENTICAL call goes on to create, claim and admit a new head. Without
      // it, every assertion above would pass against a projector that refuses
      // everything — and against one whose refusal branch has lost its `return`
      // but is being fed a fixture that never contends.
      const free = await rotatable()
      await expect(free.internal.rotateOverlayHead(free.headDescriptor, 'object'))
        .resolves.toBeUndefined()
      expect(free.built.ran('pg_try_advisory_lock')).toBe(true)
      // TOOK it and gave it back — the pair of statements the refused arm makes
      // exactly one of.
      expect(free.built.ran('pg_advisory_unlock')).toBe(true)
      // …and got far enough to CLAIM a newly created head, which is the first
      // durable act past the lock. The assertion stops here rather than
      // reaching for the rotation row: this minimal fixture does not carry the
      // segment state that step needs, and asserting a step the fixture cannot
      // reach is how a liveness witness becomes the thing that fails.
      expect(free.built.ran('INSERT INTO automerge_document_workspace')).toBe(true)
    })

    it('signale la perte UNE fois, et une re-promotion réarme le signal', async () => {
      // The memo behind "report the loss once per loss" has exactly ONE purge
      // site — the success branch of `holdsStaticPlane` — and this drives it.
      // A memo whose purge is never exercised is a memo that stops reporting
      // after the first event and looks identical to a healthy one.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        let isStatic = true
        const { internal, ran } = harness({ staticWorkspace: () => isStatic })
        const refusals = () => warn.mock.calls.filter(
          ([message]) => String(message).includes('static projection refused'),
        ).length
        // Each pass carries a DIFFERENT tombstone so the semantic fingerprint
        // changes every time; an identical ModelMeta would short-circuit in
        // `metadataUnchanged` and the pass would never reach the plane check.
        const pass = (id: string, revision: number) => internal.projectMeta(
          descriptorOf('meta'), baseMeta({ deletedDiagramIds: [id] }), revision,
        )

        await pass('dg-1', 7)
        expect(ran('DELETE FROM ro_diagrams')).toBe(true)
        expect(refusals()).toBe(0)

        isStatic = false
        await pass('dg-2', 8)
        expect(refusals()).toBe(1)
        await pass('dg-3', 9)
        // Still ONE: a projector that logged per publication would drown the
        // log of a busy workspace at whatever rate its documents change.
        expect(refusals()).toBe(1)

        isStatic = true
        await pass('dg-4', 10)
        expect(refusals()).toBe(1)

        isStatic = false
        await pass('dg-5', 11)
        // TWO. This is the purge: without it the second demotion of the same
        // workspace is silent, which is the demotion an operator is most
        // likely to be watching for.
        expect(refusals()).toBe(2)
      } finally {
        warn.mockRestore()
      }
    })
  })

  it('supprime les lignes ro_diagrams des ids nouvellement tombstones', async () => {
    // THE "written but never read" test: `deleteDiagrams` must run in the
    // publish transaction. Otherwise the tombstone is durable in the CRDT and
    // inert: the card comes back on the next page load, and every global view
    // still counts the diagram.
    const { internal, ran, callsMatching } = harness()

    await internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
    )

    expect(ran('DELETE FROM ro_diagrams')).toBe(true)
    expect(callsMatching('DELETE FROM ro_diagrams')[0].params).toContainEqual(['dg-gone'])
    // The page and the TOTAL are two different sources
    // (`ro_diagram_summaries` and `ro_workspace_stats.diagram_count`, see
    // `diagramList.ts`). Fixing the
    // rows without the counter shows 9 999 cards under a "10 000" heading.
    const counter = callsMatching('ro_workspace_stats').filter(
      (call) => call.sql.includes('diagram_count'),
    )
    expect(counter).toHaveLength(1)
    expect(counter[0].params).toContain(-1)
  })

  it('inclut deletedDiagramIds dans empreinte semantique', async () => {
    // The most likely shape of "written but never read", invisible to the test
    // above because that one reaches the transaction on a first projection. If
    // `semanticFingerprint` ignored `deletedDiagramIds`, a ModelMeta whose only
    // change is a diagram tombstone would compare EQUAL to the previous one,
    // `metadataUnchanged` would short-circuit, and `projectMeta` would return
    // having done nothing at all — silently, for ever.
    const { internal, ran } = harness()

    // Pass 1 establishes the fingerprint memo with NO diagram tombstone.
    await internal.projectMeta(descriptorOf('meta'), baseMeta(), 7)
    expect(ran('DELETE FROM ro_diagrams')).toBe(false)

    // Pass 2 changes ONLY `deletedDiagramIds`.
    await internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 8,
    )

    expect(ran('DELETE FROM ro_diagrams')).toBe(true)
  })

  it('supprime la membership et les resumes avec le diagramme', async () => {
    // The quiet half. Nothing in `readModel/schema.ts` declares ON DELETE
    // CASCADE, so deleting only `ro_diagrams` would leave the membership rows —
    // and Model Objects and Dependencies read `ro_diagram_objects`
    // (`objectExplorer.ts`, `queries.ts`). The dead diagram would keep
    // appearing under "linked diagrams" long after its card is gone.
    const { internal, ran } = harness()

    await internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
    )

    expect(ran('DELETE FROM ro_diagram_objects')).toBe(true)
    expect(ran('DELETE FROM ro_diagram_groups')).toBe(true)
    expect(ran('DELETE FROM ro_diagram_connections')).toBe(true)
    expect(ran('DELETE FROM ro_connection_flows')).toBe(true)
    // `refreshDiagramSummaries` purges `ro_diagram_summaries` through its
    // NOT EXISTS clause once the `ro_diagrams` row is gone.
    expect(ran('DELETE FROM ro_diagram_summaries')).toBe(true)
    // …and the object-flow index with its coverage witness, or the witness
    // would certify flows that no longer have rows.
    expect(ran('DELETE FROM ro_flow_objects')).toBe(true)
    expect(ran('DELETE FROM ro_diagram_flow_index')).toBe(true)
  })

  it('certifie la couverture des flux seulement pour une vraie map flows', async () => {
    // A DiagramDoc whose `flows` is missing or not a map is projected as an
    // EMPTY flow set (as it always was for ro_connection_flows). The coverage
    // witness must not certify that: it is dropped, so the diagram's flows
    // read as unknown ("at least N") instead of "exactly 0".
    const project = async (flows: unknown) => {
      const { internal, ran, callsMatching } = harness()
      const diagramDescriptor = { ...descriptorOf('dg-doc'), kind: 'diagram', entityId: 'dg1' }
      await (internal as unknown as {
        projectDiagram(descriptor: unknown, doc: unknown, revision: number): Promise<void>
      }).projectDiagram(diagramDescriptor, {
        id: 'dg1', name: 'D', objectIds: ['A'], connectionIds: [], groupIds: [],
        ...(flows === undefined ? {} : { flows }),
      }, 3)
      return { ran, callsMatching }
    }

    const real = await project({ f1: { id: 'f1', name: 'Checkout', steps: [{ type: 'process', objectId: 'A' }] } })
    expect(real.ran('INSERT INTO ro_flow_objects')).toBe(true)
    const witness = real.callsMatching('INSERT INTO ro_diagram_flow_index')
    expect(witness).toHaveLength(1)
    expect(witness[0].params[0]).toEqual(['dg1'])

    for (const notAMap of [undefined, [{ id: 'f1', steps: [] }], 'garbage']) {
      const run = await project(notAMap)
      expect(run.ran('INSERT INTO ro_diagram_flow_index')).toBe(false)
      // All three tables, scoped to exactly this diagram of this workspace.
      for (const table of ['ro_flows', 'ro_flow_objects', 'ro_diagram_flow_index']) {
        expect(run.callsMatching(`DELETE FROM ${table} WHERE`).map((call) => call.params))
          .toEqual([['land', 'version', 'dg1']])
      }
    }
  })

  it('ne supprime pas deux fois pour deux projections du meme tombstone', async () => {
    // The delete set is the delta against `overlayState`, not the WHOLE list.
    // `deleteDiagrams` is idempotent on the rows, so a whole-list delete would
    // look fine — but `adjustWorkspaceCount` is a RUNNING counter clamped by
    // GREATEST(0, …), so the footer total would walk down on every projection
    // and land on zero for good (`contentDigest.ts` names this as a source of
    // drift).
    //
    // The second pass changes something ELSE (a group), so the fingerprint
    // differs and the projection really does run again — otherwise this test
    // would pass on the short-circuit rather than on the delta.
    const { internal, callsMatching } = harness()

    await internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
    )
    expect(callsMatching('DELETE FROM ro_diagrams')).toHaveLength(1)

    await internal.projectMeta(
      descriptorOf('meta'),
      baseMeta({ deletedDiagramIds: ['dg-gone'], groups: { g1: { id: 'g1', name: 'Platform' } } }),
      8,
    )

    // Same tombstone, second projection: nothing new was deleted, so nothing
    // may be subtracted from the workspace counter either.
    expect(callsMatching('DELETE FROM ro_diagrams')).toHaveLength(1)
  })

  it('rejoue un tombstone qu un court-circuit « deja projete » avait saute', async () => {
    // `this.overlayState.set(...)` runs at the TOP of `projectMeta`, before the
    // `sourceAlreadyProjected || metadataUnchanged` short circuit — and that
    // branch returns having applied nothing. So a revision whose queue
    // watermark is already satisfied (a projector that restarted, a build that
    // acknowledged the revision without knowing the field yet, any second
    // process) marks its tombstones as projected while no `deleteDiagrams`
    // ever ran. Without a catch-up, `newlyDeletedDiagramIds` would be empty for
    // those ids FOR EVER: the client hides the cards, the server keeps serving
    // them (one may even be chosen as the boot diagram and render
    // `diagram-not-found`), and only `fsck diagram-tombstone-honoured` sees it.
    let alreadyProjected = true
    const { internal, callsMatching } = harness({ alreadyProjected: () => alreadyProjected })

    await internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-missed'] }), 7,
    )
    // Anti-void guard: the short circuit really fired. Without it this test
    // would prove nothing about the repair.
    expect(callsMatching('DELETE FROM ro_diagrams')).toHaveLength(0)

    // Any later, ordinary change. The missed id must be caught up with it.
    alreadyProjected = false
    await internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-missed', 'dg-new'] }), 8,
    )

    const deletes = callsMatching('DELETE FROM ro_diagrams')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].params).toContainEqual(['dg-missed', 'dg-new'])
  })

  it('recalcule les compteurs des connexions qui perdent une appartenance ou un flux', async () => {
    // The other quiet half of membership deletion: deleting the
    // membership rows silently invalidates `ro_connection_stats.diagram_count`
    // and `flow_count`, which is exactly what the Model Connections page shows
    // as "appears in N diagrams / N flows". Drop the `refreshConnectionStats`
    // call and every connection the diagram carried keeps counting it for ever
    // — a number that is wrong, visible, and attached to no error.
    //
    // It also pins the ORDER, which is the part a reader cannot check: the
    // connection ids have to be captured BEFORE the membership and flow rows
    // are deleted, because after the deletes there is nothing left to find them
    // by. Capturing afterwards yields an empty set, `refreshConnectionStats`
    // returns on its own guard, and the defect looks exactly like the missing
    // call — silent in both directions.
    const { internal, calls, callsMatching } = harness({ affectedConnections: ['conn-1', 'conn-2'] })

    await internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
    )

    const refresh = callsMatching('INSERT INTO ro_connection_stats')
    expect(refresh).toHaveLength(1)
    expect(refresh[0].params).toContainEqual(['conn-1', 'conn-2'])

    // The capture precedes the membership delete.
    const capturedAt = calls.findIndex((call) => call.sql.includes('SELECT connection_id FROM ro_diagram_connections'))
    const deletedAt = calls.findIndex((call) => call.sql.includes('DELETE FROM ro_diagram_connections'))
    expect(capturedAt).toBeGreaterThanOrEqual(0)
    expect(deletedAt).toBeGreaterThan(capturedAt)
  })

  it('un REDEMARRAGE du projecteur rejoue toute la liste sans re-decrementer le total', async () => {
    // The belt `staticDeltaProjector.ts` describes: the counter is adjusted by
    // the REAL number of rows `deleteDiagrams` removed, never by the size of
    // its input.
    //
    // `overlayState` is a plain in-memory Map, private to the process and
    // deleted on detach. So `previousOverlayState` is undefined on every
    // projector restart and every re-attach, and `newlyDeletedDiagramIds`
    // becomes the WHOLE tombstone list again — this is the ORDINARY path, not
    // an exotic one. The rows are already gone, so a correct pass removes zero
    // and `adjustWorkspaceCount` is never even called (`if (!delta) return`).
    //
    // Sourcing the delta from `newlyDeletedDiagramIds.length` instead reads
    // identically on a first projection and on two same-process passes, so
    // only a restart shows the difference — while in production it subtracts the
    // entire deletion history from `diagram_count` on EVERY restart, clamped at
    // zero by GREATEST(0, …). The footer then lies permanently about a
    // workspace nothing is wrong with, and no alarm exists for it:
    // `diagram-tombstone-honoured` compares the list with `ro_diagrams` and is
    // perfectly happy.
    const first = harness()

    await first.internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
    )
    // Anti-void guard n°1: the first pass really did remove a row and really
    // did subtract for it.
    const firstCounter = first.callsMatching('ro_workspace_stats')
      .filter((call) => call.sql.includes('diagram_count'))
    expect(firstCounter).toHaveLength(1)
    expect(firstCounter[0].params).toContain(-1)

    // The projector restarts: a fresh instance, the SAME database.
    const restarted = harness({ rows: first.deletedDiagramRows })

    await restarted.internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 8,
    )

    // Anti-void guard n°2: the restarted instance really did replay the whole
    // list — without this the test would pass on a short circuit instead of on
    // the row count.
    const replayed = restarted.callsMatching('DELETE FROM ro_diagrams')
    expect(replayed).toHaveLength(1)
    expect(replayed[0].params).toContainEqual(['dg-gone'])

    // Zero rows went, so nothing may be subtracted — not even zero.
    expect(
      restarted.callsMatching('ro_workspace_stats').filter((call) => call.sql.includes('diagram_count')),
    ).toHaveLength(0)
  })

  it('incremente la generation de rendu d un diagramme tombstone', async () => {
    // The `diagramIds` arm of `bumpDiagramRenderGenerations`: without it
    // `diagramRenderRedisCache` keeps serving a cached render of a diagram
    // that no longer exists — the canvas opens a deleted diagram from cache.
    const { internal, callsMatching } = harness()

    await internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
    )

    const bump = callsMatching('read_model_diagram_render_generations')
    expect(bump).toHaveLength(1)
    expect(bump[0].params).toContainEqual(['dg-gone'])
  })

  it('capture la base sparse-draft avant de supprimer', async () => {
    // `captureSparseDraftEntityBases(… "diagram" …)` must run first. An
    // active sparse child draft serves untouched entities from its parent's
    // read model; without the base capture the deleted diagram resolves to
    // nothing there and the child's merge computes a diff against a void.
    const { internal, callsMatching } = harness()

    await internal.projectMeta(
      descriptorOf('meta'), baseMeta({ deletedDiagramIds: ['dg-gone'] }), 7,
    )

    const captures = callsMatching('draft_sparse_base_entities')
      .filter((call) => call.params.includes('diagram'))
    expect(captures).toHaveLength(1)
    expect(captures[0].params).toContainEqual(['dg-gone'])
  })

  it('n ecrit rien quand aucun diagramme n est tombstone', async () => {
    // The void guard for the whole group: a projection of an ordinary ModelMeta
    // must not touch a single diagram table. Without this, a test above could
    // be passing on a delete that runs unconditionally.
    const { internal, ran } = harness()

    await internal.projectMeta(descriptorOf('meta'), baseMeta(), 7)

    expect(ran('DELETE FROM ro_diagrams')).toBe(false)
    expect(ran('DELETE FROM ro_diagram_objects')).toBe(false)
    expect(ran('read_model_diagram_render_generations')).toBe(false)
  })
})
