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

import { describe, it, expect, vi } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import { runWorkspaceCompaction, type WorkspaceCompactionDeps } from './workspaceCompaction.js'
import { modelEpochConfig } from './modelEpochConfig.js'
import type { Queryable } from './types.js'
import type { WorkspaceKey } from './projector.js'

/**
 * Claim-at-write, made OBSERVABLE.
 *
 * `createClaimedDocument` notifies through `documentsRegistration`, a module
 * private that only a `WorkspaceDocIndex` constructor ever sets — so in a
 * DB-free repo the claim is a silent no-op and "claimed" is indistinguishable
 * from "unclaimed". Without this spy, dropping `workspace: key` from the
 * `compactOverlay` call would mint the rotated head and every overflow shard
 * UNCLAIMED — a state the transport cannot serve — with the suite green.
 *
 * Spread from the original so only this one export is replaced; the mock is
 * per-file, so no other suite is affected.
 */
const claimedWorkspaces: string[] = []
vi.mock('../rbac/docScope.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rbac/docScope.js')>()
  return {
    ...actual,
    createClaimedDocument: async <T,>(repo: Repo, workspace: WorkspaceKey, rootUrl: string, value: T) => {
      claimedWorkspaces.push(`${workspace.landscapeId}/${workspace.versionId}`)
      return actual.createClaimedDocument<T>(repo, workspace, rootUrl, value)
    },
  }
})

/**
 * The compaction pass and its three refusals.
 *
 * DB-FREE ON PURPOSE: injecting `db` as a `Queryable` means the two SQL reads
 * can be answered by a fake, so the file needs no database and cannot skip — an
 * unset `TEST_DATABASE_URL` is exactly the condition under which a DB-gated file
 * exits 0 having asserted nothing.
 *
 * Fixture choices that keep the assertions meaningful:
 *
 *   - BOTH collections are populated, so the connections pass reaches its
 *     guard rather than returning early;
 *   - the "overlay was not cleared" witness is the OVERLAY document by name and
 *     value, never a positional index (the base shard also contains the id
 *     after a fold);
 *   - generations are STRINGS, as pg returns bigint — `'9' >= '10'` is true, so
 *     the `Number()` coercion must be exercised;
 *   - every fake checks WHICH workspace it was asked about.
 */

const KEY: WorkspaceKey = { landscapeId: 'land-1', versionId: 'ver-1' }
const OTHER_KEY_PARAMS = 'a workspace other than the one under test'

type Obj = { id: string; name: string }
type Conn = { id: string; fromId: string; toId: string }

interface FakeDbOptions {
  isStatic?: boolean | (() => boolean)
  attached?: boolean
  /** Strings, like pg: `bigint` arrives as text, and `'9' >= '10'` is true. */
  observed?: string
  projected?: string
  projectorInstanceId?: string | null
  /** Flips what the projection row reports after a re-attach, to model a stale
   *  row being healed. */
  onRefresh?: () => void
  /** G4-16f guard (g): a model epoch forward journal is open. */
  forwardJournalOpen?: boolean
  /** Dismissed override rows (entity_id, path, late_value). */
  declined?: Array<{ entity_id: string; path: string[]; late_value: unknown }>
}

/** Answers the only two statements this pass issues, and REFUSES anything else:
 *  a fake that quietly returns `{rows: []}` to an unexpected statement turns a
 *  new query into a silent false. It also asserts the workspace it was asked
 *  about — without that, pointing any call site at a different key is invisible. */
/** The statements `fakeDb` answered on the G4-16k scan table, in order. */
const overlayScanStatements: string[] = []

function fakeDb(opts: FakeDbOptions, scanRows = new Map<string, string[]>(),
  scanLateSeen = new Map<string, Record<string, number>>()): Queryable & { staticReads: () => number } {
  let staticReads = 0
  return {
    staticReads: () => staticReads,
    async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
      // G4-16f guard (g): no epoch forward table in this fake — the pass reads
      // "no journal open" and goes on. Asked before the workspace parameters:
      // the existence probe has none.
      // The per-pass gate (`modelEpochRowsExist`): the table, then "any row".
      if (text.includes("'.read_model_model_epochs'") && !text.includes('epoch_docs')) {
        return { rows: [{ present: opts.forwardJournalOpen ?? false }] as unknown as R[], rowCount: 1 }
      }
      if (text.includes('EXISTS (SELECT 1 FROM read_model_model_epochs WHERE')) {
        expect(params, OTHER_KEY_PARAMS).toEqual([KEY.landscapeId, KEY.versionId])
        return { rows: [{ any: true }] as unknown as R[], rowCount: 1 }
      }
      // The forwarder that runs before the guard: no published epoch here.
      if (text.includes('FROM read_model_model_epochs') && text.includes("state = 'published'")) {
        return { rows: [] as unknown as R[], rowCount: 0 }
      }
      if (text.includes("'.read_model_model_epoch_forwards'")) {
        return { rows: [{ present: opts.forwardJournalOpen ?? false }] as unknown as R[], rowCount: 1 }
      }
      if (text.includes('FROM read_model_model_epoch_forwards')) {
        expect(params, OTHER_KEY_PARAMS).toEqual([KEY.landscapeId, KEY.versionId])
        return { rows: [{ open: true }] as unknown as R[], rowCount: 1 }
      }
      // The epoch override table, with the dismissed rows the test gives.
      if (text.includes("'.read_model_model_epoch_overrides'")) {
        return { rows: [{ present: (opts.declined ?? []).length > 0 }] as unknown as R[], rowCount: 1 }
      }
      if (text.includes('FROM read_model_model_epoch_overrides')) {
        expect(params?.slice(0, 2), OTHER_KEY_PARAMS).toEqual([KEY.landscapeId, KEY.versionId])
        // An unexpected statement must not be answered as "no row": the
        // production step catches a throw here as a reported failure, which a
        // test asserting "never written back" would read as a pass.
        if (!text.includes("state IN ('dismissed', 'pending')")) throw new Error(`unexpected override statement: ${text}`)
        const rows = (opts.declined ?? []).map((row) => ({ state: 'dismissed', ...row }))
        return { rows: rows as unknown as R[], rowCount: rows.length }
      }
      // G4-16k: the rematerialization's scan store (`overlayClearScanStore`).
      if (text.includes('read_model_overlay_clear_scans')) {
        expect(params?.slice(0, 2), OTHER_KEY_PARAMS).toEqual([KEY.landscapeId, KEY.versionId])
        const verb = text.trim().split(/\s+/)[0]
        const collection = String(params?.[2])
        overlayScanStatements.push(`${verb} ${collection}`)
        // Keeps what was saved, as the table does (per fake: one workspace's
        // run), in the order it was saved (the store reads oldest first).
        if (verb === 'INSERT') {
          const ids = params?.[3] as string[]
          const heads = params?.[4] as string[]
          const lateSeen = params?.[5] as string[]
          ids.forEach((id, i) => {
            scanRows.delete(`${collection}:${id}`)
            scanRows.set(`${collection}:${id}`, heads[i].split(','))
            scanLateSeen.set(`${collection}:${id}`, JSON.parse(lateSeen[i]) as Record<string, number>)
          })
          return { rows: [] as R[], rowCount: ids.length }
        }
        if (verb === 'DELETE') throw new Error('no segment is gone in this fake')
        const rows = [...scanRows].filter(([k]) => k.startsWith(`${collection}:`))
          .map(([k, h]) => ({ document_id: k.slice(collection.length + 1), scanned_heads: h, late_seen: scanLateSeen.get(k) ?? {} }))
        return { rows: rows as unknown as R[], rowCount: rows.length }
      }
      expect(params, OTHER_KEY_PARAMS).toEqual([KEY.landscapeId, KEY.versionId])
      if (text.includes('read_model_static_workspaces')) {
        staticReads += 1
        const value = typeof opts.isStatic === 'function' ? opts.isStatic() : (opts.isStatic ?? false)
        return { rows: [{ present: value }] as unknown as R[], rowCount: 1 }
      }
      if (text.includes('read_model_projection_state')) {
        return {
          rows: [{
            observed_generation: opts.observed ?? '1',
            projected_generation: opts.projected ?? '1',
            projector_attached: opts.attached ?? true,
            // Defaults to THIS cell's id, not null: `markReadModelProjectorAttached`
            // always supplies one, so `attached = true` with a null id is a row
            // production cannot produce, and a fake modelling an impossible state
            // makes every test using it a test of nothing.
            projector_instance_id:
              'projectorInstanceId' in opts ? opts.projectorInstanceId : 'this-cell',
          }] as unknown as R[],
          rowCount: 1,
        }
      }
      throw new Error(`workspaceCompaction issued an unexpected statement: ${text.slice(0, 80)}`)
    },
  }
}

/** The pooled clients the pass takes for its two `overlay-rotation:` keys
 * (G4-16i), and the settle transaction it commits on them. Answers exactly
 * the statements that path issues and REFUSES anything else, like `fakeDb`.
 * `locked` decides each acquisition, in order (`true` when unset); every
 * statement and every hand-back is recorded in `events`, in order. A workspace
 * with no retirement rows: the settle commits having written nothing. */
function fakeConnect(locked: boolean[] = [], events: string[] = [], fence: () => string | null = () => 'this-cell') {
  let acquisitions = 0
  const connect = async () => {
    const id = `client${events.filter((event) => event.startsWith('connect ')).length + 1}`
    events.push(`connect ${id}`)
    return {
      async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
        if (text.includes('pg_try_advisory_lock(')) {
          const answer = locked[acquisitions] ?? true
          acquisitions += 1
          events.push(`${id} lock ${String(params?.[0])} ${answer}`)
          return { rows: [{ locked: answer }] as unknown as R[], rowCount: 1 }
        }
        if (text.includes('pg_advisory_unlock(')) {
          events.push(`${id} unlock ${String(params?.[0])}`)
          return { rows: [{ released: true }] as unknown as R[], rowCount: 1 }
        }
        if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') {
          events.push(`${id} ${text.split(';')[0]}`)
          return { rows: [] as R[], rowCount: 0 }
        }
        expect(params?.slice(0, 2), OTHER_KEY_PARAMS).toEqual([KEY.landscapeId, KEY.versionId])
        if (text.includes('read_model_static_workspaces') && text.includes('FOR KEY SHARE')) {
          return { rows: [] as R[], rowCount: 0 }
        }
        // The settle's write fence: held by THIS cell's projector unless the
        // test moved it.
        if (text.includes('read_model_projection_state') && text.includes('FOR UPDATE')) {
          events.push(`${id} fence`)
          // `participant`: the connection's protocol version, which the
          // assertion refuses below 2 (protocolParticipant.ts).
          return { rows: [{ write_fence: fence(), participant: 2 }] as unknown as R[], rowCount: 1 }
        }
        if (text.includes('FROM read_model_ordinary_head_retirements')) {
          events.push(`${id} rows`)
          return { rows: [] as R[], rowCount: 0 }
        }
        throw new Error(`the rotation-key client got an unexpected statement: ${text.slice(0, 80)}`)
      },
      release(destroy?: Error | boolean) { events.push(`release ${id}${destroy ? ' destroyed' : ''}`) },
    }
  }
  return { connect, events }
}

interface Fixture {
  repo: Repo
  rootUrl: string
  base: DocHandle<{ objects: Record<string, Obj> }>
  overlay: DocHandle<{ objects: Record<string, Obj> }>
  connBase: DocHandle<{ connections: Record<string, Conn> }>
  connOverlay: DocHandle<{ connections: Record<string, Conn> }>
  changes: () => number
}

/**
 * A model with BOTH collections populated.
 *
 * The connections half is not decoration: with an empty connection overlay,
 * `foldCollection` returns at `ids.length === 0 && tombstones.length === 0`
 * BEFORE either guard consultation, so `stillSafeToWrite` would only be proven
 * on the objects pass.
 */
async function fixture(): Promise<Fixture> {
  const repo = new Repo({})
  let changes = 0
  const seen = new Set<DocHandle<unknown>>()
  const patch = <T,>(handle: DocHandle<T>): DocHandle<T> => {
    if (!handle || seen.has(handle as DocHandle<unknown>)) return handle
    seen.add(handle as DocHandle<unknown>)
    const original = handle.change.bind(handle)
    ;(handle as unknown as { change: unknown }).change = (...args: unknown[]) => {
      changes += 1
      return (original as (...a: unknown[]) => unknown)(...args)
    }
    return handle
  }

  const base = repo.create({ objects: { o0: { id: 'o0', name: 'A' } } })
  const overlay = repo.create({ objects: { o0: { id: 'o0', name: 'A-edited' } } })
  const connBase = repo.create({ connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o0' } } })
  const connOverlay = repo.create({ connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o9' } } })
  const meta = repo.create({
    objectShardUrls: [base.url, overlay.url],
    connectionShardUrls: [connBase.url, connOverlay.url],
    editsObjectShardUrl: overlay.url,
    editsConnectionShardUrl: connOverlay.url,
  })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
  const all = [base, overlay, connBase, connOverlay, meta, root] as DocHandle<unknown>[]
  await Promise.all(all.map((h) => h.whenReady()))

  // Patch AFTER building, so constructing the fixture does not count.
  all.forEach(patch)
  const originalCreate = repo.create.bind(repo)
  const originalFind = repo.find.bind(repo)
  ;(repo as unknown as { create: unknown }).create = (...args: unknown[]) =>
    patch((originalCreate as (...a: unknown[]) => DocHandle<unknown>)(...args))
  ;(repo as unknown as { find: unknown }).find = async (...args: unknown[]) =>
    patch(await (originalFind as (...a: unknown[]) => Promise<DocHandle<unknown>>)(...args))

  return { repo, rootUrl: root.url, base, overlay, connBase, connOverlay, changes: () => changes }
}

interface Spies {
  deps: WorkspaceCompactionDeps
  releases: () => number
  ensures: () => number
  /** What each `ensure` was asked (G4-16f C6-2a: compaction never adopts). */
  ensureOptions: () => unknown[]
  warnings: () => string[]
  keysSeen: () => string[]
}

function spied(f: Fixture, db: Queryable, over: Partial<WorkspaceCompactionDeps> = {}): Spies {
  let releases = 0
  let ensures = 0
  const ensureOptions: unknown[] = []
  const warnings: string[] = []
  const keysSeen: string[] = []
  const note = (key: WorkspaceKey) => { keysSeen.push(`${key.landscapeId}/${key.versionId}`) }
  const deps: WorkspaceCompactionDeps = {
    repo: f.repo,
    rootUrl: f.rootUrl,
    db,
    connect: fakeConnect().connect,
    fleet: {
      isResident: (key) => { note(key); return true },
      // `true` is STATED: `false` means "attached nothing"
      // (`skipped_reattach_no_root`).
      ensure: async (key, options) => { note(key); ensureOptions.push(options); ensures += 1; return true },
      release: (key) => { note(key); releases += 1 },
      residentProjectorInstanceId: (key) => { note(key); return 'this-cell' },
    },
    ownership: { owns: (key) => { note(key); return true } },
    isShuttingDown: () => false,
    log: () => undefined,
    warn: (m) => { warnings.push(m) },
    ...over,
  }
  return {
    deps, releases: () => releases, ensures: () => ensures, ensureOptions: () => ensureOptions,
    warnings: () => warnings, keysSeen: () => keysSeen,
  }
}

/** Every fake was handed the workspace under test and no other. */
const expectOnlyTheKeyUnderTest = (s: Spies) => {
  expect([...new Set(s.keysSeen())], OTHER_KEY_PARAMS).toEqual([`${KEY.landscapeId}/${KEY.versionId}`])
}

describe('runWorkspaceCompaction (T-28d)', () => {
  it('mints the rotated heads CLAIMED for this workspace (E4-F)', async () => {
    // Dropping `workspace: key` sends `compactOverlay` down the plain
    // `repo.create` path, so the fresh write head and any overflow shard are
    // never claimed. `docScope.coverage.test.ts` tests the notify hook itself,
    // not this call site.
    claimedWorkspaces.length = 0
    const f = await fixture()
    const s = spied(f, fakeDb({}))
    await runWorkspaceCompaction(KEY, s.deps)
    expect(claimedWorkspaces.length,
      'no document was claimed — the rotated head was minted unclaimed').toBeGreaterThan(0)
    expect([...new Set(claimedWorkspaces)],
      'a document was claimed for the wrong workspace').toEqual([`${KEY.landscapeId}/${KEY.versionId}`])
  })

  it('G4-16k: the pass reads and records its overlay rematerialization scans for THIS workspace', async () => {
    // Without the `clearScans` wiring every pass would read each segment's
    // whole history, and a segment a singular-pointer meta forgets after its
    // head rotates would never be scanned again.
    overlayScanStatements.length = 0
    const f = await fixture()
    const s = spied(f, fakeDb({}))
    await runWorkspaceCompaction(KEY, s.deps)
    expect(overlayScanStatements).toEqual(['SELECT object', 'INSERT object', 'SELECT connection', 'INSERT connection'])
  })

  it('G4-16k: the production pass gives a late edit the browser\'s grace period (a day) before writing it back', async () => {
    const f = await fixture()
    const rows = new Map<string, string[]>()
    const marie = A.clone(f.overlay.doc() as A.Doc<{ objects: Record<string, Obj> }>)
    await runWorkspaceCompaction(KEY, spied(f, fakeDb({}, rows)).deps)
    expect(f.overlay.doc()?.objects.o0).toBeUndefined()
    const edited = A.change(marie, (d) => { d.objects.o0.name = 'hers-offline' })
    f.overlay.update((doc) => A.merge(doc, edited))
    await runWorkspaceCompaction(KEY, spied(f, fakeDb({}, rows)).deps)
    expect(f.base.doc()?.objects.o0.name).toBe('A-edited')
    // Control: with no grace, the same pass writes it back.
    vi.stubEnv('OVERLAY_CLEAR_REMATERIALIZE_GRACE_MS', '0')
    try {
      await runWorkspaceCompaction(KEY, spied(f, fakeDb({}, rows)).deps)
    } finally { vi.unstubAllEnvs() }
    expect(f.base.doc()?.objects.o0.name).toBe('hers-offline')
  })

  it('the production pass never writes back a write she dismissed in the batch re-apply', async () => {
    const f = await fixture()
    const rows = new Map<string, string[]>()
    const marie = A.clone(f.overlay.doc() as A.Doc<{ objects: Record<string, Obj> }>)
    await runWorkspaceCompaction(KEY, spied(f, fakeDb({}, rows)).deps)
    f.overlay.update((doc) => A.merge(doc, A.change(marie, (d) => { d.objects.o0.name = 'hers-offline' })))
    const declined = [{ entity_id: 'o0', path: ['objects', 'o0', 'name'], late_value: 'hers-offline' }]
    vi.stubEnv('OVERLAY_CLEAR_REMATERIALIZE_GRACE_MS', '0')
    let outcome: Awaited<ReturnType<typeof runWorkspaceCompaction>>
    try {
      outcome = await runWorkspaceCompaction(KEY, spied(f, fakeDb({ declined }, rows)).deps)
    } finally { vi.unstubAllEnvs() }
    expect(f.base.doc()?.objects.o0.name).toBe('A-edited')
    // Not written back BECAUSE it was declined — not because the step failed
    // (a fake that threw on the query used to pass this test).
    expect(outcome!.result.rematerializeFailed).toBeUndefined()
  })

  it('ENSURES residency before folding when the workspace is not resident', async () => {
    // `isResident` is `() => true` everywhere else, so only this test exercises
    // the pre-fold `ensure`.
    const f = await fixture()
    let ensures = 0
    const asked: unknown[] = []
    const s = spied(f, fakeDb({}), {
      fleet: {
        isResident: () => false,
        ensure: async (_key, options) => { asked.push(options); ensures += 1; return true },
        release: () => undefined,
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    await runWorkspaceCompaction(KEY, s.deps)
    // Once before the fold, once in the `finally`.
    expect(ensures, 'a non-resident workspace was compacted without being ensured first').toBe(2)
    // G4-16f C6-2a: neither may ADOPT.
    expect(asked).toEqual([{ adopt: false }, { adopt: false }])
  })

  it('CONTROL — folds BOTH collections and reports honest counts', async () => {
    // Without this every refusal below could be produced by a pass that never
    // folds anything. All six counts are pinned, not just `objectsFolded`.
    const f = await fixture()
    const s = spied(f, fakeDb({}))
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(outcome.result.skippedReason).toBeUndefined()
    expect(outcome.result).toMatchObject({
      objectsFolded: 1, connectionsFolded: 1,
      objectsKept: 0, connectionsKept: 0,
      objectsDeleted: 0, connectionsDeleted: 0,
    })
    expect(outcome.reattach).toBe('reattached')
    expect(f.changes()).toBeGreaterThan(0)
    // Detach-then-re-attach actually happened.
    expect(s.releases(), 'the read plane was never detached before the writes').toBe(1)
    expect(s.ensures(), 'the read plane was never put back').toBe(1)
    // G4-16f C6-2a: the re-attach is a cold build, never an adoption.
    expect(s.ensureOptions()).toEqual([{ adopt: false }])
    expectOnlyTheKeyUnderTest(s)

    // The fold reached the OVERLAY documents by url, and the value moved.
    expect(f.base.doc()!.objects.o0.name).toBe('A-edited')
    expect(f.overlay.doc()!.objects.o0, 'the overlay was not cleared by a successful pass').toBeUndefined()
    expect(f.connBase.doc()!.connections.c0.toId).toBe('o9')
  })

  it('F1 — after a pass that applied, each base shard (both collections) is handed to the storage compaction, before the re-attach', async () => {
    const f = await fixture()
    const order: string[] = []
    const compacted: Array<{ documentId: string; name: unknown }> = []
    const s = spied(f, fakeDb({}), {
      compactDocumentStorage: async (documentId, doc) => {
        order.push('storage')
        compacted.push({ documentId, name: (doc as { objects?: { o0?: { name?: unknown } } }).objects?.o0?.name })
        return { outcome: 'compacted', rowsBefore: 3, removed: 3, kept: 0, snapshotOctets: 10, remembered: true, ms: 1 }
      },
    })
    const ensure = s.deps.fleet.ensure
    s.deps.fleet.ensure = async (key, options) => { order.push('ensure'); return ensure(key, options) }
    const logs: string[] = []
    s.deps.log = (m) => { logs.push(m) }
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBeUndefined()
    expect(compacted.map((c) => c.documentId).sort()).toEqual([String(f.base.documentId), String(f.connBase.documentId)].sort())
    // The document handed over is the FOLDED one.
    expect(compacted.find((c) => c.documentId === String(f.base.documentId))!.name).toBe('A-edited')
    expect(order).toEqual(['storage', 'storage', 'ensure'])
    const line = logs.map((m) => { try { return JSON.parse(m) } catch { return null } }).find((e) => e?.event === 'compaction.base_storage')
    expect(line).toMatchObject({ mode: 'on', shards: 2, compacted: 2, failed: 0, removed: 6, remembered: 2 })
  })

  it('F1 — a PROMOTION to summary between two shards stops the storage compaction (stillOwnedAndOrdinary)', async () => {
    const f = await fixture()
    let calls = 0
    const logs: string[] = []
    const s = spied(f, fakeDb({ isStatic: () => calls > 0 }), {
      compactDocumentStorage: async () => {
        calls += 1
        return { outcome: 'compacted', rowsBefore: 2, removed: 2, kept: 0, snapshotOctets: 1, remembered: true, ms: 0 }
      },
      log: (m) => { logs.push(m) },
    })
    await runWorkspaceCompaction(KEY, s.deps)
    expect(calls).toBe(1)
    const line = logs.map((m) => { try { return JSON.parse(m) } catch { return null } }).find((e) => e?.event === 'compaction.base_storage')
    expect(line).toMatchObject({ compacted: 1, stopped: true })
  })

  it('F1 — AM_BASE_SHARD_STORAGE_COMPACTION=off compacts nothing and says so in the line', async () => {
    const f = await fixture()
    let calls = 0
    const logs: string[] = []
    const s = spied(f, fakeDb({}), {
      baseShardStorageCompaction: 'off',
      compactDocumentStorage: async () => { calls += 1; throw new Error('unreachable') },
      log: (m) => { logs.push(m) },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBeUndefined()
    expect(calls).toBe(0)
    const line = logs.map((m) => { try { return JSON.parse(m) } catch { return null } }).find((e) => e?.event === 'compaction.base_storage')
    expect(line).toMatchObject({ mode: 'off', shards: 2, compacted: 0 })
  })

  it('F1 — a storage compaction that THROWS is reported and the pass stands', async () => {
    const f = await fixture()
    const s = spied(f, fakeDb({}), {
      compactDocumentStorage: async () => { throw new Error('pool refused') },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBeUndefined()
    expect(outcome.result.objectsFolded).toBe(1)
    expect(outcome.reattach).toBe('reattached')
    expect(s.warnings().filter((w) => /base shard storage compaction failed .* pool refused/.test(w))).toHaveLength(2)
  })

  it('F1 — stops at the first sign the cell may not write, and never runs on a refused pass', async () => {
    const f = await fixture()
    let calls = 0
    let owned = true
    const s = spied(f, fakeDb({}), {
      ownership: { owns: () => owned },
      compactDocumentStorage: async () => {
        calls += 1
        owned = false
        return { outcome: 'compacted', rowsBefore: 2, removed: 2, kept: 0, snapshotOctets: 1, remembered: false, ms: 0 }
      },
    })
    await runWorkspaceCompaction(KEY, s.deps)
    expect(calls).toBe(1)
    // A pass refused before writing compacts nothing.
    const g = await fixture()
    let refusedCalls = 0
    const r = spied(g, fakeDb({ attached: false }), {
      compactDocumentStorage: async () => { refusedCalls += 1; throw new Error('unreachable') },
    })
    await runWorkspaceCompaction(KEY, r.deps)
    expect(refusedCalls).toBe(0)
  })

  it('refuses when the projection has NOT acknowledged every observed generation', async () => {
    // Generations are STRINGS, as pg returns bigint: `'9' >= '10'` is true, so
    // this exercises the `Number()` coercion.
    const f = await fixture()
    const s = spied(f, fakeDb({ attached: true, observed: '10', projected: '9' }))
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(outcome.result.skippedReason).toBe('projection_not_acknowledged')
    expect(outcome.reattach).toBe('not_detached')
    expect(f.changes(), 'the pass wrote while the read model was behind').toBe(0)
    expect(s.releases(), 'the plane was detached for a pass that never ran').toBe(0)
    // EVERY counter, not just the reason: these reach an operator through
    // `POST /api/model/compact`.
    expect(outcome.result).toMatchObject({
      objectsFolded: 0, connectionsFolded: 0, objectsKept: 0, connectionsKept: 0,
      objectsDeleted: 0, connectionsDeleted: 0,
    })
  })

  it('refuses when the projector is not attached at all', async () => {
    const f = await fixture()
    const s = spied(f, fakeDb({ attached: false, observed: '4', projected: '4' }))
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBe('projection_not_acknowledged')
    expect(f.changes()).toBe(0)
  })

  it('GUARD (a) — refuses to fold when ownership is lost DURING shard resolution', async () => {
    // WHERE THE UP-FRONT CHECK LIVES, because it changes what this test means:
    // this module performs NO ownership check of its own before the fold — the
    // admission check is the caller's (`admitRepoMaintenance`). Inside the pass
    // the predicate is the ONLY ownership read, so `owns: () => false` is
    // exactly "lost after admission", not "never owned".
    const f = await fixture()
    const s = spied(f, fakeDb({}), { ownership: { owns: () => false } })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(outcome.result.skippedReason).toBe('ownership_lost_mid_fold')
    expect(f.changes(), 'the pass wrote after ownership was lost').toBe(0)
    expect(s.warnings().some((m) => m.includes('aborted mid-fold')),
      'the abort was not reported — a silent refusal is the failure this guard exists to end').toBe(true)
  })

  it('GUARD (a) — refuses the destructive CLEAR when ownership is lost after the fold', async () => {
    // The second consultation, and the one that matters most. The fold has
    // already written the base — safe and idempotent, because the overlay still
    // holds the same entries and the read model reads it last-wins. The CLEAR is
    // the step after which the base is the value's only home.
    const f = await fixture()
    let asked = 0
    // True for the objects pass's FIRST consultation only.
    const s = spied(f, fakeDb({}), { ownership: { owns: () => { asked += 1; return asked <= 1 } } })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(outcome.result.skippedReason).toBe('ownership_lost_mid_fold')
    expect(asked, 'the predicate was consulted once, not before BOTH writes').toBeGreaterThan(1)
    expect(f.changes(), 'the fold half was refused too, so this proves nothing about the clear')
      .toBeGreaterThan(0)

    // THE WITNESS, BY NAME AND BY VALUE: the base shard also contains `o0`
    // after a fold, so assert the OVERLAY document itself, and the value.
    expect(f.overlay.doc()!.objects.o0,
      'the overlay entry was cleared after ownership was lost — the edit now lives only in the base')
      .toBeDefined()
    expect(f.overlay.doc()!.objects.o0.name).toBe('A-edited')
    // ...and the fold really did happen, so "not cleared" is not "nothing ran".
    expect(f.base.doc()!.objects.o0.name).toBe('A-edited')
    // The reported count is what happened, not a zero: folded into the base and
    // still in the overlay.
    expect(outcome.result.objectsFolded).toBe(1)
  })

  it('GUARD (a) — refuses when the workspace is PROMOTED to summary mid-fold', async () => {
    // Ownership can be intact while the workspace stops being ordinary: a
    // promotion hands the base shards to StaticDeltaProjector. The predicate
    // re-reads staticness, not only ownership.
    const f = await fixture()
    let reads = 0
    const db = fakeDb({ isStatic: () => { reads += 1; return reads > 1 } })
    const s = spied(f, db)
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(outcome.result.skippedReason).toBe('ownership_lost_mid_fold')
    expect(f.changes(), 'the pass wrote into shards a promotion had handed away').toBe(0)
    expect(db.staticReads(), 'staticness was asked once — the mid-fold re-read is gone').toBeGreaterThan(1)
  })

  it('GUARD (a) — an UNANSWERABLE staticness check is treated as unsafe, not as permission', async () => {
    // A live round trip between resolving the shards and writing them. Letting
    // it throw would be fail-safe by accident but would arrive as a stack trace
    // instead of a named refusal, and a throw from the connections pass would
    // discard the objects pass's counts entirely.
    const f = await fixture()
    let reads = 0
    const db: Queryable = {
      async query<R extends Record<string, unknown>>(text: string) {
        if (text.includes('read_model_static_workspaces')) {
          reads += 1
          if (reads > 1) throw new Error('statement timeout')
          return { rows: [{ present: false }] as unknown as R[], rowCount: 1 }
        }
        return {
          rows: [{
            observed_generation: '1', projected_generation: '1',
            projector_attached: true, projector_instance_id: 'this-cell',
          }] as unknown as R[],
          rowCount: 1,
        }
      },
    }
    const s = spied(f, db)
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBe('ownership_lost_mid_fold')
    expect(f.changes()).toBe(0)
    expect(s.warnings().some((m) => m.includes('unanswerable'))).toBe(true)
  })

  it('GUARD (b) — refuses when the projection row names a FOREIGN projector instance', async () => {
    // `attached = true` and `projected >= observed`, so the numbers say go. They
    // were published by another cell after a failover. The re-attach is
    // attempted once and the row still names the foreigner.
    const f = await fixture()
    const s = spied(f, fakeDb({
      attached: true, observed: '5', projected: '5', projectorInstanceId: 'another-cell',
    }))
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(outcome.result.skippedReason).toBe('foreign_projector_instance')
    expect(f.changes()).toBe(0)
  })

  it('GUARD (b) — refuses when this cell CANNOT NAME its own resident projector', async () => {
    // `residentProjectorInstanceId` returns null for an evicted or
    // never-attached workspace, and a lost write fence schedules that eviction
    // on a macrotask — so null appears in the window between the acknowledgement
    // read and the comparison, while the lease is still held and the workspace
    // is still ordinary, so guard (a) sees nothing wrong. "We cannot name our
    // own projector" must not read as "the acknowledgement is ours".
    const f = await fixture()
    const s = spied(f, fakeDb({ projectorInstanceId: 'someone' }), {
      fleet: {
        isResident: () => true,
        ensure: async () => undefined,
        release: () => undefined,
        residentProjectorInstanceId: () => null,
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBe('foreign_projector_instance')
    expect(f.changes()).toBe(0)
  })

  it('GUARD (b) — a STALE row from this cell heals on one re-attach instead of latching', async () => {
    // `markReadModelProjectorAttached` is best-effort telemetry, so one lost
    // UPDATE leaves the row naming a dead process from this same cell. Refusing
    // forever would turn that into compaction being off for the life of the
    // process — and the default workspace is pinned, so eviction cannot
    // re-attach it either. The overlay would grow without bound, which is the
    // cost compaction exists to cap.
    const f = await fixture()
    let healed = false
    const db: Queryable = {
      async query<R extends Record<string, unknown>>(text: string) {
        if (text.includes('read_model_static_workspaces')) {
          return { rows: [{ present: false }] as unknown as R[], rowCount: 1 }
        }
        return {
          rows: [{
            observed_generation: '3', projected_generation: '3', projector_attached: true,
            projector_instance_id: healed ? 'this-cell' : 'dead-process-on-this-cell',
          }] as unknown as R[],
          rowCount: 1,
        }
      },
    }
    const asked: unknown[] = []
    const s = spied(f, db, {
      fleet: {
        isResident: () => true,
        // The re-attach is what rewrites the row, and it reports success.
        ensure: async (_key, options) => { asked.push(options); healed = true; return true },
        release: () => undefined,
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason,
      'a stale row from this cell latched compaction off instead of healing').toBeUndefined()
    expect(outcome.result.objectsFolded).toBe(1)
    // G4-16f C6-2a: the refresh (then the post-fold re-attach) never adopts —
    // the refresh reads the acknowledgement the moment `ensure` returns.
    expect(asked).toEqual([{ adopt: false }, { adopt: false }])
  })

  it('GUARD (b) — proceeds when the instance MATCHES (control)', async () => {
    // Without this, "refuses on a foreign instance" is indistinguishable from
    // "refuses whenever an instance id is present at all".
    const f = await fixture()
    const s = spied(f, fakeDb({ attached: true, observed: '5', projected: '5', projectorInstanceId: 'this-cell' }))
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBeUndefined()
    expect(outcome.result.objectsFolded).toBe(1)
  })

  it('GUARD (g), G4-16f R4-a — refuses while a model epoch forward journal is open: nothing detached, nothing written', async () => {
    const f = await fixture()
    // `modelEpochs` present, flag OFF: with epoch rows the guard holds under
    // every value of the flag (absent, the pass issues no epoch statement).
    const s = spied(f, fakeDb({ attached: true, observed: '5', projected: '5', projectorInstanceId: 'this-cell', forwardJournalOpen: true }), {
      modelEpochs: {
        config: modelEpochConfig({}), instanceId: 'this-cell',
        withLifecycleLock: async () => ({ granted: false }),
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBe('epoch_forward_pending')
    expect(outcome.reattach).toBe('not_detached')
    expect(f.changes(), 'the pass WROTE under an open journal').toBe(0)
  })

  it('GUARD (c) — names the outcome when the re-attach is SKIPPED while shutting down', async () => {
    // Shutting down must also stop the FOLD, hence the `changes()` assertion
    // alongside the re-attach outcome.
    const f = await fixture()
    const s = spied(f, fakeDb({}), { isShuttingDown: () => true })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(outcome.reattach).toBe('skipped_shutting_down')
    expect(s.ensures(), 'the pass re-attached while shutting down').toBe(0)
    expect(f.changes(), 'the pass WROTE while shutting down').toBe(0)
    expect(outcome.result.skippedReason).toBe('ownership_lost_mid_fold')
    expect(s.warnings().some((m) => m.includes('DETACHED'))).toBe(true)
  })

  it('GUARD (c) — names the outcome when ownership is gone at re-attach time', async () => {
    // Owned through every predicate consultation, lost by the time the `finally`
    // runs. The count is pinned rather than assumed: both collections consult
    // twice, so four, and the fifth call is the `finally`'s.
    const PREDICATE_OWNS = 4
    const f = await fixture()
    let calls = 0
    const s = spied(f, fakeDb({}), {
      ownership: { owns: () => { calls += 1; return calls <= PREDICATE_OWNS } },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(calls, 'the number of ownership reads changed — this test no longer means what it says')
      .toBe(PREDICATE_OWNS + 1)
    expect(outcome.result.skippedReason, 'the fold itself was refused — this is not the re-attach path')
      .toBeUndefined()
    expect(outcome.reattach).toBe('skipped_not_owned')
    expect(s.warnings().some((m) => m.includes('DETACHED'))).toBe(true)
  })

  it('GUARD (c) — a re-attach that THROWS is named, and does not replace the result', async () => {
    // `ensure()` throws `ProjectorStaticWorkspaceError` for a workspace promoted
    // to summary — the very path guard (a) exists for. Uncaught it would discard
    // the result, skip the warning, leave `reattach` unassigned, and replace any
    // error `compactOverlay` was already throwing.
    const f = await fixture()
    const s = spied(f, fakeDb({}), {
      fleet: {
        isResident: () => true,
        ensure: async () => { throw new Error('ProjectorStaticWorkspaceError') },
        release: () => undefined,
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(outcome.reattach).toBe('skipped_reattach_failed')
    expect(outcome.result.objectsFolded, "the compaction's own result was discarded by the finally").toBe(1)
    expect(s.warnings().some((m) => m.includes('re-attach threw'))).toBe(true)
  })

  it('GUARD (c) — a re-attach that does NOT throw and attaches NOTHING is named', async () => {
    // `ProjectorFleet.ensure` answers `false` rather than throwing when the
    // workspace root does not resolve; the outcome must not say `'reattached'`
    // while the read plane is down. Reachable for every NON-default workspace —
    // the default one falls back to `fallbackRootUrl`.
    const f = await fixture()
    const s = spied(f, fakeDb({}), {
      fleet: {
        isResident: () => true,
        ensure: async () => false,
        release: () => undefined,
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(outcome.reattach).toBe('skipped_reattach_no_root')
    // The compaction's own result still comes back — the same property the
    // throwing case pins. A detached read plane is not a reason to lose the
    // counts of a fold that DID happen.
    expect(outcome.result.objectsFolded).toBe(1)
    expect(outcome.result.skippedReason).toBeUndefined()
    expect(s.warnings().some((m) => m.includes('DETACHED') && m.includes('did not resolve'))).toBe(true)
  })

  it('GUARD (b) — the instance refresh reports a re-attach that attached nothing', async () => {
    // `refreshProjectorAttachment` detaches BEFORE it re-attaches, so a no-root
    // answer must not be reported as re-attached.
    const f = await fixture()
    const s = spied(f, fakeDb({ projectorInstanceId: 'another-cell' }), {
      fleet: {
        isResident: () => true,
        ensure: async () => false,
        release: () => undefined,
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)

    expect(outcome.result.skippedReason).toBe('foreign_projector_instance')
    expect(outcome.reattach).toBe('skipped_reattach_failed')
  })

  it('G4-16f — a FAILED re-attach (thrown, or attaching nothing) is handed to the retry, once, with its cause; a successful, a not-owned and a never-detached pass are not', async () => {
    const f = await fixture()
    const handed: Array<{ key: string; cause: string; reason: string }> = []
    const onReadPlaneLeftDetached = (key: WorkspaceKey, cause: unknown, reason: string) => {
      handed.push({ key: `${key.landscapeId}/${key.versionId}`, cause: String(cause), reason })
    }
    const fleet = (ensure: () => Promise<boolean>) => ({
      isResident: () => true, ensure, release: () => undefined, residentProjectorInstanceId: () => 'this-cell',
    })
    const thrown = new Error('StoragePoolExhaustedError: could not get a permit for "unfenced-mutation"')
    const threw = await runWorkspaceCompaction(KEY, spied(f, fakeDb({}), {
      fleet: fleet(async () => { throw thrown }), onReadPlaneLeftDetached,
    }).deps)
    expect(threw.reattach).toBe('skipped_reattach_failed')
    expect(handed).toEqual([{ key: `${KEY.landscapeId}/${KEY.versionId}`, cause: String(thrown), reason: 'reattach_failed' }])

    handed.length = 0
    const noRoot = await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({}), {
      fleet: fleet(async () => false), onReadPlaneLeftDetached,
    }).deps)
    expect(noRoot.reattach).toBe('skipped_reattach_no_root')
    expect(handed.map((entry) => [entry.key, entry.reason])).toEqual([[`${KEY.landscapeId}/${KEY.versionId}`, 'no_root']])

    handed.length = 0
    const ok = await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({}), { onReadPlaneLeftDetached }).deps)
    expect(ok.reattach).toBe('reattached')
    const never = await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({ isStatic: true }), { onReadPlaneLeftDetached }).deps)
    expect(never.reattach).toBe('not_detached')
    expect(handed, 'a re-attach that worked, or a pass that never detached, is not handed over').toEqual([])
  })

  it('G4-16f — ownership lost at the re-attach is handed over as not_owned (dormant, retried once owned again); a shutdown is not handed over', async () => {
    const handed: string[] = []
    const onReadPlaneLeftDetached = (_key: WorkspaceKey, _cause: unknown, reason: string) => { handed.push(reason) }
    let calls = 0
    const notOwned = await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({}), {
      ownership: { owns: () => { calls += 1; return calls <= 4 } }, onReadPlaneLeftDetached,
    }).deps)
    expect(notOwned.reattach, 'the same ownership count as GUARD (c) above').toBe('skipped_not_owned')
    expect(handed).toEqual(['not_owned'])

    handed.length = 0
    let down = false
    const shutdown = await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({}), {
      fleet: {
        isResident: () => true, ensure: async () => true,
        release: (_key, reason) => { if (reason === 'compaction') down = true },
        residentProjectorInstanceId: () => 'this-cell',
      },
      isShuttingDown: () => down,
      onReadPlaneLeftDetached,
    }).deps)
    expect(shutdown.reattach).toBe('skipped_shutting_down')
    expect(handed).toEqual([])
  })

  it('G4-16f — a thrown re-attach is classified: ProjectorOwnershipError → not_owned; a stop or a promotion is not handed over', async () => {
    const { ProjectorOwnershipError, ProjectorStaticWorkspaceError } = await import('./projectorService.js')
    const { ColdBuildAdmissionStoppedError } = await import('./coldBuildAdmission.js')
    const cases: Array<[Error, string[]]> = [
      [new ProjectorOwnershipError(), ['not_owned']],
      [new ColdBuildAdmissionStoppedError(), []],
      [new ProjectorStaticWorkspaceError(KEY), []],
    ]
    for (const [error, expected] of cases) {
      const handed: string[] = []
      const outcome = await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({}), {
        fleet: {
          isResident: () => true, ensure: async (_key, options) => { if (options?.adopt === false) throw error; return true },
          release: () => undefined, residentProjectorInstanceId: () => 'this-cell',
        },
        onReadPlaneLeftDetached: (_key, _cause, reason) => { handed.push(reason) },
      }).deps)
      expect(outcome.reattach, error.name).toBe('skipped_reattach_failed')
      expect(handed, error.name).toEqual(expected)
    }
  })

  it('G4-16f — the instance refresh (guard (b)) hands a failed re-attach to the retry, and a throwing hook does not break the pass', async () => {
    const f = await fixture()
    const handed: string[] = []
    const outcome = await runWorkspaceCompaction(KEY, spied(f, fakeDb({ projectorInstanceId: 'another-cell' }), {
      fleet: {
        isResident: () => true,
        ensure: async () => { throw new Error('StoragePoolExhaustedError') },
        release: () => undefined,
        residentProjectorInstanceId: () => 'this-cell',
      },
      onReadPlaneLeftDetached: (key, _cause, reason) => { handed.push(`${key.versionId}:${reason}`); throw new Error('the hook broke') },
    }).deps)
    expect(outcome.result.skippedReason).toBe('foreign_projector_instance')
    expect(outcome.reattach).toBe('skipped_reattach_failed')
    expect(handed).toEqual([`${KEY.versionId}:reattach_failed`])
  })

  it('G4-16f — the instance refresh that attaches NOTHING is handed over as no_root', async () => {
    const handed: string[] = []
    const outcome = await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({ projectorInstanceId: 'another-cell' }), {
      fleet: { isResident: () => true, ensure: async () => false, release: () => undefined, residentProjectorInstanceId: () => 'this-cell' },
      onReadPlaneLeftDetached: (_key, _cause, reason) => { handed.push(reason) },
    }).deps)
    expect(outcome.result.skippedReason).toBe('foreign_projector_instance')
    expect(handed).toEqual(['no_root'])
  })

  it('G4-16f — every re-attach the pass runs is WATCHED: the pass\'s and the instance refresh\'s, settled after the ensure', async () => {
    const watched: string[] = []
    const watchReattach = (key: WorkspaceKey) => { watched.push(`start:${key.versionId}`); return () => { watched.push(`end:${key.versionId}`) } }
    let inFlight = false
    const fleet = {
      isResident: () => true,
      ensure: async () => { inFlight = true; await Promise.resolve(); expect(watched.at(-1)).toBe(`start:${KEY.versionId}`); inFlight = false; return true },
      release: () => undefined,
      residentProjectorInstanceId: () => 'this-cell',
    }
    await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({}), { fleet, watchReattach }).deps)
    expect(watched).toEqual([`start:${KEY.versionId}`, `end:${KEY.versionId}`])
    expect(inFlight).toBe(false)
    watched.length = 0
    await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({ projectorInstanceId: 'another-cell' }), {
      fleet: { ...fleet, ensure: async () => { throw new Error('x') } }, watchReattach,
    }).deps)
    expect(watched, 'the refresh is watched, and settled when it throws').toEqual([`start:${KEY.versionId}`, `end:${KEY.versionId}`])
  })

  it('G4-16f — the log says "rebuilt" only when the re-attach attached, and the HTTP body carries the re-attach outcome', async () => {
    const { compactionHttpBody } = await import('./workspaceCompaction.js')
    const logs: string[] = []
    const failed = await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({}), {
      fleet: { isResident: () => true, ensure: async (_k, o) => { if (o?.adopt === false) throw new Error('StoragePoolExhaustedError'); return true }, release: () => undefined, residentProjectorInstanceId: () => 'this-cell' },
      log: (m) => { logs.push(m) },
    }).deps)
    const folded = logs.find((m) => m.startsWith('[compaction] folded'))!
    expect(folded).not.toContain('read model rebuilt')
    expect(folded).toContain('read model NOT rebuilt: the read plane is detached (skipped_reattach_failed)')
    expect(compactionHttpBody(failed)).toMatchObject({ objectsFolded: 1, reattach: 'skipped_reattach_failed' })

    logs.length = 0
    const ok = await runWorkspaceCompaction(KEY, spied(await fixture(), fakeDb({}), { log: (m) => { logs.push(m) } }).deps)
    expect(logs.find((m) => m.startsWith('[compaction] folded'))).toContain('; read model rebuilt')
    expect(compactionHttpBody(ok)).toMatchObject({ reattach: 'reattached' })
  })

  it('a refusal BEFORE the detach reports `not_detached`, not a skipped re-attach', async () => {
    // The four shapes must stay distinguishable: never detached, detached and
    // put back, detached and left, detach-then-re-attach-threw. Collapsing the
    // first into the third raises a false alarm on every summary workspace.
    const f = await fixture()
    const s = spied(f, fakeDb({ isStatic: true }))
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBe('summary_workspace')
    expect(outcome.reattach).toBe('not_detached')
    expect(s.releases()).toBe(0)
  })

  // ---- G4-16i guard (d): both overlay-rotation keys, by refusal ----
  const OBJECT_KEY = `overlay-rotation:${KEY.landscapeId}:${KEY.versionId}:object`
  const CONNECTION_KEY = `overlay-rotation:${KEY.landscapeId}:${KEY.versionId}:connection`

  it('GUARD (d) — holds BOTH rotation keys while it writes, settles on them, and gives them back (connection first) BEFORE the re-attach', async () => {
    const f = await fixture()
    const events: string[] = []
    const { connect } = fakeConnect([], events)
    const s = spied(f, fakeDb({}), {
      connect,
      fleet: {
        isResident: () => true,
        ensure: async () => { events.push('ensure'); return true },
        release: () => { events.push('release-projector') },
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBeUndefined()
    expect(outcome.result.objectsFolded).toBe(1)
    expect(events).toEqual([
      // Both keys BEFORE the detach.
      'connect client1', `client1 lock ${OBJECT_KEY} true`,
      'connect client2', `client2 lock ${CONNECTION_KEY} true`,
      'release-projector',
      // The settle of each collection, on its key's client, fence asserted
      // (no rows: nothing written).
      // The fence FIRST, before the first retirement row is read or locked
      // (`adoptState.ts`, THE LOCK ORDER), held FOR UPDATE to COMMIT.
      'client1 BEGIN', 'client1 fence', 'client1 rows', 'client1 COMMIT',
      'client2 BEGIN', 'client2 fence', 'client2 rows', 'client2 COMMIT',
      `client2 unlock ${CONNECTION_KEY}`, 'release client2',
      `client1 unlock ${OBJECT_KEY}`, 'release client1',
      'ensure',
    ])
  })

  it('GUARD (f) — a write fence that MOVED after the detach (another cell\'s cold build) refuses the settle: nothing committed, ModelMeta not repointed', async () => {
    const f = await fixture()
    const events: string[] = []
    const { connect } = fakeConnect([], events, () => 'another-cell')
    const s = spied(f, fakeDb({}), { connect })
    const meta = await f.repo.find<{ editsObjectShardUrl?: string }>(
      (await f.repo.find<{ modelMetaUrl: string }>(f.rootUrl as never)).doc()!.modelMetaUrl as never)
    const pointer = meta.doc()!.editsObjectShardUrl
    await expect(runWorkspaceCompaction(KEY, s.deps)).rejects.toThrow(/write fence|write_fence|another-cell/)
    expect(events.slice(events.indexOf('client1 BEGIN'))).toEqual(expect.arrayContaining(['client1 fence', 'client1 ROLLBACK']))
    expect(events.indexOf('client1 ROLLBACK')).toBe(events.indexOf('client1 fence') + 1)
    expect(events).not.toContain('client1 COMMIT')
    expect(meta.doc()!.editsObjectShardUrl).toBe(pointer)
    expect(s.ensures()).toBe(1) // detached, so put back
  })

  it('GUARD (c) — a release() that THROWS still gets the re-attach: the flag tracks "release was called"', async () => {
    const f = await fixture()
    const events: string[] = []
    const s = spied(f, fakeDb({}), {
      connect: fakeConnect([], events).connect,
      fleet: {
        isResident: () => true,
        ensure: async () => { events.push('ensure'); return true },
        release: () => { events.push('release-projector'); throw new Error('release blew up half-way') },
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    await expect(runWorkspaceCompaction(KEY, s.deps)).rejects.toThrow('release blew up half-way')
    expect(f.changes()).toBe(0)
    // Keys given back, THEN the re-attach.
    const unlocked = events.filter((event) => event.includes(' unlock ')).length
    expect(unlocked).toBe(2)
    expect(events.at(-1)).toBe('ensure')
    expect(events.indexOf('ensure')).toBeGreaterThan(events.lastIndexOf('release client1'))
  })

  it('GUARD (b), re-asked — a resident instance that MOVED while the keys were taken skips with nothing detached and the keys given back', async () => {
    const f = await fixture()
    const events: string[] = []
    let resident = 'this-cell'
    const { connect } = fakeConnect([], events)
    const s = spied(f, fakeDb({}), {
      // The instance is recycled during the acquisitions (the second connect).
      connect: async () => {
        const client = await connect()
        if (events.filter((event) => event.startsWith('connect ')).length === 2) resident = 'recycled-instance'
        return client
      },
      fleet: {
        isResident: () => true,
        ensure: async () => { events.push('ensure'); return true },
        release: () => { events.push('release-projector') },
        residentProjectorInstanceId: () => resident,
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBe('foreign_projector_instance')
    expect(outcome.reattach).toBe('not_detached')
    expect(f.changes()).toBe(0)
    expect(events).not.toContain('release-projector')
    expect(events).not.toContain('ensure')
    expect(events.filter((event) => event.includes(' unlock '))).toHaveLength(2)
    expect(s.warnings().some((m) => m.includes('recycled-instance'))).toBe(true)
  })

  it.each([
    ['object', [false], [`client1 lock ${OBJECT_KEY} false`, 'release client1']],
    ['connection', [true, false], [
      `client1 lock ${OBJECT_KEY} true`, 'connect client2', `client2 lock ${CONNECTION_KEY} false`, 'release client2',
      `client1 unlock ${OBJECT_KEY}`, 'release client1',
    ]],
  ] as const)('GUARD (d) — a %s key held elsewhere skips the pass with NOTHING written, BEFORE any detach: no release, no cold build', async (kind, locked, tail) => {
    const f = await fixture()
    const events: string[] = []
    const { connect } = fakeConnect([...locked], events)
    const s = spied(f, fakeDb({}), {
      connect,
      fleet: {
        isResident: () => true,
        ensure: async () => { events.push('ensure'); return true },
        release: () => { events.push('release-projector') },
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBe('overlay_rotation_lock_contended')
    expect(outcome.reattach).toBe('not_detached')
    expect(f.changes()).toBe(0)
    expect(f.overlay.doc()!.objects.o0.name).toBe('A-edited')
    expect(events).toEqual(['connect client1', ...tail])
    // ONE warning for the skip, naming the key.
    expect(s.warnings().filter((m) => m.includes('overlay-rotation key'))).toHaveLength(1)
    expect(s.warnings().some((m) => m.includes(kind) && m.includes('refused'))).toBe(true)
  })

  it('GUARD (d) — a THROW from the acquisition destroys that session, and nothing was detached', async () => {
    const f = await fixture()
    const events: string[] = []
    const s = spied(f, fakeDb({}), {
      connect: async () => {
        events.push('connect')
        return {
          query: async () => { throw new Error('socket gone') },
          release: (destroy?: Error | boolean) => { events.push(destroy ? 'release destroyed' : 'release') },
        }
      },
      fleet: {
        isResident: () => true,
        ensure: async () => { events.push('ensure'); return true },
        release: () => { events.push('release-projector') },
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    await expect(runWorkspaceCompaction(KEY, s.deps)).rejects.toThrow('socket gone')
    expect(events).toEqual(['connect', 'release destroyed'])
    expect(f.changes()).toBe(0)
  })

  // `acquireOverlayRotationLock` answers `unknown` when the statement returns no
  // row at all (not a thrown error): neither "acquired" nor a definite "refused".
  // Three states, one licence — only `acquired` writes, and `unknown` is paid for
  // by destroying the session (the server may have granted the key).
  it.each([
    ['object', 0, ['connect client1', 'client1 unknown', 'release client1 destroyed']],
    ['connection', 1, [
      'connect client1', 'client1 ok', 'connect client2', 'client2 unknown',
      'release client2 destroyed', `client1 unlock ${OBJECT_KEY}`, 'release client1',
    ]],
  ] as const)('GUARD (d) — an UNANSWERED %s acquisition (no row) skips the pass with nothing written and destroys that session', async (_kind, unknownAt, expected) => {
    const f = await fixture()
    const events: string[] = []
    let acquisitions = 0
    let clients = 0
    const s = spied(f, fakeDb({}), {
      connect: async () => {
        const id = `client${++clients}`
        events.push(`connect ${id}`)
        return {
          async query(text: string, params?: unknown[]) {
            if (text.includes('pg_try_advisory_lock(')) {
              const at = acquisitions++
              if (at === unknownAt) { events.push(`${id} unknown`); return { rows: [], rowCount: 0 } }
              events.push(`${id} ok`)
              return { rows: [{ locked: true }], rowCount: 1 }
            }
            if (text.includes('pg_advisory_unlock(')) {
              events.push(`${id} unlock ${String(params?.[0])}`)
              return { rows: [{ released: true }], rowCount: 1 }
            }
            throw new Error(`unexpected statement after an unanswered acquisition: ${text.slice(0, 60)}`)
          },
          release(destroy?: Error | boolean) { events.push(`release ${id}${destroy ? ' destroyed' : ''}`) },
        }
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason).toBe('overlay_rotation_lock_contended')
    expect(f.changes()).toBe(0)
    expect(events).toEqual(expected)
  })
})
