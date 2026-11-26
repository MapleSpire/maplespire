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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { StoragePoolExhaustedError } from '../automergeStorageErrors.js'
import { installedPoolConcurrencyGate, type PoolPermit } from '../db/poolConcurrencyGate.js'
import { createProcessExclusion } from '../maintenance/processExclusion.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { ProjectorFleet } from './projectorService.js'
import { ORDINARY_HEAD_ROTATION_OFF } from './ordinaryHeadRotation.js'
import { readProjectionAcknowledgement } from './compaction.js'
import { runWorkspaceCompaction, type WorkspaceCompactionDeps } from './workspaceCompaction.js'
import { compactionReattachMetricSamples } from './compactionReattach.js'
import { wireCompactionReattach, type CompactionReattachWiring } from './compactionReattachWiring.js'
import { createUnyieldingHolds } from './modelEpochForwardWiring.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16f, the 3-year bench: a compaction's re-attach refused a storage permit
 * (`StoragePoolExhaustedError('unfenced-mutation', 'queue-timeout')`, 4
 * permits, 2 s) and the read plane stayed DETACHED for the rest of the run.
 *
 * Reproduced here with the REAL pieces — the PostgreSQL storage adapter and
 * its permit gate, the real `ProjectorFleet` and cold build, the real pass,
 * the production wiring (`wireCompactionReattach`) over a real
 * `createUnyieldingHolds(createProcessExclusion())` slot — and the exhaustion
 * made deterministic: the adapter's write permits are all taken by the test
 * at the moment the pass re-attaches, while an edit made in the detached
 * window is still unsaved. The cold build's flush then waits out the permit
 * deadline and throws, exactly the bench's stack (`withBoundedClient` →
 * `save`). The permits come back after a while, as they did on the bench
 * host once its checkpoint finished.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-reattach', versionId: 'v1' }
/** The adapter's bound and deadline, small so the test does not sleep 2 s. */
const PERMITS = 2
const PERMIT_WAIT_MS = 150
/** How long the permits stay taken: past the pass's re-attach and the first retries. */
const SATURATED_MS = 1_500

let db: IsolatedSchemaDb

type Entity = { id: string; [field: string]: unknown }
type Meta = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
  groups: Record<string, unknown>
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function claim(documentId: string) {
  await db.pool.query(
    'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [documentId, WS.landscapeId, WS.versionId],
  )
}

interface Workspace { repo: Repo; rootUrl: string; meta: DocHandle<Meta> }

/** A base shard with `b`, an overlay head with `o1` (what the pass folds). */
async function workspace(): Promise<Workspace> {
  const repo = new Repo({
    storage: new PostgresStorageAdapter({ db: db.pool, dbConcurrency: PERMITS, dbConcurrencyWaitMs: PERMIT_WAIT_MS }),
    network: [],
    // Nothing is saved behind the test's back: an edit stays unsaved until a flush.
    saveDebounceRate: 60_000,
  })
  const base = repo.create<{ objects: Record<string, Entity> }>({ objects: { b: { id: 'b', name: 'B', type: 'system' } } })
  const head = repo.create<{ objects: Record<string, Entity>; writeBatchIds: string[] }>({
    objects: { o1: { id: 'o1', name: 'overlay edit', type: 'system' } }, writeBatchIds: [],
  })
  const connHead = repo.create({ connections: {}, writeBatchIds: [] })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, head.url],
    connectionShardUrls: [connHead.url],
    editsObjectShardUrl: head.url,
    editsObjectShardUrls: [head.url],
    editsConnectionShardUrl: connHead.url,
    editsConnectionShardUrls: [connHead.url],
    groups: {},
  })
  const registry = repo.create({ diagrams: {} })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  const handles = [base, head, connHead, meta, registry, root]
  await Promise.all(handles.map((h) => h.whenReady()))
  await repo.flush()
  for (const handle of handles) await claim(String(handle.documentId))
  return { repo, rootUrl: root.url, meta }
}

const roNames = async () => Object.fromEntries((await db.pool.query<{ id: string; name: string }>(
  "SELECT id, data->>'name' AS name FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id",
  [WS.landscapeId, WS.versionId],
)).rows.map((row) => [row.id, row.name]))

interface EnsureRecord { at: number; duringPass: boolean; outcome?: string }

/**
 * The real fleet, seen by the pass and the supervisor through one wrapper
 * that, at the PASS'S re-attach (the first `{ adopt: false }` ensure after a
 * `compaction` release), writes `o2` to the current overlay head — unsaved —
 * and takes every write permit for {@link SATURATED_MS}. Each `ensure` is
 * recorded with whether a compaction pass was running when it started.
 */
function saturatingFleet(ws: Workspace, real: ProjectorFleet, passRunning: () => boolean) {
  let armed = false
  let held: PoolPermit[] = []
  const ensures: EnsureRecord[] = []
  const fleet: WorkspaceCompactionDeps['fleet'] & Pick<ProjectorFleet, 'onResident' | 'liftCompactionDetached'> = {
    isResident: (key) => real.isResident(key),
    residentProjectorInstanceId: (key) => real.residentProjectorInstanceId(key) ?? null,
    release: (key, reason) => {
      if (reason === 'compaction') armed = true
      real.release(key, reason)
    },
    endCompactionWindow: (key) => real.endCompactionWindow(key),
    onResident: (listener) => real.onResident(listener),
    liftCompactionDetached: (key) => real.liftCompactionDetached(key),
    ensure: async (key, options) => {
      const record: EnsureRecord = { at: Date.now(), duringPass: passRunning() }
      ensures.push(record)
      if (armed && options?.adopt === false) {
        armed = false
        const headUrl = ws.meta.doc()!.editsObjectShardUrl as AutomergeUrl
        const head = await ws.repo.find<{ objects: Record<string, Entity> }>(headUrl)
        head.change((d) => { d.objects.o2 = { id: 'o2', name: 'written while detached', type: 'system' } })
        const gate = installedPoolConcurrencyGate(db.pool)!
        held = await Promise.all(Array.from({ length: gate.limit }, () => gate.acquire(5_000)))
        setTimeout(() => { for (const permit of held) permit.release(); held = [] }, SATURATED_MS).unref?.()
      }
      try {
        const attached = await real.ensure(key, options)
        record.outcome = attached ? 'attached' : 'no_root'
        return attached
      } catch (error) {
        record.outcome = error instanceof Error ? error.name : String(error)
        throw error
      }
    },
  }
  return { fleet, ensures, releasePermits: () => { for (const permit of held) permit.release(); held = [] } }
}

/** One scenario's world: the workspace, the real fleet behind the wrapper,
 * ONE slot (as production), the production wiring, and a pass runner. */
async function scenario(delaysMs: readonly number[]) {
  const ws = await workspace()
  const real = new ProjectorFleet(ws.repo, async () => ws.rootUrl, {
    fallbackRootUrl: ws.rootUrl, db: db.pool, ordinaryHeadRotation: ORDINARY_HEAD_ROTATION_OFF, adopt: 'off', maxProjectors: 2,
  })
  const holds = createUnyieldingHolds(createProcessExclusion())
  let passes = 0
  const saturating = saturatingFleet(ws, real, () => passes > 0)
  const events: Array<Record<string, unknown>> = []
  const stops: Array<() => void> = []
  const wiring: CompactionReattachWiring = wireCompactionReattach({
    fleet: saturating.fleet,
    ownership: null,
    readiness: { shuttingDown: false },
    holds,
    stops,
    // The REAL storage gate, as `index.ts` passes the write pool's.
    writeGate: () => installedPoolConcurrencyGate(db.pool),
    overrides: {
      delaysMs, backoffMs: [1_000],
      log: (event) => { events.push(event) }, warn: (event) => { events.push(event) },
    },
  })
  const warnings: string[] = []
  /** A compaction pass under the slot, as `index.ts` runs it. */
  const pass = () => holds.run(async () => {
    passes += 1
    try {
      return await runWorkspaceCompaction(WS, {
        repo: ws.repo, rootUrl: ws.rootUrl, db: db.pool, connect: () => db.pool.connect(), fleet: saturating.fleet,
        ownership: { owns: () => true }, isShuttingDown: () => false,
        log: () => {}, warn: (m) => { warnings.push(m) },
        ...wiring.passHooks,
      })
    } finally {
      passes -= 1
    }
  })
  /** Another pass holding the slot for `ms` (doing `work` inside it). */
  const anotherPass = (ms: number, work: () => Promise<unknown> = async () => undefined) => holds.run(async () => {
    passes += 1
    try {
      await sleep(ms)
      await work()
    } finally {
      passes -= 1
    }
  })
  const detachedGauge = () => compactionReattachMetricSamples(wiring.supervisor)
    .find((s) => s.name === 'maplespire_read_model_compaction_detached_workspaces')!.values[0]!.value
  const teardown = async () => {
    saturating.releasePermits()
    for (const stop of stops) stop()
    real.stopAll()
    await sleep(300)
    await ws.repo.shutdown().catch(() => undefined)
  }
  expect(await real.ensure(WS)).toBe(true)
  await until(() => readProjectionAcknowledgement(db.pool, WS), (ack) => ack.acknowledged)
  return { ws, real, wiring, events, warnings, pass, anotherPass, detachedGauge, teardown, ...saturating }
}

suite('a compaction re-attach refused a storage permit (G4-16f, 3-year bench) — real adapter, fleet, cold build, PostgreSQL', () => {
  let restoreRegistration: () => void = () => {}
  let quiet: Array<{ mockRestore(): void }> = []
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'compaction_reattach')
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)`)
  })
  afterAll(async () => { await sleep(500); await db?.teardown() })
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
      read_model_projection_state, read_model_change_events`)
    // The cold build and the pass log a great deal; the supervisor's events are captured.
    quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      for (const documentId of documentIds) {
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId],
        )
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
  })
  afterEach(() => {
    restoreRegistration()
    for (const spy of quiet) spy.mockRestore()
  })

  it('the pass reports the refusal and hands it over; the supervisor re-attaches once the permits come back — never during a pass, from the COMPACTED state, with the write made while detached, the fleet\'s mark lifted — and the gauge goes 1 then 0', async () => {
    const s = await scenario([200, 400, 800, 1_600])
    try {
      expect(await roNames()).toEqual({ b: 'B', o1: 'overlay edit' })
      const outcome = await s.pass()
      // A SECOND PASS takes the slot right away: a retry that
      // did not wait for the slot would run during it.
      const second = s.anotherPass(700)

      // THE BENCH'S FAILURE, reproduced: the fold happened, the re-attach
      // threw the storage refusal, the plane is down.
      expect(outcome.result.skippedReason).toBeUndefined()
      expect(outcome.result.objectsFolded).toBe(1)
      expect(outcome.reattach).toBe('skipped_reattach_failed')
      expect(s.ensures.find((entry) => entry.duringPass)?.outcome).toBe(StoragePoolExhaustedError.name)
      expect(s.warnings.some((m) => m.includes('re-attach threw') && m.includes('could not get a permit'))).toBe(true)
      expect(s.real.isResident(WS)).toBe(false)
      expect(s.real.isCompactionDetached(WS)).toBe(true)
      expect(s.wiring.supervisor.isPending(WS)).toBe(true)
      expect(s.detachedGauge()).toBe(1)

      // RECOVERY, without a read, a restart or another compaction.
      const attached = await until(() => s.real.isResident(WS), Boolean, 20_000)
      expect(attached, `still detached; supervisor events: ${JSON.stringify(s.events)}`).toBe(true)
      await second
      await until(() => !s.wiring.supervisor.isPending(WS), Boolean, 2_000)
      expect(s.wiring.supervisor.isPending(WS)).toBe(false)
      expect(s.detachedGauge()).toBe(0)

      // NEVER DURING A PASS: only the pass's own re-attach ran inside one.
      expect(s.ensures.filter((entry) => entry.duringPass)).toHaveLength(1)
      const retries = s.ensures.filter((entry) => !entry.duringPass)
      expect(retries.some((entry) => entry.outcome === StoragePoolExhaustedError.name)).toBe(true)
      expect(retries.at(-1)?.outcome).toBe('attached')
      expect(s.events.find((event) => event.event === 'read_model.compaction_reattach_recovered')).toMatchObject({ by: 'retry' })
      // `{ adopt: false }` lifted the fleet's mark: the next start may adopt again.
      expect(s.real.isCompactionDetached(WS)).toBe(false)

      // THE COMPACTED STATE: the overlay is folded into the base and cleared;
      // the rebuilt rows serve it, and the write made while detached.
      await until(() => readProjectionAcknowledgement(db.pool, WS), (ack) => ack.acknowledged)
      expect(await roNames()).toEqual({ b: 'B', o1: 'overlay edit', o2: 'written while detached' })
      const meta = s.ws.meta.doc()!
      const base = await s.ws.repo.find<{ objects: Record<string, Entity> }>(meta.objectShardUrls[0] as AutomergeUrl)
      expect(Object.keys(base.doc()!.objects).sort()).toEqual(['b', 'o1'])

      // NO PERMIT LEAKED by the refusals.
      await s.ws.repo.flush()
      const gate = installedPoolConcurrencyGate(db.pool)!
      const idle = await until(() => ({ inFlight: gate.inFlightCount, live: gate.liveQueueDepth }), (g) => g.inFlight === 0 && g.live === 0, 5_000)
      expect(idle).toEqual({ inFlight: 0, live: 0 })
    } finally {
      await s.teardown()
    }
  }, 60_000)

  it('a pass that RE-ATTACHED the workspace while the retry waited for the slot ends the outage: the retry re-asks under the slot and builds nothing', async () => {
    const s = await scenario([200, 400, 800])
    try {
      const outcome = await s.pass()
      expect(outcome.reattach).toBe('skipped_reattach_failed')
      // The next pass holds the slot past the saturation, then re-attaches.
      await s.anotherPass(SATURATED_MS + 300, () => s.fleet.ensure(WS, { adopt: false }))
      await until(() => !s.wiring.supervisor.isPending(WS), Boolean, 5_000)
      expect(s.real.isResident(WS)).toBe(true)
      expect(s.events.find((event) => event.event === 'read_model.compaction_reattach_recovered')).toMatchObject({ by: 'already_resident' })
      expect(s.ensures.filter((entry) => !entry.duringPass), 'the waiting retry built nothing').toHaveLength(0)
    } finally {
      await s.teardown()
    }
  }, 60_000)

  it('a READ\'s cold build ends the outage at once: the gauge is 0 when its ensure returns, not at the next tick, and the fleet\'s mark is lifted', async () => {
    const s = await scenario([30_000])
    try {
      const outcome = await s.pass()
      expect(outcome.reattach).toBe('skipped_reattach_failed')
      expect(s.detachedGauge()).toBe(1)
      s.releasePermits()
      // A read: the route's plain `ensure`, `off` because of the mark.
      expect(await s.real.ensure(WS)).toBe(true)
      expect(s.detachedGauge()).toBe(0)
      expect(s.wiring.supervisor.isPending(WS)).toBe(false)
      expect(s.events.find((event) => event.event === 'read_model.compaction_reattach_recovered')).toMatchObject({ by: 'already_resident' })
      expect(s.real.isCompactionDetached(WS)).toBe(false)
      expect(s.ensures.filter((entry) => !entry.duringPass)).toHaveLength(0)
    } finally {
      await s.teardown()
    }
  }, 60_000)

  it('a caller QUEUED at the real storage gate postpones the retry without the slot; once it drains, the retry re-attaches', async () => {
    const s = await scenario([200, 400, 800])
    try {
      const outcome = await s.pass()
      expect(outcome.reattach).toBe('skipped_reattach_failed')
      // The permits are still held: a caller now WAITS at the gate.
      const gate = installedPoolConcurrencyGate(db.pool)!
      const queued = gate.acquire(5_000).then((permit) => permit.release())
      expect(gate.liveQueueDepth).toBe(1)
      await until(() => !s.wiring.supervisor.isPending(WS), Boolean, 20_000)
      await queued
      expect(s.real.isResident(WS)).toBe(true)
      expect(s.wiring.supervisor.snapshot().attempts.skippedSaturated).toBeGreaterThanOrEqual(1)
      expect(s.events.filter((event) => event.event === 'read_model.compaction_reattach_skipped').length).toBeGreaterThanOrEqual(1)
      // No retry built while the gate had a caller queued.
      expect(s.ensures.filter((entry) => !entry.duringPass).map((entry) => entry.outcome)).toEqual(['attached'])
    } finally {
      await s.teardown()
    }
  }, 60_000)

  it('the control: the same exhaustion WITHOUT the hand-over leaves the read plane detached — what the bench saw', async () => {
    const s = await scenario([200])
    try {
      const outcome = await runWorkspaceCompaction(WS, {
        repo: s.ws.repo, rootUrl: s.ws.rootUrl, db: db.pool, connect: () => db.pool.connect(), fleet: s.fleet,
        ownership: { owns: () => true }, isShuttingDown: () => false, log: () => {}, warn: () => {},
      })
      expect(outcome.reattach).toBe('skipped_reattach_failed')
      await sleep(SATURATED_MS + 2_000)
      expect(s.real.isResident(WS), 'nothing re-attaches it').toBe(false)
    } finally {
      await s.teardown()
    }
  }, 60_000)
})
