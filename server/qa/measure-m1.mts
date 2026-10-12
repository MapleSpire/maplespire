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
 * M1 — the ADMISSION BARRIER, per workspace, p50 and p99.
 *
 *   cd server
 *   TEST_DATABASE_URL=postgres://... TEST_REDIS_URL=redis://... \
 *     npx tsx qa/measure-m1.mts ../reports/M1-raw.json
 *
 * Raw series only. Interpretation belongs in a separate, hand-written file, so
 * re-running can never clobber a conclusion — the shape `m2-reconcile-scale.mts`
 * uses.
 *
 * WHAT "THE ADMISSION BARRIER" IS, precisely. `onOwnershipAcquired`'s own
 * docstring: "Acquisition listeners form an admission barrier: the durable
 * lease exists, but owns()/ready stays false until process-local state is
 * refreshed." So the barrier for ONE workspace is the interval that
 * `acquireMissing` already times from `startedAt` — the Postgres fence read,
 * `ensureMinimumToken`, `acquireForPartition`, `persistLease`, the SERIAL
 * listener notification — and ends at `sync.cell.workspace_admitted`.
 *
 * THE INSTRUMENTATION ALREADY EXISTS. `elapsedMs` appears FOUR times in
 * `src/syncCells/ownership.ts`, but one of them is `slowestStatementMs`
 * accumulation inside `timedQueryable`'s callback, not a log line. THREE log
 * lines carry it:
 *
 *   sync.cell.workspace_fence_persisted   admission path
 *   sync.cell.workspace_admitted          admission path
 *   sync.cell.workspace_lease_recovered   partition-WORKER recovery
 *
 * A fourth admission line, `sync.cell.workspace_admission_started`, carries no
 * `elapsedMs` at all — it is the start marker. This harness counts all four
 * events and publishes the counts.
 *
 * AND THEY DO NOT ADD UP. The notification awaits its listeners serially
 * before the admission is logged — `notifyOwnershipAcquired` is a bare
 * `for (const listener of ...) await listener(event)`. But the consequence is
 * NESTING, not a missing term: `fence_persisted` and `admitted` are two reads
 * of the SAME `startedAt`, so `admitted ⊇ fence_persisted` and their difference
 * IS the serial listener time. Adding them would double-count the whole
 * acquisition. This harness publishes the difference as `listenerGapMs` and
 * makes the slow-listener control move exactly that term.
 *
 * TWO INSTRUMENTS ON THE SAME INTERVAL, deliberately. The coordinator's clock
 * is `Date.now` (constructor default), so its `elapsedMs` is quantised to whole
 * milliseconds — at a per-workspace cost of single-digit ms that is a real
 * error bar. So the harness ALSO brackets each workspace with `performance.now()`
 * taken as the `admission_started` and `admitted` lines are written. If the two
 * instruments disagree by more than quantisation, one of them is wrong and the
 * headline is not to be trusted. Both are published.
 *
 * The report goes to a FILE named on the command line: the subject writes ~3
 * lines per workspace to stdout and at 3 000 workspaces a redirect buries the
 * report under ~9 000 lines of subject.
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createClient } from 'redis'
import { createIsolatedSchemaDb } from '../src/testing/isolatedSchema.js'
import type { RedisRuntime } from '../src/runtime/redis.js'
import {
  SyncCellOwnershipCoordinator,
  ensureSyncCellOwnershipSchema,
  type SyncCellOwnershipConfig,
} from '../src/syncCells/ownership.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
const REDIS_URL = process.env.TEST_REDIS_URL
if (!DATABASE_URL || !REDIS_URL) {
  // Loud, not skipped. A measurement that quietly produced no numbers would be
  // indistinguishable from one that measured zero — and zero is VOID here.
  throw new Error('M1 needs TEST_DATABASE_URL and TEST_REDIS_URL; refusing to report nothing')
}

/** Workspaces admitted in the two baseline arms. 3 000 gives a p99 standing on
 *  30 observations rather than on one; a p99 over a handful of samples can
 *  wobble by 2x (49 -> 92 ms has been seen on five). */
const BASELINE_N = 3_000
/** The control arm is smaller only because each admission there costs an extra
 *  CONTROL_LISTENER_MS on purpose. */
const CONTROL_N = 800
/** Long enough to dwarf both the quantisation of `Date.now` and the natural
 *  spread of the baseline, so a p99 that did not move cannot be called noise. */
const CONTROL_LISTENER_MS = 25

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!
}
const round = (value: number): number => Number(value.toFixed(2))
const summarise = (values: number[]) => ({
  samples: values.length,
  p50: values.length ? round(percentile(values, 0.5)) : null,
  p90: values.length ? round(percentile(values, 0.9)) : null,
  p99: values.length ? round(percentile(values, 0.99)) : null,
  min: values.length ? round(Math.min(...values)) : null,
  max: values.length ? round(Math.max(...values)) : null,
  mean: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null,
})

interface Capture {
  /** `sync.cell.workspace_admitted.elapsedMs`, the barrier as the SUBJECT times it. */
  admittedElapsedMs: number[]
  /** `sync.cell.workspace_fence_persisted.elapsedMs` — the same `startedAt`, read
   *  BEFORE the serial listener notification. */
  fencePersistedElapsedMs: number[]
  /** admitted - fence_persisted, per workspace: the serial listener term. */
  listenerGapMs: number[]
  /** The same interval bracketed by the HARNESS with performance.now(), so the
   *  subject's whole-millisecond clock is not the only witness. */
  harnessBarrierMs: number[]
  counts: Record<string, number>
}

/** Intercepts the coordinator's own log lines. It replaces `console.log` and
 *  `console.warn` for the duration of one arm; anything that is not a
 *  `sync.cell.workspace_*` JSON line is passed through untouched, so a real
 *  error from the subject still reaches the terminal. */
function installCapture(): { capture: Capture; restore: () => void } {
  const capture: Capture = {
    admittedElapsedMs: [],
    fencePersistedElapsedMs: [],
    listenerGapMs: [],
    harnessBarrierMs: [],
    counts: {},
  }
  const startedAt = new Map<string, number>()
  const persisted = new Map<string, number>()
  const realLog = console.log
  const realWarn = console.warn

  const handle = (args: unknown[], passthrough: (...a: unknown[]) => void): void => {
    const first = args[0]
    if (typeof first !== 'string' || !first.startsWith('{"event":"sync.cell.workspace_')) {
      passthrough(...args)
      return
    }
    let line: Record<string, unknown>
    try {
      line = JSON.parse(first) as Record<string, unknown>
    } catch {
      passthrough(...args)
      return
    }
    const event = String(line.event)
    capture.counts[event] = (capture.counts[event] ?? 0) + 1
    const key = `${String(line.landscapeId)}/${String(line.versionId)}`
    const at = performance.now()
    if (event === 'sync.cell.workspace_admission_started') startedAt.set(key, at)
    else if (event === 'sync.cell.workspace_fence_persisted') {
      persisted.set(key, Number(line.elapsedMs))
      capture.fencePersistedElapsedMs.push(Number(line.elapsedMs))
    } else if (event === 'sync.cell.workspace_admitted') {
      const elapsed = Number(line.elapsedMs)
      capture.admittedElapsedMs.push(elapsed)
      const before = persisted.get(key)
      if (before !== undefined) capture.listenerGapMs.push(elapsed - before)
      const opened = startedAt.get(key)
      if (opened !== undefined) capture.harnessBarrierMs.push(at - opened)
      startedAt.delete(key)
      persisted.delete(key)
    }
  }

  console.log = (...args: unknown[]) => handle(args, realLog)
  console.warn = (...args: unknown[]) => handle(args, realWarn)
  return {
    capture,
    restore: () => {
      console.log = realLog
      console.warn = realWarn
    },
  }
}

interface ArmResult {
  arm: string
  workspaces: number
  listenerSleepMs: number
  coldStartMs: number
  admitted: ReturnType<typeof summarise>
  fencePersisted: ReturnType<typeof summarise>
  listenerGap: ReturnType<typeof summarise>
  harnessBracket: ReturnType<typeof summarise>
  eventCounts: Record<string, number>
  warmPassAdmissions: number
  acquisitionCount: number
  slowestStatementMs: number
}

/**
 * One token per PROCESS, carried into the SCHEMA NAME.
 *
 * The arm suffixes are fixed (`a` / `b` / `ctl`) and `createIsolatedSchemaDb`
 * opens with `DROP SCHEMA IF EXISTS … CASCADE`, so without this two concurrent
 * runs on the shared CI database drop each other's schemas mid-flight — and
 * measurements here are fanned out across agents sharing one Postgres.
 * `teardown()` still drops it, so nothing accumulates.
 */
const RUN_TOKEN = randomBytes(4).toString('hex')

async function runArm(
  arm: string,
  schemaSuffix: string,
  workspaces: number,
  listenerSleepMs: number,
): Promise<ArmResult> {
  const db = await createIsolatedSchemaDb(DATABASE_URL!, `sync_cell_m1_${schemaSuffix}_${RUN_TOKEN}`)
  const prefix = `m1-${randomBytes(6).toString('hex')}`
  const client = createClient({ url: REDIS_URL })
  await client.connect()
  const runtime = {
    configured: true,
    get ready() { return client.isReady },
    prefix,
    send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime

  try {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        kind TEXT NOT NULL DEFAULT 'version'
      );
    `)
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', ['m1', 'm1'])
    // One statement, not N: the seed is not the subject.
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, status, kind)
       SELECT 'v' || i, 'm1', 'v' || i, 'automerge:root-' || i, 'active', 'version'
         FROM generate_series(1, $1) AS i`,
      [workspaces],
    )

    const config: SyncCellOwnershipConfig = {
      enabled: true,
      cellId: `m1-cell-${schemaSuffix}`,
      advertiseUrl: 'http://m1.internal:3001',
      leaseTtlMs: 600_000,
      renewIntervalMs: 300_000,
      partitionLeaseTtlMs: 60_000,
      partitionRenewIntervalMs: 20_000,
      partitionProbeIntervalMs: 60_000,
      partitionWorker: false,
      // An hour, so no scheduled pass lands inside a measured one and gets
      // attributed to it.
      reconcileIntervalMs: 3_600_000,
      telemetryIntervalMs: 3_600_000,
      reconcilePassDeadlineMs: 600_000,
      concurrency: 16,
      admissionConcurrency: 4,
      partitionCount: 1,
      topologyGeneration: `m1-${schemaSuffix}`,
    } as SyncCellOwnershipConfig

    const coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime, config)
    if (listenerSleepMs > 0) {
      // THE CONTROL. Registered through the SHIPPED seam, not a patched method:
      // if the barrier does not actually await this, p99 will not move and the
      // instrument will have failed its own witness.
      coordinator.onOwnershipAcquired(async () => {
        await new Promise((resolve) => setTimeout(resolve, listenerSleepMs))
      })
    }

    const { capture, restore } = installCapture()
    let coldStartMs = 0
    let warmPassAdmissions = 0
    let acquisitionCount = 0
    let slowestStatementMs = 0
    try {
      const coldStarted = performance.now()
      await coordinator.start()
      coldStartMs = performance.now() - coldStarted

      const snapshot = coordinator.snapshot()
      // VOID rules, asserted rather than assumed. An arm that discovered nothing
      // would report a very fast barrier for entirely the wrong reason.
      if (snapshot.expectedWorkspaceCount !== workspaces) {
        throw new Error(`VOID ${arm}: expectedWorkspaceCount=${snapshot.expectedWorkspaceCount}`)
      }
      if (snapshot.ownedWorkspaceCount !== workspaces) {
        throw new Error(`VOID ${arm}: ownedWorkspaceCount=${snapshot.ownedWorkspaceCount}`)
      }
      if (snapshot.fenceDivergencesSeen !== 0) {
        throw new Error(`VOID ${arm}: fenceDivergencesSeen=${snapshot.fenceDivergencesSeen}`)
      }
      acquisitionCount = snapshot.acquisitionCount

      // SECOND CONTROL, in the same arm: a warm pass admits nothing, so the
      // instrument must return ZERO samples here, not a small number.
      const beforeWarm = capture.admittedElapsedMs.length
      await coordinator.reconcileNow()
      warmPassAdmissions = capture.admittedElapsedMs.length - beforeWarm
      slowestStatementMs = coordinator.snapshot().slowestStatementMs
    } finally {
      restore()
      await coordinator.stop()
    }

    if (capture.admittedElapsedMs.length !== workspaces) {
      throw new Error(
        `VOID ${arm}: captured ${capture.admittedElapsedMs.length} admissions for ${workspaces} workspaces`
        + ' — the log interception missed lines, so no percentile here is trustworthy',
      )
    }

    return {
      arm,
      workspaces,
      listenerSleepMs,
      coldStartMs: round(coldStartMs),
      admitted: summarise(capture.admittedElapsedMs),
      fencePersisted: summarise(capture.fencePersistedElapsedMs),
      listenerGap: summarise(capture.listenerGapMs),
      harnessBracket: summarise(capture.harnessBarrierMs),
      eventCounts: capture.counts,
      warmPassAdmissions,
      acquisitionCount,
      slowestStatementMs,
    }
  } finally {
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 500 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    for (let offset = 0; offset < keys.length; offset += 500) {
      await client.sendCommand(['DEL', ...keys.slice(offset, offset + 500)])
    }
    await client.close()
    await db.teardown()
  }
}

/**
 * The OTHER profile, and the reason there are two. The three arms above admit
 * thousands of workspaces at once, four at a time, with the pool saturated for
 * the whole run — that is the COLD-START barrier, the one a deploy pays. It is
 * not the barrier a single new version pays when it appears in a cell that is
 * already up and idle, and quoting the first as if it were the second would
 * overstate the steady-state cost.
 *
 * So: one workspace at a time. Insert a version, drive one `reconcileNow()`,
 * record the single admission it produces, repeat.
 */
async function runSoloArm(iterations: number): Promise<ArmResult> {
  const db = await createIsolatedSchemaDb(DATABASE_URL!, `sync_cell_m1_solo_${RUN_TOKEN}`)
  const prefix = `m1-${randomBytes(6).toString('hex')}`
  const client = createClient({ url: REDIS_URL })
  await client.connect()
  const runtime = {
    configured: true,
    get ready() { return client.isReady },
    prefix,
    send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime

  try {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        kind TEXT NOT NULL DEFAULT 'version'
      );
    `)
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', ['m1', 'm1'])
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, status, kind)
       VALUES ('v0', 'm1', 'v0', 'automerge:root-0', 'active', 'version')`,
    )

    const config: SyncCellOwnershipConfig = {
      enabled: true,
      cellId: 'm1-cell-solo',
      advertiseUrl: 'http://m1.internal:3001',
      leaseTtlMs: 600_000,
      renewIntervalMs: 300_000,
      partitionLeaseTtlMs: 60_000,
      partitionRenewIntervalMs: 20_000,
      partitionProbeIntervalMs: 60_000,
      partitionWorker: false,
      reconcileIntervalMs: 3_600_000,
      telemetryIntervalMs: 3_600_000,
      reconcilePassDeadlineMs: 600_000,
      concurrency: 16,
      admissionConcurrency: 4,
      partitionCount: 1,
      topologyGeneration: 'm1-solo',
    } as SyncCellOwnershipConfig

    const coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime, config)
    const { capture, restore } = installCapture()
    let coldStartMs = 0
    let warmPassAdmissions = 0
    let acquisitionCount = 0
    let slowestStatementMs = 0
    let soloFrom = 0
    try {
      const coldStarted = performance.now()
      await coordinator.start()
      coldStartMs = performance.now() - coldStarted
      if (capture.admittedElapsedMs.length !== 1) {
        throw new Error(`VOID solo: start() admitted ${capture.admittedElapsedMs.length}, expected 1`)
      }
      // The seeding admission is measured and DISCARDED: it pays the cold pool,
      // the first plan compilation and the partition acquisition.
      soloFrom = 1

      for (let i = 1; i <= iterations; i += 1) {
        await db.pool.query(
          `INSERT INTO versions (id, landscape_id, label, root_url, status, kind)
           VALUES ($1, 'm1', $1, 'automerge:root-' || $1, 'active', 'version')`,
          [`v${i}`],
        )
        const before = capture.admittedElapsedMs.length
        await coordinator.reconcileNow()
        const admitted = capture.admittedElapsedMs.length - before
        if (admitted !== 1) {
          throw new Error(`VOID solo: iteration ${i} admitted ${admitted} workspace(s), expected exactly 1`)
        }
      }

      const snapshot = coordinator.snapshot()
      if (snapshot.ownedWorkspaceCount !== iterations + 1) {
        throw new Error(`VOID solo: ownedWorkspaceCount=${snapshot.ownedWorkspaceCount}`)
      }
      if (snapshot.fenceDivergencesSeen !== 0) {
        throw new Error(`VOID solo: fenceDivergencesSeen=${snapshot.fenceDivergencesSeen}`)
      }
      acquisitionCount = snapshot.acquisitionCount

      const beforeWarm = capture.admittedElapsedMs.length
      await coordinator.reconcileNow()
      warmPassAdmissions = capture.admittedElapsedMs.length - beforeWarm
      slowestStatementMs = coordinator.snapshot().slowestStatementMs
    } finally {
      restore()
      await coordinator.stop()
    }

    return {
      arm: 'solo-admission',
      workspaces: iterations,
      listenerSleepMs: 0,
      coldStartMs: round(coldStartMs),
      admitted: summarise(capture.admittedElapsedMs.slice(soloFrom)),
      fencePersisted: summarise(capture.fencePersistedElapsedMs.slice(soloFrom)),
      listenerGap: summarise(capture.listenerGapMs.slice(soloFrom)),
      harnessBracket: summarise(capture.harnessBarrierMs.slice(soloFrom)),
      eventCounts: capture.counts,
      warmPassAdmissions,
      acquisitionCount,
      slowestStatementMs,
    }
  } finally {
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 500 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    for (let offset = 0; offset < keys.length; offset += 500) {
      await client.sendCommand(['DEL', ...keys.slice(offset, offset + 500)])
    }
    await client.close()
    await db.teardown()
  }
}

/** Solo admissions, each in its own reconcile pass. */
const SOLO_N = 300

// SERIALLY. Two coordinators racing the same Redis and the same Postgres would
// measure the contention rather than the barrier.
const baselineA = await runArm('baseline-a', 'a', BASELINE_N, 0)
const baselineB = await runArm('baseline-b', 'b', BASELINE_N, 0)
const control = await runArm('control-slow-listener', 'ctl', CONTROL_N, CONTROL_LISTENER_MS)
const solo = await runSoloArm(SOLO_N)

const arms = [baselineA, baselineB, control, solo]

// ---------------------------------------------------------------------------
// The controls, ASSERTED. The harness refuses to publish rather than hand over
// a number whose instrument was never shown capable of a different answer.
// ---------------------------------------------------------------------------

// (1) ZERO ADMISSIONS MUST YIELD ZERO SAMPLES, in every arm. A warm reconcile
// pass acquires nothing; an instrument that manufactured a percentile there
// would be manufacturing one everywhere.
for (const arm of arms) {
  if (arm.warmPassAdmissions !== 0) {
    throw new Error(`VOID: warm pass in ${arm.arm} admitted ${arm.warmPassAdmissions} workspace(s)`)
  }
}

// (2) A SLOWER ADMISSION MUST MOVE THE NUMBER, by about the amount injected —
// and it must move `admitted` while leaving `fence_persisted` where it was,
// because the listener is awaited BETWEEN those two log lines. A single
// assertion on p99 alone would pass for an instrument that merely got noisier.
const baseAdmittedP99 = Math.max(baselineA.admitted.p99!, baselineB.admitted.p99!)
const basePersistedP50 = Math.max(baselineA.fencePersisted.p50!, baselineB.fencePersisted.p50!)
if (!(control.admitted.p99! > baseAdmittedP99 + CONTROL_LISTENER_MS / 2)) {
  throw new Error(
    `VOID: a ${CONTROL_LISTENER_MS} ms acquisition listener did not move admitted p99`
    + ` (${baseAdmittedP99} -> ${control.admitted.p99})`,
  )
}
if (!(control.fencePersisted.p50! <= basePersistedP50 + CONTROL_LISTENER_MS / 2)) {
  throw new Error(
    `VOID: the listener moved fence_persisted p50 too (${basePersistedP50} -> ${control.fencePersisted.p50}),`
    + ' so it is not landing where the code says it lands',
  )
}

// (3) THE TWO INSTRUMENTS MUST AGREE — AT EVERY PUBLISHED STATISTIC, not only
// at p50. The subject times with `Date.now` (whole milliseconds); the harness
// brackets the same interval with `performance.now()`. A disagreement beyond a
// couple of milliseconds means one of them is measuring something else.
//
// p99 AND max are checked here because p50 alone leaves the headline
// undefended: an instrument that replaced every subject reading below 28 ms
// with the constant 6 (leaving the ~30 ms control arm untouched) would publish
// a FABRICATED p99 with a matching p50, which control (2) cannot catch either
// (it constrains only the slow-listener arm).
//
// The tolerance is the SAME 3 ms as p50, and that is measured rather than
// picked: across the four arms of the recorded run the two instruments differ by
// 0.31 / 0.01 / 0.30 / 0.19 ms at p99 and 0.16 / 0.30 / 0.21 / 0.04 ms at max.
// Three milliseconds is roughly ten times the observed drift, while the
// fabrication above misses by 13-16 ms.
const STATISTICS = ['p50', 'p99', 'max'] as const
for (const arm of arms) {
  for (const statistic of STATISTICS) {
    const subject = arm.admitted[statistic]
    const bracket = arm.harnessBracket[statistic]
    if (subject === null || bracket === null || subject === undefined || bracket === undefined) {
      throw new Error(`VOID: ${arm.arm} — ${statistic} is missing from one of the two instruments`)
    }
    if (Math.abs(bracket - subject) > 3) {
      throw new Error(
        `VOID: ${arm.arm} — subject ${statistic} ${subject} ms vs harness bracket ${statistic}`
        + ` ${bracket} ms; the two instruments disagree`,
      )
    }
  }
}

const OUTPUT = process.argv[2]
if (!OUTPUT) throw new Error('usage: tsx qa/measure-m1.mts <output.json>')
writeFileSync(OUTPUT, `${JSON.stringify({
  measureId: 'M1',
  task: 'T-M1',
  takenOn: new Date().toISOString().slice(0, 10),
  harness: 'server/qa/measure-m1.mts',
  baselineWorkspaces: BASELINE_N,
  controlWorkspaces: CONTROL_N,
  controlListenerMs: CONTROL_LISTENER_MS,
  soloIterations: SOLO_N,
  admissionConcurrency: 4,
  arms,
}, null, 2)}\n`, 'utf8')
console.log(`M1 raw written to ${OUTPUT}`)
console.log(JSON.stringify({
  baselineA: { admittedP50: baselineA.admitted.p50, admittedP99: baselineA.admitted.p99 },
  baselineB: { admittedP50: baselineB.admitted.p50, admittedP99: baselineB.admitted.p99 },
  control: { admittedP50: control.admitted.p50, admittedP99: control.admitted.p99 },
  solo: { admittedP50: solo.admitted.p50, admittedP99: solo.admitted.p99 },
}))
