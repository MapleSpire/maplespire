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
import { runWorkspaceCompaction, type WorkspaceCompactionDeps } from './workspaceCompaction.js'
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
}

/** Answers the only two statements this pass issues, and REFUSES anything else:
 *  a fake that quietly returns `{rows: []}` to an unexpected statement turns a
 *  new query into a silent false. It also asserts the workspace it was asked
 *  about — without that, pointing any call site at a different key is invisible. */
function fakeDb(opts: FakeDbOptions): Queryable & { staticReads: () => number } {
  let staticReads = 0
  return {
    staticReads: () => staticReads,
    async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
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
  warnings: () => string[]
  keysSeen: () => string[]
}

function spied(f: Fixture, db: Queryable, over: Partial<WorkspaceCompactionDeps> = {}): Spies {
  let releases = 0
  let ensures = 0
  const warnings: string[] = []
  const keysSeen: string[] = []
  const note = (key: WorkspaceKey) => { keysSeen.push(`${key.landscapeId}/${key.versionId}`) }
  const deps: WorkspaceCompactionDeps = {
    repo: f.repo,
    rootUrl: f.rootUrl,
    db,
    fleet: {
      isResident: (key) => { note(key); return true },
      // `true` is STATED: `false` means "attached nothing"
      // (`skipped_reattach_no_root`).
      ensure: async (key) => { note(key); ensures += 1; return true },
      release: (key) => { note(key); releases += 1 },
      residentProjectorInstanceId: (key) => { note(key); return 'this-cell' },
    },
    ownership: { owns: (key) => { note(key); return true } },
    isShuttingDown: () => false,
    log: () => undefined,
    warn: (m) => { warnings.push(m) },
    ...over,
  }
  return { deps, releases: () => releases, ensures: () => ensures, warnings: () => warnings, keysSeen: () => keysSeen }
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

  it('ENSURES residency before folding when the workspace is not resident', async () => {
    // `isResident` is `() => true` everywhere else, so only this test exercises
    // the pre-fold `ensure`.
    const f = await fixture()
    let ensures = 0
    const s = spied(f, fakeDb({}), {
      fleet: {
        isResident: () => false,
        ensure: async () => { ensures += 1 },
        release: () => undefined,
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    await runWorkspaceCompaction(KEY, s.deps)
    // Once before the fold, once in the `finally`.
    expect(ensures, 'a non-resident workspace was compacted without being ensured first').toBe(2)
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
    expectOnlyTheKeyUnderTest(s)

    // The fold reached the OVERLAY documents by url, and the value moved.
    expect(f.base.doc()!.objects.o0.name).toBe('A-edited')
    expect(f.overlay.doc()!.objects.o0, 'the overlay was not cleared by a successful pass').toBeUndefined()
    expect(f.connBase.doc()!.connections.c0.toId).toBe('o9')
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
    const s = spied(f, db, {
      fleet: {
        isResident: () => true,
        // The re-attach is what rewrites the row, and it reports success.
        ensure: async () => { healed = true; return true },
        release: () => undefined,
        residentProjectorInstanceId: () => 'this-cell',
      },
    })
    const outcome = await runWorkspaceCompaction(KEY, s.deps)
    expect(outcome.result.skippedReason,
      'a stale row from this cell latched compaction off instead of healing').toBeUndefined()
    expect(outcome.result.objectsFolded).toBe(1)
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
})
