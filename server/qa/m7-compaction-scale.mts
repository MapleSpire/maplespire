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
 * M7 — how long the overlay-compaction pass takes at 300 / 12 000 / 200 000
 * objects, split into the three segments a caller can actually be blocked on.
 *
 *   cd server
 *   TEST_DATABASE_URL=postgres://... NODE_OPTIONS=--max-old-space-size=8192 \
 *     npx tsx qa/m7-compaction-scale.mts ../reports/M7-raw.json
 *
 * It writes the RAW series only. Interpretation belongs in a separate,
 * hand-written file, so re-running the harness can never clobber a conclusion
 * — the same shape as `m2-reconcile-scale.mts`.
 *
 * WHY THE NUMBER IS WANTED. The maintenance advisory lock makes the pass
 * EXCLUSIVE; it does not make it SHORT. A critical section is only safe if its
 * duration is known, and a daily job that holds an exclusive lock for an
 * unknown duration is not a schedulable job.
 *
 * THREE SEGMENTS, NOT ONE, and the split is not cosmetic. `runWorkspaceCompaction`
 * does exactly this, in this order:
 *
 *     fleet.release(key, 'compaction')     <- DETACH: listeners come off
 *     compactOverlay(..., mode: 'apply')   <- COMPACT: base shards rewritten
 *     fleet.ensure(key)                    <- REATTACH: the ro_* rows are rebuilt
 *
 * The read plane is detached for the SUM of the three, not for the middle one,
 * and the middle one is the only one anybody would have guessed at. Publishing
 * `compactMs` alone would understate the window by whatever the rebuild costs —
 * which at these scales is the dominant term.
 *
 * "COLD" IS ABOUT THE ro_* ROWS, NOT ABOUT THE DOCUMENTS. `ProjectorFleet.release` runs the projector's
 * stop closure and deletes it from `byKey`; whether the Automerge documents are
 * unloaded depends entirely on whether a residency registry is attached, because
 * the unload is `residency?.releaseOwner(...)` (projectorService.ts) ->
 * `evict` -> `repo.removeFromCache` (automergeResidency.ts, :362).
 * Production attaches one (index.ts) and this harness now does too, so
 * both segments pay the reload. `documentsEvictedDuringPass` is published rather
 * than asserted: the eviction is scheduled, not awaited, so what the fold
 * actually found in cache is a measurement, not a promise.
 *
 * WHAT ELSE IS INSIDE THE LOCK, and why `detachedWindowMs` is not the whole
 * answer. The maintenance coordinator checks a pooled client out
 * (coordinator.ts), takes the advisory lock, calls the task (:410) and only
 * releases in its outermost `finally` (:481). So the hold spans the ENTIRE call,
 * and `runWorkspaceCompaction` has two shipped shapes that add whole extra cold
 * builds to it before the window even opens: a pre-flight `ensure()` when the
 * workspace is not resident (workspaceCompaction.ts) and a release+ensure on
 * a projector-instance mismatch (:223). `totalCallMs` is therefore published
 * alongside the window, and one pass per scale is run deliberately NOT resident
 * so the pre-flight cost is a number rather than a footnote.
 *
 * THE OVERLAY IS HELD CONSTANT ACROSS SCALES, and that is the measurement.
 * `foldCollection` resolves EVERY base shard and indexes EVERY id in them
 * (`idToShard`, compaction.ts) before it can place a single overlay
 * entry, and when there are creations it enumerates every key a SECOND time for
 * `counts` (:311). The fixture therefore varies only the base — 50 edited ids +
 * 10 created ids at every scale — which isolates those terms instead of
 * confounding them with the overlay's own size. Note what that does NOT isolate:
 * `editedIds` is spread across the whole range, so the number of shards actually
 * `.change()`d also grows with scale (1 at 300, <=24 at 12 000, 50 at 200 000).
 *
 * THE PLACEMENT PATH NEEDS A SCALE THAT IS A MULTIPLE OF 512. At the three
 * mandated scales the last base shard has 212 / 288 / 192 free slots, so all ten
 * creations are absorbed by `compaction.ts` and the overflow loop at :323 —
 * the one that mints a shard and splices it into `objectShardUrls` — never runs
 * once. `PLACEMENT_SCALE`
 * is a supplementary, clearly-labelled sample at 512 objects where every base
 * shard is exactly full, so the path is exercised and its cost is on the record;
 * it is NOT one of the three published figures.
 *
 * THE CONTROL IS A SECOND PASS ON AN EMPTY OVERLAY. Growth across scales is the
 * first control and the obvious one, but by itself it cannot distinguish "the
 * fold costs this much" from "resolving the root and the meta costs this much
 * and grows for some other reason". So every scale runs the SAME pass a second
 * time, immediately, with the overlay now empty: `foldCollection` returns at
 * compaction.ts, before it resolves a single base shard and before either
 * `stillSafeToWrite` round trip. The assertion is NOT a fixed ratio, which
 * would have to be fitted to the data; it asserts instead that the fold/empty
 * RATIO GROWS with scale, which is what a constant-measuring instrument cannot
 * produce. See `CONTROL 2` at the foot of this file.
 *
 * RUN BY NO GATE, deliberately: this is a measurement, not a gate. `server/tsconfig.check.json`
 * covers `server/qa`, so a drifting signature is still a red `typecheck:all`.
 */
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import pg from 'pg'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../src/testing/isolatedSchema.js'
import { ensureReadModelSchema } from '../src/readModel/schema.js'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { createEmptyRoot } from '../src/automergeServer.js'
import { findReadyDocument } from '../src/automergeRepoCompat.js'
import { ProjectorFleet, awaitInitialDiagramProbe, type RootResolver } from '../src/readModel/projectorService.js'
import { AutomergeResidencyLeases } from '../src/automergeResidency.js'
import { envNumber } from '../src/envNumber.js'
// The cross-scale controls live in plain `.mjs` so `scripts/m7-controls.test.mjs`
// can pin them under `test:ci-diagnostics`. This harness is run by no gate, so
// without that suite nothing would check that its controls can still fail.
// One definition, imported here.
import {
  growsWithScale,
  foldToEmptyRatioGrows,
  segmentsPartitionTheCall,
} from '../../scripts/m7-controls.mjs'
import { readProjectionAcknowledgement } from '../src/readModel/compaction.js'
import { runWorkspaceCompaction, type WorkspaceCompactionDeps } from '../src/readModel/workspaceCompaction.js'
import type { WorkspaceKey } from '../src/readModel/projector.js'
import { openBootstrapScope } from '../src/bootstrapScope.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
if (!DATABASE_URL) {
  // Loud, not skipped. A measurement that quietly produced no numbers would be
  // indistinguishable from one that measured zero.
  throw new Error('M7 needs TEST_DATABASE_URL; refusing to report nothing')
}
const OUTPUT = process.argv[2]
if (!OUTPUT) throw new Error('usage: tsx qa/m7-compaction-scale.mts <output.json>')

/**
 * The published scales; not a knob.
 *
 * `M7_SMOKE=1` swaps in two small scales so the harness itself can be exercised
 * in a minute, and it is NOT an override of the published scales: a smoke run
 * runs every VOID rule and every control, then refuses to WRITE. A knob that
 * could quietly publish a 1 200-object number under the label 200 000 is the
 * measurement equivalent of a gate that reports success having done nothing.
 */
const SMOKE = process.env.M7_SMOKE === '1'
/**
 * Whether the fleet gets a residency registry, as production's does
 * (index.ts). DEFAULT ON, because that is the shipped configuration —
 * and it is a knob rather than a constant because the two settings measure
 * genuinely different things and one of them does not complete.
 *
 * WITH the registry, the projector's stop closure calls
 * `residency.releaseOwner(...)` (projectorService.ts), which evicts every
 * document whose last lease that was (automergeResidency.ts) via
 * `repo.removeFromCache` (:362). So the DETACH unloads the base shards and the
 * fold must read all of them back. Measured effect on `compactMs`: 58.0 -> 115.8
 * at 300 objects (x2.0), 130.8 -> 1126.5 at 12 000 (x8.6) — both means over two
 * runs, with residency off and on. At 200 000 the run does not finish at all:
 * it dies on an unhandled `AbortError` from a document query's 10 s deadline,
 * reproducibly (2/2 running alone, after 2/2 under contention), after pass 1's
 * re-attach has already succeeded. That is published as a finding, not worked
 * around. Its CAUSE is unproven: the unbatched `Promise.all` at
 * compaction.ts is consistent with everything observed but not demonstrated.
 *
 * WITHOUT it, every document stays in the repo cache across the detach, and the
 * three segments are a FLOOR: real, reproducible at all three mandated scales,
 * and understating whatever the reload costs. Rows carry `residencyAttached` so
 * the two can never be read as one series.
 */
const RESIDENCY = process.env.M7_RESIDENCY !== 'off'
/** The smoke pair is 1 base shard against 24, not 1 against 3: there is a
 *  ~44 ms floor (the flush and the two fresh overlay heads, each a PostgreSQL
 *  round trip), and at 3 shards the fold is entirely inside it, so the growth
 *  control would fail on NOISE. */
const SCALES = SMOKE ? [300, 12_000] : [300, 12_000, 200_000]
/** The client's VITE_MODEL_SHARD_SIZE default, which `compaction.ts` mirrors. */
const SHARD_SIZE = 512
/** Overlay entries whose id ALREADY lives in a base shard — the fold-in-place half. */
const OVERLAY_EDITS = 50
/** Overlay entries with no base shard — the placement half (mints a new shard). */
const OVERLAY_CREATES = 10
/** A small connection set, so the SECOND collection pass actually runs rather
 *  than early-returning on an empty overlay. Held constant across scales: the
 *  measurement parameterises by OBJECTS, and a connection base scaled
 *  alongside would make the two passes inseparable in the total. */
const CONNECTIONS = 200
const CONNECTION_EDITS = 5
/** How long the harness will wait for the projector to acknowledge before it
 *  declares the pre-state undefined and the run VOID. */
const ACK_DEADLINE_MS = 60_000

type ShardDoc = { objects?: Record<string, unknown>; connections?: Record<string, unknown> }
type MetaDoc = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls?: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls?: string[]
}
type RootDoc = { modelMetaUrl?: string }

const failures: string[] = []
function check(condition: boolean, label: string, detail: unknown): void {
  if (!condition) failures.push(`${label}: ${JSON.stringify(detail)}`)
}

const object = (id: string, revision: number) => ({
  id,
  name: `Object ${id} r${revision}`,
  type: 'component',
  description: `Synthetic M7 fixture entity, revision ${revision}`,
  technology: 'typescript',
})

/**
 * Build a workspace with `objectCount` objects spread over ceil(n/512) base
 * shards, plus an overlay holding a FIXED 50 edits + 10 creates.
 *
 * Uses the production `createEmptyRoot` and then splices base shards in FRONT of
 * the overlay write head, rather than authoring a ModelMeta by hand: the head
 * must stay LAST in its shard-url list (`withHeadLast`, and `forkRoot` remaps by
 * position), and a fixture that got that wrong would be measuring a workspace
 * shape the product cannot produce.
 */
async function buildFixture(repo: Repo, objectCount: number): Promise<{
  rootUrl: string
  editedIds: string[]
  createdIds: string[]
  connectionEditIds: string[]
}> {
  // The root graph is named for a target workspace (bootstrapMint.ts).
  // This fixture publishes no versions row, so the name is nominal here.
  const { rootUrl } = await createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-m7', versionId: 'V-m7' }, { kind: 'unfenced', reason: 'no-forker' }))
  const rootHandle = await findReadyDocument<RootDoc>(repo, rootUrl)
  const metaUrl = rootHandle.doc()?.modelMetaUrl
  if (!metaUrl) throw new Error('createEmptyRoot produced no modelMetaUrl')
  const metaHandle = await findReadyDocument<MetaDoc>(repo, metaUrl)

  const shardCount = Math.ceil(objectCount / SHARD_SIZE)
  const baseUrls: string[] = []
  const allIds: string[] = []
  for (let shard = 0; shard < shardCount; shard++) {
    const take = Math.min(SHARD_SIZE, objectCount - shard * SHARD_SIZE)
    const objects: Record<string, unknown> = {}
    for (let i = 0; i < take; i++) {
      const id = `o-${shard}-${i}`
      objects[id] = object(id, 1)
      allIds.push(id)
    }
    const handle = repo.create<ShardDoc>({ objects })
    await handle.whenReady()
    baseUrls.push(handle.url)
  }

  const connections: Record<string, unknown> = {}
  for (let i = 0; i < CONNECTIONS; i++) {
    const id = `c-${i}`
    connections[id] = {
      id,
      fromId: allIds[i % allIds.length],
      toId: allIds[(i + 1) % allIds.length],
      label: `edge ${i} r1`,
    }
  }
  const connectionShard = repo.create<ShardDoc>({ connections })
  await connectionShard.whenReady()

  // Base shards in front of the head, which stays last.
  metaHandle.change((m) => {
    m.objectShardUrls.unshift(...baseUrls)
    m.connectionShardUrls.unshift(connectionShard.url)
  })

  // The overlay: edits of ids that exist in a base shard (folded in place) and
  // creates that exist nowhere (placed). Every base shard is exactly full at
  // 512 except possibly the last, so the creates generally mint a new shard —
  // the placement path, including its claim + flush.
  const meta = metaHandle.doc()
  if (!meta) throw new Error('ModelMeta unreadable right after its own change')
  const editedIds = Array.from({ length: OVERLAY_EDITS }, (_, i) =>
    allIds[Math.floor((i * allIds.length) / OVERLAY_EDITS)]!)
  const createdIds = Array.from({ length: OVERLAY_CREATES }, (_, i) => `o-created-${i}`)
  const objectHead = await findReadyDocument<ShardDoc>(repo, meta.editsObjectShardUrl)
  objectHead.change((s) => {
    const coll = s.objects ?? (s.objects = {})
    for (const id of editedIds) coll[id] = object(id, 2)
    for (const id of createdIds) coll[id] = object(id, 1)
  })

  const connectionEditIds = Array.from({ length: CONNECTION_EDITS }, (_, i) => `c-${i}`)
  const connectionHead = await findReadyDocument<ShardDoc>(repo, meta.editsConnectionShardUrl)
  connectionHead.change((s) => {
    const coll = s.connections ?? (s.connections = {})
    for (const id of connectionEditIds) {
      coll[id] = {
        id,
        fromId: allIds[0],
        toId: allIds[1 % allIds.length],
        label: `edge ${id} r2`,
      }
    }
  })

  await repo.flush()
  return { rootUrl, editedIds, createdIds, connectionEditIds }
}

/**
 * Put a fresh overlay back on a workspace that has just been compacted, so a
 * later pass has real work to do. Writes into the CURRENT head — compaction
 * mints a new one and repoints ModelMeta at it, so the head this reads is not
 * the one the previous pass cleared.
 */
async function reseedOverlay(
  repo: Repo,
  rootUrl: string,
  editedIds: readonly string[],
  revision: number,
  createdPrefix: string,
): Promise<string[]> {
  const rootHandle = await findReadyDocument<RootDoc>(repo, rootUrl)
  const metaHandle = await findReadyDocument<MetaDoc>(repo, rootHandle.doc()!.modelMetaUrl!)
  const head = await findReadyDocument<ShardDoc>(repo, metaHandle.doc()!.editsObjectShardUrl)
  const created = Array.from({ length: OVERLAY_CREATES }, (_, i) => `${createdPrefix}${i}`)
  head.change((s) => {
    const coll = s.objects ?? (s.objects = {})
    for (const id of editedIds) coll[id] = object(id, revision)
    for (const id of created) coll[id] = object(id, 1)
  })
  const connHead = await findReadyDocument<ShardDoc>(repo, metaHandle.doc()!.editsConnectionShardUrl)
  connHead.change((s) => {
    const coll = s.connections ?? (s.connections = {})
    for (let i = 0; i < CONNECTION_EDITS; i++) {
      coll[`c-${i}`] = { id: `c-${i}`, fromId: 'o-0-0', toId: 'o-0-1', label: `edge c-${i} r${revision}` }
    }
  })
  await repo.flush()
  return created
}

/** Poll until this cell's own projector has acknowledged every observed
 *  generation. Bounded: an unacknowledged pre-state makes the pass refuse for a
 *  reason that has nothing to do with its duration, and a run that started from
 *  an undefined state is VOID, not slow. */
async function waitForAcknowledgement(
  db: pg.Pool,
  key: WorkspaceKey,
  residentInstanceId: () => string | null,
): Promise<{ ok: boolean; waitedMs: number }> {
  const started = performance.now()
  for (;;) {
    const ack = await readProjectionAcknowledgement(db, key)
    if (ack.acknowledged && ack.projectorInstanceId !== null && ack.projectorInstanceId === residentInstanceId()) {
      return { ok: true, waitedMs: performance.now() - started }
    }
    if (performance.now() - started > ACK_DEADLINE_MS) {
      return { ok: false, waitedMs: performance.now() - started }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

interface PassTimings {
  detachMs: number
  compactMs: number
  reattachMs: number
  detachedWindowMs: number
  /** What the maintenance lock and the pooled client are actually held for: the WHOLE
   *  call, not the window inside it. */
  totalCallMs: number
  /** The pre-flight cold build at workspaceCompaction.ts, when the pass
   *  enters on a workspace this cell has not got resident. Zero when it was. */
  preflightEnsureMs: number
  ensureCalls: number
  refreshReleases: number
  objectsFolded: number
  connectionsFolded: number
  objectsKept: number
  connectionsKept: number
  skippedReason: string | null
  reattach: string
}

/**
 * Run the REAL `runWorkspaceCompaction` once, timing its segments from the
 * outside by decorating the fleet it is handed.
 *
 * EVERY `ensure` IS RECORDED WITH ITS START INSTANT, not just the last one, and
 * the re-attach is then identified as the one that STARTED AFTER the
 * `release('compaction')`. A single overwritten `reattachMs` would be correct
 * only for the entry state where the workspace is already resident — the state
 * that produces exactly one `ensure`. `runWorkspaceCompaction` has two other
 * shipped shapes: it cold-builds
 * up front when the workspace is NOT resident (:192), and it does
 * release+ensure again on a projector-instance mismatch (:223). Both sit inside
 * the same held lock, and attributing either of them to the re-attach — or
 * letting them silently redefine `compactMs`'s left edge — is how a best-case
 * sample gets published as "the" duration.
 */
async function timedPass(
  key: WorkspaceKey,
  repo: Repo,
  rootUrl: string,
  db: pg.Pool,
  fleet: ProjectorFleet,
): Promise<PassTimings> {
  let detachMs = 0
  let detachEnd = 0
  let refreshReleases = 0
  const ensures: Array<{ startedAt: number; ms: number }> = []

  const decorated: WorkspaceCompactionDeps['fleet'] = {
    isResident: (k) => fleet.isResident(k),
    residentProjectorInstanceId: (k) => fleet.residentProjectorInstanceId(k),
    release: (k, reason) => {
      if (reason === 'compaction-instance-refresh') refreshReleases += 1
      const t0 = performance.now()
      fleet.release(k, reason)
      const elapsed = performance.now() - t0
      if (reason === 'compaction') {
        detachMs = elapsed
        detachEnd = performance.now()
      }
    },
    ensure: async (k) => {
      const startedAt = performance.now()
      const value = await fleet.ensure(k as WorkspaceKey)
      ensures.push({ startedAt, ms: performance.now() - startedAt })
      return value
    },
  }

  const deps: WorkspaceCompactionDeps = {
    repo,
    rootUrl,
    db,
    fleet: decorated,
    ownership: { owns: () => true },
    isShuttingDown: () => false,
    log: () => undefined,
    warn: (message) => console.warn(message),
  }

  const callStarted = performance.now()
  const outcome = await runWorkspaceCompaction(key, deps)
  const totalCallMs = performance.now() - callStarted

  const reattachEnsure = ensures.find((e) => e.startedAt >= detachEnd)
  const preflight = ensures.filter((e) => e.startedAt < detachEnd)
  const reattachMs = reattachEnsure?.ms ?? 0
  const compactMs = reattachEnsure ? reattachEnsure.startedAt - detachEnd : 0
  return {
    detachMs: Number(detachMs.toFixed(1)),
    compactMs: Number(compactMs.toFixed(1)),
    reattachMs: Number(reattachMs.toFixed(1)),
    detachedWindowMs: Number((detachMs + compactMs + reattachMs).toFixed(1)),
    totalCallMs: Number(totalCallMs.toFixed(1)),
    preflightEnsureMs: Number(preflight.reduce((sum, e) => sum + e.ms, 0).toFixed(1)),
    ensureCalls: ensures.length,
    refreshReleases,
    objectsFolded: outcome.result.objectsFolded,
    connectionsFolded: outcome.result.connectionsFolded,
    objectsKept: outcome.result.objectsKept,
    connectionsKept: outcome.result.connectionsKept,
    skippedReason: outcome.result.skippedReason ?? null,
    reattach: outcome.reattach,
  }
}

async function measure(objectCount: number, run: number): Promise<Record<string, unknown>> {
  const label = `${objectCount}-${run}`
  // pg_trgm must be resolvable as `public.gin_trgm_ops` BEFORE the schema-pinned
  // pool opens: `ensureReadModelSchema` issues `CREATE EXTENSION IF NOT EXISTS
  // pg_trgm` with no SCHEMA clause, so under a search_path of only the test
  // schema it lands there — and every index DDL in that file names
  // `public.gin_trgm_ops` explicitly.
  const bootstrap = new pg.Pool({ connectionString: DATABASE_URL, max: 1 })
  try {
    await bootstrap.query('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public')
  } finally {
    await bootstrap.end().catch(() => undefined)
  }

  let db: IsolatedSchemaDb | null = null
  let repo: Repo | null = null
  let fleet: ProjectorFleet | null = null
  let residency: AutomergeResidencyLeases | null = null
  // Hoisted so the `finally` can quiesce THIS workspace's in-flight work before
  // it drops the schema out from under it.
  const key: WorkspaceKey = { landscapeId: `m7-${objectCount}`, versionId: `run-${run}` }
  try {
    // BOUNDED RETRY on the schema setup, and it is a real transient rather than
    // defensive padding. `createIsolatedSchemaDb` opens with
    // `DROP SCHEMA IF EXISTS … CASCADE`, which needs AccessExclusiveLock on every
    // relation it removes. A previous scale's process has exited by then, but its
    // PostgreSQL backends can still be finishing an INSERT for a moment
    // afterwards, and the two block each other: measured as
    // `40P01 deadlock detected`, with the report naming exactly that pair
    // (AccessExclusiveLock waiting on a holder of RowExclusiveLock, and back).
    // Retrying the SETUP is safe in a way retrying a measurement would not be —
    // nothing has been timed yet.
    db = await (async () => {
      const schemaName = `m7_compaction_${objectCount}_${run}`
      for (let attempt = 1; ; attempt++) {
        try {
          return await createIsolatedSchemaDb(DATABASE_URL!, schemaName)
        } catch (error) {
          const code = (error as { code?: string }).code
          const transient = code === '40P01' || code === '55P03' || code === '40001'
          if (!transient || attempt >= 5) throw error
          console.warn(`[m7] schema setup for ${schemaName} hit ${code}; retry ${attempt}/4`)
          await new Promise((resolve) => setTimeout(resolve, 750 * attempt))
        }
      }
    })()
    await ensureReadModelSchema(db.pool)
    // Minimal shapes of the tables the storage adapter and the claim path touch
    // outside the read model (no FKs — this harness owns every row it reads; the
    // real DDL is in db.ts / syncCells/ownership.ts). Mirrors the setup in
    // promoteSummaryWorkspace.integration.test.ts.
    await db.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      parent_version_id TEXT, kind TEXT DEFAULT 'version', status TEXT DEFAULT 'active',
      base_manifest JSONB,
      PRIMARY KEY (landscape_id, id))`)
    await db.pool.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    // `resolveOrgId` reads this on EVERY cold build. Without it the lookup
    // raises 42P01, is caught, and logs — a thrown exception and a console
    // round trip inside the segment being timed. The
    // table is left EMPTY on purpose: an absent row is the same answer
    // (`org_id: null`) that a workspace RBAC has not backfilled gives, and it is
    // reached the way production reaches it rather than through a catch block.
    await db.pool.query(`CREATE TABLE IF NOT EXISTS scopes (
      kind TEXT NOT NULL, landscape_id TEXT, version_id TEXT, org_id TEXT)`)

    // `network: []` — with an adapter attached and no peer connected,
    // `repo.find()` never settles for a missing document, which is the honest
    // behaviour for a server that has just bound its port.
    repo = new Repo({
      storage: new PostgresStorageAdapter({ db: db.pool }),
      network: [],
      saveDebounceRate: 0,
    })

    const buildStarted = performance.now()
    const fixture = await buildFixture(repo, objectCount)
    const buildMs = performance.now() - buildStarted

    await db.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [key.landscapeId, key.versionId, fixture.rootUrl],
    )
    const resolveRoot: RootResolver = async (landscapeId, versionId, fallback) =>
      (landscapeId === key.landscapeId && versionId === key.versionId ? fixture.rootUrl : fallback)
    // `residency` IS PASSED (when RESIDENCY is on), because production passes it
    // (index.ts) and leaving it out changes what is being measured,
    // not merely how precisely. The projector's stop closure calls
    // `residency.releaseOwner(residencyOwner)` (projectorService.ts); for
    // every document whose last lease that was, `releaseOwner` calls `evict`
    // (automergeResidency.ts), which is `repo.removeFromCache`
    // (:362) — guarded only by `hasActivePeers` (:336), and the daily job runs
    // at 00:00 with no peer attached. So in production the DETACH itself
    // unloads the shards, and `compactOverlay` then has to re-read up to 391
    // documents from PostgreSQL in batches of 3
    // (batchedResolve.ts). A harness without the registry measures a
    // compaction whose shards are all still in cache — a floor, published as if
    // it were the figure.
    residency = RESIDENCY ? new AutomergeResidencyLeases(repo) : null
    fleet = new ProjectorFleet(repo, resolveRoot, {
      fallbackRootUrl: fixture.rootUrl,
      db: db.pool,
      maxProjectors: 2,
      ...(residency ? { residency } : {}),
    })

    // The FIRST cold build. Reported for context, not as `reattachMs`, and the
    // reason is NOT the document cache: `coldBuildReadModel` issues its DELETEs before reinserting
    // (projector.ts), so the first one deletes nothing and the second
    // deletes every row of the workspace. Both run against the same repo; only
    // this one runs against a repo that has never been detached from.
    const firstColdStarted = performance.now()
    await fleet.ensure(key)
    const initialColdBuildMs = performance.now() - firstColdStarted

    const ackBefore = await waitForAcknowledgement(db.pool, key, () => fleet!.residentProjectorInstanceId(key))
    check(ackBefore.ok, `${label}.acknowledgedBeforePass1`, ackBefore)

    const rowsBefore = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2',
      [key.landscapeId, key.versionId],
    )
    check(
      Number(rowsBefore.rows[0]!.n) === objectCount + OVERLAY_CREATES,
      `${label}.readModelHoldsEveryObjectBeforeTheFold`,
      { saw: Number(rowsBefore.rows[0]!.n), expected: objectCount + OVERLAY_CREATES },
    )

    // THE OVERLAY SEGMENTS THAT EXIST *BEFORE* THE PASS. Captured here, because
    // reading the pointer afterwards proves nothing: a successful pass MINTS a
    // fresh head and repoints ModelMeta at it (compaction.ts), so the
    // document `editsObjectShardUrl` names after the pass is born empty. A rule
    // that read the after-pointer would pass even with the real overlay left
    // fully populated.
    const metaBefore = await findReadyDocument<MetaDoc>(
      repo,
      (await findReadyDocument<RootDoc>(repo, fixture.rootUrl)).doc()!.modelMetaUrl!,
    )
    const overlayUrlsBefore = [...new Set([
      ...(metaBefore.doc()!.editsObjectShardUrls ?? []),
      metaBefore.doc()!.editsObjectShardUrl,
    ])]
    const instanceBefore = fleet.residentProjectorInstanceId(key)
    const evictedBefore = residency ? (await residency.snapshot()).evictedDocuments : 0
    const pass1 = await timedPass(key, repo, fixture.rootUrl, db.pool, fleet)
    const instanceAfter = fleet.residentProjectorInstanceId(key)
    const documentsEvictedDuringPass = residency
      ? (await residency.snapshot()).evictedDocuments - evictedBefore
      : 0

    // ---- VOID rules. Each one is a way for the three numbers above to be small
    // for a reason that has nothing to do with speed.
    check(pass1.skippedReason === null, `${label}.pass1DidNotSkip`, pass1.skippedReason)
    check(pass1.reattach === 'reattached', `${label}.pass1Reattached`, pass1.reattach)
    check(pass1.ensureCalls === 1, `${label}.exactlyOneReattachEnsure`, pass1.ensureCalls)
    check(pass1.refreshReleases === 0, `${label}.noInstanceRefreshInflatedTheGap`, pass1.refreshReleases)
    // THREE RULES ABOUT THE SEGMENTS THEMSELVES, each catching a silent
    // timing error.
    //
    // (i) `reattachMs > 0`. Dropping ONE `await` inside the decorator leaves
    //     `runWorkspaceCompaction` correctly awaiting — the outer promise unwraps
    //     the inner — so nothing breaks, but `reattachMs` reads 0 and
    //     `detachedWindowMs` reads 107 ms where the truth is 2 184 ms — a
    //     twenty-fold understatement of the quantity being measured. The same rule also catches an `ensure()` that short-circuited on
    //     a projector that was never removed from `byKey`.
    check(pass1.reattachMs > 0, `${label}.reattachWasActuallyTimed`, pass1.reattachMs)
    // (ii) The two segments cannot be swapped in silence: exchanging the
    //      assignments would publish a synchronous listener detach as 2.1 s and
    //      a cold rebuild of 12 010 objects as 0.4 ms.
    check(pass1.detachMs < pass1.reattachMs, `${label}.detachIsCheaperThanTheRebuild`, pass1)
    // (iii) The three segments must PARTITION the call. Computing `compactMs`
    //       from `performance.now()` instead of the re-attach's start instant
    //       yields a window longer than the call itself. `totalCallMs` is
    //       measured around
    //       the same call, so the containment is checkable in one line.
    check(
      segmentsPartitionTheCall(pass1.detachedWindowMs, pass1.totalCallMs),
      `${label}.segmentsPartitionTheCall`,
      { window: pass1.detachedWindowMs, call: pass1.totalCallMs },
    )
    // THE RE-ATTACH ACTUALLY REBUILT. Nothing above witnesses that: `release`
    // KEEPS the ro_* rows by contract (projectorService.ts), so a row
    // count is identical whether a rebuild ran or not, `reattach: 'reattached'`
    // only says nothing threw, and `ensureCalls` only says the call happened.
    // `start()` mints a fresh randomUUID per cold build (projectorService.ts),
    // so a CHANGED instance id is the thing that could not have happened without
    // one — and `null` catches an `ensure()` that attached nothing yet reports
    // `'reattached'`.
    check(
      instanceAfter !== null && instanceAfter !== instanceBefore,
      `${label}.reattachStartedANewProjectorInstance`,
      { before: instanceBefore, after: instanceAfter },
    )
    check(
      pass1.objectsFolded === OVERLAY_EDITS + OVERLAY_CREATES,
      `${label}.foldedEveryOverlayObject`,
      { saw: pass1.objectsFolded, expected: OVERLAY_EDITS + OVERLAY_CREATES },
    )
    check(
      pass1.connectionsFolded === CONNECTION_EDITS,
      `${label}.foldedEveryOverlayConnection`,
      { saw: pass1.connectionsFolded, expected: CONNECTION_EDITS },
    )
    check(pass1.objectsKept === 0 && pass1.connectionsKept === 0, `${label}.nothingConcurrentlyEdited`, pass1)

    // The overlay must actually be EMPTY afterwards — the destructive half is
    // the one the duration is being measured for. Read on the segments captured
    // BEFORE the pass, never on the pointer after it.
    const metaAfter = await findReadyDocument<MetaDoc>(
      repo,
      (await findReadyDocument<RootDoc>(repo, fixture.rootUrl)).doc()!.modelMetaUrl!,
    )
    const residueBySegment: Record<string, number> = {}
    for (const url of overlayUrlsBefore) {
      const segment = await findReadyDocument<ShardDoc>(repo, url)
      residueBySegment[url] = Object.keys(segment.doc()?.objects ?? {}).length
    }
    check(
      Object.values(residueBySegment).every((n) => n === 0),
      `${label}.everyPreExistingOverlaySegmentWasCleared`,
      residueBySegment,
    )

    const rowsAfter = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2',
      [key.landscapeId, key.versionId],
    )
    check(
      Number(rowsAfter.rows[0]!.n) === objectCount + OVERLAY_CREATES,
      `${label}.readModelRebuiltEveryObject`,
      { saw: Number(rowsAfter.rows[0]!.n), expected: objectCount + OVERLAY_CREATES },
    )
    // NOT a witness that anything was rebuilt — `release` keeps the rows, and
    // this value was ALREADY r2 before the pass, because the overlay is read
    // last-wins by the cold build that ran before it. What it refutes is a LOSS:
    // a clear that dropped the edit would read back r1. The rebuild witness is
    // `reattachStartedANewProjectorInstance` above.
    const edited = await db.pool.query<{ name: string }>(
      'SELECT name FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
      [key.landscapeId, key.versionId, fixture.editedIds[0]],
    )
    check(
      edited.rows[0]?.name === `Object ${fixture.editedIds[0]} r2`,
      `${label}.foldedValueSurvivedTheClear`,
      edited.rows[0]?.name ?? null,
    )
    // THE FOLD LANDED IN A BASE SHARD, read out of Automerge rather than out of
    // SQL. `objectsFolded` counts OVERLAY ids and cannot tell a fold-in-place
    // (compaction.ts) from a re-classification to `created` and a
    // placement (:310-322) — and the re-classification is silently reachable,
    // since `idToShard` fills from `h.doc()?.[collKey] ?? {}` (:257), so a handle
    // whose `doc()` is undefined contributes nothing and throws nothing. Every
    // SQL-side check would still pass.
    const shardUrlsAfter = metaAfter.doc()!.objectShardUrls
    const foldedHome = await (async () => {
      for (const url of shardUrlsAfter) {
        const shard = await findReadyDocument<ShardDoc>(repo!, url)
        const entry = shard.doc()?.objects?.[fixture.editedIds[0]!] as { name?: string } | undefined
        if (entry) return { url, name: entry.name }
      }
      return null
    })()
    check(
      foldedHome?.name === `Object ${fixture.editedIds[0]} r2`,
      `${label}.editWasFoldedIntoABaseShard`,
      foldedHome,
    )

    // ---- THE CONTROL. The same pass, immediately, on an overlay that is now
    // empty: `foldCollection` returns at compaction.ts, before it resolves a
    // single base shard. The `<` check below is weak on its own (at 300 objects
    // a 46.9 ms empty pass satisfies it while demonstrating nothing); the real
    // control is the cross-scale ratio — see CONTROL 2 at the foot of this file.
    const ackBefore2 = await waitForAcknowledgement(db.pool, key, () => fleet!.residentProjectorInstanceId(key))
    check(ackBefore2.ok, `${label}.acknowledgedBeforePass2`, ackBefore2)
    const pass2 = await timedPass(key, repo, fixture.rootUrl, db.pool, fleet)
    check(pass2.skippedReason === null, `${label}.pass2DidNotSkip`, pass2.skippedReason)
    check(
      pass2.objectsFolded === 0 && pass2.connectionsFolded === 0,
      `${label}.pass2FoldedNothing`,
      pass2,
    )
    check(
      pass2.compactMs < pass1.compactMs,
      `${label}.emptyOverlayPassIsCheaper`,
      { fold: pass1.compactMs, empty: pass2.compactMs },
    )
    // The same VOID rules as pass 1, because pass 2 publishes two numbers of its
    // own. Without them, an `ensure()` that threw would leave `reattachMs` at 0 —
    // the decorator assigns after the await — and 0 would be published as
    // `emptyPassReattachMs`.
    check(pass2.reattach === 'reattached', `${label}.pass2Reattached`, pass2.reattach)
    check(pass2.ensureCalls === 1, `${label}.pass2ExactlyOneReattachEnsure`, pass2.ensureCalls)
    check(pass2.refreshReleases === 0, `${label}.pass2NoInstanceRefresh`, pass2.refreshReleases)
    check(fleet.isResident(key), `${label}.residentAfterPass2`, null)

    // ---- PASS 3 — WHAT THE LOCK ACTUALLY HOLDS, worst realistic case: a fresh
    // overlay to fold AND a workspace this cell does not have resident, so the
    // pre-flight `ensure()` at workspaceCompaction.ts fires INSIDE the same
    // held advisory lock and the same checked-out pool client. `detachedWindowMs`
    // cannot see that segment by construction; `totalCallMs` is what the
    // coordinator holds (coordinator.ts -> :481).
    await reseedOverlay(repo, fixture.rootUrl, fixture.editedIds, 3, 'o-created2-')
    const ackBefore3 = await waitForAcknowledgement(db.pool, key, () => fleet!.residentProjectorInstanceId(key))
    check(ackBefore3.ok, `${label}.acknowledgedBeforePass3`, ackBefore3)
    fleet.release(key, 'm7-cold-entry')
    check(!fleet.isResident(key), `${label}.pass3EntersNotResident`, null)
    const pass3 = await timedPass(key, repo, fixture.rootUrl, db.pool, fleet)
    check(pass3.skippedReason === null, `${label}.pass3DidNotSkip`, pass3.skippedReason)
    check(pass3.reattach === 'reattached', `${label}.pass3Reattached`, pass3.reattach)
    check(pass3.ensureCalls === 2, `${label}.pass3PaidAPreflightColdBuild`, pass3.ensureCalls)
    check(pass3.preflightEnsureMs > 0, `${label}.pass3PreflightWasTimed`, pass3.preflightEnsureMs)
    check(
      pass3.objectsFolded === OVERLAY_EDITS + OVERLAY_CREATES,
      `${label}.pass3FoldedTheReseededOverlay`,
      { saw: pass3.objectsFolded, expected: OVERLAY_EDITS + OVERLAY_CREATES },
    )
    check(
      pass3.totalCallMs > pass3.detachedWindowMs,
      `${label}.lockHoldExceedsTheDetachedWindow`,
      { total: pass3.totalCallMs, window: pass3.detachedWindowMs },
    )

    return {
      objects: objectCount,
      run,
      baseShards: Math.ceil(objectCount / SHARD_SIZE),
      buildMs: Number(buildMs.toFixed(1)),
      initialColdBuildMs: Number(initialColdBuildMs.toFixed(1)),
      compactMs: pass1.compactMs,
      detachMs: pass1.detachMs,
      reattachMs: pass1.reattachMs,
      detachedWindowMs: pass1.detachedWindowMs,
      totalCallMs: pass1.totalCallMs,
      emptyPassCompactMs: pass2.compactMs,
      emptyPassReattachMs: pass2.reattachMs,
      emptyPassTotalCallMs: pass2.totalCallMs,
      coldEntryPreflightMs: pass3.preflightEnsureMs,
      coldEntryCompactMs: pass3.compactMs,
      coldEntryDetachedWindowMs: pass3.detachedWindowMs,
      coldEntryTotalCallMs: pass3.totalCallMs,
      // Every row says which of the two configurations produced it. Two series
      // that differ by a factor of eight must never be readable as one.
      residencyAttached: RESIDENCY,
      documentsEvictedDuringPass,
      heapUsedMbBeforePass1: Math.round(process.memoryUsage().heapUsed / 1_048_576),
      // ceil(n/512) base + 1 head, then +1 for the rotated head pass 1 mints,
      // and +1 MORE only if the overflow loop (compaction.ts) ran. This is
      // how the supplementary placement scale proves it exercised a path the
      // three mandated scales cannot reach.
      objectShardUrlsAfterPass1: shardUrlsAfter.length,
      overflowShardMinted: shardUrlsAfter.length > Math.ceil(objectCount / SHARD_SIZE) + 2,
      objectsFolded: pass1.objectsFolded,
      connectionsFolded: pass1.connectionsFolded,
      readModelRows: Number(rowsAfter.rows[0]!.n),
      ackWaitBeforePass1Ms: Number(ackBefore.waitedMs.toFixed(1)),
      ackWaitBeforePass2Ms: Number(ackBefore2.waitedMs.toFixed(1)),
    }
  } finally {
    // Walk every await between acquire and release, applied to the harness
    // itself. `stopAll()` iterates
    // `entry.stop()`, which runs listener cleanups; unprotected, one throw there
    // would skip BOTH lines below, leaving a `max: 5` pool open and a schema
    // holding 200 000 ro_objects rows undropped — so the NEXT scale would measure
    // the pressure this one left. And a teardown failure is RECORDED, not
    // swallowed: `.catch(() => undefined)` on a schema drop is a silent failure.
    try { fleet?.stopAll() } catch (error) { failures.push(`${label}.stopAllThrew: ${String(error)}`) }
    // QUIESCE BEFORE DROPPING THE SCHEMA. `stopAll()` detaches listeners and
    // clears intervals; it does NOT cancel work already in flight — an in-flight
    // projection is an explicit contract (projectorService.ts), the
    // initial diagram probe is deliberately NOT awaited by `ensure()`
    // (:2708), and the residency evictions are tracked, not awaited. Without
    // this: `relation "read_model_projection_state" does not exist` from a
    // projector still writing into a dropped schema, or a PostgreSQL DEADLOCK
    // (40P01) between that INSERT's RowExclusiveLock and the next scale's DDL
    // AccessExclusiveLock. Both seams are exported for exactly this.
    await awaitInitialDiagramProbe(key).catch(() => undefined)
    await residency?.drain().catch((error) => { failures.push(`${label}.residencyDrainThrew: ${String(error)}`) })
    await repo?.shutdown().catch((error) => { failures.push(`${label}.repoShutdownThrew: ${String(error)}`) })
    await db?.teardown().catch((error) => { failures.push(`${label}.teardownThrew: ${String(error)}`) })
  }
}

/** Two runs: one sample per scale supports no variance
 *  statement at all, and a figure quoted without one invites being read as
 *  precise. Runs go scale-by-scale WITHIN a run, so a systematic drift across
 *  the session shows up as a difference between runs rather than hiding inside
 *  one scale's pair. */
const RUNS = envNumber('M7_RUNS', { fallback: SMOKE ? 1 : 2, minimum: 1, maximum: 20, integer: true })

/**
 * A SUPPLEMENTARY scale, not one of the three published figures.
 *
 * 512 is an exact multiple of SHARD_SIZE, so every base shard is full, `room`
 * is 0 at compaction.ts for all of them, and the ten creations fall through
 * to the overflow loop at :323 — `createClaimedDocument` for a fresh shard and
 * the splice into `objectShardUrls` BEFORE the overlay. At 300 / 12 000 /
 * 200 000 the last shard has 212 / 288 / 192 free slots, so that loop does not
 * execute once, and a header claiming the placement path was measured would be
 * false. It is cheap (one shard), so the coverage costs seconds.
 */
const PLACEMENT_SCALE = 512

/**
 * ONE PROCESS PER SCALE, and it is not tidiness.
 *
 * TWO reasons, one of measurement quality and one of correctness, and the second
 * is why this exists rather than being a nice-to-have.
 *
 * (1) QUALITY. All scales in one process share a heap. `repo.shutdown()`
 *     dereferences a Repo but forces no GC, so 12 000 objects' worth of garbage
 *     is still there when 200 000 builds, and an old-generation pause landing
 *     inside `compactOverlay` is counted as `compactMs`. A fresh process is the
 *     only thing that actually removes it.
 *
 * (2) CORRECTNESS. `stopAll()` detaches listeners
 *     and clears intervals but does NOT cancel work already in flight — an
 *     in-flight projection is an explicit contract (projectorService.ts)
 *     and the initial diagram probe is deliberately unawaited (:2708). Dropping
 *     the isolated schema under that leftover produces missing-relation errors
 *     and PostgreSQL DEADLOCKs (40P01) against the next scale's DDL. Awaiting
 *     the two exported seams (`awaitInitialDiagramProbe`, `residency.drain()`)
 *     removes most of it but not a late document load. A process
 *     boundary removes the class: the leftovers die with the process, and the
 *     schema is reclaimed by the next run's `DROP SCHEMA IF EXISTS`.
 *
 * The child is this same file with `M7_SCALES` set — no second script to drift
 * out of step with this one. The parent runs no measurement at all, so nothing
 * it does can land in a timed segment.
 */
const CHILD_SCALES = process.env.M7_SCALES
const results: Array<Record<string, unknown>> = []
let placement: Record<string, unknown>

if (CHILD_SCALES) {
  // CHILD. Measure exactly what was asked for and hand back rows + failures;
  // the cross-scale controls belong to the parent, which alone sees every row.
  // `envNumber`, not `Number(...)`: a dangling `M7_RUN=` parses to 0, and every
  // row of that child would then be labelled `run: 0` — a run index no
  // cross-scale control looks for, so the controls would silently evaluate
  // against nothing (see the `local/no-bare-env-number` lint rule).
  const run = envNumber('M7_RUN', { fallback: 1, minimum: 1, maximum: 20, integer: true })
  for (const scale of CHILD_SCALES.split(',').map((s) => Number(s.trim()))) {
    const row = await measure(scale, run)
    results.push(row)
    console.log(`M7 run${run} ${scale}: ${JSON.stringify(row)}`)
  }
  writeFileSync(OUTPUT, `${JSON.stringify({ rows: results, failures })}\n`, 'utf8')
  // A short settle before the hard exit. `process.exit` does not wait for
  // sockets to close, and a backend that is still finishing a statement holds
  // its row locks until PostgreSQL notices the client is gone — which is one
  // half of the deadlock the setup retry above catches. This makes that retry
  // rare rather than routine; it is not a substitute for it.
  await new Promise((resolve) => setTimeout(resolve, 250))
  process.exit(0)
}

// PARENT.
//
// EXCLUSIVITY FIRST, and it is not hygiene — it is the correctness of every
// number below.
//
// `createIsolatedSchemaDb` derives a FIXED schema name per suite, deliberately:
// its docstring says a crashed run then "leaves at most one stale schema,
// self-healed by the next run's DROP … CASCADE". M7 derives that name from
// `m7_compaction_${objects}_${run}`, which is identical for every runner. So a
// SECOND M7 process opens by executing `DROP SCHEMA IF EXISTS
// test_m7_compaction_12000_1 CASCADE` on the FIRST one's live schema. The victim
// does not get a named refusal; it gets an opaque `3F000 no schema has been
// selected to create in` at some later statement, which reads as flakiness — and
// the survivor's numbers are quietly taken from a half-deleted read model.
//
// The fixed-name convention is safe only under an exclusion, so here it is: a
// session advisory lock on a constant key, taken by the parent and held for the
// whole run, that REFUSES LOUDLY rather than letting two runs interleave.
const M7_LOCK = [2026, 7] as const
const { default: pgForLock } = await import('pg')
const lockClient = new pgForLock.Client({ connectionString: DATABASE_URL })
await lockClient.connect()
const lockHeld = await lockClient.query<{ locked: boolean }>(
  'SELECT pg_try_advisory_lock($1, $2) AS locked', [M7_LOCK[0], M7_LOCK[1]],
)
if (lockHeld.rows[0]?.locked !== true) {
  await lockClient.end().catch(() => undefined)
  throw new Error(
    'M7 REFUSES: another M7 run holds the advisory lock on this database. Two runs share the same '
    + 'isolated-schema names, so the second one\'s setup DROPs the first one\'s live schema. Wait for '
    + 'it, or point TEST_DATABASE_URL at a different database.',
  )
}

const { spawnSync } = await import('node:child_process')
const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')
const scratch = mkdtempSync(join(tmpdir(), 'm7-'))
const childRows: Array<Record<string, unknown>> = []

const runChild = (scale: number, run: number): Record<string, unknown> | null => {
  const out = join(scratch, `m7-${scale}-${run}.json`)
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, process.argv[1]!, out],
    {
      env: { ...process.env, M7_SCALES: String(scale), M7_RUN: String(run) },
      stdio: ['ignore', 'inherit', 'inherit'],
      encoding: 'utf8',
    },
  )
  if (result.status !== 0) {
    // A child that DIED wrote nothing. Naming that as a failure is the whole
    // point: a parent that skipped a crashed scale would publish two figures
    // under a header promising three.
    failures.push(`scale ${scale} run ${run}: child exited ${result.status} (signal ${String(result.signal)})`)
    return null
  }
  const parsed = JSON.parse(readFileSync(out, 'utf8')) as {
    rows: Array<Record<string, unknown>>
    failures: string[]
  }
  failures.push(...parsed.failures)
  return parsed.rows[0] ?? null
}

try {
  for (let run = 1; run <= RUNS; run++) {
    for (const scale of SCALES) {
      const row = runChild(scale, run)
      if (row) childRows.push(row)
    }
  }
  const placementRow = runChild(PLACEMENT_SCALE, 1)
  if (!placementRow) throw new Error('M7 VOID: the supplementary placement scale produced no row')
  placement = placementRow

  // NO LEAKED SCHEMA, and this witness is a two-for-one. It catches a `teardown()`
  // that silently did nothing, AND it catches a concurrent
  // runner, because a schema this process did not create is exactly what the
  // advisory lock above exists to make impossible. Read on the lock client, whose
  // search_path is the default, so the names are unqualified on purpose.
  const leaked = await lockClient.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'test\\_m7\\_compaction\\_%' ORDER BY nspname`,
  )
  check(
    leaked.rows.length === 0,
    'noLeakedIsolatedSchemas',
    leaked.rows.map((r) => r.nspname),
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
  // Ends the session, which drops the advisory lock with it — the one thing that
  // certainly releases it, and the reason a Client is used here rather than a
  // pooled connection (`client.release()` does NOT end the session).
  await lockClient.end().catch(() => undefined)
}
results.push(...childRows)

/** `null` for a scale whose child died — the caller records that as a failed
 *  control rather than throwing a TypeError that would read as a crash. */
const rowAt = (objects: number, run: number) =>
  (results.find((row) => row.objects === objects && row.run === run) ?? null) as
    { compactMs: number; emptyPassCompactMs: number } | null

// CONTROL 1. An instrument that returned the same number at 300 and at 200 000
// would be measuring itself rather than the fold. Asserted for EVERY run, not
// for an average: an average can be dragged into growth by a single outlier.
for (let run = 1; run <= RUNS; run++) {
  const small = rowAt(SCALES[0]!, run)
  const large = rowAt(SCALES[SCALES.length - 1]!, run)
  check(
    growsWithScale(small?.compactMs ?? null, large?.compactMs ?? null),
    `run${run}.compactionGrowsWithScale`,
    { smallest: small?.compactMs ?? null, largest: large?.compactMs ?? null },
  )
}

// CONTROL 2 — THE EMPTY-OVERLAY DISCRIMINATOR.
//
// The per-scale form is only `empty < fold`, which is weak on its own, and a
// fixed ratio would have to be fitted to the observation it is supposed to
// test. The cross-scale form is stronger and scale-free. The failure this control
// exists to exclude is "`compactMs` is a constant that does not depend on the
// fold". Against that hypothesis the fold/empty RATIO would be FLAT across
// scales, whatever its value. So the assertion is that the ratio itself GROWS:
// the empty pass reloads the root, the meta and the overlay segments after the
// detach evicted them, and that cost is the same at every scale, while the fold
// additionally reloads and indexes every base shard. Measured, in the warm-cache
// variant, of the order of 200 at 300 objects against of the order of 1 200 at
// 200 000 — order of magnitude only, because the denominator is two to three
// tenths of a millisecond and rounding alone moves the ratio by fifty percent.
const ratioAt = (objects: number, run: number) => {
  const row = rowAt(objects, run)
  return row ? row.compactMs / Math.max(row.emptyPassCompactMs, 0.01) : null
}
for (let run = 1; run <= RUNS; run++) {
  const small = ratioAt(SCALES[0]!, run)
  const large = ratioAt(SCALES[SCALES.length - 1]!, run)
  check(
    foldToEmptyRatioGrows(small, large),
    `run${run}.foldToEmptyRatioGrowsWithScale`,
    { small, large },
  )
}

// CONTROL 3, a PAIR, because either half alone is satisfiable by an instrument
// that cannot tell the two cases apart: the supplementary scale must have minted
// an overflow shard, and every published scale must NOT have. That is what makes
// "the placement path is not in the three figures" a measurement rather than an
// inference from arithmetic.
check(placement.overflowShardMinted === true, 'placementScaleMintedAnOverflowShard', placement)
for (const row of results) {
  check(
    row.overflowShardMinted === false,
    `published-${row.objects}-${row.run}.didNOTreachThePlacementPath`,
    { shardUrls: row.objectShardUrlsAfterPass1, baseShards: row.baseShards },
  )
}

if (failures.length) {
  // Refuse to publish rather than emit a number whose meaning is unknown.
  throw new Error(`M7 VOID — ${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`)
}

if (SMOKE) {
  console.log('M7 SMOKE: every VOID rule and both controls passed at the reduced scales; NOT publishing.')
  process.exit(0)
}

writeFileSync(OUTPUT, `${JSON.stringify({
  measureId: 'M7',
  task: 'T-M7',
  takenOn: new Date().toISOString().slice(0, 10),
  harness: 'server/qa/m7-compaction-scale.mts',
  fixture: {
    shardSize: SHARD_SIZE,
    overlayEdits: OVERLAY_EDITS,
    overlayCreates: OVERLAY_CREATES,
    connections: CONNECTIONS,
    connectionEdits: CONNECTION_EDITS,
  },
  samples: results.length,
  runs: RUNS,
  residencyAttached: RESIDENCY,
  scales: results,
  /** NOT one of the three mandated figures — see `PLACEMENT_SCALE`. */
  supplementaryPlacementScale: placement,
}, null, 2)}\n`, 'utf8')
console.log(`M7 written to ${OUTPUT}`)
