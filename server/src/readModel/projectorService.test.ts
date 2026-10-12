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
import { change, from, getHeads } from '@automerge/automerge'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ColdBuildAdmission, ColdBuildAdmissionStoppedError } from './coldBuildAdmission.js'
import { setDocumentReleaseGuard } from './documentReleaseGuard.js'
import {
  documentRepoState,
  DocumentPermanentlyUnavailableError,
  DocumentTemporarilyUnavailableError,
} from './documentResolution.js'
import { documentRetryRegistry } from './documentRetryQueue.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { syncedHandle } from '../automergeRepoCompat.js'
import {
  awaitInitialDiagramProbe,
  documentResolveDeadlineMs,
  residentSweepIntervalMs,
  extractModelEntities,
  ProjectorFleet,
  ProjectorOwnershipError,
  createReconcilingGuard,
  resolveHandleWithRetry,
  startReadModelProjector,
} from './projectorService.js'
import type { Queryable } from './types.js'
import type { WorkspaceKey } from './projector.js'
import { digestOfIds } from './contentDigest.js'
import { ReadModelWriteFenceError } from './health.js'
import { refusedProjectionCount, resetRefusedProjections } from './projectionIntegrity.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** Let the projector's fire-and-forget health writes and queue tasks settle. */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

/**
 * Drain microtasks until `predicate` holds, then stop.
 *
 * A FIXED `await Promise.resolve()` count is a bet on exactly how many awaits
 * the fleet happens to take before it reaches `startProjector` — and the bet
 * loses the day a guard (such as the static-workspace SQL probe) is added in
 * FRONT of it. Stop on the condition, not on a turn count; the turn count
 * stays only as the runaway bound.
 */
async function settleUntil(predicate: () => boolean, turns = 50): Promise<void> {
  for (let index = 0; index < turns && !predicate(); index += 1) await Promise.resolve()
}

type FakeDoc = Record<string, unknown>

/**
 * `#docSynchronizers` for a fake, DERIVED from its handle table and never a
 * second knob, and a live GETTER rather than a snapshot because `handles` is
 * mutated in place by the `removeFromCache` stubs below.
 *
 * The real `Repo` cannot hold a document in one table and not the other:
 * `#ensureQuery` attaches every source synchronously as it registers the
 * query, and `removeFromCache` and `delete` drop both together. Production
 * reads residency through the synchronizer precisely because that equality
 * holds and the alternative rebuilds a whole Record per access
 * (`automergeRepoCompat.ts`; the equality is pinned against a real Repo in
 * `automergeRepoCompat.seam.test.ts`). A fake offering `handles` alone models
 * a repo that CANNOT EXIST, and stays green over code reading the table
 * production actually consults.
 *
 * Copied rather than imported: `src/lib/automerge/handleRetry.test.ts` and
 * `documentResolution.test.ts` carry the same nine lines, and a `*.test.ts`
 * must not import from another `*.test.ts` — the two programs do not even
 * share a module graph.
 */
function syncLayerOver(handles: Record<string, unknown>) {
  return {
    get docSynchronizers() {
      return Object.fromEntries(
        Object.entries(handles).map(([id, handle]) => [id, { query: {
          handle,
          peek: () => ({ state: (handle as { state?: string }).state, handle }),
        } }]),
      )
    },
  }
}

/**
 * The ONE place the small inline fixtures below build a fake `Repo`, so the
 * handle table and the sync layer over it can never be set apart — which is
 * the drift itself, not a tidiness preference.
 *
 * `documentRepoState` reads residency through `syncedHandle`
 * (`automergeRepoCompat.ts`, O(1)), not through `repo.handles`. A
 * fixture that offers `handles` and NO sync layer makes that read THROW, the
 * probe's own `try { … } catch { return 'unknown' }` swallows it,
 * `findWithProgress` is never called, and every classification arm is skipped:
 * the probe answers `'unknown'` for every input while the suite stays green.
 *
 * `Object.assign` onto the literal, NOT a spread of it: a spread would read
 * every property once and freeze any getter a fixture defines.
 */
function fakeRepo(parts: Record<string, unknown> & { handles: Record<string, unknown> }): Repo {
  return Object.assign(parts, { synchronizer: syncLayerOver(parts.handles) }) as unknown as Repo
}

describe('fakeRepo — la couche de synchronisation est CÂBLÉE, pas décorative', () => {
  it('un dépôt qui déclare `ready` se lit `ready`, et la table reste vivante', () => {
    // Catches a factory that forgets `synchronizer`: `syncedHandle` would then
    // throw a TypeError, `documentRepoState` would swallow it and answer
    // `'unknown'` for any input — so every classification assertion in this
    // file would pass without the repo ever being asked.
    const handles: Record<string, unknown> = { abc: { documentId: 'abc', state: 'ready' } }
    const repo = fakeRepo({
      findWithProgress: () => ({ peek: () => ({ state: 'ready' }) }),
      handles,
    })

    expect(documentRepoState(repo, 'automerge:abc')).toBe('ready')
    // …and through the seam production actually reads, a GETTER rather than a
    // snapshot: `removeFromCache` mutates `handles` in place, and a copy taken
    // at construction would misreport residency.
    expect(syncedHandle(repo, 'abc')).toBe(handles.abc)
    delete handles.abc
    expect(syncedHandle(repo, 'abc')).toBeUndefined()
  })
})

/**
 * An Automerge repo whose contents are a plain map. A url absent from the map
 * behaves exactly like automerge-repo's unavailable document, so the projector
 * exercises the real classification path. Every `find` is recorded, which is
 * what the concurrency and no-retry gates below assert on.
 */
function fakeAutomergeRepo(docs: Record<string, FakeDoc>) {
  const findCalls: string[] = []
  /**
   * A Set, because `DocHandle` DEDUPLICATES by identity — measured, not
   * assumed: it defines its own `on`, and `on(f); on(f); on(g)` leaves two
   * listeners, fires `f` once per change, and one `off(f)` removes it. That is
   * NOT raw eventemitter3 behaviour (there the same registration stacks and
   * fires twice); an array here would model a double-fire that production
   * cannot produce.
   *
   * So a redundant re-watch is harmless to the change stream. It is not free:
   * each one costs a `repo.find` and a `cleanups` entry. `onCalls` counts the
   * ATTEMPTS separately, which is the cost that is real and the only thing an
   * anti-double-watch assertion can honestly pin.
   */
  const listeners = new Map<string, Set<() => void>>()
  const onCalls = new Map<string, number>()
  const handles: Record<string, unknown> = {}
  let active = 0
  let maxActive = 0

  const handleFor = (url: string) => {
    const documentId = url.replace(/^automerge:/, '')
    const existing = handles[documentId]
    if (existing) return existing
    const registered = new Set<() => void>()
    listeners.set(url, registered)
    const handle = {
      documentId,
      url,
      state: 'ready',
      doc: () => docs[url],
      whenReady: async () => undefined,
      on: (_event: string, fn: () => void) => {
        onCalls.set(url, (onCalls.get(url) ?? 0) + 1)
        registered.add(fn)
      },
      off: (_event: string, fn: () => void) => { registered.delete(fn) },
    }
    handles[documentId] = handle
    return handle
  }

  const repo = {
    handles,
    // DERIVED from `handles` and never a second knob — see `syncLayerOver`.
    synchronizer: syncLayerOver(handles),
    flush: async () => undefined,
    removeFromCache: async (documentId: string) => { delete handles[documentId] },
    findWithProgress: (url: string) => ({ peek: () => ({ state: docs[url] ? 'ready' : 'unavailable' }) }),
    find: async (url: string) => {
      findCalls.push(url)
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        await Promise.resolve()
        await Promise.resolve()
        if (!docs[url]) throw new Error(`Document ${url} is unavailable`)
        return handleFor(url)
      } finally {
        active -= 1
      }
    },
  }

  return {
    repo: repo as unknown as Repo,
    findCalls,
    findsFor: (url: string) => findCalls.filter((candidate) => candidate === url).length,
    maxConcurrentFinds: () => maxActive,
    publish: (url: string, doc: FakeDoc) => { docs[url] = doc },
    emitChange: (url: string) => { for (const fn of [...(listeners.get(url) ?? [])]) fn() },
    /** Effective watchers — deduplicated, as `DocHandle` does. */
    listenerCount: (url: string) => (listeners.get(url)?.size ?? 0),
    /** Registration ATTEMPTS. Deduplication makes a redundant re-watch harmless
     * to the change stream but not free: it costs a `repo.find` and a `cleanups`
     * entry every time, unbounded. This is the observable that survives the
     * dedup. */
    onCallCount: (url: string) => (onCalls.get(url) ?? 0),
  }
}

/** A Queryable that records every statement and can fail a targeted one. */
function fakeDb() {
  const queries: string[] = []
  /** Statement text AND bound parameters. The text alone cannot distinguish a
   * compare-and-set from the same statement with a NULL id, because the
   * `$3 IS NULL OR ...` branch is in the SQL either way — an assertion on the
   * text is vacuous for exactly the property worth pinning. */
  const calls: Array<{ text: string; params: unknown[] }> = []
  const completed: string[] = []
  let generation = 0
  let arrivalSeq = 0
  /** What the row-write fence currently holds — set by the claim, read by the
   * assert. Exposed via `setFence` so a test can play the takeover that
   * re-claims it out from under a running projector. */
  let fence: string | null = null
  let failOn: RegExp | null = null
  let failCode = '57P01'
  /**
   * Hold ONE matching statement open.
   *
   * The only way to reach a projector's post-`stop()` paths from a test: a pass
   * has to still be in flight when the teardown runs, and the teardown clears
   * every piece of state a health publish consults. A slow pool produces exactly
   * this shape. Self-disarming, so it holds the first match and nothing after.
   */
  let holdOn: RegExp | null = null
  let releaseHeld: (() => void) | null = null
  /** Does `read_model_static_workspaces` carry this workspace? FALSE by
   * default: every fixture in this file is an ordinary workspace, which is what
   * lets the ordinary projector write at all. `setStatic` plays a promotion
   * landing under an attached projector. */
  let isStatic = false
  const db: Queryable = {
    query: async (text: string, params?: unknown[]) => {
      queries.push(text)
      calls.push({ text, params: params ?? [] })
      if (holdOn?.test(text)) {
        holdOn = null
        await new Promise<void>((resolve) => { releaseHeld = resolve })
      }
      // COMPLETION order, which is what the row actually ends up reflecting.
      // `queries` records issue order and cannot see two statements racing on
      // different pool connections; this can.
      completed.push(text)
      if (failOn?.test(text)) {
        // The SQLSTATE is a parameter, because the code the projector sees
        // decides what it does with the failure: `57P01` is a genuine fault to
        // be recorded, `55P03` means another writer holds the projection mutex
        // and must NOT be recorded onto that writer's row.
        throw Object.assign(
          new Error(failCode === '55P03' ? 'canceling statement due to lock timeout'
            : 'terminating connection due to administrator command'),
          { code: failCode },
        )
      }
      if (/read_model_static_workspaces/.test(text)) {
        // PARAMS-SENSITIVE, and that is the point. A fake that answers the same
        // for any parameters cannot tell a correctly-threaded workspace key
        // from a mis-threaded one (handing the helper or the pre-check the
        // WRONG workspace). In production that is a mutex on a key
        // nobody else takes (serializing nothing) plus an authority check
        // against a workspace that does not exist, which answers `false` and
        // therefore admits `'ordinary'` unconditionally.
        const asked = (params ?? []) as string[]
        const mine = asked[0] === WORKSPACE.landscapeId && asked[1] === WORKSPACE.versionId
        return { rows: [{ present: mine ? isStatic : false }] as never[], rowCount: 1 }
      }
      if (/RETURNING observed_generation/.test(text)) {
        generation += 1
        return { rows: [{ observed_generation: generation }] as never[], rowCount: 1 }
      }
      // The arrival-watermark clock: a monotone counter, like the
      // real sequence. Returning `rows: []` here would crash
      // captureArrivalWatermark on rows[0] — the clock is consumed on every
      // projection pass, so the fake must tick.
      if (/nextval\('automerge_arrival_seq'\)/.test(text)) {
        arrivalSeq += 1
        return { rows: [{ w: String(arrivalSeq) }] as never[], rowCount: 1 }
      }
      // The row-write fence: the cold build's claim is a CAS on the
      // previously-observed value, every projection reads the fence back (the
      // pre-`begin` check and the in-transaction FOR UPDATE assert share one
      // statement shape). The fake must remember the claim and honor the CAS
      // — answering `rows: []` to the reads would abort every tracked
      // projection in the suite, and unconditionally accepting the claim
      // would hide a missed CAS from the unit tier.
      if (/write_fence = EXCLUDED\.write_fence/.test(text)) {
        const expectedPrevious = (params?.[4] as string | null | undefined) ?? null
        if (fence !== expectedPrevious) return { rows: [], rowCount: 0 }
        fence = (params?.[3] as string | undefined) ?? null
        return { rows: [], rowCount: 1 }
      }
      if (/SELECT write_fence FROM read_model_projection_state/.test(text)) {
        return { rows: [{ write_fence: fence }] as never[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return {
    db,
    queries,
    calls,
    failWhen: (pattern: RegExp | null, code = '57P01') => { failOn = pattern; failCode = code },
    holdWhen: (pattern: RegExp | null) => { holdOn = pattern },
    release: () => { releaseHeld?.(); releaseHeld = null },
    held: () => releaseHeld !== null,
    completed,
    matching: (pattern: RegExp) => queries.filter((text) => pattern.test(text)),
    callsMatching: (pattern: RegExp) => calls.filter(({ text }) => pattern.test(text)),
    /** The takeover, from the row's point of view: another instance's cold
     * build claimed the fence. */
    setFence: (value: string | null) => { fence = value },
    getFence: () => fence,
    /** Promote the workspace UNDER a projector that is already attached.
     *
     * The fleet's `isStaticWorkspace` refusal runs once, at `ensure()`, so it
     * is a verdict with a timestamp; nothing re-checks afterwards and nothing
     * detaches an already-resident ordinary projector when its workspace is
     * promoted. That is reachable in production through both CLI doors, which
     * pass no hooks at all and run in a different process from the fleet. */
    setStatic: (value: boolean) => { isStatic = value },
  }
}

/** Statements unique to one code path (the schema DDL mentions these tables and
 * columns too, so a bare table name would match setup noise). */
const FLOW_PROJECTION = /SELECT DISTINCT connection_id FROM ro_connection_flows/
const MARK_DEGRADED = /degraded_since = COALESCE/
const CLEAR_DEGRADED = /degraded_since = NULL/

/**
 * The LAST thing this workspace said about its own health. Counting marks and
 * clears separately cannot distinguish "degraded, then recovered" from
 * "recovered, then degraded", and both writes are expected in the same run
 * now that attach publishes health unconditionally — so order is the assertion.
 */
function lastHealthWrite(queries: readonly string[]): 'mark' | 'clear' | undefined {
  for (let i = queries.length - 1; i >= 0; i -= 1) {
    if (MARK_DEGRADED.test(queries[i])) return 'mark'
    if (CLEAR_DEGRADED.test(queries[i])) return 'clear'
  }
  return undefined
}

const WORKSPACE: WorkspaceKey = { landscapeId: 'ls-doc', versionId: 'v1' }

/** A sharded root whose registry references `diagrams`. */
function workspaceDocs(diagrams: Record<string, unknown>, extra: Record<string, FakeDoc> = {}) {
  return {
    'automerge:root': { modelMetaUrl: 'automerge:meta', modelUrl: '', shardUrls: ['automerge:registry'] },
    'automerge:meta': { objectShardUrls: [], connectionShardUrls: [], groups: {} },
    'automerge:registry': { diagrams },
    ...extra,
  }
}

describe('extractModelEntities (pure)', () => {
  it('keeps the captured shard snapshot and its heads together when a change arrives during the yield', async () => {
    for (const field of ['objects', 'connections'] as const) {
      const original = from({ [field]: { entity: { id: 'entity', name: 'before' } } })
      let current = original
      const model = await extractModelEntities({ modelMetaUrl: 'meta' }, async url => {
        if (url === 'meta') return { groups: {},
          objectShardUrls: field === 'objects' ? ['first', 'second'] : [],
          connectionShardUrls: field === 'connections' ? ['first', 'second'] : [] }
        if (url === 'first') {
          setImmediate(() => { current = change(current, doc => { doc[field].entity.name = 'after' }) })
          return current
        }
        expect(current[field].entity.name).toBe('after')
        return { [field]: {} }
      })
      const heads = field === 'objects' ? model.objectShardHeadsByUrl : model.connectionShardHeadsByUrl
      expect(model[field]).toEqual([{ id: 'entity', name: 'before' }])
      expect(heads.get('first')).toEqual(getHeads(original))
      expect(heads.get('first')).not.toEqual(getHeads(current))
    }
  })

  it('admits I/O between object and connection shard loads while preserving overlays and tombstones', async () => {
    const order: string[] = []
    const docs: Record<string, unknown> = {
      meta: { objectShardUrls: ['os0', 'os1'], connectionShardUrls: ['cs0', 'cs1'], groups: {},
        deletedObjectIds: ['deleted-object'], deletedConnectionIds: ['deleted-connection'] },
      os0: { objects: { o: { id: 'o', name: 'base' }, 'deleted-object': { id: 'deleted-object' } } },
      os1: { objects: { o: { id: 'o', name: 'edited' } } },
      cs0: { connections: { c: { id: 'c', name: 'base' }, 'deleted-connection': { id: 'deleted-connection' } } },
      cs1: { connections: { c: { id: 'c', name: 'edited' } } },
    }
    const model = await extractModelEntities({ modelMetaUrl: 'meta' }, async url => {
      order.push(`load-${url}`)
      if (url !== 'meta') setImmediate(() => order.push(`io-${url}`))
      return docs[url]
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const [first, second] of [['os0', 'os1'], ['cs0', 'cs1']]) {
      expect(order.indexOf(`io-${first}`)).toBeGreaterThan(order.indexOf(`load-${first}`))
      expect(order.indexOf(`io-${first}`)).toBeLessThan(order.indexOf(`load-${second}`))
    }
    expect(model.objects).toEqual([{ id: 'o', name: 'edited' }])
    expect(model.connections).toEqual([{ id: 'c', name: 'edited' }])
    expect([...model.objectsByShardUrl.keys()]).toEqual(['os0', 'os1'])
    expect([...model.connectionsByShardUrl.keys()]).toEqual(['cs0', 'cs1'])
    expect(model.defects).toEqual([])
  })

  it('bounds shard resolver concurrency during a large cold build', async () => {
    const shardUrls = Array.from({ length: 20 }, (_, index) => `reg-${index}`)
    let active = 0
    let maximum = 0
    const resolve = async (url: string) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((done) => setTimeout(done, 1))
      active -= 1
      if (url === 'meta') return { objectShardUrls: [], connectionShardUrls: [], groups: {} }
      return { diagrams: {} }
    }

    await extractModelEntities({ modelMetaUrl: 'meta', shardUrls }, resolve)

    expect(maximum).toBe(3)
  })

  it('reads a sharded model: object/connection shards + meta groups + registry diagrams', async () => {
    const docs: Record<string, unknown> = {
      meta: { objectShardUrls: ['os0', 'os1'], connectionShardUrls: ['cs0'], groups: { g1: { id: 'g1', name: 'G' } } },
      os0: { objects: { o0: { id: 'o0' }, o1: { id: 'o1' } } },
      os1: { objects: { o2: { id: 'o2' } } },
      cs0: { connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o1' } } },
      // diagram registry shards (root.shardUrls → RegistryShard.diagrams)
      reg0: { diagrams: { d1: { id: 'd1', objectIds: ['o0'], parentObjectId: 'o2' }, d2: { id: 'd2', objectIds: ['o1'] } } },
    }
    const resolve = async (url: string) => docs[url]
    const m = await extractModelEntities({ modelMetaUrl: 'meta', shardUrls: ['reg0'] }, resolve)
    expect(m.objects.map((o) => o.id).sort()).toEqual(['o0', 'o1', 'o2'])
    expect(m.connections.map((c) => c.id)).toEqual(['c0'])
    expect(m.groups.map((g) => g.id)).toEqual(['g1'])
    expect(m.diagrams.map((d) => d.id).sort()).toEqual(['d1', 'd2'])
    expect(m.objectShardUrls).toEqual(['os0', 'os1'])
    expect(m.registryShardUrls).toEqual(['reg0'])
  })

  it('reads a monolithic model (ModelDoc, no shards)', async () => {
    const docs: Record<string, unknown> = {
      model: {
        objects: { o0: { id: 'o0' } },
        connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o0' } },
        groups: { g1: { id: 'g1' } },
      },
    }
    const m = await extractModelEntities({ modelUrl: 'model' }, async (u) => docs[u])
    expect(m.objects.map((o) => o.id)).toEqual(['o0'])
    expect(m.connections.map((c) => c.id)).toEqual(['c0'])
    expect(m.groups.map((g) => g.id)).toEqual(['g1'])
    expect(m.objectShardUrls).toEqual([])
  })

  it('is defensive: empty for an undefined root or missing docs', async () => {
    expect(await extractModelEntities(undefined, async () => undefined)).toMatchObject({ objects: [], connections: [], groups: [] })
    expect(await extractModelEntities({ modelMetaUrl: 'm' }, async () => undefined)).toMatchObject({ objects: [], connections: [] })
    expect(await extractModelEntities({ modelUrl: 'm' }, async () => undefined)).toMatchObject({ objects: [] })
  })
})

describe('resolveHandleWithRetry', () => {
  it('reloads durable storage after an earlier find cached the document as unavailable', async () => {
    const documentId = 'child-doc'
    const unavailable = { documentId, state: 'unavailable' }
    const ready = { documentId, state: 'ready', whenReady: vi.fn(async () => undefined) }
    const handles: Record<string, unknown> = { [documentId]: unavailable }
    const removeFromCache = vi.fn(async () => { delete handles[documentId] })
    const find = vi.fn()
      .mockRejectedValueOnce(new Error('Document is unavailable'))
      .mockImplementationOnce(async () => {
        expect(handles[documentId]).toBeUndefined()
        return ready
      })
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'unavailable' }) }),
      handles,
      removeFromCache,
    })

    await expect(resolveHandleWithRetry(repo, `automerge:${documentId}`, {
      tries: 2,
      delayMs: 0,
    })).resolves.toBe(ready)
    expect(removeFromCache).toHaveBeenCalledWith(documentId)
    expect(find).toHaveBeenCalledTimes(2)
  })

  it('propagates an unexpected failure immediately instead of spending the retry budget', async () => {
    const outage = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })
    const find = vi.fn(async () => { throw outage })
    const removeFromCache = vi.fn(async () => undefined)
    // The repo does NOT report this document as unavailable, so nothing
    // corroborates a retry: the failure has to surface.
    const repo = fakeRepo({
      find,
      handles: { abc: { documentId: 'abc', state: 'ready' } },
      findWithProgress: () => ({ peek: () => ({ state: 'ready' }) }),
      removeFromCache,
    })

    // ANTI-VACUITY. With `handles` and no sync layer the residency read would
    // throw, the probe's own catch would answer `'unknown'` — which classifies
    // as `unexpected` too — and the failure would surface without the repo
    // ever being asked. This line pins that it really is asked, and really
    // answers `ready`; a probe reporting `unavailable` would spend the whole
    // 20-try budget instead.
    expect(documentRepoState(repo, 'automerge:abc')).toBe('ready')

    await expect(resolveHandleWithRetry(repo, 'automerge:abc', { tries: 20, delayMs: 0 }))
      .rejects.toBe(outage)
    expect(find).toHaveBeenCalledTimes(1)
    expect(removeFromCache).not.toHaveBeenCalled()
  })

  it('fails fast on a reference that can never resolve', async () => {
    for (const message of ['Document abc was deleted', "Invalid AutomergeUrl: 'abc'"]) {
      const find = vi.fn(async () => { throw new Error(message) })
      const repo = fakeRepo({
        find,
        handles: {},
        findWithProgress: () => ({ peek: () => ({ state: 'unavailable' }) }),
        removeFromCache: vi.fn(async () => undefined),
      })

      await expect(resolveHandleWithRetry(repo, 'automerge:abc', { tries: 20, delayMs: 0 }))
        .rejects.toBeInstanceOf(DocumentPermanentlyUnavailableError)
      expect(find).toHaveBeenCalledTimes(1)
    }
  })

  it('reports an exhausted budget as a retryable document error carrying the cause', async () => {
    const cause = new Error('Document abc is unavailable')
    const repo = fakeRepo({
      find: vi.fn(async () => { throw cause }),
      handles: {},
      findWithProgress: () => ({ peek: () => ({ state: 'unavailable' }) }),
      removeFromCache: vi.fn(async () => undefined),
    })

    const failure = await resolveHandleWithRetry(repo, 'automerge:abc', { tries: 3, delayMs: 0 })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(failure).toMatchObject({ code: 'read_model_document_unavailable', retryable: true, attempts: 3 })
    expect((failure as Error).cause).toBe(cause)
  })

  it('stops retrying as soon as its signal is aborted', async () => {
    const controller = new AbortController()
    const find = vi.fn(async () => { throw new Error('Document abc is unavailable') })
    const repo = fakeRepo({
      find,
      handles: {},
      findWithProgress: () => ({ peek: () => ({ state: 'unavailable' }) }),
      removeFromCache: vi.fn(async () => undefined),
    })

    const pending = resolveHandleWithRetry(repo, 'automerge:abc', {
      tries: 50,
      delayMs: 0,
      sleep: async () => { controller.abort() },
      signal: controller.signal,
    })

    await expect(pending).rejects.toThrow()
    expect(find).toHaveBeenCalledTimes(1)
  })
})

/**
 * `repo.find()` CAN NEVER SETTLE, and does so on the shape production runs.
 *
 * With a network adapter attached and zero connected peers — every server
 * between binding its port and the first browser connecting — a document in
 * neither storage nor any peer leaves its DocumentQuery in `loading` forever: no
 * source ever reports unavailable, so `find` neither resolves nor rejects.
 * Measured against @automerge/automerge-repo 2.6.0-alpha.2 on the same missing
 * document: no network adapter -> rejects in 2 ms; NodeWSServerAdapter with zero
 * peers -> still pending at 10 000 ms.
 *
 * Without a ceiling, a projector can hang until a browser connects — no
 * attach, every /api/model/* route at 503, and the cold-build admission slots
 * held.
 *
 * These tests pin the ceiling. They use a `find` that returns a promise which is
 * NEVER settled by the test, so any regression that drops the deadline does not
 * fail them — it hangs them, and vitest reports the timeout.
 */
describe('a repo.find that never settles', () => {
  const neverSettles = () => {
    const calls: string[] = []
    const repo = fakeRepo({
      find: (url: string) => { calls.push(url); return new Promise<never>(() => {}) },
      handles: {},
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      removeFromCache: vi.fn(async () => undefined),
    })
    return { repo, calls }
  }

  it('is bounded by the deadline and reported as unavailable, not as a cancellation', async () => {
    // `unavailable` is the whole point: `aborted` would make
    // `tryAttachDiagramDoc` drop the document silently, so it would never reach
    // the retry queue and never be counted as degraded either.
    const { repo, calls } = neverSettles()

    const failure = await resolveHandleWithRetry(repo, 'automerge:abc', {
      tries: 2, delayMs: 0, deadlineMs: 30,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(failure).toMatchObject({ code: 'read_model_document_unavailable', retryable: true })
    expect(calls.length).toBe(2)
  }, 10_000)

  it('still treats the CALLER\'s abort as a cancellation while a deadline is armed', async () => {
    // The two aborts arrive through the same signal and must not be conflated:
    // a deadline means "queue it", the caller's own signal means "we are going
    // away". Conflating them reports a SHUTDOWN as a missing document, which
    // degrades the workspace on the way out and leaves that mark behind.
    //
    // `tries: 1` is what makes this falsifiable. With more tries the loop's own
    // `signal.throwIfAborted()` re-raises the abort on the next iteration and
    // hides the confusion; with one try the loop simply ends, and a conflating
    // implementation returns `DocumentTemporarilyUnavailableError` instead.
    const controller = new AbortController()
    const { repo, calls } = neverSettles()

    const pending = resolveHandleWithRetry(repo, 'automerge:abc', {
      tries: 1, delayMs: 0, deadlineMs: 5_000, signal: controller.signal,
    })
    queueMicrotask(() => controller.abort())

    const failure = await pending.catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect((failure as Error).name).toMatch(/Abort/)

    // And an abort mid-budget stops the loop rather than spending it.
    const second = new AbortController()
    const { repo: repo2, calls: calls2 } = neverSettles()
    const pending2 = resolveHandleWithRetry(repo2, 'automerge:abc', {
      tries: 5, delayMs: 0, deadlineMs: 5_000, signal: second.signal,
    })
    queueMicrotask(() => second.abort())
    await pending2.catch(() => undefined)
    expect(calls2.length).toBe(1)
    expect(calls.length).toBe(1)
  }, 10_000)

  it('does not await a handle that came back not-ready, and calls it permanent', async () => {
    // Two properties in one, because they are the same line.
    //
    // (1) `DocHandle.whenReady()` returns a FOREVER promise — never a rejection —
    //     for any state but `ready`, and it runs AFTER `find` resolves, so it is
    //     a second hang that no deadline on `find` can bound.
    // (2) `DocHandle.state` is `deleted` or `ready` and NOTHING ELSE in
    //     automerge-repo 2.6.0-alpha.2 (`this.#document.deleted ? "deleted" :
    //     "ready"`), so `deleted` is the only state reachable here. Reporting it
    //     as *temporarily* unavailable would buy a permanently dead reference
    //     the full retry budget and end in a degradation, where `invalid` is the
    //     tolerated warn-once path.
    //
    // `deleted` is therefore the case that matters; the second row guards the
    // unknown-future-state case, which must not be retried either.
    for (const state of ['deleted', 'some-future-state']) {
      const handle = { documentId: 'abc', state, whenReady: () => new Promise<never>(() => {}) }
      const find = vi.fn(async () => handle)
      const repo = fakeRepo({
        find,
        handles: {},
        findWithProgress: () => ({ peek: () => ({ state: 'ready' }) }),
        removeFromCache: vi.fn(async () => undefined),
      })

      await expect(resolveHandleWithRetry(repo, 'automerge:abc', { tries: 20, delayMs: 0, deadlineMs: 5_000 }))
        .rejects.toBeInstanceOf(DocumentPermanentlyUnavailableError)
      // Permanent means permanent: one attempt, not the budget.
      expect(find).toHaveBeenCalledTimes(1)
    }
  }, 10_000)

  it('lets the projector attach anyway, with the stuck diagrams queued', async () => {
    // The production symptom, end to end: the boot probe must not be able to
    // hold the cold build open. Everything but the diagram documents resolves.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'Stuck', objectIds: [], docUrl: 'automerge:d1doc' },
      d2: { id: 'd2', name: 'Also stuck', objectIds: [], docUrl: 'automerge:d2doc' },
    })
    const inner = fakeAutomergeRepo(docs)
    const realFind = (inner.repo as unknown as { find: (url: string) => Promise<unknown> }).find
      .bind(inner.repo)
    const wedged = {
      ...inner.repo,
      find: (url: string) => /doc$/.test(url) ? new Promise<never>(() => {}) : realFind(url),
    } as unknown as Repo
    const store = fakeDb()
    const scheduledBefore = documentRetryRegistry.snapshot().scheduled

    // The ambient default is set absurdly high for the duration of this test, so
    // a projector that fails to pass its injected ceiling down to the diagram
    // probe hangs and this test times out. Without this the same regression
    // merely makes the test slow, and slow still passes.
    //
    // Restored in a `finally` around the WHOLE body, never chained onto the
    // promise under test: that promise not settling is precisely the regression
    // this test exists to catch, so a `.finally()` on it would never run and
    // 600 s would leak into every test after this one.
    const previous = process.env.READ_MODEL_RESOLVE_DEADLINE_MS
    process.env.READ_MODEL_RESOLVE_DEADLINE_MS = '600000'
    let stop: (() => void) | undefined
    try {
      stop = await startReadModelProjector(
        wedged, 'automerge:root', store.db, WORKSPACE, undefined, 0, 40,
      )
      // Attached: the cold build committed and the projector is serving. Without
      // the ceiling this line is never reached — the `await` above never returns.
      //
      // The probe is DEFERRED as well as bounded: attachment does not wait for
      // the probe at all. Settling it here is only so the queue assertion
      // below observes the state it means to — the 40 ms injected ceiling is
      // what keeps that settle from becoming the 600 s wait this test forbids.
      await awaitInitialDiagramProbe(WORKSPACE)
      expect(store.matching(/projector_attached = true/).length).toBe(1)
      // And the stuck documents reached the bounded queue rather than being
      // dropped as cancellations. `scheduled` is a monotonic counter, but the
      // REGISTRY sums only queues still registered and a projector unregisters
      // its own on stop — so this delta is safe because every test in this file
      // stops inside a `finally`, not because the aggregate cannot fall.
      expect(documentRetryRegistry.snapshot().scheduled - scheduledBefore).toBeGreaterThanOrEqual(2)
      // Attached is NOT healthy. Two documents are still owed, so nothing may
      // have told the row this workspace is fine.
      expect(store.matching(CLEAR_DEGRADED).length).toBe(0)
    } finally {
      stop?.()
      if (previous === undefined) delete process.env.READ_MODEL_RESOLVE_DEADLINE_MS
      else process.env.READ_MODEL_RESOLVE_DEADLINE_MS = previous
    }
  }, 20_000)
})

describe('the deadline knob itself', () => {
  // A ceiling with an off switch that a dangling `VAR=` can flip is not a
  // ceiling. `Number('')` is 0 and 0 is finite, so the obvious
  // `Number.isFinite(v) && v >= 0` admits the ONE value that disables it — and
  // perversely falls back safely for garbage. Both sibling parsers in this
  // directory (documentRetryQueue `boundedNumber`, coldBuildAdmission
  // `boundedInteger`) already treat blank as unset and require a minimum.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['zero', '0'],
    ['negative', '-1'],
    ['garbage', 'abc'],
    ['NaN-ish', 'Infinity'],
  ])('refuses to disable the ceiling for %s', (_label, raw) => {
    const env = raw === undefined ? {} : { READ_MODEL_RESOLVE_DEADLINE_MS: raw }
    expect(documentResolveDeadlineMs(env)).toBeGreaterThan(0)
  })

  it('honours a real value', () => {
    expect(documentResolveDeadlineMs({ READ_MODEL_RESOLVE_DEADLINE_MS: '250' })).toBe(250)
  })
})

describe('residentSweepIntervalMs', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['negative', '-1'],
    ['garbage', 'abc'],
    ['NaN-ish', 'Infinity'],
  ])('keeps the re-attach sweep running for %s', (_label, raw) => {
    const env = raw === undefined ? {} : { READ_MODEL_RESIDENT_SWEEP_MS: raw }
    expect(residentSweepIntervalMs(env)).toBe(1_000)
  })

  it('disables the sweep only on an explicit 0', () => {
    expect(residentSweepIntervalMs({ READ_MODEL_RESIDENT_SWEEP_MS: '0' })).toBe(0)
  })

  it('honours a real value', () => {
    expect(residentSweepIntervalMs({ READ_MODEL_RESIDENT_SWEEP_MS: '250' })).toBe(250)
  })
})

describe('missing diagram documents (bounded resolution)', () => {
  it('publishes the core model and bounds 1000 unresolvable references to 4 resolutions and 1 timer', async () => {
    const diagrams = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [
      `d${index}`,
      { id: `d${index}`, name: `D${index}`, docUrl: `automerge:missing-${index}`, objectIds: [] },
    ]))
    const repo = fakeAutomergeRepo(workspaceDocs(diagrams))
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // The core model is committed before any diagram document is attempted.
      expect(store.matching(/DELETE FROM ro_objects/).length).toBeGreaterThan(0)
      // Exactly one attempt per document, four at a time, never a thousand.
      expect(repo.findsFor('automerge:missing-0')).toBe(1)
      expect(repo.findCalls.filter((url) => url.startsWith('automerge:missing-')).length).toBe(1_000)
      expect(repo.maxConcurrentFinds()).toBeLessThanOrEqual(4)

      const queues = documentRetryRegistry.snapshot()
      expect(queues.activeTimers).toBe(1)
      expect(queues.pendingDepth).toBe(512)
      expect(queues.rejectedOverCapacity).toBe(488)
      // Refused documents are reported, not silently forgotten — and one row
      // write per incident, not one per refused document.
      await flushMicrotasks()
      expect(store.matching(MARK_DEGRADED).length).toBe(1)
      // The attach-time clear (which drops a degradation left by a PREVIOUS
      // projector) must not swallow this one. Order is the assertion: whatever
      // else happened, the last word about this workspace is that it is
      // degraded.
      expect(lastHealthWrite(store.queries)).toBe('mark')
    } finally {
      stop()
    }
    expect(documentRetryRegistry.snapshot()).toMatchObject({ queues: 0, pendingDepth: 0, activeTimers: 0 })
  }, 30_000)

  it('projects a late-arriving document and clears the degraded marker', async () => {
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'Late', docUrl: 'automerge:late', objectIds: [] },
    })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      expect(documentRetryRegistry.snapshot().pendingDepth).toBe(1)
      expect(store.matching(FLOW_PROJECTION).length).toBe(0)

      repo.publish('automerge:late', { flows: { f1: { id: 'f1', steps: [{ connectionId: 'c1' }] } } })
      await vi.waitFor(() => {
        expect(store.matching(FLOW_PROJECTION).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      expect(documentRetryRegistry.snapshot()).toMatchObject({ pendingDepth: 0, resolved: 1 })
      expect(documentRetryRegistry.snapshot().maxTimeToAvailableMs).toBeGreaterThan(0)
    } finally {
      stop()
    }
  }, 30_000)

  it('drops a pending document as soon as the registry stops referencing it', async () => {
    const registry: Record<string, unknown> = {
      d1: { id: 'd1', name: 'Going', docUrl: 'automerge:going', objectIds: [] },
    }
    const docs = workspaceDocs(registry)
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      expect(documentRetryRegistry.snapshot().pendingDepth).toBe(1)

      delete registry.d1
      repo.emitChange('automerge:registry')
      await vi.waitFor(() => {
        expect(documentRetryRegistry.snapshot().pendingDepth).toBe(0)
      }, { timeout: 5_000 })

      expect(documentRetryRegistry.snapshot()).toMatchObject({ activeTimers: 0 })
      expect(repo.findsFor('automerge:going')).toBe(1)
    } finally {
      stop()
    }
  }, 30_000)

  /**
   * One coalescer for the registry, not one per shard.
   *
   * Each registry pass re-extracts the ENTIRE model and reconciles EVERY
   * diagram, so a coalescer per registry url would do that N times for N
   * shards changing in the same tick, producing N identical results. Per-shard
   * coalescers collapse their own shard's burst but nothing collapses the
   * burst ACROSS shards.
   *
   * Asserted as a ratio against a single-shard change rather than a magic
   * number: what must hold is that a six-shard burst costs the same as a
   * one-shard burst, whatever a full pass happens to cost today.
   */
  it('collapses a multi-shard registry burst into one model extraction', async () => {
    const registryUrls = Array.from({ length: 6 }, (_, index) => `automerge:reg-${index}`)
    const docs: Record<string, FakeDoc> = {
      'automerge:root': { modelMetaUrl: 'automerge:meta', modelUrl: '', shardUrls: registryUrls },
      'automerge:meta': {
        objectShardUrls: Array.from({ length: 5 }, (_, i) => `automerge:obj-${i}`),
        connectionShardUrls: Array.from({ length: 5 }, (_, i) => `automerge:conn-${i}`),
        groups: {},
      },
    }
    for (const url of registryUrls) docs[url] = { diagrams: {} }
    for (let i = 0; i < 5; i += 1) docs[`automerge:obj-${i}`] = { objects: {} }
    for (let i = 0; i < 5; i += 1) docs[`automerge:conn-${i}`] = { connections: {} }

    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // Baseline: what one registry change costs.
      const beforeSingle = repo.findCalls.length
      repo.emitChange(registryUrls[0]!)
      await vi.waitFor(() => {
        expect(repo.findCalls.length).toBeGreaterThan(beforeSingle)
      }, { timeout: 5_000 })
      await new Promise((done) => setTimeout(done, 200))
      const singleShardFinds = repo.findCalls.length - beforeSingle

      // Now all six change in one tick, as they do when a client renames
      // several diagrams or an import lands.
      const beforeBurst = repo.findCalls.length
      for (const url of registryUrls) repo.emitChange(url)
      await vi.waitFor(() => {
        expect(repo.findCalls.length).toBeGreaterThan(beforeBurst)
      }, { timeout: 5_000 })
      await new Promise((done) => setTimeout(done, 300))
      const burstFinds = repo.findCalls.length - beforeBurst

      // The property that matters is that the burst does NOT scale with the
      // number of shards. Two passes is the floor for a leading-edge coalescer,
      // and it is required rather than wasteful: the first pass starts on the
      // first trigger, so the changes carried by triggers 2..6 arrive mid-pass
      // and need one more pass to be reflected. Six coalescers would give six.
      expect(burstFinds).toBeLessThanOrEqual(singleShardFinds * 2)
      expect(burstFinds).toBeLessThan(singleShardFinds * 6)
    } finally {
      stop()
    }
  }, 30_000)

  it('stops every pending retry when the projector is detached', async () => {
    const diagrams = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      `d${index}`,
      { id: `d${index}`, docUrl: `automerge:gone-${index}`, objectIds: [] },
    ]))
    const repo = fakeAutomergeRepo(workspaceDocs(diagrams))
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    expect(documentRetryRegistry.snapshot().pendingDepth).toBe(20)
    const findsBefore = repo.findCalls.length

    stop()
    await new Promise((done) => setTimeout(done, 400))

    expect(repo.findCalls.length).toBe(findsBefore)
    expect(documentRetryRegistry.snapshot()).toMatchObject({ queues: 0, pendingDepth: 0, activeTimers: 0 })
  }, 30_000)

  it('tolerates a reference to a document that can never resolve', async () => {
    const repo = fakeAutomergeRepo(workspaceDocs({
      d1: { id: 'd1', name: 'Legacy', docUrl: 'automerge:deleted-doc', objectIds: [] },
    }))
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const deleting = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:deleted-doc') throw new Error('Document deleted-doc was deleted')
        return realFind(url)
      },
    } as unknown as Repo
    const store = fakeDb()

    const stop = await startReadModelProjector(deleting, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // Registry metadata still projected; only the optional flows are absent,
      // and nothing is queued for a retry that could never succeed.
      expect(store.matching(/ro_diagrams/).length).toBeGreaterThan(0)
      expect(documentRetryRegistry.snapshot().pendingDepth).toBe(0)
      await flushMicrotasks()
      expect(store.matching(MARK_DEGRADED).length).toBe(0)
    } finally {
      stop()
    }
  }, 30_000)
})

/**
 * The workspace ROOT is a live document, not boot configuration.
 *
 * Registry shard urls live on `root.shardUrls` (`readDiagrams`), and the client
 * appends one at runtime (`bridge.ts` `publishNewRegistryShard`) on two reachable
 * paths: rollover past `SHARD_SIZE` (200 diagrams), and the FIRST creation in a
 * summary-only workspace whose root has no `registryWriteUrl` yet.
 *
 * Object and connection shard urls live on ModelMeta, which IS watched, and the
 * meta handler reconciles newly-appended urls into the watched set. The
 * registry needs the same: the root must be watched, or a shard appended after
 * boot is invisible — its diagrams never reach `ro_diagrams` and their flows
 * are never projected — until the projector restarts.
 *
 * A change to an OLD registry shard would pick the new shard's CONTENTS up in
 * passing (re-extraction re-reads the root), but on a workspace where all new
 * activity is in the new shard — which is exactly what a rollover produces —
 * nothing else fires.
 *
 * These two tests are the registry's half of the symmetry: the appended shard is
 * projected, AND it is watched from then on. The second does not follow from the
 * first; reading a url once is not subscribing to it.
 */
describe('registry shards appended after boot', () => {
  const diagramInShard = (id: string) => ({
    diagrams: { [id]: { id, name: id.toUpperCase(), docUrl: `automerge:${id}doc`, objectIds: [] } },
  })

  it('projects the diagrams of a registry shard appended to the root after boot', async () => {
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'Boot', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      expect(repo.findsFor('automerge:d2doc')).toBe(0)

      // The rollover, in the order the client performs it: the shard and its
      // diagram document are durable BEFORE the root is told about them
      // (`publishAfterDurableFlush`), so the root change is the only signal.
      repo.publish('automerge:registry-2', diagramInShard('d2'))
      repo.publish('automerge:d2doc', { flows: { f1: { id: 'f1', steps: [{ connectionId: 'c1' }] } } })
      ;(docs['automerge:root'] as { shardUrls: string[] }).shardUrls.push('automerge:registry-2')
      repo.emitChange('automerge:root')

      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d2doc')).toBe(1)
      }, { timeout: 5_000 })
      await vi.waitFor(() => {
        expect(store.matching(FLOW_PROJECTION).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })
    } finally {
      stop()
    }
  }, 30_000)

  it('watches the appended shard from then on, rather than reading it once', async () => {
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'Boot', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      repo.publish('automerge:registry-2', diagramInShard('d2'))
      repo.publish('automerge:d2doc', { flows: {} })
      ;(docs['automerge:root'] as { shardUrls: string[] }).shardUrls.push('automerge:registry-2')
      repo.emitChange('automerge:root')
      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d2doc')).toBe(1)
      }, { timeout: 5_000 })

      // A SECOND diagram, created later in the same new shard — the ordinary
      // steady state after a rollover. Only a watcher on that shard reports it.
      const shard = docs['automerge:registry-2'] as { diagrams: Record<string, unknown> }
      shard.diagrams.d3 = { id: 'd3', name: 'D3', docUrl: 'automerge:d3doc', objectIds: [] }
      repo.publish('automerge:d3doc', { flows: {} })
      repo.emitChange('automerge:registry-2')

      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d3doc')).toBe(1)
      }, { timeout: 5_000 })
    } finally {
      stop()
    }
  }, 30_000)

  it('does not re-watch a shard the root already listed', async () => {
    // A root change carries the whole document, not a delta, so every root edit
    // re-presents every shard url it already had.
    //
    // Asserted on registration ATTEMPTS, not on listener count: `DocHandle`
    // deduplicates by identity (measured — see the harness comment), and
    // `watchRegistryShard` attaches the shared `registryCoalescer.trigger`, so a
    // redundant re-watch cannot double-fire anything. What it does cost is a
    // `repo.find` and a `cleanups` entry per root edit, unbounded, and that is
    // what this pins. Asserting listener count here would look stronger and
    // prove nothing.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'Boot', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      expect(repo.onCallCount('automerge:registry')).toBe(1)

      for (let i = 0; i < 5; i += 1) repo.emitChange('automerge:root')
      await new Promise((done) => setTimeout(done, 300))

      expect(repo.onCallCount('automerge:registry')).toBe(1)
      expect(repo.listenerCount('automerge:registry')).toBe(1)
    } finally {
      stop()
    }
  }, 30_000)

  it('degrades on an appended shard it cannot open, and re-attempts it later', async () => {
    // A shard published to the root before its own document reached us. The
    // read model is knowingly missing that shard's diagrams, so it must not
    // report healthy — and it must not be recorded as watched, or the miss
    // becomes permanent.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'Boot', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let shardReachable = false
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:registry-2' && !shardReachable) {
          throw new Error('Document registry-2 was deleted')
        }
        return realFind(url)
      },
    } as unknown as Repo

    const stop = await startReadModelProjector(flaky, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      ;(docs['automerge:root'] as { shardUrls: string[] }).shardUrls.push('automerge:registry-2')
      repo.emitChange('automerge:root')

      await vi.waitFor(() => {
        expect(store.matching(MARK_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      // And it STAYS degraded while the shard is still missing. Every pass that
      // can publish health runs again on each of these changes; a health check
      // that only consults the missing-DOCUMENT set — and not the missing-SHARD
      // set — would report this workspace healthy with a whole shard absent.
      for (let i = 0; i < 4; i += 1) repo.emitChange('automerge:root')
      await new Promise((done) => setTimeout(done, 300))
      expect(lastHealthWrite(store.queries)).toBe('mark')

      // The shard arrives. The next root change must pick it up, which it can
      // only do if the failure left it out of the watched set.
      shardReachable = true
      repo.publish('automerge:registry-2', diagramInShard('d2'))
      repo.publish('automerge:d2doc', { flows: {} })
      repo.emitChange('automerge:root')

      // WATCHED, not merely read. The registry pass re-resolves every shard url
      // on the root anyway, so `findsFor` alone passes even if the failed shard
      // was wrongly recorded as watched; only a listener on it proves the
      // failure left it re-attemptable.
      await vi.waitFor(() => {
        expect(repo.listenerCount('automerge:registry-2')).toBe(1)
      }, { timeout: 5_000 })
      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d2doc')).toBe(1)
      }, { timeout: 5_000 })

      // And the workspace must come BACK to healthy. A degradation that never
      // clears is not a safer default — it is a permanent page for a transient
      // fault, and nothing above can tell the two apart.
      //
      // Order, not count: attach already wrote one clear before any of this, so
      // `CLEAR_DEGRADED > 0` would pass even if the recovery published nothing —
      // which is exactly what happens if `publishDegradation` forgets to reset
      // the `healthPublished` latch.
      await vi.waitFor(() => {
        expect(lastHealthWrite(store.queries)).toBe('clear')
      }, { timeout: 5_000 })
    } finally {
      stop()
    }
  }, 30_000)

  it('detaches the root watcher when the projector stops', async () => {
    // One residency is shared by the whole fleet and the fleet is LRU-capped at
    // 8, so a watcher left on the root outlives its projector and keeps
    // projecting into a workspace nobody is serving.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'Boot', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    expect(repo.listenerCount('automerge:root')).toBe(1)

    stop()
    expect(repo.listenerCount('automerge:root')).toBe(0)

    const findsAfterStop = repo.findCalls.length
    ;(docs['automerge:root'] as { shardUrls: string[] }).shardUrls.push('automerge:registry-2')
    repo.publish('automerge:registry-2', diagramInShard('d2'))
    repo.emitChange('automerge:root')
    await new Promise((done) => setTimeout(done, 200))

    expect(repo.findCalls.length).toBe(findsAfterStop)
  }, 30_000)

  it('clears a degradation left behind by a previous projector', async () => {
    // A degradation left by a PREVIOUS process must be cleared by a fresh
    // projector that rebuilds the workspace completely. A clear guarded on
    // `degradationPublished !== null` would never run — that is the state
    // every FRESH projector starts in — so no later process could ever retract
    // the row.
    const repo = fakeAutomergeRepo(workspaceDocs({
      d1: { id: 'd1', name: 'Fine', objectIds: [] },
    }))
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })
      // And it is a CLEAR, not a clear-then-mark: nothing here is degraded.
      expect(store.matching(MARK_DEGRADED).length).toBe(0)
      // Exactly one clear, and it names no projector. Binding the clear to
      // `projector_instance_id` reads as safety and is not:
      // `StaticDeltaProjector` writes that column too, with a different id, in
      // the same process — so a compare-and-set would fail deterministically on
      // every static workspace — and it would make the clear hostage to a
      // separate write landing. The parameter list is asserted so the coupling
      // cannot come back unnoticed.
      const clears = store.callsMatching(CLEAR_DEGRADED)
      expect(clears.length).toBe(1)
      expect(clears[0]!.params).toEqual([WORKSPACE.landscapeId, WORKSPACE.versionId])
    } finally {
      stop()
    }
  }, 30_000)

  it('keeps waiting for a shard the client is still pushing, past the boot budget', async () => {
    // Two budgets, two jobs, and conflating them is a regression waiting to
    // happen. `CONTROL_DOCUMENT_TRIES` is 3 so a doomed BOOT cannot hold one of
    // two cold-build admission slots for minutes. This path is not the boot
    // path: it is a shard a client published mid-session and is still pushing,
    // and waiting IS its purpose. It also has no safety net — a shard that
    // misses the window lands in `degradedShards`, which has no retry queue and
    // is re-attempted only on the next meta or root change, so a workspace that
    // appends one shard and then goes quiet stays degraded with nothing
    // scheduled.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'Boot', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    // More failures than the boot budget allows, fewer than the shard budget.
    let refusals = 6
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:obj-late' && refusals > 0) {
          refusals -= 1
          throw new Error('Document obj-late is unavailable')
        }
        return realFind(url)
      },
    } as unknown as Repo

    const stop = await startReadModelProjector(flaky, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      repo.publish('automerge:obj-late', { objects: { o9: { id: 'o9', name: 'Late', type: 'system' } } })
      // REPLACE the meta document; do NOT push into its array.
      // `extractModelEntities` hands back the array it read, and this harness's
      // `doc()` returns the same object every time — so pushing into it also
      // grows `model.objectShardUrls`, which is the very list the "already
      // watched?" check consults, and the append becomes invisible. Production
      // is immune because Automerge hands out a fresh view per call, which is
      // exactly what makes the trap worth naming: it silently turns this test
      // into a no-op that passes.
      repo.publish('automerge:meta', {
        objectShardUrls: ['automerge:obj-late'], connectionShardUrls: [], groups: {},
      })
      repo.emitChange('automerge:meta')

      // It gets there. With the boot budget it would exhaust after three and
      // leave the workspace degraded with nothing scheduled to fix it.
      await vi.waitFor(() => {
        expect(refusals).toBe(0)
        expect(store.matching(/INSERT INTO ro_objects/).length).toBeGreaterThan(0)
      }, { timeout: 20_000 })
      expect(store.matching(MARK_DEGRADED).length).toBe(0)
    } finally {
      stop()
    }
  }, 40_000)

  it('still reports health when the attach TELEMETRY write failed', async () => {
    // Health must NOT be coupled to the attach write (a compare-and-set on
    // `projector_instance_id`, or a flag latched when that write returns or
    // succeeds): if Postgres restarts as the attach commits, the statement
    // lands, the ack is lost, and the projector owns a row it will never again
    // be willing to clear. There is no retry of that write and
    // `ProjectorFleet.ensure` memoizes the entry, so it would be permanent for
    // the process.
    //
    // Health is gated on `stillOwned`, which is process-local and does not
    // depend on any write. `markReadModelProjectorAttached` is telemetry, and
    // this asserts it: its failure must not silence the workspace.
    const repo = fakeAutomergeRepo(workspaceDocs({
      d1: { id: 'd1', name: 'Fine', objectIds: [] },
    }))
    const store = fakeDb()
    store.failWhen(/projector_attached = true/)

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBe(1)
      }, { timeout: 5_000 })
      expect(store.matching(MARK_DEGRADED).length).toBe(0)
    } finally {
      store.failWhen(null)
      stop()
    }
  }, 30_000)

  it('a DISOWNED projector issues no health write at all, in either direction (A7)', async () => {
    // What this pins, stated exactly: ownership is checked TWICE on the
    // clear's path — once at the gate in `publishHealthIfNothingOutstanding`,
    // and again inside `queueHealthWrite`'s tail, which rolls back rather than
    // skipping. Each masks the other, so this test pins the PAIR (dropping
    // both issues a CLEAR) and nothing pins either half alone. The tail's copy
    // is the load-bearing one (it closes the gap between DECIDING a write and
    // ISSUING it); the gate's is a fast path. Deleting the fast path is not
    // free either — without it the clear latches `healthPublished = true` and
    // `degradationPublished = null` before the tail refuses, and while the
    // rollback restores the first it does not restore the second, so the dedup
    // silently re-opens.
    //
    // Why the property matters: `clearReadModelWorkspaceDegraded` is
    // deliberately unconditional, so a statement issued by a cell whose Redis
    // lease has lapsed erases the TRUE owner's degradation, and that owner will
    // not re-issue it — its own `degradationPublished` still names the kind it
    // last wrote. `publishDegradation` and this clear are the ONLY writers of
    // that triple, so their gates are the whole protection.
    //
    // Owned at boot and lost afterwards, never "never owned": with the row
    // write fence a never-owned projector cannot finish its cold build, so
    // that arm asserts nothing about this guard. The blip modelled here is a
    // lease flicker during operation, which is the reachable one.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let owns = true
    let breakDiagram = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc' && breakDiagram) throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 20, undefined, () => owns,
    )
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // A real incident, marked while this cell still owns the workspace. This
      // is what puts the projector in the only state where the clear's
      // `!stillOwned()` is the LAST guard standing: `healthPublished` is false
      // (the mark lowered it), the depth is 0 and nothing is stopped.
      await vi.waitFor(() => {
        expect(store.matching(MARK_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      // The lease lapses. `syncCellOwnership.owns` reports false for any Redis
      // state but `ready`, and a reconnect inside the renew cadence flips it
      // back with no ownership-loss event — so there is no teardown here, and
      // `stopped` stays false.
      owns = false
      const resolvesWhileDegraded = repo.findsFor('automerge:d1doc')

      // …and now the workspace RECOVERS. Both degraded sets empty, the queue
      // drains, and a CLEAR is decided. It must not be issued: this cell no
      // longer speaks for the row, and `clearReadModelWorkspaceDegraded` is
      // unconditional, so a statement here erases the true owner's degradation
      // permanently — the owner will not re-issue it, because its own
      // `degradationPublished` still names the kind it last wrote.
      breakDiagram = false
      repo.emitChange('automerge:registry')
      // Wait on EVIDENCE that the recovery completed, not on a clock: if the
      // re-resolve has not finished, the clear is blocked by the non-empty
      // degraded set rather than by the guard under test. The document being
      // found again is the moment the set empties and the clear becomes
      // decidable — which is the only moment this test is about.
      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d1doc')).toBeGreaterThan(resolvesWhileDegraded)
      }, { timeout: 5_000 })
      // Then several beats at the injected 20 ms cadence, bounded by a LITERAL:
      // a bound derived from the cadence under test would agree with any
      // cadence that constant is given.
      await new Promise((done) => setTimeout(done, 500))
      expect(store.matching(CLEAR_DEGRADED)).toEqual([])

      // POSITIVE CONTROL, and it carries the whole test. Without it "the clear
      // was suppressed" and "no clear was ever decided" are the same green —
      // and the second is what a recovery that silently failed to happen looks
      // like. Ownership returns, nothing else changes, and the clear must
      // arrive.
      owns = true
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })
    } finally {
      stop()
    }
  }, 30_000)

  it('does not call a workspace healthy when a repaired SHARD brings unsynced diagrams', async () => {
    // The same rule as the reconcile guard, one caller up: `rootProjectLatest`
    // must not publish health right after watching a recovered shard and right
    // BEFORE triggering the registry pass that examines that shard's diagrams.
    // Watching a shard says nothing about its documents: the pass then queues
    // the unsynced ones, a queued document never degrades, and a latched
    // all-clear would stand for the queue's full 120 s.
    //
    // This is the "degrades on an appended shard" scenario with ONE line
    // removed — the diagram document is never published.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'Boot', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let shardReachable = false
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:registry-2' && !shardReachable) {
          throw new Error('Document registry-2 was deleted')
        }
        return realFind(url)
      },
    } as unknown as Repo

    const stop = await startReadModelProjector(flaky, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      ;(docs['automerge:root'] as { shardUrls: string[] }).shardUrls.push('automerge:registry-2')
      repo.emitChange('automerge:root')
      await vi.waitFor(() => {
        expect(store.matching(MARK_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      // The SHARD arrives; its diagram's document does NOT.
      shardReachable = true
      repo.publish('automerge:registry-2', diagramInShard('d2'))
      repo.emitChange('automerge:root')

      await vi.waitFor(() => {
        expect(repo.listenerCount('automerge:registry-2')).toBe(1)
      }, { timeout: 5_000 })
      await new Promise((done) => setTimeout(done, 300))

      // d2's document is outstanding, so the last word must still be "degraded".
      expect(lastHealthWrite(store.queries)).toBe('mark')
    } finally {
      stop()
    }
  }, 30_000)

  it('does not call a workspace healthy from HALFWAY through a reconcile', async () => {
    // Complements the "does NOT say healthy while documents are still queued"
    // test, whose failing document happens to be examined first.
    //
    // `resolveInBatches` walks the registry 4 at a time, `attachDiagramDoc`'s
    // success path publishes health, and a document that fails is queued only
    // when its own batch is reached. So an early success can report "nothing
    // outstanding" while a later document has not been looked at yet — and the
    // report LATCHES, while a queued document never degrades, so nothing
    // retracts it for the queue's full 120 s.
    //
    // Ordering here is the whole test: the failing document is LAST, five
    // batches behind the first success. An early publish would be a clear;
    // the correct behaviour is silence until the pass ends.
    const diagrams: Record<string, unknown> = {}
    for (let i = 0; i < 20; i += 1) {
      diagrams[`ok${i}`] = { id: `ok${i}`, name: `OK${i}`, objectIds: [], docUrl: `automerge:ok${i}doc` }
    }
    diagrams.late = { id: 'late', name: 'Late', objectIds: [], docUrl: 'automerge:latedoc' }
    const docs = workspaceDocs(diagrams)
    for (let i = 0; i < 20; i += 1) docs[`automerge:ok${i}doc`] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // 20 documents resolved, one is queued: the workspace is incomplete and
      // nothing may have said otherwise.
      expect(repo.findsFor('automerge:ok0doc')).toBe(1)
      expect(store.matching(CLEAR_DEGRADED).length).toBe(0)

      // Still silent a moment later — the queue is what holds it now.
      await new Promise((done) => setTimeout(done, 200))
      expect(store.matching(CLEAR_DEGRADED).length).toBe(0)

      // And it recovers on its own once the document arrives.
      repo.publish('automerge:latedoc', { flows: {} })
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBe(1)
      }, { timeout: 10_000 })
    } finally {
      stop()
    }
  }, 30_000)

  it('publishes nothing after it is stopped, even from a pass already in flight', async () => {
    // A pass in flight across `stop()` must not publish health. The fixture is
    // delicate; each requirement below exists because without it the test
    // passes for the wrong reason.
    //
    // The hazard: `stop()` clears `degradedDocuments`, clears `degradedShards`
    // and stops the retry queue — every piece of state the health publish
    // consults. A pass still in flight resumes into an apparently clean world
    // and reports a workspace it no longer serves as healthy. `stillOwned` does
    // not cover it: LRU eviction tears a projector down without any lease
    // changing hands, and a direct caller has no fleet at all.
    //
    // What the fixture has to arrange:
    //   - the workspace must be DEGRADED going in, or `healthPublished` is
    //     already true and the publish short-circuits identically either way;
    //   - the degradation must come from a DIAGRAM document, not a shard — an
    //     unopenable shard also breaks `extractModelEntities`, so no later pass
    //     can run and there is nothing in flight to hold;
    //   - the document must RESOLVE on the second pass, or it re-degrades and
    //     `degradedDocuments` blocks the publish on its own;
    //   - and the pass has to be held at its very first statement.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    // The document EXISTS, so `documentRepoState` reports `ready` and a generic
    // failure classifies as `unexpected` — the branch that degrades immediately
    // rather than queueing.
    let breakDiagram = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc' && breakDiagram) throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    const stop = await startReadModelProjector(flaky, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => {
        expect(lastHealthWrite(store.queries)).toBe('mark')
      }, { timeout: 5_000 })
      const clearsWhileDegraded = store.matching(CLEAR_DEGRADED).length

      // The document is fine now, so the next pass has nothing to degrade — the
      // ONLY thing that can stop it publishing is the teardown.
      breakDiagram = false
      // Every tracked projection claims a generation first, so this holds the
      // registry pass at its first statement.
      store.holdWhen(/INSERT INTO read_model_projection_state/)
      repo.emitChange('automerge:registry')
      await vi.waitFor(() => { expect(store.held()).toBe(true) }, { timeout: 5_000 })

      stop()
      store.release()
      await new Promise((done) => setTimeout(done, 300))

      expect(store.matching(CLEAR_DEGRADED).length).toBe(clearsWhileDegraded)
      expect(lastHealthWrite(store.queries)).toBe('mark')
    } finally {
      store.holdWhen(null)
      store.release()
      stop()
    }
  }, 30_000)

  it('does not MARK degraded after it is stopped either', async () => {
    // In-process half of "a torn-down projector writes no health". `stop()` gates the clear; it has to gate the mark
    // for the same reason — a degradation a torn-down projector leaves behind
    // outlives it exactly as a stale clear would, and the next owner will not
    // retract it, because its own `degradationPublished` is null and its
    // `healthPublished` says the row is fine.
    //
    // A SHARD is what makes this reachable. Every diagram-document path is already immune after `stop()`:
    // `attachDiagramDoc` is passed `documentRetries.signal`, which the teardown
    // aborts, so the failure classifies as `aborted` and returns without
    // degrading. Control documents are resolved with no signal at all, so an
    // in-flight meta pass can still reach `degradeShard` after the projector is
    // gone. That is the path with no other guard on it.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    docs['automerge:obj-late'] = { objects: { o9: { id: 'o9', name: 'Late', type: 'system' } } }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => {
        expect(lastHealthWrite(store.queries)).toBe('clear')
      }, { timeout: 5_000 })

      // A shard appears whose initial apply will fail. REPLACE the meta document
      // rather than pushing into its array — `extractModelEntities` hands back
      // the array it read and this harness's `doc()` returns the same object, so
      // a push would also grow `model.objectShardUrls` and the append would be
      // invisible.
      repo.publish('automerge:meta', {
        objectShardUrls: ['automerge:obj-late'], connectionShardUrls: [], groups: {},
      })
      store.failWhen(/INSERT INTO ro_objects/)
      store.holdWhen(/INSERT INTO read_model_projection_state/)
      repo.emitChange('automerge:meta')
      await vi.waitFor(() => { expect(store.held()).toBe(true) }, { timeout: 5_000 })

      stop()
      store.release()
      await new Promise((done) => setTimeout(done, 400))

      // POSITIVE first: this test is otherwise pure absence and would pass just
      // as happily if the shard apply were never attempted at all — if the SQL
      // this keys on is renamed, or the meta replacement stops producing a new
      // shard url. Then the absence assertion means something.
      expect(store.matching(/INSERT INTO ro_objects/).length).toBeGreaterThan(0)
      expect(store.matching(MARK_DEGRADED).length).toBe(0)
    } finally {
      store.failWhen(null)
      store.holdWhen(null)
      store.release()
      stop()
    }
  }, 30_000)

  it('does not MARK degraded for a workspace this cell no longer serves', async () => {
    // The cross-replica half, expressed through the same predicate the clear
    // uses. Without it, a projector whose lease has moved on can still write a
    // degradation onto the new owner's row — and the new owner has nothing that
    // would ever clear it.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    // The SAME fixture with ownership granted, so the absence below is known to
    // be caused by the predicate and not by the document quietly resolving or
    // being queued instead of degraded.
    const owned = fakeDb()
    const stopOwned = await startReadModelProjector(flaky, 'automerge:root', owned.db, WORKSPACE)
    try {
      await vi.waitFor(() => {
        expect(owned.matching(MARK_DEGRADED).length).toBe(1)
      }, { timeout: 5_000 })
    } finally {
      stopOwned()
    }

    // Owned at boot, lost afterwards — the real fleet lifecycle, and with the
    // row-write fence the only reachable shape: a projector that never
    // owned the workspace skips its fence claim, fails its own cold build's
    // fence assert, and `startReadModelProjector` throws before there is
    // anything to observe. Losing the lease AFTER boot keeps the fence held by
    // this instance (the fence tracks claims, not the flickery lease), so the
    // projector keeps running and the health predicate is what this test
    // isolates.
    let ownsWorkspace = true
    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 0, undefined, () => ownsWorkspace,
    )
    ownsWorkspace = false
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await new Promise((done) => setTimeout(done, 300))
      // The document genuinely failed — it simply is not this cell's business.
      expect(store.matching(MARK_DEGRADED).length).toBe(0)
      expect(store.matching(CLEAR_DEGRADED).length).toBe(0)
    } finally {
      stop()
    }
  }, 30_000)

  it('holds a degradation decided during an ownership blip, and publishes it after', async () => {
    // Suppressing is not the same as dropping. `degrade()` records the url BEFORE the gate, so the
    // health publish is blocked by the non-empty set — and `publishDegradation`
    // only runs again on a NEW incident, which on a quiet workspace never comes.
    // The row would say healthy while the projector knows it is not, forever.
    //
    // The window is ordinary: `ownsWorkspace` reports false whenever Redis is
    // not `ready`, and a reconnect inside the renew cadence flips it back with
    // no ownership-loss event and no generation bump.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let owns = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    // A 20 ms resident sweep, because the workspace must be QUIET. Driving a
    // change to trigger the flush would also re-attempt the failed document and
    // raise a second incident — which publishes on its own and makes the test
    // pass whether the first one was held or dropped.
    //
    // Owned at boot, lost synchronously after — with the row-write fence a
    // never-owned projector cannot finish its cold build, and the
    // blip this test models is a lease flicker DURING operation anyway.
    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 20, undefined, () => owns,
    )
    owns = false
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await new Promise((done) => setTimeout(done, 200))
      expect(store.matching(MARK_DEGRADED).length).toBe(0)

      // Redis comes back. Nothing else happens — no change, no new incident.
      // The sweep's beat is the only thing that can publish what was held.
      owns = true
      await vi.waitFor(() => {
        expect(store.matching(MARK_DEGRADED).length).toBe(1)
      }, { timeout: 5_000 })
      expect(store.matching(CLEAR_DEGRADED).length).toBe(0)
    } finally {
      stop()
    }
  }, 30_000)

  it('does not let a health write QUEUED before the teardown land after it', async () => {
    // Serialized writes widen the gap between deciding one and issuing it. A
    // write can sit behind the queue while the
    // projector is evicted and a replacement cold-builds the same workspace
    // clean — and the late write lands on the replacement's row, which the
    // replacement will not correct because its own flags already say what it
    // last decided. The gate is therefore re-checked inside the queued closure,
    // not only where the write was decided.
    // The write under test must be QUEUED BEHIND a stalled one, not the stalled
    // one itself: a write already inside `db.query` has passed the gate and will
    // finish either way. Holding the MARK and then provoking a recovery puts a
    // CLEAR in the queue with nothing of its own in flight.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let breakDiagram = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc' && breakDiagram) throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    store.holdWhen(MARK_DEGRADED)
    const stop = await startReadModelProjector(flaky, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => { expect(store.held()).toBe(true) }, { timeout: 5_000 })

      // The document recovers, so a CLEAR is decided and queues behind the MARK.
      breakDiagram = false
      repo.emitChange('automerge:registry')
      // WAIT FOR THE DECISION, do not sleep and hope. A fixed sleep that is too
      // short on a loaded box means the CLEAR was never decided at all, and the
      // absence assertions below then pass for the wrong reason. The re-attach is the observable proof the
      // decision has been made: `attachDiagramDoc`'s success path is what calls
      // the health publish.
      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d1doc')).toBeGreaterThan(0)
      }, { timeout: 5_000 })
      expect(store.matching(CLEAR_DEGRADED).length).toBe(0) // decided, still queued

      stop()
      store.release()
      await new Promise((done) => setTimeout(done, 300))

      // The MARK, already in flight, lands. The CLEAR behind it must not: by the
      // time it would run, this projector no longer speaks for the workspace.
      expect(store.completed.filter((q) => MARK_DEGRADED.test(q)).length).toBe(1)
      expect(store.matching(CLEAR_DEGRADED).length).toBe(0)
    } finally {
      store.holdWhen(null)
      store.release()
      stop()
    }
  }, 30_000)

  it('re-decides a health write its own gate refused', async () => {
    // The gate must not silently DISCARD a decision. Both flags are latched
    // where the write is decided, so a skip leaves this projector believing the
    // row says something it does not — and every later call short-circuits on
    // exactly those flags. That is the permanent-stale row again, one layer in,
    // and it needs no teardown: `ownsWorkspace` reports false whenever Redis is
    // not `ready`, and a reconnect inside the renew cadence flips it back with
    // no ownership-loss event at all.
    // The write under test has to be QUEUED BEHIND a stalled one — a statement
    // already inside `db.query` has passed the gate and completes regardless, so
    // holding the write itself proves nothing. Degrade first (MARK stalls), then
    // recover (CLEAR queues behind it), then lapse ownership before releasing.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let owns = true
    let breakDiagram = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc' && breakDiagram) throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    store.holdWhen(MARK_DEGRADED)
    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 20, undefined, () => owns,
    )
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => { expect(store.held()).toBe(true) }, { timeout: 5_000 })

      breakDiagram = false
      repo.emitChange('automerge:registry')
      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d1doc')).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      // Ownership lapses while the CLEAR sits in the queue.
      owns = false
      store.release()
      await new Promise((done) => setTimeout(done, 200))
      expect(store.completed.filter((q) => CLEAR_DEGRADED.test(q)).length).toBe(0)

      // It comes back. The beat must re-decide and re-issue; without the
      // rollback `healthPublished` is still true and no clear is ever written.
      owns = true
      await vi.waitFor(() => {
        expect(store.completed.filter((q) => CLEAR_DEGRADED.test(q)).length).toBe(1)
      }, { timeout: 5_000 })
    } finally {
      store.holdWhen(null)
      store.release()
      stop()
    }
  }, 30_000)

  it('re-decides a MARK its own gate refused, the mirror of the clear', async () => {
    // Symmetric to the clear, and the two rollbacks differ: a refused MARK must
    // HOLD the incident, or the row never learns about it and the non-empty
    // degraded set blocks any clear — the row saying healthy while the projector
    // knows it is not. The refusal rollback must NOT un-dedup:
    // `degradationPublished` is re-opened by `flushHeldDegradation`, and doing
    // it in the rollback would re-admit one mark per failing document.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    docs['automerge:d2doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let owns = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d2doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    // Stall the boot CLEAR so the MARK that follows queues behind it.
    store.holdWhen(CLEAR_DEGRADED)
    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 20, undefined, () => owns,
    )
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => { expect(store.held()).toBe(true) }, { timeout: 5_000 })

      const registry = docs['automerge:registry'] as { diagrams: Record<string, unknown> }
      registry.diagrams.d2 = { id: 'd2', name: 'Two', docUrl: 'automerge:d2doc', objectIds: [] }
      repo.emitChange('automerge:registry')
      // A queued write is not ISSUED, so `store.matching` cannot observe
      // "decided but waiting" — that is what serializing means. The final
      // assertion is this test's positive control instead: if the degrade never
      // happened, no MARK ever appears and the wait below times out.
      await new Promise((done) => setTimeout(done, 200))

      owns = false
      store.release()
      await new Promise((done) => setTimeout(done, 200))
      expect(store.completed.filter((q) => MARK_DEGRADED.test(q)).length).toBe(0)

      owns = true
      await vi.waitFor(() => {
        expect(store.completed.filter((q) => MARK_DEGRADED.test(q)).length).toBe(1)
      }, { timeout: 5_000 })
    } finally {
      store.holdWhen(null)
      store.release()
      stop()
    }
  }, 30_000)

  it('re-issues a CLEAR the database REJECTED, and stops once it lands', async () => {
    // The two tests above cover a write this projector's own gate REFUSED.
    // A write the database REJECTS must also roll back:
    // `publishHealthIfNothingOutstanding` latches `healthPublished = true`
    // BEFORE queueing, so one pool exhaustion, one reset connection, one
    // statement timeout would otherwise leave this projector believing the row
    // says healthy while the row still carries a previous process's
    // `degraded_since` — and nothing would lift it afterwards.
    //
    // The SECOND half (the retry stops once it lands) guards against a
    // rollback that re-issues for ever. It is a second line of defence: other
    // tests (`re-decides a health write its own gate refused`, `bounds 1000
    // unresolvable references`) also catch unbounded-retry shapes.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let breakDiagram = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc' && breakDiagram) throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 20,
    )
    await awaitInitialDiagramProbe(WORKSPACE)
    // ISSUE count, not completion count: a rejected statement is an attempt,
    // and attempts are the whole observable here.
    const clears = () => store.matching(CLEAR_DEGRADED).length
    try {
      await vi.waitFor(() => {
        expect(store.matching(MARK_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      // Every CLEAR from here on is refused by the database itself.
      store.failWhen(CLEAR_DEGRADED)
      const before = clears()
      breakDiagram = false
      repo.emitChange('automerge:registry')

      // Any number above ONE is the discriminator, and three is margin rather
      // than a calibrated bound: `healthPublished` is latched before the write
      // is queued, so without the rollback NO caller produces a second attempt
      // and the count stops at exactly 1.
      await vi.waitFor(() => {
        expect(clears() - before).toBeGreaterThanOrEqual(3)
      }, { timeout: 5_000 })

      // It lands, and the retry STOPS. 300 ms is fifteen beats at this test's
      // 20 ms cadence.
      store.failWhen(null)
      await new Promise((done) => setTimeout(done, 300))
      const settled = clears()
      await new Promise((done) => setTimeout(done, 300))
      expect(clears()).toBe(settled)
    } finally {
      store.failWhen(null)
      stop()
    }
  }, 30_000)

  it('re-issues a MARK the database REJECTED, and stops once it lands', async () => {
    // The mirror, and the rollbacks differ: a rejected MARK must un-dedup
    // (`degradationPublished = null`) AND hold the incident, because
    // `publishDegradation` only runs again on a NEW incident and a quiet
    // workspace never has one. Without both halves the row reports healthy
    // while this projector knows the workspace is incomplete — the worse of
    // the two directions.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    docs['automerge:d2doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d2doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 20,
    )
    await awaitInitialDiagramProbe(WORKSPACE)
    const marks = () => store.matching(MARK_DEGRADED).length
    try {
      store.failWhen(MARK_DEGRADED)
      const before = marks()
      const registry = docs['automerge:registry'] as { diagrams: Record<string, unknown> }
      registry.diagrams.d2 = { id: 'd2', name: 'Two', docUrl: 'automerge:d2doc', objectIds: [] }
      repo.emitChange('automerge:registry')

      await vi.waitFor(() => {
        expect(marks() - before).toBeGreaterThanOrEqual(3)
      }, { timeout: 5_000 })

      store.failWhen(null)
      await new Promise((done) => setTimeout(done, 300))
      const settled = marks()
      await new Promise((done) => setTimeout(done, 300))
      expect(marks()).toBe(settled)
    } finally {
      store.failWhen(null)
      stop()
    }
  }, 30_000)

  it('does not re-raise an incident the workspace has already recovered from', async () => {
    // The ABA the rollback opens: serializing means a MARK can
    // still be IN FLIGHT when the recovery that cancels it is decided, so by the
    // time the write rejects, the incident it describes is over. A rollback that
    // holds the incident unconditionally then hands a resolved failure to the
    // beat, which marks the row degraded for a workspace whose degraded sets are
    // both empty. The next beat clears it again — so the damage is bounded, and
    // it is still a false alarm on the row alerting reads.
    //
    // Publishing a held incident is right only while something is still
    // outstanding, so the degraded sets are read at the flush.
    //
    // NOT because "every caller of `publishDegradation` adds to a set first" —
    // the flush itself is a caller and adds to nothing. The sets are an honest
    // witness because they are read LATE, at the moment the decision is taken,
    // rather than captured when the hold was created.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let breakDiagram = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc' && breakDiagram) throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    // Stall the MARK so the recovery can overtake it, then reject it on release.
    store.holdWhen(MARK_DEGRADED)
    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 20,
    )
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => { expect(store.held()).toBe(true) }, { timeout: 5_000 })

      // Recover WHILE the mark is in flight. The CLEAR queues behind it.
      breakDiagram = false
      repo.emitChange('automerge:registry')
      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d1doc')).toBeGreaterThan(0)
      }, { timeout: 5_000 })
      await new Promise((done) => setTimeout(done, 100))

      const marksBefore = store.matching(MARK_DEGRADED).length
      store.failWhen(MARK_DEGRADED)
      store.release()

      // The clear lands, and then NOTHING marks the row again: the incident the
      // rejected write described no longer exists.
      await vi.waitFor(() => {
        expect(store.completed.filter((q) => CLEAR_DEGRADED.test(q)).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })
      await new Promise((done) => setTimeout(done, 300))
      expect(store.matching(MARK_DEGRADED).length).toBe(marksBefore)
    } finally {
      store.holdWhen(null)
      store.failWhen(null)
      store.release()
      stop()
    }
  }, 30_000)

  it('re-opens the dedup when a failed MARK leaves no evidence to hold', async () => {
    // A rollback hole that would be silent, permanent UNDER-reporting.
    //
    // When the rollback finds both degraded sets empty it creates no hold — and
    // if it also leaves `degradationPublished` naming the kind whose write never
    // landed, nothing can ever clear it. The flush needs a hold, and the clear's
    // own reset is unreachable while any set is non-empty. So the next incident
    // of the SAME kind returns at the dedup and queues nothing, for ever, while
    // the row reports healthy for a workspace this projector knows is degraded.
    //
    // Driven through the REFUSAL exit rather than a rejection because both share
    // the one rollback closure, and a refusal is deterministic to arrange. The
    // beat is parked at 2 s so that nothing but the code under test can reset
    // the flag inside the window.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    docs['automerge:d2doc'] = { flows: {} }
    docs['automerge:d3doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let owns = true
    let breakSecond = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d2doc' && breakSecond) throw new Error('boom')
        if (url === 'automerge:d3doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    // Boot HEALTHY so there is a clear to stall; the MARK then has to be
    // QUEUED behind it, not executing, for the gate to refuse it.
    store.holdWhen(CLEAR_DEGRADED)
    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 2_000, undefined, () => owns,
    )
    await awaitInitialDiagramProbe(WORKSPACE)
    const registry = docs['automerge:registry'] as { diagrams: Record<string, unknown> }
    try {
      await vi.waitFor(() => { expect(store.held()).toBe(true) }, { timeout: 5_000 })

      registry.diagrams.d2 = { id: 'd2', name: 'Two', docUrl: 'automerge:d2doc', objectIds: [] }
      repo.emitChange('automerge:registry')
      // A queued write is not ISSUED, and `findsFor` cannot see a rejected find
      // either — the stub throws before it delegates, so nothing counts it. The
      // final assertion is this test's positive control instead.
      await new Promise((done) => setTimeout(done, 200))

      // Ownership lapses FIRST, and that ordering is the whole test. While this
      // cell owns the workspace, a recovery that empties both sets immediately
      // decides a CLEAR, and the clear's own `degradationPublished = null`
      // resets the dedup as a side effect — masking the defect entirely. The
      // clear has to be BLOCKED while the evidence disappears,
      // which is `reconciling > 0` in production and `!stillOwned()` here.
      owns = false

      // d2 recovers while its mark is still queued: the evidence is gone before
      // the rollback runs. Now the stub DOES delegate, so the find is countable.
      breakSecond = false
      repo.emitChange('automerge:registry')
      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d2doc')).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      store.release()
      await new Promise((done) => setTimeout(done, 200))
      expect(store.completed.filter((q) => MARK_DEGRADED.test(q)).length).toBe(0)

      // A NEW incident of the same kind, raised in the same turn ownership
      // returns so the parked beat cannot slip in and reset the flag for us.
      owns = true
      registry.diagrams.d3 = { id: 'd3', name: 'Three', docUrl: 'automerge:d3doc', objectIds: [] }
      repo.emitChange('automerge:registry')

      // It must reach the row. Without the un-dedup it never does — no timeout
      // is long enough, because nothing is left that could issue it.
      await vi.waitFor(() => {
        expect(store.completed.filter((q) => MARK_DEGRADED.test(q)).length).toBeGreaterThanOrEqual(1)
      }, { timeout: 5_000 })
    } finally {
      store.holdWhen(null)
      store.release()
      stop()
    }
  }, 30_000)

  it('drops a held incident the workspace recovered from before the flush ran', async () => {
    // The mirror of the guard above, at the CONSUMER. Checking the evidence
    // where the hold is created is not enough: the incident can resolve between
    // the hold and the flush, and the recovery's own call to
    // `publishHealthIfNothingOutstanding` IS a flush point — it runs that block
    // before it clears anything. So the producer-side check alone misses the
    // commonest ordering rather than a rare one, and the flush marks a workspace
    // whose degraded sets are both empty.
    //
    // Usually that flap clears microseconds later. It does not when the
    // fall-through is blocked by `reconciling` or by a non-empty retry queue and
    // the projector is evicted first — leaving a row falsely degraded with
    // nothing left to retract it.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let breakDiagram = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc' && breakDiagram) throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    // The beat is the ONLY flush point (see `flushHeldDegradation`), so this
    // test has to let several beats run rather than park them (a parked beat
    // would make it pass over the defect). The mark stays armed to fail throughout: with the guard the
    // hold is discarded once and nothing is attempted again; without it, the
    // flush re-publishes, rejects, re-holds, and the count climbs every beat.
    store.holdWhen(MARK_DEGRADED)
    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 100,
    )
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => { expect(store.held()).toBe(true) }, { timeout: 5_000 })

      // The mark rejects while d1 is still degraded, so a hold IS created.
      store.failWhen(MARK_DEGRADED)
      store.release()
      await vi.waitFor(() => {
        expect(store.completed.filter((q) => MARK_DEGRADED.test(q)).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      breakDiagram = false
      repo.emitChange('automerge:registry')
      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d1doc')).toBeGreaterThan(0)
      }, { timeout: 5_000 })
      // Let the recovery settle and both sets empty before the count is taken.
      await new Promise((done) => setTimeout(done, 300))
      const marksBefore = store.matching(MARK_DEGRADED).length

      // Four beats. Nothing may be attempted for an incident that is over.
      await new Promise((done) => setTimeout(done, 400))
      expect(store.matching(MARK_DEGRADED).length).toBe(marksBefore)
    } finally {
      store.holdWhen(null)
      store.failWhen(null)
      store.release()
      stop()
    }
  }, 30_000)

  it('says out loud that a health write failed', async () => {
    // The retry is silent by design — it re-issues on the next beat and nobody
    // is told. So this line is the ONLY operator-visible evidence that the row
    // is not keeping up, and no other test would notice it missing. The rule
    // is that a `catch` on a path carrying user-visible state has to say what
    // makes the failure visible; here the answer is this line and nothing else.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    const errors: string[] = []
    let spy: { mockRestore: () => void } | null = null
    let cleanup: (() => void) | null = null
    store.failWhen(MARK_DEGRADED)
    try {
      // Installed INSIDE the try, deliberately. Spying before the boot leaves
      // `console.error` swallowing for the remaining sixty-odd tests in this
      // file if the boot throws, and `server/vitest.config.ts` sets no
      // `restoreMocks`. That the boot does not throw is a property of another
      // function, not of this test.
      spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(' '))
      })
      const stop = await startReadModelProjector(
        flaky, 'automerge:root', store.db, WORKSPACE, undefined, 20,
      )
      cleanup = stop
      await awaitInitialDiagramProbe(WORKSPACE)
      await vi.waitFor(() => {
        expect(errors.some((line) => line.includes('failed to persist degraded state'))).toBe(true)
      }, { timeout: 5_000 })
    } finally {
      store.failWhen(null)
      spy?.mockRestore()
      cleanup?.()
    }
  }, 30_000)

  it('marks again after a clear, for a second incident of the same kind', async () => {
    // `degradationPublished` is a per-KIND dedup, and the clear's decision site
    // is what re-opens it on the ordinary success path, and the failure a
    // missing re-open allows is the same shape as the rollback hole this
    // section is about: a stale flag silently swallowing a real incident, so
    // the row reports healthy for a workspace the projector knows is degraded.
    //
    // No failure injection at all here — this is the path where every write
    // lands, which is why the flush cannot rescue it: no rejection means no
    // held incident means the flush never runs.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    docs['automerge:d2doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let breakFirst = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc' && breakFirst) throw new Error('boom')
        if (url === 'automerge:d2doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 20,
    )
    await awaitInitialDiagramProbe(WORKSPACE)
    const marks = () => store.completed.filter((q) => MARK_DEGRADED.test(q)).length
    const clears = () => store.completed.filter((q) => CLEAR_DEGRADED.test(q)).length
    try {
      await vi.waitFor(() => { expect(marks()).toBeGreaterThanOrEqual(1) }, { timeout: 5_000 })
      const marksAtFirstIncident = marks()

      breakFirst = false
      repo.emitChange('automerge:registry')
      await vi.waitFor(() => { expect(clears()).toBeGreaterThanOrEqual(1) }, { timeout: 5_000 })

      // A second, independent failure of the SAME kind.
      const registry = docs['automerge:registry'] as { diagrams: Record<string, unknown> }
      registry.diagrams.d2 = { id: 'd2', name: 'Two', docUrl: 'automerge:d2doc', objectIds: [] }
      repo.emitChange('automerge:registry')
      await vi.waitFor(() => {
        expect(marks()).toBeGreaterThan(marksAtFirstIncident)
      }, { timeout: 5_000 })
    } finally {
      stop()
    }
  }, 30_000)

  it('does not issue one health write per change event while the database rejects', async () => {
    // The amplification `publishDegradation`'s own header forbids — "one row
    // write per incident, not per failing document" — reached through the FLUSH
    // door rather than the rollback door. Every caller of
    // `publishHealthIfNothingOutstanding` is a flush point, so with a mark
    // rejecting, each change event consumes the hold, re-opens the dedup,
    // re-publishes, rejects and re-holds: one statement and one `console.error`
    // per event, at the event rate, aimed at a database that is already failing.
    //
    // The beat is parked at 5 s so it cannot be the source of anything counted
    // here: every write this test sees is driven by a change event.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.failWhen(MARK_DEGRADED)
    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 5_000,
    )
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => {
        expect(store.matching(MARK_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })
      const before = store.matching(MARK_DEGRADED).length

      // Forty change events inside one beat interval.
      for (let i = 0; i < 40; i += 1) {
        repo.emitChange('automerge:registry')
        await new Promise((done) => setTimeout(done, 5))
      }
      await new Promise((done) => setTimeout(done, 100))

      // Bounded by the BEAT, not by the events. Five is generous headroom for a
      // 5 s beat over a ~300 ms window; forty is the defect.
      expect(store.matching(MARK_DEGRADED).length - before).toBeLessThanOrEqual(5)
    } finally {
      store.failWhen(null)
      spy.mockRestore()
      stop()
    }
  }, 30_000)

  it('retries a held degradation at the INJECTED beat cadence', async () => {
    // The whole "no backoff" argument is that the retry rate IS the beat, so
    // the beat is load-bearing: ignoring `residentSweepMs` entirely, or
    // inverting the ternary that chooses it, would pass every other test in
    // this file.
    //
    // The consequence is not abstract. Every test here that injects a small
    // cadence *believes* it set one; at the 1 s default several of them contain
    // no beat at all inside their observation window and pass vacuously. The
    // one that drops a held incident is exactly that shape — four beats in
    // 400 ms, or nothing.
    //
    // So: one test pins the cadence, and the rest may keep depending on it.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    let spy: { mockRestore: () => void } | null = null
    let cleanup: (() => void) | null = null
    store.failWhen(MARK_DEGRADED)
    try {
      spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const stop = await startReadModelProjector(
        flaky, 'automerge:root', store.db, WORKSPACE, undefined, 50,
      )
      cleanup = stop
      await awaitInitialDiagramProbe(WORKSPACE)
      await vi.waitFor(() => {
        expect(store.matching(MARK_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      const before = store.matching(MARK_DEGRADED).length
      await new Promise((done) => setTimeout(done, 500))
      const attempts = store.matching(MARK_DEGRADED).length - before

      // ~10 beats at the injected 50 ms. The LOWER bound is what kills a beat
      // that fell back to the 1 s default — that window would hold none — and
      // the upper bound is what keeps the retry from becoming a free-running
      // loop off some other trigger. Both are literals, deliberately: deriving
      // either from `healthBeatMs` would agree with any value it is given.
      expect(attempts).toBeGreaterThanOrEqual(3)
      expect(attempts).toBeLessThanOrEqual(30)
    } finally {
      store.failWhen(null)
      spy?.mockRestore()
      cleanup?.()
    }
  }, 30_000)

  it('beats on its own cadence when no resident sweep sets one', async () => {
    // Every other beat test borrows the sweep's 20 ms knob, so none of them
    // notice if the beat is gated on that knob — in which case
    // `READ_MODEL_RESIDENT_SWEEP_MS=0` (or a typo, since `Number('x') > 0` is
    // false) would silently remove the only flush path a quiet workspace has.
    // Slow by construction: it waits on the real default cadence.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let owns = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    // Sweep explicitly OFF. Owned at boot — with the row-write fence a
    // projector that never owned the workspace cannot finish its cold build at
    // all — and lost synchronously after, before the deferred probe's first
    // await can resume, so the degradation it decides is gated from the start.
    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 0, undefined, () => owns,
    )
    owns = false
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await new Promise((done) => setTimeout(done, 200))
      expect(store.matching(MARK_DEGRADED).length).toBe(0)

      owns = true
      await vi.waitFor(() => {
        expect(store.matching(MARK_DEGRADED).length).toBe(1)
      }, { timeout: 10_000, interval: 100 })
    } finally {
      stop()
    }
  }, 30_000)

  it('flushes a held degradation even when it had already reported healthy', async () => {
    // The flush has to run BEFORE the `healthPublished` early return, and the
    // blip test alone cannot show that: there `healthPublished` is false
    // throughout, so a flush placed after the check would still pass. The real
    // shape is a workspace that booted healthy and degrades later.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'One', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    docs['automerge:d2doc'] = { flows: {} }
    let owns = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d2doc') throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    const stop = await startReadModelProjector(
      flaky, 'automerge:root', store.db, WORKSPACE, undefined, 20, undefined, () => owns,
    )
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBe(1)
      }, { timeout: 5_000 })

      // Ownership lapses, then a new diagram's document fails.
      owns = false
      const registry = docs['automerge:registry'] as { diagrams: Record<string, unknown> }
      registry.diagrams.d2 = { id: 'd2', name: 'Two', docUrl: 'automerge:d2doc', objectIds: [] }
      repo.emitChange('automerge:registry')
      await new Promise((done) => setTimeout(done, 200))
      expect(store.matching(MARK_DEGRADED).length).toBe(0)

      // It comes back. The held mark must be published despite this projector
      // having previously said "healthy".
      owns = true
      await vi.waitFor(() => {
        expect(store.matching(MARK_DEGRADED).length).toBe(1)
      }, { timeout: 5_000 })
    } finally {
      stop()
    }
  }, 30_000)

  it('lands health writes in the order they were decided, not the order the pool finishes them', async () => {
    // `db` is a `pg.Pool`. Two fire-and-forget statements issued microseconds
    // apart can commit in either order, and the loser is PERMANENT: in-process
    // `degradationPublished` and `healthPublished` both believe the row already
    // says what they last decided, so neither writes again. A MARK that lands
    // after its own retraction leaves a healthy workspace degraded forever.
    //
    // Asserted on COMPLETION order — `queries` records issue order and cannot
    // see the race at all.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let breakDiagram = true
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc' && breakDiagram) throw new Error('boom')
        return realFind(url)
      },
    } as unknown as Repo

    // Stall the MARK in the pool, then let the recovery issue its CLEAR while
    // the MARK is still in flight.
    store.holdWhen(MARK_DEGRADED)
    const stop = await startReadModelProjector(flaky, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => { expect(store.held()).toBe(true) }, { timeout: 5_000 })

      breakDiagram = false
      repo.emitChange('automerge:registry')
      await new Promise((done) => setTimeout(done, 200))

      store.release()
      await vi.waitFor(() => {
        expect(lastHealthWrite(store.completed)).toBe('clear')
      }, { timeout: 5_000 })

      // Decided mark-then-clear, so the row must end up cleared. Unserialized,
      // the clear finishes first and the row is left degraded with nothing
      // outstanding, permanently.
      expect(lastHealthWrite(store.completed)).toBe('clear')
    } finally {
      store.holdWhen(null)
      store.release()
      stop()
    }
  }, 30_000)

  it('publishes nothing once the fleet has taken the workspace away', async () => {
    // Ownership gating, expressed where the knowledge actually lives (not as
    // a CAS on the instance id). A cold build cannot be cancelled — `release()` only bumps
    // a generation — so a projector can finish for a workspace this cell no
    // longer serves. Its clear would erase the real owner's degradation, and the
    // real owner will not reissue it, because `publishDegradation` dedups on the
    // kind it already reported.
    const repo = fakeAutomergeRepo(workspaceDocs({
      d1: { id: 'd1', name: 'Fine', objectIds: [] },
    }))
    const store = fakeDb()
    // Owned at boot, lost synchronously after. A cold build finishing on a
    // cell that lost the workspace ROLLS BACK on the row-write fence, so the
    // scenario this guards is the lease blip on a projector that legitimately
    // claimed its fence: its health
    // writes stay gated while unowned, and the clear is owed the moment
    // ownership returns.
    let owned = true

    const stop = await startReadModelProjector(
      repo.repo, 'automerge:root', store.db, WORKSPACE, undefined, 0, undefined, () => owned,
    )
    owned = false
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await new Promise((done) => setTimeout(done, 300))
      expect(store.matching(CLEAR_DEGRADED).length).toBe(0)

      // Ownership comes back — a re-acquired lease, or simply a later pass on a
      // cell that still serves it. The report is owed from then on, so the very
      // next health call must make it: a gate that latched "already tried" would
      // leave the row stale for the life of the projector.
      owned = true
      repo.emitChange('automerge:root')
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBe(1)
      }, { timeout: 5_000 })
    } finally {
      stop()
    }
  }, 30_000)

  it('does NOT say healthy while documents are still queued', async () => {
    // The mirror image of a stale degradation: a premature all-clear.
    // `handleDiagramAttachFailure` puts an unavailable document into
    // the retry queue and adds it to `degradedDocuments` only if the queue
    // REFUSES it — so an empty degraded set says nothing about a workspace whose
    // documents are all still being fetched. Reporting healthy there is a
    // degradation that is never VISIBLE: under fleet LRU churn a projector can
    // be recycled before the queue's 120 s wall clock abandons anything.
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'Pending', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let reachable = false
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    const flaky = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:d1doc' && !reachable) throw new Error('Document d1doc is unavailable')
        return realFind(url)
      },
    } as unknown as Repo

    const stop = await startReadModelProjector(flaky, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // Attached, but owing one document: silence, not an all-clear.
      await vi.waitFor(() => {
        expect(store.matching(/projector_attached = true/).length).toBe(1)
      }, { timeout: 5_000 })
      expect(store.matching(CLEAR_DEGRADED).length).toBe(0)

      // The document arrives and the queue drains. THAT is when the workspace
      // may be called healthy — and something has to say so, because on a quiet
      // workspace no further change ever arrives to trigger it.
      reachable = true
      repo.publish('automerge:d1doc', { flows: {} })
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBe(1)
      }, { timeout: 10_000 })
    } finally {
      stop()
    }
  }, 30_000)

  it('says "healthy" once, not once per change', async () => {
    // The attach-time publish cannot consult `degradationPublished` — a fresh
    // projector's is always null — so what
    // keeps it from becoming one UPDATE per change on a busy workspace is the
    // separate `healthPublished` latch. Drop that and this count grows with the
    // change stream.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'Fine', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBe(1)
      }, { timeout: 5_000 })

      for (let i = 0; i < 6; i += 1) repo.emitChange('automerge:root')
      for (let i = 0; i < 6; i += 1) repo.emitChange('automerge:registry')
      await new Promise((done) => setTimeout(done, 400))

      expect(store.matching(CLEAR_DEGRADED).length).toBe(1)
      expect(store.matching(MARK_DEGRADED).length).toBe(0)
    } finally {
      stop()
    }
  }, 30_000)

  it('does NOT degrade a monolith workspace that shards its model', async () => {
    /**
     * `modelMetaUrl` appearing on a root that booted as a monolith must NOT be
     * flagged as degraded, even though after that point every object and
     * connection edit goes to shards this projector never opened, so its read
     * model really does freeze.
     *
     * Two reasons, neither visible from this function:
     *
     * 1. This hook cannot tell a server-maintenance sharding migration from a
     *    replayed historical change (older workspaces were bootstrapped as a
     *    monolith and sharded on first boot).
     * 2. It could never clear. `clearDegradationIfRecovered` returns while
     *    `degradationPublished === null` — precisely the state a fresh projector
     *    starts in — so the restart that resolves the workspace cannot clear the
     *    row saying it is broken.
     *
     * The freeze is real; it needs a projector restart, not a health flag. What
     * this test pins is that the alarm is not here.
     */
    const docs: Record<string, FakeDoc> = {
      'automerge:root': { modelUrl: 'automerge:model', shardUrls: ['automerge:registry'] },
      'automerge:model': { objects: {}, connections: {}, groups: {} },
      'automerge:registry': { diagrams: {} },
    }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await flushMicrotasks()
      expect(store.matching(MARK_DEGRADED).length).toBe(0)

      repo.publish('automerge:meta', { objectShardUrls: [], connectionShardUrls: [], groups: {} })
      ;(docs['automerge:root'] as { modelMetaUrl?: string }).modelMetaUrl = 'automerge:meta'
      repo.emitChange('automerge:root')
      // Long enough for the root coalescer to run a full pass, not merely to
      // have been scheduled — otherwise this passes before anything could fire.
      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:registry')).toBeGreaterThan(1)
      }, { timeout: 5_000 })

      expect(store.matching(MARK_DEGRADED).length).toBe(0)
    } finally {
      stop()
    }
  }, 30_000)
})

/**
 * Residency invariant (automergeResidency.ts): "A projector leases every
 * document to which it attaches a listener." Idle eviction skips only leased
 * and active-peer documents, and `evict()` unloads the handle by replacing its
 * document with `A.init()` — so an unleased document with a live watcher loses
 * its change stream silently, while the workspace still reports healthy.
 */
/** Minimal in-memory StorageAdapter so an evicted document can be RELOADED —
 * which is what makes the production failure observable: the reload produces a
 * NEW DocHandle, and a listener left on the old one never fires again. */
class MemoryStorage {
  private readonly chunks = new Map<string, Uint8Array>()
  private key(key: readonly string[]): string { return key.join('/') }
  async load(key: readonly string[]): Promise<Uint8Array | undefined> { return this.chunks.get(this.key(key)) }
  async save(key: readonly string[], data: Uint8Array): Promise<void> { this.chunks.set(this.key(key), data) }
  async remove(key: readonly string[]): Promise<void> { this.chunks.delete(this.key(key)) }
  async loadRange(prefix: readonly string[]): Promise<Array<{ key: string[]; data: Uint8Array }>> {
    const head = this.key(prefix)
    return [...this.chunks.entries()]
      .filter(([key]) => key.startsWith(head))
      .map(([key, data]) => ({ key: key.split('/'), data }))
  }
  async removeRange(prefix: readonly string[]): Promise<void> {
    const head = this.key(prefix)
    for (const key of [...this.chunks.keys()]) if (key.startsWith(head)) this.chunks.delete(key)
  }
}

describe('diagram document residency', () => {
  async function workspaceRepo() {
    const repo = new Repo({ storage: new MemoryStorage() as never })
    const diagramDoc = repo.create({ flows: { f1: { id: 'f1', steps: [{ connectionId: 'c1' }] } } })
    const objectShard = repo.create({ objects: { o0: { id: 'o0', name: 'A' } } })
    const connectionShard = repo.create({ connections: {} })
    const meta = repo.create({
      objectShardUrls: [objectShard.url], connectionShardUrls: [connectionShard.url], groups: {},
    })
    const registry = repo.create({
      diagrams: { d1: { id: 'd1', name: 'D', docUrl: diagramDoc.url, objectIds: [] } },
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([diagramDoc, objectShard, connectionShard, meta, registry, root].map((h) => h.whenReady()))
    return { repo, diagramDoc, objectShard, root }
  }

  /**
   * A design decision, stated as a test so it cannot be quietly reversed:
   * diagram documents are deliberately NOT leased.
   *
   * A healthy workspace keeps a handful of resident handles. Leasing a
   * 30k-diagram workspace would pin three orders of magnitude more against an
   * unreclaimable WASM high-water mark. It is also unnecessary — `evict()`
   * already refuses any document with an active peer, so a lease would protect
   * only documents that are idle AND peerless, which are exactly the documents
   * that cannot be receiving changes.
   *
   * The contract is detach-on-evict plus re-attach-while-resident instead.
   */
  it('leases the shards it watches but deliberately not diagram documents', async () => {
    const { repo, diagramDoc, objectShard, root } = await workspaceRepo()
    const residency = new AutomergeResidencyLeases(repo)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo, root.url, store.db, WORKSPACE, residency)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // Shards are leased: they are few, bounded by the model's shape.
      expect(residency.isLeased(objectShard.documentId)).toBe(true)
      // Diagrams are not: they are unbounded in the workspace's size.
      expect(residency.isLeased(diagramDoc.documentId)).toBe(false)
    } finally {
      stop()
    }
  }, 30_000)

  /**
   * An eviction landing BETWEEN the resolve and the watcher
   * registration must not install a watcher on a handle the repo has already
   * dropped.
   *
   * `attachDiagramDoc` resolves, then awaits `project()` — a real SQL round trip
   * — and only then attaches. That await is the window. Without the guard the
   * watcher is registered against the dead handle, and because the resident
   * sweep skips any url already in `diagramWatchers`, the document is never
   * re-attached — a permanently orphaned diagram.
   *
   * The window is opened deliberately here rather than raced for: the flow
   * projection is held open until the eviction has happened.
   */
  it('does not watch a handle evicted while the attach was in flight', async () => {
    const { repo, diagramDoc, root } = await workspaceRepo()
    const residency = new AutomergeResidencyLeases(repo)
    const store = fakeDb()
    await repo.flush()

    let releaseFlow: (() => void) | null = null
    const entered = new Promise<void>((resolveEntered) => {
      const inner = store.db.query.bind(store.db)
      store.db.query = (async (text: string, params?: unknown[]) => {
        if (FLOW_PROJECTION.test(text) && !releaseFlow) {
          const gate = new Promise<void>((release) => { releaseFlow = release })
          resolveEntered()
          await gate
        }
        return inner(text, params)
      }) as typeof store.db.query
    })

    const starting = startReadModelProjector(
      repo, root.url, store.db, WORKSPACE, residency, 20,
    )
    await entered

    // The sweep reclaims the document while the attach is still mid-flight.
    await expect(residency.evict(diagramDoc.documentId)).resolves.toBe(true)
    releaseFlow!()
    const stop = await starting

    try {
      // The document comes back; the resident sweep must be free to re-attach,
      // which it is only if no watcher was registered against the dead handle.
      const reloaded = await repo.find(diagramDoc.url)
      await reloaded.whenReady()
      const before = store.matching(FLOW_PROJECTION).length
      await vi.waitFor(() => {
        reloaded.change((doc: { flows: Record<string, unknown> }) => {
          doc.flows.f3 = { id: 'f3', steps: [{ connectionId: 'c3' }] }
        })
        expect(store.matching(FLOW_PROJECTION).length).toBeGreaterThan(before)
      }, { timeout: 5_000 })
    } finally {
      stop()
    }
  }, 30_000)

  /**
   * The behavioural assertion: this is the documented reproduction in the
   * sponsor kit's read-model projector health guide.
   *
   * Deliberately NOT asserted as `listenerCount('change') === 0`. The vendored
   * patch-automerge-peer-sync-state.mjs leaves one internal listener on every
   * ready handle, so a perfect detach lands on 1 and that assertion is
   * unreachable. And "no flow-projection SQL during eviction" passes with zero
   * production changes, because 2.6.0-alpha.2's removeFromCache does not
   * re-init and therefore fires no change event — vacuous.
   *
   * What matters is that a change arriving after the document comes back is
   * projected. That is the user-visible property, and it fails on an orphaned
   * watcher no matter how the internals are counted.
   */
  it('re-projects a change that lands after the document was evicted and reopened', async () => {
    const { repo, diagramDoc, root } = await workspaceRepo()
    const residency = new AutomergeResidencyLeases(repo)
    const store = fakeDb()

    const stop = await startReadModelProjector(
      repo, root.url, store.db, WORKSPACE, residency, 20,
    )
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await vi.waitFor(() => {
        expect(store.matching(FLOW_PROJECTION).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      // Durable first, as production storage is — otherwise eviction discards
      // the only copy and the reload below reports the document unavailable.
      await repo.flush()

      // Exactly what startIdleEviction does for an idle, peerless document.
      // Unleased, so it goes: that is the point of the design.
      await expect(residency.evict(diagramDoc.documentId)).resolves.toBe(true)

      // ...and it must NOT be reported as an orphaned watcher. The projector
      // deliberately watches diagrams without leasing them, and detaches from the eviction
      // hook. A detector that flags the intended design cannot report the
      // accident — which is the whole reason the census exists.
      expect((await residency.snapshot()).orphanedListenerEvictions).toBe(0)

      // The document comes back when a client opens it, and the change lands on
      // whatever handle the repo hands out now — NOT the one the projector
      // watched before the eviction.
      const reloaded = await repo.find(diagramDoc.url)
      await reloaded.whenReady()
      expect(reloaded).not.toBe(diagramDoc)

      // The resident sweep re-attaches to the new handle.
      const before = store.matching(FLOW_PROJECTION).length
      await vi.waitFor(() => {
        reloaded.change((doc: { flows: Record<string, unknown> }) => {
          doc.flows.f2 = { id: 'f2', steps: [{ connectionId: 'c2' }] }
        })
        expect(store.matching(FLOW_PROJECTION).length).toBeGreaterThan(before)
      }, { timeout: 5_000 })
    } finally {
      stop()
    }
  }, 30_000)
})

describe('projection failures (degraded, never a resolution retry)', () => {
  it('does not retry document resolution when PostgreSQL fails during syncConnectionFlows', async () => {
    const repo = fakeAutomergeRepo(workspaceDocs(
      { d1: { id: 'd1', name: 'Flows', docUrl: 'automerge:flows', objectIds: [] } },
      { 'automerge:flows': { flows: { f1: { id: 'f1', steps: [{ connectionId: 'c1' }] } } } },
    ))
    const store = fakeDb()
    store.failWhen(FLOW_PROJECTION)

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await flushMicrotasks()
      // The document resolved once and is never resolved again: another
      // repo.find() cannot repair a database outage.
      expect(repo.findsFor('automerge:flows')).toBe(1)
      // The workspace admits it is degraded rather than reporting healthy.
      expect(store.matching(MARK_DEGRADED).length).toBe(1)
      // Bounded reprojection only — no unbounded background work.
      await new Promise((done) => setTimeout(done, 1_500))
      expect(repo.findsFor('automerge:flows')).toBe(1)
      expect(documentRetryRegistry.snapshot().abandoned.exhausted).toBeLessThanOrEqual(1)
    } finally {
      stop()
    }
  }, 30_000)

  it('recovers to a non-degraded state once the projection succeeds again', async () => {
    const repo = fakeAutomergeRepo(workspaceDocs(
      { d1: { id: 'd1', name: 'Flows', docUrl: 'automerge:flows', objectIds: [] } },
      { 'automerge:flows': { flows: {} } },
    ))
    const store = fakeDb()
    store.failWhen(FLOW_PROJECTION)

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      await flushMicrotasks()
      expect(store.matching(MARK_DEGRADED).length).toBe(1)

      store.failWhen(null)
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBe(1)
      }, { timeout: 5_000 })
      expect(repo.findsFor('automerge:flows')).toBe(1)
    } finally {
      stop()
    }
  }, 30_000)

  it('keeps a failed cold build out of the resident fleet', async () => {
    const repo = fakeAutomergeRepo(workspaceDocs({}))
    const store = fakeDb()
    store.failWhen(/DELETE FROM ro_objects/)
    const fleet = new ProjectorFleet(repo.repo, async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:root',
      db: store.db,
    })

    await expect(fleet.ensure(WORKSPACE)).rejects.toThrow(/terminating connection/)

    expect(fleet.isResident(WORKSPACE)).toBe(false)
    expect(fleet.snapshot()).toMatchObject({ residentProjectors: 0, inFlightWorkspaces: 0 })
    fleet.stopAll()
  }, 30_000)
})

describe('write-fence pass shape (round 7)', () => {
  it('every pass takes the projection mutex first, and deltas pre-check the fence before begin', async () => {
    // Two properties outcome-based tests cannot see (the FOR UPDATE and the
    // lock order) are pinned here at the statement level instead: the mutex is
    // the first thing inside every fenced transaction — it is what closes the
    // phantom-row window and the claim-vs-prune deadlock — and a delta reads
    // the fence BEFORE `begin`, so a known-dead pass
    // never bumps the new owner's `observed_generation`.
    const docs = workspaceDocs({}, {
      'automerge:os0': { objects: { o0: { id: 'o0', name: 'A', type: 'system' } } },
    })
    docs['automerge:meta'] = { objectShardUrls: ['automerge:os0'], connectionShardUrls: [], groups: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // Cold build: the mutex precedes the first row write.
      const mutexIdx = store.queries.findIndex((q) => /pg_advisory_xact_lock/.test(q))
      const firstRowWrite = store.queries.findIndex((q) => /DELETE FROM ro_objects|INSERT INTO ro_objects/.test(q))
      expect(mutexIdx).toBeGreaterThanOrEqual(0)
      expect(firstRowWrite).toBeGreaterThan(mutexIdx)

      // Let the boot's trailing passes drain so the slice below is one pass —
      // the seeded boot projection (fake docs have no Automerge heads, so the
      // gap-possible trigger fires) issues queries asynchronously past the
      // probe await, hence quiescence rather than a microtask flush.
      await vi.waitFor(async () => {
        const len = store.queries.length
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(store.queries.length).toBe(len)
      }, { timeout: 5_000 })
      const mark = store.queries.length
      // The REGISTRY pass is the delta driven here: the object-shard delta
      // path runs Automerge's conflict collector on the source document,
      // which a plain-object fake cannot satisfy — while every runTracked
      // pass shares the exact shape this test pins.
      repo.emitChange('automerge:registry')
      await vi.waitFor(() => {
        expect(store.queries.slice(mark).some((q) => /SELECT write_fence[\s\S]*FOR UPDATE/.test(q))).toBe(true)
      }, { timeout: 5_000 })

      // Delta order: pre-check (no lock) → begin → mutex → rows → locked assert.
      const pass = store.queries.slice(mark)
      const preCheck = pass.findIndex((q) => /SELECT write_fence/.test(q) && !/FOR UPDATE/.test(q))
      const begin = pass.findIndex((q) => /RETURNING observed_generation/.test(q))
      const mutex = pass.findIndex((q) => /pg_advisory_xact_lock/.test(q))
      const rows = pass.findIndex((q) => /ro_diagrams/.test(q))
      const lockedAssert = pass.findIndex((q) => /SELECT write_fence/.test(q) && /FOR UPDATE/.test(q))
      expect(preCheck).toBeGreaterThanOrEqual(0)
      expect(begin).toBeGreaterThan(preCheck)
      expect(mutex).toBeGreaterThan(begin)
      expect(rows).toBeGreaterThan(mutex)
      expect(lockedAssert).toBeGreaterThan(rows)
    } finally {
      stop()
    }
  }, 30_000)
})

describe('ProjectorFleet cold-build admission', () => {
  it('rejects non-owned workspaces before resolving or starting a projector', async () => {
    const resolveRoot = vi.fn(async () => 'root-a')
    const startProjector = vi.fn(async () => vi.fn())
    const fleet = new ProjectorFleet(new Repo({}), resolveRoot, {
      fallbackRootUrl: 'root-default',
      db: {} as never,
      ownsWorkspace: () => false,
      startProjector,
    })

    await expect(fleet.ensure({ landscapeId: 'a', versionId: 'v1' }))
      .rejects.toBeInstanceOf(ProjectorOwnershipError)
    expect(resolveRoot).not.toHaveBeenCalled()
    expect(startProjector).not.toHaveBeenCalled()
    expect(fleet.snapshot()).toMatchObject({
      residentProjectors: 0,
      foreignResidentProjectors: 0,
      ownershipRejectedStarts: 1,
    })
  })

  it('converts a mid-build fence abort into the same accounting as the post-build ownership check', async () => {
    // Without this conversion, `index.ts`'s boot path — which tolerates only
    // ProjectorOwnershipError — would FAIL SERVER BOOT on a fence abort
    // during the default workspace's cold build.
    const startProjector = vi.fn(async () => {
      throw new ReadModelWriteFenceError(
        { landscapeId: 'a', versionId: 'v1' }, 'me', 'somebody-else')
    })
    const fleet = new ProjectorFleet(new Repo({}), async () => 'root-a', {
      fallbackRootUrl: 'root-default',
      db: {} as never,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })

    await expect(fleet.ensure({ landscapeId: 'a', versionId: 'v1' }))
      .rejects.toBeInstanceOf(ProjectorOwnershipError)
    expect(fleet.snapshot()).toMatchObject({
      residentProjectors: 0,
      ownershipRejectedStarts: 1,
    })
    fleet.stopAll()
  })

  it('recycles a resident projector whose fence was taken, so the next ensure() can re-claim', async () => {
    // A fence lost AFTER attach means another instance's cold build owns the
    // rows: this projector can never commit again (only a cold build claims,
    // and its own already ran). Without the recycle it would sit attached and
    // silently frozen forever — every delta aborting into a coalescer's
    // console.error, nothing scheduled, no metric.
    const stops = new Map<string, ReturnType<typeof vi.fn>>()
    const fenceHooks = new Map<string, () => void>()
    const startProjector = vi.fn(async (
      ..._args: Parameters<typeof startReadModelProjector>
    ) => {
      const key = _args[3] as WorkspaceKey
      const k = `${key.landscapeId}/${key.versionId}`
      fenceHooks.set(k, _args[8] as () => void)
      const stop = vi.fn()
      stops.set(k, stop)
      return stop
    })
    const fleet = new ProjectorFleet(new Repo({}), async () => 'root-a', {
      fallbackRootUrl: 'root-default',
      db: {} as never,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })

    const key = { landscapeId: 'a', versionId: 'v1' }
    await fleet.ensure(key)
    expect(fleet.isResident(key)).toBe(true)
    expect(typeof fenceHooks.get('a/v1')).toBe('function')

    fenceHooks.get('a/v1')!()
    // The recycle is deferred (the projector fires the hook from inside its
    // own aborting pass); give the zero-delay timer a beat.
    await new Promise((done) => setTimeout(done, 25))

    expect(fleet.isResident(key)).toBe(false)
    expect(stops.get('a/v1')).toHaveBeenCalledTimes(1)
    expect(fleet.snapshot()).toMatchObject({ writeFenceAborts: 1 })

    // And the workspace is not poisoned: the next ensure() cold-builds anew.
    await fleet.ensure(key)
    expect(fleet.isResident(key)).toBe(true)
    fleet.stopAll()
  })

  it('invalidates the ownership predicate on LRU eviction, not only on lease loss', async () => {
    // `evict()` tears a projector down but leaves `ownsWorkspace` true — this
    // cell does still hold the lease, it simply is not serving the workspace any
    // more. Without a generation bump the torn-down projector's predicate keeps
    // answering yes, and `stop()` has just cleared `degradedDocuments`,
    // `degradedShards` and the retry queue — every piece of state a health
    // publish consults. An async pass still in flight then reports healthy for a
    // workspace with no resident projector.
    const captured = new Map<string, () => boolean>()
    const startProjector = vi.fn(async (
      ..._args: Parameters<typeof startReadModelProjector>
    ) => {
      const key = _args[3] as WorkspaceKey
      captured.set(`${key.landscapeId}/${key.versionId}`, _args[7] as () => boolean)
      return vi.fn()
    })
    const fleet = new ProjectorFleet(new Repo({}), async () => 'root-a', {
      fallbackRootUrl: 'root-default',
      db: {} as never,
      maxProjectors: 1,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })

    await fleet.ensure({ landscapeId: 'a', versionId: 'v1' })
    expect(captured.get('a/v1')!()).toBe(true)

    // A second workspace at cap 1 evicts the first.
    await fleet.ensure({ landscapeId: 'b', versionId: 'v1' })
    expect(captured.get('a/v1')!()).toBe(false)
    expect(captured.get('b/v1')!()).toBe(true)
  })

  it('hands the projector a LIVE ownership predicate, not a snapshot', async () => {
    // The fleet's ownership check runs only after the build returns, and a build
    // cannot be cancelled — `release()` bumps a generation and nothing else. So
    // a projector that loses its workspace mid-build still runs to completion
    // and still writes, and its health writes are the dangerous ones: a stale
    // clear erases the real owner's degradation, which that owner will not
    // reissue because `publishDegradation` dedups on the kind it reported.
    //
    // Asserting the predicate is CALLED and tracks the fleet, not merely that an
    // 8th argument exists: a snapshot boolean would satisfy the signature and
    // answer with whatever was true when the build started, which is exactly the
    // wrong moment.
    let owns = true
    let captured: (() => boolean) | undefined
    const startProjector = vi.fn(async (
      ..._args: Parameters<typeof startReadModelProjector>
    ) => {
      captured = _args[7] as (() => boolean) | undefined
      return vi.fn()
    })
    const key = { landscapeId: 'a', versionId: 'v1' }
    const fleet = new ProjectorFleet(new Repo({}), async () => 'root-a', {
      fallbackRootUrl: 'root-default',
      db: {} as never,
      ownsWorkspace: () => owns,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })

    await fleet.ensure(key)
    expect(typeof captured).toBe('function')
    expect(captured!()).toBe(true)

    owns = false
    expect(captured!()).toBe(false)

    owns = true
    fleet.release(key, 'lease-lost')
    // Generation moved on: this build no longer speaks for the workspace even
    // though the cell owns it again.
    expect(captured!()).toBe(false)
  })

  it('invalidates a cold build on ownership loss and detaches its late listeners', async () => {
    let owns = true
    const running = deferred<() => void>()
    const lateStop = vi.fn()
    const startProjector = vi.fn(async () => running.promise)
    const key = { landscapeId: 'a', versionId: 'v1' }
    const fleet = new ProjectorFleet(new Repo({}), async () => 'root-a', {
      fallbackRootUrl: 'root-default',
      db: {} as never,
      ownsWorkspace: () => owns,
      startProjector,
    })

    const start = fleet.ensure(key)
    await settleUntil(() => startProjector.mock.calls.length > 0)
    expect(startProjector).toHaveBeenCalledOnce()
    owns = false
    fleet.release(key, 'lease-lost')
    running.resolve(lateStop)

    await expect(start).rejects.toBeInstanceOf(ProjectorOwnershipError)
    expect(lateStop).toHaveBeenCalledOnce()
    expect(fleet.snapshot()).toMatchObject({
      residentProjectors: 0,
      foreignResidentProjectors: 0,
    })
  })

  it('detaches an already-resident projector when its owner releases it', async () => {
    const stop = vi.fn()
    const key = { landscapeId: 'a', versionId: 'v1' }
    const fleet = new ProjectorFleet(new Repo({}), async () => 'root-a', {
      fallbackRootUrl: 'root-default',
      db: {} as never,
      startProjector: vi.fn(async () => stop),
    })
    await fleet.ensure(key)

    fleet.release(key, 'lease-lost')

    expect(stop).toHaveBeenCalledOnce()
    expect(fleet.isResident(key)).toBe(false)
    expect(fleet.snapshot()).toMatchObject({ ownershipEvictions: 1, foreignResidentProjectors: 0 })
  })

  it('exposes the resident projector instance id, and forgets it on release', async () => {
    // The promotion primitive's `projector-instance-mismatch` precondition —
    // the executable answer to the stale-state trap (a `read_model_projection_state`
    // row left by a PREVIOUS process reads healthy and says nothing about now) —
    // compares that row against the run happening NOW, so the fleet must
    // expose the resident projector's instance id: a caller passing `null`
    // DISABLES the check (live in tests, inert in production).
    //
    // `null` for an unknown or released workspace is not a gap: it is the honest
    // "this process cannot name it", and the precondition skips on it exactly as
    // it does for the standalone script.
    const key = { landscapeId: 'a', versionId: 'v1' }
    const startProjector = vi.fn(async (
      _repo: unknown, _root: unknown, _db: unknown, _key: unknown, _residency: unknown,
      _sweep: unknown, _resolve: unknown, _stillOwned: unknown, _onFenceLost: unknown,
      onAttached?: (instanceId: string) => void,
    ) => {
      onAttached?.('run-under-test')
      return vi.fn()
    })
    const fleet = new ProjectorFleet(new Repo({}), async () => 'root-a', {
      fallbackRootUrl: 'root-default',
      db: {} as never,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })

    expect(fleet.residentProjectorInstanceId(key)).toBeNull()
    await fleet.ensure(key)
    expect(fleet.residentProjectorInstanceId(key)).toBe('run-under-test')
    expect(fleet.residentProjectorInstanceId({ landscapeId: 'a', versionId: 'other' })).toBeNull()

    fleet.release(key, 'lease-lost')
    expect(fleet.residentProjectorInstanceId(key)).toBeNull()
  })

  it('shares one global concurrency budget across distinct workspaces', async () => {
    const admission = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 3 })
    const releases = new Map<string, ReturnType<typeof deferred<() => void>>>()
    const starts: string[] = []
    const startProjector = vi.fn(async (_repo, _root, _db, key) => {
      starts.push(key.landscapeId)
      const release = deferred<() => void>()
      releases.set(key.landscapeId, release)
      return release.promise
    })
    const fleet = new ProjectorFleet(
      new Repo({}),
      async (landscapeId) => landscapeId ? `root-${landscapeId}` : null,
      {
        fallbackRootUrl: 'root-default',
        db: {} as never,
        maxProjectors: 8,
        coldBuildAdmission: admission,
        startProjector,
      }
    )

    const a = fleet.ensure({ landscapeId: 'a', versionId: 'v1' })
    const b = fleet.ensure({ landscapeId: 'b', versionId: 'v1' })
    const c = fleet.ensure({ landscapeId: 'c', versionId: 'v1' })
    await settleUntil(() => starts.length >= 1)
    expect(starts).toEqual(['a'])
    expect(fleet.snapshot()).toMatchObject({ active: 1, queued: 2, inFlightWorkspaces: 3 })

    releases.get('a')!.resolve(vi.fn())
    await a
    await settleUntil(() => starts.length >= 2)
    expect(starts).toEqual(['a', 'b'])
    releases.get('b')!.resolve(vi.fn())
    await b
    await settleUntil(() => starts.length >= 3)
    expect(starts).toEqual(['a', 'b', 'c'])
    releases.get('c')!.resolve(vi.fn())
    await c
    expect(fleet.snapshot()).toMatchObject({ active: 0, queued: 0, residentProjectors: 3 })
    expect(startProjector).toHaveBeenCalledTimes(3)
    fleet.stopAll()
  })

  it('cancels queued starts and detaches a build that completes after stopAll', async () => {
    const admission = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 2 })
    const running = deferred<() => void>()
    const lateStop = vi.fn()
    const startProjector = vi.fn(async () => running.promise)
    const fleet = new ProjectorFleet(
      new Repo({}),
      async (landscapeId) => landscapeId ? `root-${landscapeId}` : null,
      {
        fallbackRootUrl: 'root-default',
        db: {} as never,
        maxProjectors: 8,
        coldBuildAdmission: admission,
        startProjector,
      }
    )
    const active = fleet.ensure({ landscapeId: 'a', versionId: 'v1' })
    const queued = fleet.ensure({ landscapeId: 'b', versionId: 'v1' })
    const queuedRejection = expect(queued).rejects.toBeInstanceOf(ColdBuildAdmissionStoppedError)
    await Promise.resolve()
    fleet.stopAll()
    await queuedRejection

    running.resolve(lateStop)
    await expect(active).rejects.toBeInstanceOf(ColdBuildAdmissionStoppedError)
    expect(lateStop).toHaveBeenCalledOnce()
    expect(fleet.snapshot()).toMatchObject({
      fleetStopped: true,
      residentProjectors: 0,
      inFlightWorkspaces: 0,
      queued: 0,
      cancelled: 1,
    })
  })
})

// ── extraction defects, refused deltas, and the sealed digest ────────────────

describe('extractModelEntities reports what it could not read', () => {
  it('has no defects on a healthy sharded workspace', async () => {
    // The gate that keeps every assertion below meaningful: if the ordinary
    // shape produced defects, the signal would be noise across the whole fleet.
    const docs: Record<string, unknown> = {
      meta: { objectShardUrls: ['os0'], connectionShardUrls: ['cs0'], groups: {} },
      os0: { objects: { o0: { id: 'o0' } } },
      cs0: { connections: {} },
      reg0: { diagrams: { d1: { id: 'd1' } } },
    }
    const model = await extractModelEntities(
      { modelMetaUrl: 'meta', modelUrl: '', shardUrls: ['reg0'] },
      async (url) => docs[url],
    )
    expect(model.defects).toEqual([])
    expect(model.objects).toHaveLength(1)
  })

  it('names an EMPTY object shard instead of contributing nothing silently', async () => {
    // The real-world case: an Automerge document with no data chunk resolves
    // fine and `doc()` returns `{}`. Its ids are absent from the read model, so
    // a counter must move.
    const docs: Record<string, unknown> = {
      meta: { objectShardUrls: ['os0', 'os1'], connectionShardUrls: [], groups: {} },
      os0: { objects: { o0: { id: 'o0' } } },
      os1: {},
      reg0: { diagrams: {} },
    }
    const model = await extractModelEntities(
      { modelMetaUrl: 'meta', modelUrl: '', shardUrls: ['reg0'] },
      async (url) => docs[url],
    )
    expect(model.objects).toHaveLength(1)
    expect(model.defects).toEqual([
      { kind: 'document-uninitialised', source: 'object-shard', url: 'os1' },
    ])
  })

  it('names an unreadable ModelMeta, the branch that discards the ENTIRE model', async () => {
    const model = await extractModelEntities(
      { modelMetaUrl: 'meta', modelUrl: '', shardUrls: ['reg0'] },
      async (url) => (url === 'reg0' ? { diagrams: { d1: { id: 'd1' } } } : undefined),
    )
    expect(model.objects).toEqual([])
    // It still projects the diagrams it COULD read; the hole is reported, not
    // fatal.
    expect(model.diagrams).toHaveLength(1)
    expect(model.defects).toEqual([{ kind: 'document-unreadable', source: 'model-meta', url: 'meta' }])
  })

  it('names an empty registry shard and a ModelMeta with no groups map', async () => {
    const docs: Record<string, unknown> = {
      meta: { objectShardUrls: [], connectionShardUrls: [] },
      reg0: {},
    }
    const model = await extractModelEntities(
      { modelMetaUrl: 'meta', modelUrl: '', shardUrls: ['reg0'] },
      async (url) => docs[url],
    )
    expect(model.defects).toEqual([
      { kind: 'document-uninitialised', source: 'registry-shard', url: 'reg0' },
      { kind: 'document-uninitialised', source: 'model-meta', url: 'meta' },
    ])
  })

  it('names a root that carries neither model reference', async () => {
    const model = await extractModelEntities({ modelUrl: '', shardUrls: [] }, async () => undefined)
    expect(model.defects).toEqual([{ kind: 'root-no-model-reference', source: 'root', url: null }])
  })

  it('reports the monolith path too', async () => {
    const model = await extractModelEntities(
      { modelUrl: 'model', shardUrls: [] },
      async () => ({ objects: { o0: { id: 'o0' } } }),
    )
    expect(model.objects).toHaveLength(1)
    // `connections` and `groups` are absent from that document.
    expect(model.defects.map((defect) => defect.kind)).toEqual([
      'document-uninitialised', 'document-uninitialised',
    ])
  })
})

describe('a shard delta is refused when the shard document is uninitialised', () => {
  const shardedDocs = (objects: Record<string, unknown>) => ({
    'automerge:root': { modelMetaUrl: 'automerge:meta', modelUrl: '', shardUrls: ['automerge:registry'] },
    'automerge:meta': { objectShardUrls: ['automerge:os0'], connectionShardUrls: [], groups: {} },
    'automerge:registry': { diagrams: {} },
    'automerge:os0': { objects },
  })

  it('applies a delta that empties the map, because {} IS a real deletion', async () => {
    const repo = fakeAutomergeRepo(shardedDocs({ o0: { id: 'o0' } }))
    const store = fakeDb()
    resetRefusedProjections()
    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      const before = store.matching(/DELETE FROM ro_objects/).length
      repo.publish('automerge:os0', { objects: {} })
      repo.emitChange('automerge:os0')
      await vi.waitFor(() => {
        expect(store.matching(/DELETE FROM ro_objects/).length).toBeGreaterThan(before)
      }, { timeout: 5_000 })
      expect(refusedProjectionCount()).toBe(0)
    } finally {
      stop()
    }
  })

  it('REFUSES a metadata projection whose ModelMeta lost its groups map', async () => {
    // `syncGroups` is a FULL sync: an empty list deletes every group row. Same
    // data-loss shape as the shard delta, same rule.
    const repo = fakeAutomergeRepo({
      'automerge:root': { modelMetaUrl: 'automerge:meta', modelUrl: '', shardUrls: ['automerge:registry'] },
      'automerge:meta': { objectShardUrls: [], connectionShardUrls: [], groups: { g1: { id: 'g1' } } },
      'automerge:registry': { diagrams: {} },
    })
    const store = fakeDb()
    resetRefusedProjections()
    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      const GROUP_FULL_SYNC = /DELETE FROM ro_group_technologies[\s\S]*<> ALL/
      const before = store.matching(GROUP_FULL_SYNC).length
      repo.publish('automerge:meta', { objectShardUrls: [], connectionShardUrls: [] })
      repo.emitChange('automerge:meta')
      await vi.waitFor(() => {
        expect(refusedProjectionCount()).toBe(1)
      }, { timeout: 5_000 })
      expect(store.matching(GROUP_FULL_SYNC).length).toBe(before)
    } finally {
      stop()
    }
  })

  it('REFUSES the delta when the objects field disappears, leaving the rows alone', async () => {
    // `Object.values(source?.objects ?? {})` would read an uninitialised shard
    // document as "every object in this shard was deleted", and
    // `applyObjectShardDelta` would delete them. A document that failed to load
    // is not evidence of a deletion.
    const repo = fakeAutomergeRepo(shardedDocs({ o0: { id: 'o0' }, o1: { id: 'o1' } }))
    const store = fakeDb()
    resetRefusedProjections()
    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      const before = store.matching(/DELETE FROM ro_objects/).length
      repo.publish('automerge:os0', {})
      repo.emitChange('automerge:os0')
      await vi.waitFor(() => {
        expect(refusedProjectionCount()).toBe(1)
      }, { timeout: 5_000 })
      expect(store.matching(/DELETE FROM ro_objects/).length).toBe(before)
    } finally {
      stop()
    }
  })
})

describe('the cold build seals a digest inside its own transaction', () => {
  it('stamps all four kinds, dated with the generation it just completed', async () => {
    const repo = fakeAutomergeRepo({
      'automerge:root': { modelMetaUrl: 'automerge:meta', modelUrl: '', shardUrls: ['automerge:registry'] },
      'automerge:meta': { objectShardUrls: ['automerge:os0'], connectionShardUrls: [], groups: { g1: { id: 'g1' } } },
      'automerge:registry': { diagrams: { d1: { id: 'd1' } } },
      'automerge:os0': { objects: { o0: { id: 'o0' }, o1: { id: 'o1' } } },
    })
    const store = fakeDb()
    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      const stamps = store.callsMatching(/content_digest = COALESCE/)
      expect(stamps.length).toBeGreaterThan(0)
      const stamp = stamps[0]!
      const sealed = JSON.parse(stamp.params[2] as string) as Record<string, { n: number; x: string; g: number }>
      expect(sealed.object).toMatchObject(digestOfIds(['o0', 'o1']))
      expect(sealed.connection).toMatchObject(digestOfIds([]))
      expect(sealed.group).toMatchObject(digestOfIds(['g1']))
      expect(sealed.diagram).toMatchObject(digestOfIds(['d1']))
      // Dated against the generation this projection completed, and GUARDED by
      // it — a newer generation having won means these rows are not ours. The
      // predicate is `<` rather than `=` because the stamp runs BEFORE
      // `completeReadModelProjection`, while the row still carries the
      // generation being superseded.
      expect(sealed.object.g).toBe(stamp.params[5])
      expect(stamp.text).toContain('projected_generation < $6')
      // And the carry-forward may only re-date a seal that was still current at
      // that previous generation. Without this clause an unrelated projection
      // resurrects a stale seal and a healthy read model reports corruption;
      // asserted on the SQL because the unit harness has no real database to
      // demonstrate it against (projectorService.integration.test.ts does).
      expect(stamp.text).toContain("value->>'g' = projected_generation::text")
      // A full extraction that found nothing wrong records ZERO, which is a
      // different fact from the NULL a never-examined workspace carries.
      expect(stamp.params[3]).toBe(0)
    } finally {
      stop()
    }
  })

  it('records the defect count and summary when the cold build could not read a shard', async () => {
    const repo = fakeAutomergeRepo({
      'automerge:root': { modelMetaUrl: 'automerge:meta', modelUrl: '', shardUrls: ['automerge:registry'] },
      'automerge:meta': { objectShardUrls: ['automerge:os0'], connectionShardUrls: [], groups: {} },
      'automerge:registry': { diagrams: {} },
      'automerge:os0': {},
    })
    const store = fakeDb()
    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    // The diagram probe is deferred and not awaited by the projector
    // (residency means the CORE model, not the flows), so settle it here
    // rather than assert a state that has not happened yet.
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      const stamp = store.callsMatching(/content_digest = COALESCE/)[0]!
      expect(stamp.params[3]).toBe(1)
      expect(stamp.params[4]).toContain('object-shard/document-uninitialised')
    } finally {
      stop()
    }
  })
})

// The deferral itself, pinned. `ProjectorFleet.start` marks a workspace resident
// only when `startReadModelProjector` resolves, and `/api/model/*` answers 503
// until then — so an awaited diagram probe would put every core route behind
// every diagram document (e.g. a minute of 503s on a workspace with a few
// unstored references).
describe('the diagram probe is deferred, not awaited', () => {
  it('attaches while a diagram document is still unresolved, and resolves it after', async () => {
    // Two things have to be pinned here, and a test that pins only the first
    // passes against DELETING the probe outright:
    //   (a) start() resolves while `held` is still pending — the probe is not
    //       on the attach path;
    //   (b) the probe nonetheless ran, and completes once `held` settles — it
    //       was deferred, not dropped.
    //
    // What this must NOT be is a stopwatch. "Attached, and ro_diagrams
    // written" right after start() is also satisfied by an AWAITED probe,
    // because the probe is bounded and its deadline simply fires; an
    // `elapsed < N` check discriminates only while two magic numbers stay
    // ordered, and wastes the full deadline on failure.
    //
    // `held` never settles on its own, so "did start() wait?" is a LIVENESS
    // question, and liveness is decidable in milliseconds: race start() against
    // a short deadline that exists only to fail. The awaiting mutant loses that
    // race with a sentence naming the defect; the honest path wins it in ~10 ms.
    const PROBE_DEADLINE_MS = 30_000 // must merely exceed ATTACH_BUDGET_MS
    const ATTACH_BUDGET_MS = 2_000
    const docs = workspaceDocs({
      d1: { id: 'd1', name: 'Held', objectIds: [], docUrl: 'automerge:d1doc' },
    })
    const inner = fakeAutomergeRepo(docs)
    const realFind = (inner.repo as unknown as { find: (url: string) => Promise<unknown> }).find
      .bind(inner.repo)
    const gate = deferred<void>()
    let diagramFinds = 0
    const slow = {
      ...inner.repo,
      find: async (url: string) => {
        if (/doc$/.test(url)) {
          diagramFinds += 1
          await gate.promise
          throw new Error('gave up')
        }
        return realFind(url)
      },
    } as unknown as Repo
    const store = fakeDb()

    const starting = startReadModelProjector(
      slow, 'automerge:root', store.db, WORKSPACE, undefined, 0, PROBE_DEADLINE_MS,
    )
    // The losing side of the race is still running. Release the gate and stop
    // whatever eventually attaches, on the failing path too — an awaiting mutant
    // must fail on the assertion, not on a leaked projector afterwards.
    const cleanup = async () => {
      gate.resolve()
      await starting.then((stop) => stop(), () => undefined)
    }
    let attachTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        starting,
        new Promise<never>((_, reject) => {
          attachTimer = setTimeout(() => reject(new Error(
            `start() had not resolved after ${ATTACH_BUDGET_MS} ms with the diagram document `
            + 'still held — it awaited the diagram probe',
          )), ATTACH_BUDGET_MS)
        }),
      ])
    } catch (error) {
      await cleanup()
      throw error
    } finally {
      clearTimeout(attachTimer)
    }
    try {
      expect(store.matching(/projector_attached = true/).length).toBe(1)
      // (b), first half: the probe is in flight, not skipped. Without this the
      // test is satisfied by a build that never probes diagrams at all.
      await vi.waitFor(() => { expect(diagramFinds).toBeGreaterThan(0) }, { timeout: 5_000 })

      gate.resolve()
      // (b), second half: it completes. `awaitInitialDiagramProbe` is the seam
      // the other ~30 tests here lean on; a probe whose rejection escaped the
      // stored promise would leave this pending forever.
      await Promise.race([
        awaitInitialDiagramProbe(WORKSPACE),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
          'awaitInitialDiagramProbe never settled after the diagram resolve failed',
        )), 5_000)),
      ])
      expect(store.matching(/ro_diagrams/).length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  }, 30_000)
})

describe('resolveHandleWithRetry — the release guard', () => {
  afterEach(() => {
    // Module-level state. Leaving a guard installed would make the NEXT file's
    // expectations depend on test order.
    setDocumentReleaseGuard(null)
  })

  /** A repo that always reports the document unavailable, so the release path
   *  is reached on every attempt and `removeFromCache` is the only variable. */
  function unavailableRepo(): { repo: Repo; removeFromCache: ReturnType<typeof vi.fn> } {
    const documentId = 'refused-doc'
    const removeFromCache = vi.fn(async () => undefined)
    const repo = fakeRepo({
      find: vi.fn(async () => { throw new Error('Document is unavailable') }),
      findWithProgress: () => ({ peek: () => ({ state: 'unavailable' }) }),
      handles: { [documentId]: { documentId, state: 'unavailable' } },
      removeFromCache,
    })
    return { repo, removeFromCache }
  }

  it('releases as before when NO guard is installed', async () => {
    const { repo, removeFromCache } = unavailableRepo()
    await expect(resolveHandleWithRetry(repo, 'automerge:refused-doc', { tries: 2, delayMs: 0 }))
      .rejects.toThrow()
    // Fail-open is deliberate: every unit test and every tool that builds a bare
    // projector runs with no guard, and must keep the unguarded behaviour.
    expect(removeFromCache).toHaveBeenCalled()
  })

  it('does NOT detach a document whose refusal is still outstanding', async () => {
    const { repo, removeFromCache } = unavailableRepo()
    setDocumentReleaseGuard((documentId) => documentId !== 'refused-doc')

    await expect(resolveHandleWithRetry(repo, 'automerge:refused-doc', { tries: 3, delayMs: 0 }))
      .rejects.toThrow()

    // This is the whole point: `removeFromCache` -> CollectionSynchronizer.detach
    // deletes the DocSynchronizer that `shareConfigChanged()` must traverse to
    // lift the very refusal that made this document unresolvable.
    expect(removeFromCache).not.toHaveBeenCalled()
  })

  it('is asked about the DOCUMENT ID, not the URL', async () => {
    const { repo } = unavailableRepo()
    const seen: string[] = []
    setDocumentReleaseGuard((documentId) => { seen.push(documentId); return true })

    await expect(resolveHandleWithRetry(repo, 'automerge:refused-doc', { tries: 1, delayMs: 0 }))
      .rejects.toThrow()

    expect(seen).toContain('refused-doc')
    expect(seen.every((id) => !id.startsWith('automerge:'))).toBe(true)
  })

  it('a guard that THROWS releases anyway rather than wedging the retry loop', async () => {
    const { repo, removeFromCache } = unavailableRepo()
    setDocumentReleaseGuard(() => { throw new Error('ledger exploded') })

    await expect(resolveHandleWithRetry(repo, 'automerge:refused-doc', { tries: 2, delayMs: 0 }))
      .rejects.toThrow(/unavailable/i)
    expect(removeFromCache).toHaveBeenCalled()
  })
})

/** A residency whose eviction can be driven from a test.
 *
 * Only three members are reached from the projector — `acquire`,
 * `releaseOwner`, `onBeforeEvict` — and `evict` here fires the listeners
 * WITHOUT removing the handle from the repo, which is the state the resident
 * sweep exists for: the document was dropped and has come straight back, so a
 * ready handle is sitting there with no watcher on it. */
function fakeResidency() {
  const listeners = new Set<(documentId: string, handle?: unknown) => void>()
  return {
    leases: {
      acquire: () => {},
      releaseOwner: () => {},
      onBeforeEvict: (fn: (documentId: string, handle?: unknown) => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    } as unknown as AutomergeResidencyLeases,
    evict: (documentId: string) => { for (const fn of [...listeners]) fn(documentId) },
  }
}

describe('N8.1 — the resident sweep and the three-guard ownership invariant', () => {
  /** A url is owned by exactly one of: an attached watcher, an in-flight
   * attempt, or the retry queue. The sweep must consult all three: the first
   * is the one set LAST — `diagramWatchers.set` runs at the end of
   * `projectThenWatch`, after `await project()`. */
  const DIAGRAM = { d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' } }
  // What matters here is that the SWEEP adds no attempt while the queue owns
  // the url, and the test below measures that directly by counting
  // `repo.find`s. A ceiling on the queue's own budget belongs to the queue's
  // own suite (a local copy of the budget constant would assert nothing about
  // production).

  it('re-attaches ONCE when the projection outlives many sweep ticks', async () => {
    const docs = workspaceDocs(DIAGRAM)
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const residency = fakeResidency()

    // 10 ms sweep, so the held projection below spans ~20 ticks. The window in
    // production is any `project()` slower than `residentSweepMs` — an
    // object-shard delta on a large model, or a slow pool.
    const stop = await startReadModelProjector(
      repo.repo, 'automerge:root', store.db, WORKSPACE, residency.leases, 10,
    )
    try {
      await awaitInitialDiagramProbe(WORKSPACE)
      const attemptsAfterBoot = repo.onCallCount('automerge:d1doc')
      expect(repo.listenerCount('automerge:d1doc')).toBe(1)

      // Hold the flow projection: every re-attach now blocks INSIDE
      // `projectThenWatch`, before it can write `diagramWatchers`.
      store.holdWhen(FLOW_PROJECTION)
      residency.evict('d1doc')
      expect(repo.listenerCount('automerge:d1doc')).toBe(0)

      await vi.waitFor(() => { expect(store.held()).toBe(true) })
      // ~20 sweep ticks with the projection still in flight. A sweep that
      // ignored in-flight attempts would enter `attachDiagramDoc` on each one.
      await new Promise((done) => setTimeout(done, 200))
      store.release()

      await vi.waitFor(() => { expect(repo.listenerCount('automerge:d1doc')).toBe(1) })
      // Settle: anything a redundant attach started is resolved by now.
      await new Promise((done) => setTimeout(done, 100))

      // `DocHandle.on` deduplicates by IDENTITY and each
      // attach builds a NEW `coalescer.trigger` closure, so stacked attaches are
      // stacked listeners — `diagramWatchers` keeps only the last and every
      // earlier `stop()` closure is unreachable.
      expect(repo.listenerCount('automerge:d1doc')).toBe(1)
      // The registration ATTEMPTS, which is the observable that survives the
      // dedup and the one that counts `repo.find` cost too.
      expect(repo.onCallCount('automerge:d1doc') - attemptsAfterBoot).toBe(1)
    } finally {
      store.holdWhen(null)
      store.release()
      stop()
    }
  }, 30_000)

  it('leaves NO listener behind after stop(), which is what poisons the orphan detector', async () => {
    // The consequence that ranks first: an orphaned listener survives `stop()`
    // and goes on projecting for a workspace this projector no longer serves —
    // projection writes are not gated by `stopped`/`stillOwned`, only health
    // writes are. The next eviction then counts it and fires
    // `automerge.orphaned_listener_evicted`, the detector built to catch exactly
    // that class.
    const docs = workspaceDocs(DIAGRAM)
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const residency = fakeResidency()

    const stop = await startReadModelProjector(
      repo.repo, 'automerge:root', store.db, WORKSPACE, residency.leases, 10,
    )
    try {
      await awaitInitialDiagramProbe(WORKSPACE)
      store.holdWhen(FLOW_PROJECTION)
      residency.evict('d1doc')
      await vi.waitFor(() => { expect(store.held()).toBe(true) })
      await new Promise((done) => setTimeout(done, 200))
      store.release()
      await vi.waitFor(() => { expect(repo.listenerCount('automerge:d1doc')).toBe(1) })
    } finally {
      store.holdWhen(null)
      store.release()
      stop()
    }
    // `stop()` walks `diagramWatchers`, which holds ONE entry per url; stacked
    // extra closures would never be in it to be walked.
    await new Promise((done) => setTimeout(done, 60))
    expect(repo.listenerCount('automerge:d1doc')).toBe(0)
  }, 30_000)

  it('does not race a re-attach the RETRY QUEUE already owns', async () => {
    // The sweep re-attaches through `tryAttachDiagramDoc`, so a failure is
    // QUEUED — from that moment the url is owned by `documentRetries`, and a
    // sweep that consulted
    // only `diagramWatchers` would attach concurrently on every tick for as long
    // as it stayed there.
    //
    // Note the shape needed to reach it: the document must have attached ONCE,
    // because the sweep iterates `diagramUrlByDocumentId` and only a successful
    // resolve puts an entry there. A never-resolved document is not reachable
    // from this loop at all, so a test built on one would assert nothing.
    const docs = workspaceDocs(DIAGRAM)
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const residency = fakeResidency()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const stop = await startReadModelProjector(
      repo.repo, 'automerge:root', store.db, WORKSPACE, residency.leases, 10,
    )
    try {
      await awaitInitialDiagramProbe(WORKSPACE)
      const findsAfterBoot = repo.findsFor('automerge:d1doc')

      // Evict, and make every projection fail: the sweep's re-attach resolves
      // the handle, then throws a `DiagramFlowProjectionError` out of
      // `project()`, which schedules a bounded REPROJECTION in
      // `documentRetries`. From here the url belongs to the queue.
      //
      // `findsFor`, not `onCallCount`: a failing attach throws inside
      // `projectThenWatch` BEFORE `handle.on('change', …)`, so it registers no
      // listener at all and the listener counter never moves — the observable
      // has to be one the failing path actually produces.
      store.failWhen(FLOW_PROJECTION)
      residency.evict('d1doc')
      await vi.waitFor(() => {
        expect(repo.findsFor('automerge:d1doc')).toBeGreaterThan(findsAfterBoot)
      })
      const findsOnceQueued = repo.findsFor('automerge:d1doc')

      // ~20 more ticks. The queue re-runs `projectThenWatch` from the handle it
      // already holds, so a retry costs NO `repo.find`; every find in this
      // window is a sweep that went around the queue.
      await new Promise((done) => setTimeout(done, 200))
      expect(repo.findsFor('automerge:d1doc') - findsOnceQueued).toBe(0)
    } finally {
      store.failWhen(null)
      spy.mockRestore()
      stop()
    }
  }, 30_000)
})

describe('N8.4 — a shard-arrival pass must silence the health beat', () => {
  /** Both tests need the same three things, and the third is the one that makes
   * them mean anything: a workspace whose health is NOT yet published (so a
   * CLEAR is still possible at all), a shard whose document has not arrived (so
   * a pass is genuinely in flight), and a LIVENESS WITNESS — the CLEAR must
   * appear once the shard lands. Without the witness, "no CLEAR" and "the
   * projector was dead" are the same green. */
  function gatedRepo(docs: Record<string, FakeDoc>, gatedUrl: string) {
    const repo = fakeAutomergeRepo(docs)
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => { open = resolve })
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    let attempts = 0
    return {
      ...repo,
      // The wrapper counts SEPARATELY from `findsFor`, which only sees calls
      // that reach the inner fake — and a gated call never does until it is
      // released, which is the whole state being measured.
      arrivalAttempts: () => attempts,
      openGate: () => { open() },
      gatedRepo: {
        ...repo.repo,
        find: async (url: string) => {
          if (url === gatedUrl) { attempts += 1; await gate }
          return realFind(url)
        },
      } as unknown as Repo,
    }
  }

  it('publishes no CLEAR while a newly-appended REGISTRY shard is still arriving', async () => {
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' } })
    // `automerge:d1doc` is deliberately absent: the diagram lands in
    // `documentRetries`, so `healthPublished` stays false and a CLEAR remains
    // reachable. With health already latched true, this whole scenario is
    // unobservable — which is why the missing document is load-bearing setup,
    // not incidental.
    docs['automerge:newshard'] = { diagrams: {} }
    const harness = gatedRepo(docs, 'automerge:newshard')
    const store = fakeDb()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 20 ms health beat (it borrows the sweep cadence), and no residency, so the
    // resident sweep is not installed and cannot confound this.
    const stop = await startReadModelProjector(
      harness.gatedRepo, 'automerge:root', store.db, WORKSPACE, undefined, 20, 50,
    )
    try {
      await awaitInitialDiagramProbe(WORKSPACE)
      expect(store.matching(CLEAR_DEGRADED)).toHaveLength(0)

      // Append the shard and start the pass. It blocks on the gate, so the
      // window is held open for as long as this test needs instead of being bet
      // on a fixed number of milliseconds.
      ;(docs['automerge:root'] as { shardUrls: string[] }).shardUrls.push('automerge:newshard')
      harness.emitChange('automerge:root')
      await vi.waitFor(() => { expect(harness.arrivalAttempts()).toBeGreaterThan(0) })

      // Now let the queued diagram succeed, so a publish is DECIDED in the
      // middle of the shard pass.
      //
      // What is measured: with a pass in flight, NO route publishes — which is
      // stronger than pinning one of them, and is what the guard actually
      // promises. This test does not depend on a particular publish route
      // (`onIdle` or the health beat); other tests cover those.
      docs['automerge:d1doc'] = { flows: {} }
      await vi.waitFor(() => { expect(harness.listenerCount('automerge:d1doc')).toBe(1) }, { timeout: 10_000 })
      // Several more beats, so this is not merely a race the assertion won.
      await new Promise((done) => setTimeout(done, 150))

      expect(store.matching(CLEAR_DEGRADED)).toHaveLength(0)

      // THE WITNESS. Release the shard and the workspace really is healthy, so
      // the CLEAR must arrive — otherwise the assertion above is satisfied by a
      // projector that had simply stopped writing.
      harness.openGate()
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 10_000 })
    } finally {
      harness.openGate()
      spy.mockRestore()
      stop()
    }
  }, 30_000)

  it('publishes no CLEAR while a newly-appended OBJECT shard is still arriving', async () => {
    // The meta path, whose budget is `SHARD_ARRIVAL_TRIES` (20) rather than the
    // root path's 3 — the longer of the two windows. Guarded by the same
    // wrapper, and tested separately because a
    // single `withReconciling` call site covering both would be exactly the
    // "two green halves that never meet" shape: one wired, one not, one test.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' } })
    docs['automerge:newobjects'] = { objects: {} }
    const harness = gatedRepo(docs, 'automerge:newobjects')
    const store = fakeDb()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const stop = await startReadModelProjector(
      harness.gatedRepo, 'automerge:root', store.db, WORKSPACE, undefined, 20, 50,
    )
    try {
      await awaitInitialDiagramProbe(WORKSPACE)
      expect(store.matching(CLEAR_DEGRADED)).toHaveLength(0)

      // ASSIGNED, not pushed. `extractModelEntities` keeps a reference to the
      // very array `metaHandle.doc()` hands it, and this fake's `doc()` returns
      // the live object — so `push` would also grow `model.objectShardUrls`, the
      // list the loop diffs against, and the shard would read as
      // already-watched. A real Automerge `doc()` hands out a fresh snapshot
      // each time; assigning a new array reproduces those semantics.
      ;(docs['automerge:meta'] as { objectShardUrls: string[] }).objectShardUrls = ['automerge:newobjects']
      harness.emitChange('automerge:meta')
      await vi.waitFor(() => { expect(harness.arrivalAttempts()).toBeGreaterThan(0) }, { timeout: 5_000 })

      docs['automerge:d1doc'] = { flows: {} }
      await vi.waitFor(() => { expect(harness.listenerCount('automerge:d1doc')).toBe(1) }, { timeout: 10_000 })
      await new Promise((done) => setTimeout(done, 150))

      expect(store.matching(CLEAR_DEGRADED)).toHaveLength(0)

      harness.openGate()
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 10_000 })
    } finally {
      harness.openGate()
      spy.mockRestore()
      stop()
    }
  }, 30_000)
})

describe('N8.1 round two — the holes three review lenses found', () => {
  const DIAGRAM = { d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' } }

  it('installs NO watcher for an attach still IN FLIGHT when stop() runs', async () => {
    // Pins the `documentRetries.signal` wire (passing `undefined` instead
    // would otherwise go unnoticed).
    //
    // `resolveHandleWithRetry` consults the signal at its loop head and around
    // `repo.find`, and NOWHERE after the handle resolves. So threading a signal
    // bounds the RESOLVE — the short phase on this path — and leaves
    // `await project()`, the long one, wide open. An attach parked there across
    // a `stop()` could reach `handle.on('change', …)` after
    // `diagramWatchers.clear()` and write into a map nothing would ever walk
    // again — a listener that then drives full `syncConnectionFlows`
    // transactions for a workspace this projector no longer serves.
    //
    // The existing `leaves NO listener behind after stop()` test LOOKS like this
    // one and is not: it releases the hold and waits for the attach to land
    // BEFORE stopping, so nothing is ever in flight across the teardown.
    const docs = workspaceDocs(DIAGRAM)
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const residency = fakeResidency()

    const stop = await startReadModelProjector(
      repo.repo, 'automerge:root', store.db, WORKSPACE, residency.leases, 10,
    )
    let stopped = false
    try {
      await awaitInitialDiagramProbe(WORKSPACE)
      store.holdWhen(FLOW_PROJECTION)
      residency.evict('d1doc')

      // THE WITNESS that the scenario was actually set up: a flow-projection
      // statement is parked, so an attach really is inside `project()`. Without
      // it, "no listener afterwards" is equally satisfied by a sweep that never
      // ran, and the test would pass against any build.
      await vi.waitFor(() => { expect(store.held()).toBe(true) })

      stop()
      stopped = true
      const flowsAtStop = store.matching(FLOW_PROJECTION).length

      // Let the parked projection finish. Its continuation reaches the
      // `handle.on('change', …)` line with `stopped === true`.
      store.release()
      await new Promise((done) => setTimeout(done, 150))

      expect(repo.listenerCount('automerge:d1doc')).toBe(0)

      // And the consequence, not only the symptom: a change arriving afterwards
      // must drive no projection, because no listener may exist to hear it.
      repo.emitChange('automerge:d1doc')
      await new Promise((done) => setTimeout(done, 100))
      expect(store.matching(FLOW_PROJECTION).length).toBe(flowsAtStop)
    } finally {
      store.holdWhen(null)
      store.release()
      if (!stopped) stop()
    }
  }, 30_000)

  it('a second reconcile over an ALREADY-WATCHED diagram adds no listener', async () => {
    // The other of the two call sites. Through the sweep, dropping
    // `diagramWatchers.has` from the three-guard is masked by the sweep's own
    // `continue`; through `reconcilePass` -> `resolveInBatches` it is not, so a
    // registry change that re-runs the pass over unchanged diagrams would stack
    // one distinct `coalescer.trigger` per diagram — the same orphaned-listener
    // class, through the other door. Only this test covers that clause.
    const docs = workspaceDocs(DIAGRAM)
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(
      repo.repo, 'automerge:root', store.db, WORKSPACE, undefined, 0,
    )
    try {
      await awaitInitialDiagramProbe(WORKSPACE)
      expect(repo.listenerCount('automerge:d1doc')).toBe(1)
      const attemptsAfterBoot = repo.onCallCount('automerge:d1doc')

      // A registry change with the SAME diagram list re-runs the whole pass.
      for (let round = 0; round < 3; round += 1) {
        repo.emitChange('automerge:registry')
        await new Promise((done) => setTimeout(done, 60))
      }

      // The witness that the passes ran at all: the registry projection reaches
      // the database each time. Without it, "no new listener" is satisfied by a
      // change that was never delivered.
      expect(store.matching(/INSERT INTO ro_diagrams/).length).toBeGreaterThan(1)
      expect(repo.listenerCount('automerge:d1doc')).toBe(1)
      expect(repo.onCallCount('automerge:d1doc') - attemptsAfterBoot).toBe(0)
    } finally {
      stop()
    }
  }, 30_000)

  it('does not re-arm a document the retry queue has ABANDONED', async () => {
    // `publishDegradation` deduplicates by KIND; `project()`'s catch degrades
    // as `registry` and `onDiagramRetryAbandoned` as `document_resolution`, so
    // a sweep that re-arms an abandoned url would let the two alternating
    // kinds defeat the dedup, writing the health row TWICE per cycle,
    // unbounded.
    const docs = workspaceDocs(DIAGRAM)
    docs['automerge:d1doc'] = { flows: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    const residency = fakeResidency()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // The queue's real backoff is 250 ms doubling to 30 s, so one full
    // fail -> retry x5 -> abandon -> re-arm cycle is ~8 s at production
    // settings, so a short window after the FIRST degradation would sit inside
    // the first cycle, before any amplification. Compressed here rather than
    // waited out: 5 ms base, 20 ms ceiling
    // makes a cycle ~100 ms and the window below covers several.
    const savedBase = process.env.READ_MODEL_DOC_RETRY_BASE_MS
    const savedMax = process.env.READ_MODEL_DOC_RETRY_MAX_MS
    process.env.READ_MODEL_DOC_RETRY_BASE_MS = '5'
    process.env.READ_MODEL_DOC_RETRY_MAX_MS = '20'

    const stop = await startReadModelProjector(
      repo.repo, 'automerge:root', store.db, WORKSPACE, residency.leases, 10,
    )
    try {
      await awaitInitialDiagramProbe(WORKSPACE)
      store.failWhen(FLOW_PROJECTION)
      residency.evict('d1doc')

      // Wait for the queue to give up. TWO rows is the witness that the whole
      // cycle ran: `project()`'s catch degrades as `registry` and
      // `onDiagramRetryAbandoned` as `document_resolution`, and it is precisely
      // those two kinds alternating that defeat `publishDegradation`'s dedup.
      // Waiting for one row would stop before the abandonment.
      await vi.waitFor(() => {
        expect(store.matching(MARK_DEGRADED).length).toBeGreaterThanOrEqual(2)
      }, { timeout: 15_000 })
      const marksAfterAbandon = store.matching(MARK_DEGRADED).length

      // ~100 sweep ticks and ~10 cycles' worth of time. A sweep that re-arms an
      // abandoned url adds two rows per cycle, unbounded.
      await new Promise((done) => setTimeout(done, 1_000))
      expect(store.matching(MARK_DEGRADED).length).toBe(marksAfterAbandon)
    } finally {
      if (savedBase === undefined) delete process.env.READ_MODEL_DOC_RETRY_BASE_MS
      else process.env.READ_MODEL_DOC_RETRY_BASE_MS = savedBase
      if (savedMax === undefined) delete process.env.READ_MODEL_DOC_RETRY_MAX_MS
      else process.env.READ_MODEL_DOC_RETRY_MAX_MS = savedMax
      store.failWhen(null)
      spy.mockRestore()
      stop()
    }
  }, 30_000)
})

describe('N8.4 round two — what the witness could not see', () => {
  function gatedRepo(docs: Record<string, FakeDoc>, gatedUrl: string) {
    const repo = fakeAutomergeRepo(docs)
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => { open = resolve })
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    let attempts = 0
    return {
      ...repo,
      arrivalAttempts: () => attempts,
      openGate: () => { open() },
      gatedRepo: {
        ...repo.repo,
        find: async (url: string) => {
          if (url === gatedUrl) { attempts += 1; await gate }
          return realFind(url)
        },
      } as unknown as Repo,
    }
  }

  it('publishes no CLEAR while a newly-appended CONNECTION shard is still arriving', async () => {
    // The third case: the meta path's two loops are guarded together, and the
    // object-shard test covers only the OBJECT one. This pins the CONNECTION
    // loop, so lifting it out of the guard turns a test red.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' } })
    docs['automerge:newconnections'] = { connections: {} }
    const harness = gatedRepo(docs, 'automerge:newconnections')
    const store = fakeDb()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const stop = await startReadModelProjector(
      harness.gatedRepo, 'automerge:root', store.db, WORKSPACE, undefined, 20, 50,
    )
    try {
      await awaitInitialDiagramProbe(WORKSPACE)
      expect(store.matching(CLEAR_DEGRADED)).toHaveLength(0)

      ;(docs['automerge:meta'] as { connectionShardUrls: string[] }).connectionShardUrls = ['automerge:newconnections']
      harness.emitChange('automerge:meta')
      await vi.waitFor(() => { expect(harness.arrivalAttempts()).toBeGreaterThan(0) }, { timeout: 5_000 })

      docs['automerge:d1doc'] = { flows: {} }
      await vi.waitFor(() => { expect(harness.listenerCount('automerge:d1doc')).toBe(1) }, { timeout: 10_000 })
      await new Promise((done) => setTimeout(done, 150))

      expect(store.matching(CLEAR_DEGRADED)).toHaveLength(0)

      harness.openGate()
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 10_000 })
    } finally {
      harness.openGate()
      spy.mockRestore()
      stop()
    }
  }, 30_000)

  it('the DEPTH counter is load-bearing — an inner pass ending does not un-silence an outer one', async () => {
    // `withReconciling`'s docstring justifies a counter over a boolean with the
    // nested case; this exercises it.
    //
    // Two shards gated independently. Release the inner one; while the outer is
    // still arriving, a boolean guard would already read 0 and publish.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'One', objectIds: [], docUrl: 'automerge:d1doc' } })
    docs['automerge:newobjects'] = { objects: {} }
    docs['automerge:newshard'] = { diagrams: {} }
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()
    let openMeta: () => void = () => {}
    let openRoot: () => void = () => {}
    const metaGate = new Promise<void>((resolve) => { openMeta = resolve })
    const rootGate = new Promise<void>((resolve) => { openRoot = resolve })
    const inner = repo.repo as unknown as { find: (url: string) => Promise<unknown> }
    const realFind = inner.find.bind(inner)
    let metaAttempts = 0
    let rootAttempts = 0
    const gated = {
      ...repo.repo,
      find: async (url: string) => {
        if (url === 'automerge:newobjects') { metaAttempts += 1; await metaGate }
        if (url === 'automerge:newshard') { rootAttempts += 1; await rootGate }
        return realFind(url)
      },
    } as unknown as Repo
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const stop = await startReadModelProjector(
      gated, 'automerge:root', store.db, WORKSPACE, undefined, 20, 50,
    )
    try {
      await awaitInitialDiagramProbe(WORKSPACE)
      expect(store.matching(CLEAR_DEGRADED)).toHaveLength(0)

      ;(docs['automerge:meta'] as { objectShardUrls: string[] }).objectShardUrls = ['automerge:newobjects']
      repo.emitChange('automerge:meta')
      ;(docs['automerge:root'] as { shardUrls: string[] }).shardUrls = ['automerge:registry', 'automerge:newshard']
      repo.emitChange('automerge:root')
      await vi.waitFor(() => {
        expect(metaAttempts).toBeGreaterThan(0)
        expect(rootAttempts).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      docs['automerge:d1doc'] = { flows: {} }
      await vi.waitFor(() => { expect(repo.listenerCount('automerge:d1doc')).toBe(1) }, { timeout: 10_000 })

      // Inner pass done, outer still arriving. Depth 2 -> 1, not -> 0.
      openMeta()
      await new Promise((done) => setTimeout(done, 250))
      expect(store.matching(CLEAR_DEGRADED)).toHaveLength(0)

      // THE WITNESS: releasing the outer one really does let the CLEAR out, so
      // the silence above was the guard and not a dead projector.
      openRoot()
      await vi.waitFor(() => {
        expect(store.matching(CLEAR_DEGRADED).length).toBeGreaterThan(0)
      }, { timeout: 10_000 })
    } finally {
      openMeta()
      openRoot()
      spy.mockRestore()
      stop()
    }
  }, 30_000)

})

describe('createReconcilingGuard — the two properties a battery killed nothing on', () => {
  it('is DEPTH, so an inner pass ending does not clear the guard for an outer one', async () => {
    // The wrapper's whole justification for a counter over a boolean, pinned
    // at unit level.
    const guard = createReconcilingGuard()
    let releaseOuter: () => void = () => {}
    let releaseInner: () => void = () => {}
    const outer = new Promise<void>((resolve) => { releaseOuter = resolve })
    const inner = new Promise<void>((resolve) => { releaseInner = resolve })

    expect(guard.depth).toBe(0)
    const outerRun = guard.run(async () => { await outer })
    const innerRun = guard.run(async () => { await inner })
    expect(guard.depth).toBe(2)

    releaseInner()
    await innerRun
    // A boolean reads 0 here, and the health publish would speak while the
    // outer pass is still in flight.
    expect(guard.depth).toBe(1)

    releaseOuter()
    await outerRun
    expect(guard.depth).toBe(0)
  })

  it('lowers the depth when the pass REJECTS, which is the worse survivor of the two', async () => {
    // `depth -= 1` must stay in the `finally`. Otherwise one rejecting pass
    // latches the depth at 1 for the projector's LIFE, and
    // `publishHealthIfNothingOutstanding` returns at its first clause — so the
    // workspace could never be reported healthy again, silently, with no
    // degradation recorded to explain it.
    const guard = createReconcilingGuard()
    await expect(guard.run(async () => { throw new Error('pass failed') })).rejects.toThrow('pass failed')
    expect(guard.depth).toBe(0)

    // A callback that throws SYNCHRONOUSLY, which `() => Promise<T>` permits and
    // `f().then(ok, fail)` would not catch. It
    // reaches the `finally` because `pass()` is invoked inside the `try`.
    await expect(guard.run((() => { throw new Error('sync') }) as () => Promise<void>))
      .rejects.toThrow('sync')
    expect(guard.depth).toBe(0)

    // And the guard still works afterwards, which is the property that actually
    // matters: a rejection must not poison it for every later pass.
    let ran = false
    await guard.run(async () => { ran = true })
    expect(ran).toBe(true)
    expect(guard.depth).toBe(0)
  })

  it('hands the pass result back', async () => {
    // The return value is passed through. Cheap to pin, and the meta path's
    // caller does use the value.
    const guard = createReconcilingGuard()
    await expect(guard.run(async () => 'value')).resolves.toBe('value')
  })
})

/**
 * The fleet's refusal is a VERDICT with a timestamp; the transaction's is a
 * GUARANTEE over an interval.
 *
 * `ProjectorFleet.start` calls `isStaticWorkspace` once, at attach: two
 * writers on one workspace's ro_* rows would advance generations
 * independently.
 *
 * The promotion primitive's `release()` does not fire on either CLI door — `promote-summary.ts` and
 * `demote-summary.ts` pass no hooks at all, and run in a different process from
 * the fleet, so they could not reach it if they did. Nothing re-checks after
 * attach and nothing detaches a resident ordinary projector when its workspace
 * is promoted underneath it, so the window is open until the pod restarts.
 * `projectorFleetStatic.test.ts` pins the attach-time half; this is the other.
 */
describe('A8 — a workspace promoted under an attached ordinary projector', () => {
  it('stops writing ro_* rows AND stops moving the generation', async () => {
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'Boot', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // LIVENESS WITNESS: an ordinary workspace really is being projected, and
      // an ordinary change really does reach the row plane. Without this the
      // negatives below would pass against a projector that never ran at all.
      expect(store.matching(/ro_diagrams/).length).toBeGreaterThan(0)
      repo.emitChange('automerge:root')
      await vi.waitFor(() => {
        expect(store.matching(/RETURNING observed_generation/).length).toBeGreaterThan(1)
      }, { timeout: 5_000 })

      const rowsBefore = store.matching(/DELETE FROM ro_objects/).length
      const generationsBefore = store.matching(/RETURNING observed_generation/).length

      // The promotion lands — from another process, so nothing here is told.
      store.setStatic(true)
      repo.emitChange('automerge:root')
      await flushMicrotasks()
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Not one row. Without the plane check this pass would write `ro_*` into
      // a plane the static projector now owns, unserialized against it, where
      // a pure INSERT
      // survives the other writer's blanket DELETE as a phantom certified by
      // that writer's own arrival watermark.
      expect(store.matching(/DELETE FROM ro_objects/).length).toBe(rowsBefore)
      // And the generation did not move. A SEPARATE property, and the only one
      // the in-transaction gate cannot buy on its own: `beginReadModelProjection`
      // runs on the pool, outside the transaction, so a rollback cannot undo it.
      // Each refused pass would otherwise walk the STATIC projector's healthy
      // workspace to `catching_up`, refusing `absenceProvable` and blocking
      // compaction — mirroring exactly what a stale static projector does to an
      // ordinary one.
      expect(store.matching(/RETURNING observed_generation/).length).toBe(generationsBefore)
      // No failure telemetry onto a health row that now describes the other
      // writer — the same refusal `runTracked` already makes for a lost fence.
      // The pattern is the INCREMENT, not the column: `completeReadModelProjection`
      // names `consecutive_failures` too (to reset it), so the bare column name
      // matches every SUCCESSFUL pass and this assertion would be
      // vacuous-or-wrong rather than a check.
      expect(store.matching(/consecutive_failures \+ 1/).length).toBe(0)
    } finally {
      stop()
    }
  }, 30_000)

  /** A registry whose diagram points at a document that does not exist yet, so
   * `fakeAutomergeRepo.find` throws "is unavailable" and the projector QUEUES
   * it. Publishing the document later is what lets the queued retry succeed —
   * which makes the ordering below a fact rather than a timing bet. */
  const lateDiagram = () => workspaceDocs({
    d1: { id: 'd1', name: 'Late', docUrl: 'automerge:late', objectIds: [] },
  })
  const lateDoc = { flows: { f1: { id: 'f1', steps: [{ connectionId: 'c1' }] } } }

  it('does not degrade a diagram whose flow projection merely lost the MUTEX', async () => {
    // The degradation guard skips an authority loss; a busy mutex is
    // deliberately NOT one of those, so it needs its own skip, or transient
    // contention writes a `degraded_since` — the same forgery
    // `failReadModelProjection` must not make, one stack frame up, on the same
    // health row. The two predicates
    // stay separate because they differ on RETRY, but they agree completely
    // here: neither is a degradation of THIS workspace's read model.
    const docs = workspaceDocs(
      { d1: { id: 'd1', name: 'Boot', docUrl: 'automerge:d1doc', objectIds: [] } },
      { 'automerge:d1doc': { flows: { f1: { id: 'f1', steps: [{ connectionId: 'c1' }] } } } },
    )
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // LIVENESS: the flow path really runs on this fixture.
      repo.emitChange('automerge:d1doc')
      await vi.waitFor(() => {
        expect(store.matching(FLOW_PROJECTION).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })
      const marksBefore = store.matching(MARK_DEGRADED).length
      const mutexBefore = store.matching(/pg_advisory_xact_lock/).length

      store.failWhen(/pg_advisory_xact_lock/, '55P03')
      repo.emitChange('automerge:d1doc')
      await flushMicrotasks()
      await new Promise((resolve) => setTimeout(resolve, 300))
      store.failWhen(null)

      // The arm ran: the mutex was requested again, and failed.
      expect(store.matching(/pg_advisory_xact_lock/).length).toBeGreaterThan(mutexBefore)
      expect(store.matching(MARK_DEGRADED).length).toBe(marksBefore)
    } finally {
      stop()
    }
  }, 30_000)

  it('does not degrade a QUEUED document abandoned because the mutex was busy', async () => {
    // The same refusal at the abandon site, which is reached differently: the
    // retry resolves the document, the projection dies on the mutex, the error
    // is wrapped in `DiagramFlowProjectionError`, classified `unexpected`, not
    // retried, and abandoned. It is also why `isProjectionMutexTimeout` has to
    // unwrap `cause` — the raw code is one level down by the time it lands.
    const docs = lateDiagram()
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      expect(documentRetryRegistry.snapshot().pendingDepth).toBe(1)
      expect(store.matching(MARK_DEGRADED).length).toBe(0)

      // ORDER again, not timing: the document cannot resolve until `publish`,
      // so the retry that resolves it is guaranteed to meet the busy mutex.
      store.failWhen(/pg_advisory_xact_lock/, '55P03')
      repo.publish('automerge:late', lateDoc)
      await vi.waitFor(() => {
        expect(documentRetryRegistry.snapshot().pendingDepth).toBe(0)
      }, { timeout: 15_000 })
      await flushMicrotasks()
      await new Promise((resolve) => setTimeout(resolve, 200))
      store.failWhen(null)

      expect(store.matching(MARK_DEGRADED).length).toBe(0)
    } finally {
      stop()
    }
  }, 40_000)

  it('does not degrade or reschedule a diagram attaching into a plane it has just lost', async () => {
    // `handleDiagramAttachFailure`'s authority branch. The function is entered
    // constantly across this file, but always with `authority=false`. The one
    // input that changes that is a diagram whose INITIAL attach fails
    // on the plane check rather than on resolution, which means flipping the
    // workspace between the projector returning and its DEFERRED probe running.
    const docs = workspaceDocs(
      { d1: { id: 'd1', name: 'Boot', docUrl: 'automerge:d1doc', objectIds: [] } },
      { 'automerge:d1doc': { flows: { f1: { id: 'f1', steps: [{ connectionId: 'c1' }] } } } },
    )
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    try {
      const scheduledBefore = documentRetryRegistry.snapshot().scheduled
      const marksBefore = store.matching(MARK_DEGRADED).length
      store.setStatic(true)
      await awaitInitialDiagramProbe(WORKSPACE).catch(() => undefined)
      await flushMicrotasks()
      await new Promise((resolve) => setTimeout(resolve, 300))

      // LIVENESS: the attach really was attempted — the probe resolved the
      // document — so the negatives below are about the refusal and not about a
      // pass that never happened.
      expect(repo.findsFor('automerge:d1doc')).toBeGreaterThan(0)
      // No sticky degradation onto a row that now belongs to the static
      // projector, and no reprojection queued against a permanent refusal:
      // every retry would abort identically until the fleet recycles.
      expect(store.matching(MARK_DEGRADED).length).toBe(marksBefore)
      expect(documentRetryRegistry.snapshot().scheduled - scheduledBefore).toBe(0)
    } finally {
      stop()
    }
  }, 30_000)

  it('abandons a queued document without degrading, when the plane was lost while it waited', async () => {
    // Another authority-question site: `onDiagramRetryAbandoned`'s default
    // branch. It is reached through `classifyDocumentResolutionError` rather
    // than by naming an error class, so a search for `ReadModelWriteFenceError`
    // does not find it; unguarded, it writes a `degraded_since` onto the other
    // writer's row.
    //
    // ORDER, not timing: the document cannot resolve before `publish`, so the
    // retry that finally resolves it is guaranteed to run with the workspace
    // already promoted. There is no race for this test to lose.
    const docs = lateDiagram()
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // LIVENESS: the document really is queued, and nothing has degraded yet,
      // so whatever appears below is attributable to what follows.
      expect(documentRetryRegistry.snapshot().pendingDepth).toBe(1)
      expect(store.matching(MARK_DEGRADED).length).toBe(0)

      store.setStatic(true)
      repo.publish('automerge:late', lateDoc)

      await vi.waitFor(() => {
        expect(documentRetryRegistry.snapshot().pendingDepth).toBe(0)
      }, { timeout: 15_000 })
      await flushMicrotasks()
      await new Promise((resolve) => setTimeout(resolve, 200))

      // The sticky forgery, refused. Asserted on `store`, which is per-test —
      // `documentRetryRegistry` is module-scoped with no reset between tests, so
      // an absolute count there would pass or fail on test ORDER.
      expect(store.matching(MARK_DEGRADED).length).toBe(0)
    } finally {
      stop()
    }
  }, 40_000)

  it('the same queued document drains and projects when the plane is intact', async () => {
    // NOT a control: with the plane intact the document resolves and
    // projects, so `onDiagramRetryAbandoned` is never reached and "zero
    // degradations" here cannot rule out "nothing ever degrades". What it DOES
    // assert is worth having — the same fixture drains the healthy way, which
    // is the outcome the arm above must be distinguished from.
    //
    // A real control would need a document that is abandoned for a
    // NON-authority reason and degrades — exhaustion after
    // `DIAGRAM_REPROJECTION_ATTEMPTS` — which is a slower fixture and is not
    // written.
    const docs = lateDiagram()
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      expect(documentRetryRegistry.snapshot().pendingDepth).toBe(1)
      repo.publish('automerge:late', lateDoc)
      await vi.waitFor(() => {
        expect(store.matching(FLOW_PROJECTION).length).toBeGreaterThan(0)
      }, { timeout: 15_000 })
      await flushMicrotasks()
      // The document arrived and projected: the queue drained the healthy way,
      // which is the outcome the arm above must be distinguished FROM.
      expect(store.matching(MARK_DEGRADED).length).toBe(0)
    } finally {
      stop()
    }
  }, 40_000)

  it('treats a mutex held by ANOTHER writer as transient, and records nothing on their row', async () => {
    // `lock_timeout` raises 55P03. A same-plane holder — two ordinary
    // projectors on one workspace, which is the default configuration — makes
    // the waiter abort at the ~5 s ceiling, and the raw error is not an
    // authority loss. Unhandled, this catch would fall through to
    // `failReadModelProjection`, stamping `consecutive_failures + 1` and
    // `last_error_code = '55P03'` on the health row of the projector that WON,
    // once per read-route retry for as long as the winner is building.
    const docs = workspaceDocs({ d1: { id: 'd1', name: 'Boot', objectIds: [] } })
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      // LIVENESS WITNESS: an ordinary change really does project when the mutex
      // is free, so the negatives below are about the refusal.
      repo.emitChange('automerge:root')
      await vi.waitFor(() => {
        expect(store.matching(/RETURNING observed_generation/).length).toBeGreaterThan(1)
      }, { timeout: 5_000 })
      const failuresBefore = store.matching(/consecutive_failures \+ 1/).length
      const marksBefore = store.matching(MARK_DEGRADED).length

      store.failWhen(/pg_advisory_xact_lock/, '55P03')
      repo.emitChange('automerge:root')
      await flushMicrotasks()
      await new Promise((resolve) => setTimeout(resolve, 300))
      store.failWhen(null)

      // The mutex really was requested and really did fail — without this the
      // arm never ran and the two negatives are vacuous.
      expect(store.matching(/pg_advisory_xact_lock/).length).toBeGreaterThan(1)
      expect(store.matching(/consecutive_failures \+ 1/).length).toBe(failuresBefore)
      // And NOT recorded as a degradation either: the workspace is still ours,
      // only the mutex was not. Conflating the two would turn a transient
      // refusal into a permanent one — which is why `isProjectionMutexTimeout`
      // is deliberately separate from `isReadModelAuthorityLoss`.
      expect(store.matching(MARK_DEGRADED).length).toBe(marksBefore)
    } finally {
      stop()
    }
  }, 30_000)

  it('loses the plane MID-transaction and still forges nothing onto the other writer\'s row', async () => {
    // The window the pre-check CANNOT cover, and the only one where the two
    // forgeries are reachable at all. `beginReadModelProjection` runs on the
    // pool, so holding the pass open there means the token is already issued;
    // promoting the workspace underneath it and releasing sends the pass into
    // the IN-TRANSACTION authority check with a token in hand.
    // A diagram with a REAL `docUrl`, so `attachDiagramDoc` actually attaches
    // (without one, the flow path never runs and the test is about nothing).
    const docs = workspaceDocs(
      { d1: { id: 'd1', name: 'Boot', docUrl: 'automerge:d1doc', objectIds: [] } },
      { 'automerge:d1doc': { flows: { f1: { id: 'f1', steps: [{ connectionId: 'c1' }] } } } },
    )
    const repo = fakeAutomergeRepo(docs)
    const store = fakeDb()

    const stop = await startReadModelProjector(repo.repo, 'automerge:root', store.db, WORKSPACE)
    await awaitInitialDiagramProbe(WORKSPACE)
    try {
      expect(store.matching(/ro_diagrams/).length).toBeGreaterThan(0)
      // LIVENESS WITNESS for the flow path specifically: an ordinary change on
      // the DIAGRAM document really does reach `attachDiagramDoc` and project.
      // Every negative below is about that path, so without this they are
      // assertions about a function nothing called.
      repo.emitChange('automerge:d1doc')
      await vi.waitFor(() => {
        expect(store.matching(FLOW_PROJECTION).length).toBeGreaterThan(0)
      }, { timeout: 5_000 })

      const flowsBefore = store.matching(FLOW_PROJECTION).length
      const scheduledBefore = documentRetryRegistry.snapshot().scheduled

      store.holdWhen(/RETURNING observed_generation/)
      repo.emitChange('automerge:d1doc')
      // The witness that the arm actually ran: without this the release below
      // would fire against nothing and every assertion after it would be
      // vacuous rather than red.
      await vi.waitFor(() => { expect(store.held()).toBe(true) }, { timeout: 5_000 })
      store.setStatic(true)
      store.release()
      await flushMicrotasks()
      await new Promise((resolve) => setTimeout(resolve, 200))

      // The pass ROLLED BACK. Separate from the telemetry assertions below and
      // not implied by them: with the workspace key mis-threaded to the helper,
      // the in-transaction check would ask about a workspace that does not
      // exist, get `present: false`, admit `'ordinary'` and commit. The
      // pool-side pre-check cannot catch that — it uses the right key — so
      // these two guards MASK each other and only an assertion here sees it.
      expect(store.matching(FLOW_PROJECTION).length).toBe(flowsBefore)
      // The retry budget is not burned re-projecting into a permanent refusal:
      // every reprojection would abort identically until the pod recycles.
      expect(documentRetryRegistry.snapshot().scheduled - scheduledBefore).toBe(0)

      // Forgery 1 — failure telemetry onto a health row that now describes the
      // static projector. It can walk that owner's ladder to `failed` from
      // outside.
      expect(store.matching(/consecutive_failures \+ 1/).length).toBe(0)
      // Forgery 2, and the stickier of the two, one function over:
      // `attachDiagramDoc`'s catch must exclude a lost PLANE as well as a lost
      // FENCE, or it falls through to `degrade()`. A sticky degradation here
      // would never be retracted — the only `clearReadModelWorkspaceDegraded`
      // call site is in the ordinary projector, and the fleet refuses to attach
      // it to a static workspace, so the mark would have NO lift at all.
      expect(store.matching(MARK_DEGRADED).length).toBe(0)
      // Liveness for the negatives: the pass really did reach the transaction
      // (its begin ran) rather than being turned away by the pool-side
      // pre-check, which is the case the test above already covers.
      expect(store.matching(/RETURNING observed_generation/).length).toBeGreaterThan(1)
    } finally {
      stop()
    }
  }, 30_000)
})
