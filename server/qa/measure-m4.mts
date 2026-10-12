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
 * pg_notify latency, loss rate and reconnect count across a connection
 * loss.
 *
 *   cd server
 *   TEST_DATABASE_URL=postgres://... npx tsx qa/measure-m4.mts ../reports/M4-raw.json
 *
 * WHAT IS UNDER MEASUREMENT, and it is the shipped thing rather than a model of
 * it. The emitter is the REAL trigger DDL (`ensureSyncCellOwnershipSchema` in
 * syncCells/ownership.ts) fired by the REAL writer (`invalidateWorkspaceCoverage`
 * in rbac/claimCoverage.ts). The listener is the REAL
 * `startWorkspaceCacheInvalidation` (rbac/workspaceCacheInvalidation.ts), with
 * its own reconnect cadence, its own `client.release(err)` on failure and its
 * own single-flight guard. Nothing here re-implements the subject: a hand-rolled
 * LISTEN client would have measured the harness's reconnect policy, not the
 * server's, and the reconnect policy is the entire answer.
 *
 * THREE ARMS, and the first exists only to make the other two mean something.
 *
 *   control ....... fast cadence, NO kill. Must report 0 lost and 0 reconnects.
 *   fast .......... fast cadence (1 s), one kill. Bounded gap.
 *   production .... the SHIPPED cadence (60 s), one kill. The real gap.
 *
 * The control is not a formality. The loss counter here is `emitted - received`,
 * which is exactly the shape that reports a large number when the listener never
 * worked at all, when the payload parse is wrong, when the drain is too short,
 * or when the sequence encoding drifts. An arm reporting 95 % loss and an arm
 * reporting 0 % loss with the SAME counters, the SAME drain and the SAME parse
 * is the only thing separating "the gap loses notifications" from "the
 * instrument cannot see notifications". The control also pins the RECONNECT
 * counter at zero while its retry interval fires every second — so the non-zero
 * reconnect counts are the kill, not the timer.
 *
 * IDENTIFYING THE BACKEND TO KILL. Each arm's listener pool carries a unique
 * `application_name` (`m4-<runToken>-<arm>`), and it is the ONLY pool that ever
 * uses it, so `pg_stat_activity` names exactly one pid. The harness ASSERTS the
 * count is exactly one before it terminates anything: this database is shared
 * with other agents and a wrong pid is someone else's measurement destroyed.
 *
 * ISOLATION, and one leak that cannot be closed. Tables live in a per-run
 * isolated schema, but `pg_notify` channels are per-DATABASE (isolatedSchema.ts
 * documents the same leak for `bump_auth_epoch`). Every landscape id here
 * carries the run token, and the handler DISCARDS any payload not carrying it,
 * counting it as foreign — so a sibling suite's notification can neither be
 * counted as ours nor hide one of ours.
 *
 * THE DRAIN. A loss measurement whose drain is too short reports loss that is
 * really latency. The drain here ends on QUIET — three
 * seconds with no arrival — not on a fixed sleep, and `drainEndedBy` is
 * published so a reader can see the ceiling was not the binding constraint.
 *
 * The report goes to a FILE named on the command line, not stdout: the listener
 * under measurement writes `console.warn` on every connection loss.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../src/testing/isolatedSchema.js'
import { ensureSyncCellOwnershipSchema } from '../src/syncCells/ownership.js'
import { invalidateWorkspaceCoverage } from '../src/rbac/claimCoverage.js'
import {
  startWorkspaceCacheInvalidation,
  WORKSPACE_CACHE_INVALIDATION_RECONNECT_MS,
} from '../src/rbac/workspaceCacheInvalidation.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
if (!DATABASE_URL) {
  // Loud, not skipped. A measurement that quietly produced no numbers would be
  // indistinguishable from one that measured zero.
  throw new Error('M4 needs TEST_DATABASE_URL; refusing to report nothing')
}
const OUT = process.argv[2]
if (!OUT) throw new Error('usage: npx tsx qa/measure-m4.mts <raw-report-path>')
const LOG = `${OUT}.log`

const RUN_TOKEN = randomBytes(4).toString('hex')

// appendFileSync, never console.log: this file is a harness rather than a source
// module, but the trace is the thing that survives a crashed run, and stdout is
// already carrying the subject's own warnings.
const trace = (line: string): void => {
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
}

// An unhandled 'error' from a terminated backend kills the process (the exact
// failure poolErrorGuard.ts exists for). If one gets past the guards, it must
// be VISIBLE and attributable rather than looking like a hang.
process.on('uncaughtException', (err) => {
  trace(`FATAL uncaughtException ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  trace(`FATAL unhandledRejection ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!
}
const round = (n: number): number => Math.round(n * 1000) / 1000
const stats = (values: number[]): Record<string, number> => ({
  n: values.length,
  min: values.length ? round(Math.min(...values)) : Number.NaN,
  p50: round(percentile(values, 0.5)),
  p95: round(percentile(values, 0.95)),
  p99: round(percentile(values, 0.99)),
  max: values.length ? round(Math.max(...values)) : Number.NaN,
  mean: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : Number.NaN,
})

interface ArmSpec {
  name: string
  /** Passed to the listener. `undefined` = the SHIPPED default (60 s). */
  reconnectMs: number | undefined
  emits: number
  emitIntervalMs: number
  /** Emit index after which the listener's backend is terminated. null = control. */
  killAfterEmit: number | null
}

const ARMS: ArmSpec[] = [
  { name: 'control-no-kill', reconnectMs: 1_000, emits: 300, emitIntervalMs: 20, killAfterEmit: null },
  { name: 'kill-fast-cadence', reconnectMs: 1_000, emits: 300, emitIntervalMs: 20, killAfterEmit: 60 },
  // The shipped cadence. 300 emits x 300 ms = 90 s of wall clock, which has to
  // be longer than the 60 s retry interval or the arm would report "everything
  // after the kill was lost" and never observe the recovery.
  { name: 'kill-production-cadence', reconnectMs: undefined, emits: 300, emitIntervalMs: 300, killAfterEmit: 10 },
]

/** Pings used only to establish that LISTEN is live; never counted as samples. */
const PING_BUDGET = 60
const DRAIN_QUIET_MS = 3_000
const DRAIN_CEILING_MS = 25_000

async function runArm(db: IsolatedSchemaDb, spec: ArmSpec): Promise<Record<string, unknown>> {
  const landscapeId = `L-m4-${RUN_TOKEN}-${spec.name}`
  const appName = `m4-${RUN_TOKEN}-${spec.name}`.slice(0, 63)
  const vid = (seq: number): string => `V-m4-${RUN_TOKEN}-${spec.name}-${seq}`
  const pingVid = (k: number): string => `V-m4-${RUN_TOKEN}-${spec.name}-ping-${k}`

  trace(`[${spec.name}] begin appName=${appName}`)

  // ---- seed: every version row pre-created, so the measured window fires the
  // COVERAGE trigger exactly once per emit and nothing else.
  await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1)', [landscapeId])
  await db.pool.query(
    `INSERT INTO versions (id, landscape_id, label, root_url)
     SELECT $1 || g::text, $2, 'M4', 'automerge:m4'
     FROM generate_series(0, $3::int) g`,
    [`V-m4-${RUN_TOKEN}-${spec.name}-`, landscapeId, spec.emits - 1],
  )
  await db.pool.query(
    `INSERT INTO versions (id, landscape_id, label, root_url)
     SELECT $1 || g::text, $2, 'M4', 'automerge:m4'
     FROM generate_series(0, $3::int) g`,
    [`V-m4-${RUN_TOKEN}-${spec.name}-ping-`, landscapeId, PING_BUDGET - 1],
  )

  // ---- clients
  const listenerPool = guardIdleClientErrors(
    new pg.Pool({
      connectionString: DATABASE_URL!,
      max: 5,
      // ONE socket option mirrors production, and only that one. Production's
      // `databasePoolConfig` (src/dbConfig.ts) sets max 10 /
      // idleTimeoutMillis 30_000 / connectionTimeoutMillis 10_000; this pool is
      // max 5 on node-postgres defaults — it does NOT mirror the whole config.
      //
      // REASONED, not measured: none of the three differences can move a gap
      // governed by a 60 s `setInterval` — the reconnect itself completes in
      // ~70 ms, and the LISTEN client is checked out, so it is never idle.
      //
      // `keepAlive` is the option that mirrors, and it changes nothing here in
      // either direction: `pg_terminate_backend` delivers an explicit 57P01
      // immediately, so nothing is left for a keepalive probe to find — and
      // node-postgres leaves `keepAliveInitialDelayMillis` at the OS default
      // (hours), so `keepAlive: true` does not detect a dead peer on any useful
      // timescale.
      // The case it would matter for — a socket that dies SILENTLY — is not
      // measured here by either configuration.
      keepAlive: true,
      application_name: appName,
      options: `-c search_path=${db.schema}`,
    }),
    `m4:listener:${spec.name}`,
    (event, fields) => trace(`[${spec.name}] ${event} ${JSON.stringify(fields)}`),
  )
  const killer = new pg.Client({ connectionString: DATABASE_URL!, connectionTimeoutMillis: 5_000 })
  killer.on('error', (e) => trace(`[${spec.name}] killer client error: ${e.message}`))
  await killer.connect()
  const watcher = new pg.Client({ connectionString: DATABASE_URL!, connectionTimeoutMillis: 5_000 })
  watcher.on('error', (e) => trace(`[${spec.name}] watcher client error: ${e.message}`))
  await watcher.connect()

  // ---- counters
  const arrivals = new Map<number, number>() // seq -> performance.now() of the handler
  const pingArrivals: number[] = []
  let foreignCoverage = 0
  let foreignVersion = 0
  let malformed = 0
  let lastArrivalAt = performance.now()

  const onCoverageChanged = (key: { landscapeId: string; versionId: string }): void => {
    const at = performance.now()
    if (key.landscapeId !== landscapeId) {
      foreignCoverage += 1
      return
    }
    lastArrivalAt = at
    const prefix = `V-m4-${RUN_TOKEN}-${spec.name}-`
    if (!key.versionId.startsWith(prefix)) {
      malformed += 1
      return
    }
    const tail = key.versionId.slice(prefix.length)
    if (tail.startsWith('ping-')) {
      pingArrivals.push(at)
      return
    }
    const seq = Number(tail)
    if (!Number.isInteger(seq)) {
      malformed += 1
      return
    }
    if (!arrivals.has(seq)) arrivals.set(seq, at) // first delivery wins
  }
  const onVersionCreated = (id: string): void => {
    if (id !== landscapeId) foreignVersion += 1
  }

  // ---- backend-pid watch: the reconnect counter, measured from the SERVER's
  // view rather than from anything the listener reports about itself.
  const seenPids = new Set<number>()
  const pidEvents: Array<{ atMs: number; pids: number[] }> = []
  let watching = true
  let lastPidSignature = ''
  const t0Arm = performance.now()
  const pollPids = async (): Promise<void> => {
    while (watching) {
      try {
        const { rows } = await watcher.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()`,
          [appName],
        )
        const pids = rows.map((r) => Number(r.pid)).sort((a, b) => a - b)
        for (const p of pids) seenPids.add(p)
        const sig = pids.join(',')
        if (sig !== lastPidSignature) {
          lastPidSignature = sig
          pidEvents.push({ atMs: round(performance.now() - t0Arm), pids })
        }
      } catch (e) {
        trace(`[${spec.name}] pid poll failed: ${(e as Error).message}`)
      }
      await sleep(150)
    }
  }
  const watchDone = pollPids()

  const listenerStartedAt = performance.now()
  const handle = startWorkspaceCacheInvalidation(
    listenerPool,
    { onCoverageChanged, onVersionCreated },
    spec.reconnectMs === undefined ? {} : { reconnectMs: spec.reconnectMs },
  )

  const emitStart: number[] = []
  const emitEnd: number[] = []
  let established = false
  let pingsUsed = 0
  let killInfo: Record<string, unknown> | null = null

  try {
    // ---- establish. pg offers no readiness signal worth trusting; ping with
    // real invalidations until one comes back. Each ping is a legitimate
    // durable write, so this proves delivery instead of assuming it.
    for (let k = 0; k < PING_BUDGET && !established; k += 1) {
      pingsUsed = k + 1
      await invalidateWorkspaceCoverage(db.pool, { landscapeId, versionId: pingVid(k) }, 'm4 establish ping')
      for (let w = 0; w < 10 && pingArrivals.length === 0; w += 1) await sleep(20)
      established = pingArrivals.length > 0
    }
    if (!established) throw new Error(`[${spec.name}] LISTEN never established after ${PING_BUDGET} pings`)
    trace(`[${spec.name}] established after ${pingsUsed} pings, ${round(performance.now() - listenerStartedAt)} ms`)

    // ---- the measured window
    for (let seq = 0; seq < spec.emits; seq += 1) {
      const a = performance.now()
      await invalidateWorkspaceCoverage(db.pool, { landscapeId, versionId: vid(seq) }, 'm4 measured emit')
      const b = performance.now()
      emitStart[seq] = a
      emitEnd[seq] = b

      if (spec.killAfterEmit !== null && seq === spec.killAfterEmit) {
        // The listener must demonstrably be WORKING at this instant, or the
        // loss below would be attributable to a listener that never was.
        const deliveredBeforeKill = arrivals.size
        if (deliveredBeforeKill === 0) throw new Error(`[${spec.name}] nothing delivered before the kill`)
        const { rows } = await killer.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()`,
          [appName],
        )
        // Exactly one, or nothing is terminated. This database is shared.
        if (rows.length !== 1) {
          throw new Error(`[${spec.name}] expected exactly 1 backend named ${appName}, found ${rows.length}`)
        }
        const pid = Number(rows[0]!.pid)
        const killAt = performance.now()
        const term = await killer.query<{ terminated: boolean }>(
          'SELECT pg_terminate_backend($1::int) AS terminated',
          [pid],
        )
        killInfo = {
          afterEmitSeq: seq,
          pid,
          terminated: term.rows[0]?.terminated ?? null,
          atMsSinceListenerStart: round(killAt - listenerStartedAt),
          atMsSinceArmStart: round(killAt - t0Arm),
          deliveredBeforeKill,
        }
        trace(`[${spec.name}] terminated pid ${pid} after emit ${seq}`)
      }

      if (spec.emitIntervalMs > 0) await sleep(spec.emitIntervalMs)
    }

    // ---- drain on QUIET, not on a fixed sleep.
    const drainStart = performance.now()
    let drainEndedBy = 'ceiling'
    const arrivalsAtDrainStart = arrivals.size
    for (;;) {
      const now = performance.now()
      if (now - lastArrivalAt >= DRAIN_QUIET_MS) { drainEndedBy = 'quiet'; break }
      if (now - drainStart >= DRAIN_CEILING_MS) break
      await sleep(100)
    }
    const drainElapsedMs = round(performance.now() - drainStart)
    const arrivalsDuringDrain = arrivals.size - arrivalsAtDrainStart

    // ---- fold
    const received = [...arrivals.keys()].sort((a, b) => a - b)
    const lostSeqs: number[] = []
    for (let seq = 0; seq < spec.emits; seq += 1) if (!arrivals.has(seq)) lostSeqs.push(seq)
    const postCommit: number[] = []
    const fromStatementStart: number[] = []
    for (const [seq, at] of arrivals) {
      postCommit.push(at - emitEnd[seq]!)
      fromStatementStart.push(at - emitStart[seq]!)
    }

    // The blackout: from the kill to the next notification this process saw.
    let blackoutMs: number | null = null
    let firstSeqAfterGap: number | null = null
    let lastSeqBeforeGap: number | null = null
    if (killInfo) {
      const killAtAbs = t0Arm + (killInfo.atMsSinceArmStart as number)
      const after = received.filter((s) => arrivals.get(s)! > killAtAbs)
      const before = received.filter((s) => arrivals.get(s)! <= killAtAbs)
      firstSeqAfterGap = after.length ? after[0]! : null
      lastSeqBeforeGap = before.length ? before[before.length - 1]! : null
      blackoutMs = after.length ? round(arrivals.get(after[0]!)! - killAtAbs) : null
    }

    const lossRatePct = round((100 * lostSeqs.length) / spec.emits)
    const reconnects = Math.max(0, seenPids.size - 1)

    const result: Record<string, unknown> = {
      arm: spec.name,
      reconnectMsConfigured: spec.reconnectMs ?? WORKSPACE_CACHE_INVALIDATION_RECONNECT_MS,
      reconnectCadenceIsShippedDefault: spec.reconnectMs === undefined,
      emits: spec.emits,
      emitIntervalMs: spec.emitIntervalMs,
      establishPingsUsed: pingsUsed,
      samples: arrivals.size,
      lost: lostSeqs.length,
      lossRatePct,
      reconnects,
      listenerBackendPids: [...seenPids],
      pidTimeline: pidEvents,
      kill: killInfo,
      blackoutMs,
      lastSeqBeforeGap,
      firstSeqAfterGap,
      lostSeqFirst: lostSeqs.length ? lostSeqs[0]! : null,
      lostSeqLast: lostSeqs.length ? lostSeqs[lostSeqs.length - 1]! : null,
      lostRunIsContiguous:
        lostSeqs.length === 0 ||
        lostSeqs[lostSeqs.length - 1]! - lostSeqs[0]! + 1 === lostSeqs.length,
      latencyPostCommitMs: stats(postCommit),
      latencyFromStatementStartMs: stats(fromStatementStart),
      emitStatementMs: stats(emitStart.map((a, i) => emitEnd[i]! - a)),
      drain: { endedBy: drainEndedBy, elapsedMs: drainElapsedMs, quietMs: DRAIN_QUIET_MS, arrivalsDuringDrain },
      foreignCoverageNotifications: foreignCoverage,
      foreignVersionNotifications: foreignVersion,
      malformedPayloads: malformed,
    }
    trace(`[${spec.name}] ${JSON.stringify(result)}`)
    return result
  } finally {
    watching = false
    await watchDone.catch(() => {})
    await handle.stop().catch((e) => trace(`[${spec.name}] stop failed: ${(e as Error).message}`))
    await listenerPool.end().catch(() => {})
    await killer.end().catch(() => {})
    await watcher.end().catch(() => {})
  }
}

/**
 * THE PRIMARY LATENCY ARM: writer here, listener in a SEPARATE PROCESS.
 *
 * The same-process arms above report a delivery latency of ~0,03 ms with
 * NEGATIVE minima. That is not a channel measurement — it is two callbacks on
 * one event loop, and the negative values are the instrument admitting its two
 * endpoints are not causally ordered by its own clock. It also does not resemble
 * the deployment the module was written for (process B writes, process A
 * listens). This arm crosses a real process boundary, so the number includes
 * what production actually pays: a second event loop has to wake up.
 *
 * Cross-process subtraction is only legal if the two clocks share an origin.
 * That is CHECKED, not assumed: the parent brackets a round trip around the
 * child's `process.hrtime.bigint()` and requires the child's reading to fall
 * inside. A failed bracket voids this arm rather than publishing a number
 * built on an unverified assumption.
 */
async function runCrossProcessLatencyArm(db: IsolatedSchemaDb): Promise<Record<string, unknown>> {
  const name = 'xproc-latency-no-kill'
  const emits = 300
  const emitIntervalMs = 20
  const landscapeId = `L-m4-${RUN_TOKEN}-${name}`
  const appName = `m4-${RUN_TOKEN}-${name}`.slice(0, 63)
  const prefix = `V-m4-${RUN_TOKEN}-${name}-`
  const vid = (seq: number): string => `${prefix}${seq}`
  const pingVid = (k: number): string => `${prefix}ping-${k}`

  await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1)', [landscapeId])
  await db.pool.query(
    `INSERT INTO versions (id, landscape_id, label, root_url)
     SELECT $1 || g::text, $2, 'M4', 'automerge:m4'
     FROM generate_series(0, $3::int) g`,
    [prefix, landscapeId, emits - 1],
  )
  await db.pool.query(
    `INSERT INTO versions (id, landscape_id, label, root_url)
     SELECT $1 || g::text, $2, 'M4', 'automerge:m4'
     FROM generate_series(0, $3::int) g`,
    [`${prefix}ping-`, landscapeId, PING_BUDGET - 1],
  )

  const childPath = fileURLToPath(new URL('./measure-m4-listener.mts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx', childPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      M4_SCHEMA: db.schema,
      M4_LANDSCAPE: landscapeId,
      M4_APPNAME: appName,
      M4_RECONNECT_MS: '1000',
    },
  })

  const arrivalsNs = new Map<number, bigint>()
  const pingArrivals: bigint[] = []
  let foreign = 0
  let malformed = 0
  let lastArrivalAt = performance.now()
  let readyResolve: ((pid: number) => void) | null = null
  const ready = new Promise<number>((r) => { readyResolve = r })
  let pongResolve: ((ns: bigint) => void) | null = null

  const handleLine = (line: string): void => {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      trace(`[${name}] unparseable child line: ${line}`)
      return
    }
    if (msg.ready) { readyResolve?.(Number(msg.pid)); return }
    if (msg.pong) { pongResolve?.(BigInt(msg.pong as string)); return }
    if (msg.foreign) { foreign += 1; return }
    if (msg.a && typeof msg.v === 'string') {
      lastArrivalAt = performance.now()
      const at = BigInt(msg.a as string)
      const tail = msg.v.startsWith(prefix) ? msg.v.slice(prefix.length) : null
      if (tail === null) { malformed += 1; return }
      if (tail.startsWith('ping-')) { pingArrivals.push(at); return }
      const seq = Number(tail)
      if (!Number.isInteger(seq)) { malformed += 1; return }
      if (!arrivalsNs.has(seq)) arrivalsNs.set(seq, at)
      return
    }
    if (msg.fatal || msg.poolEvent) trace(`[${name}] child: ${line}`)
  }

  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buf += chunk
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl < 0) break
      handleLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => trace(`[${name}] child stderr: ${chunk.trim()}`))

  try {
    const childPid = await Promise.race([
      ready,
      sleep(30_000).then(() => { throw new Error(`[${name}] child never reported ready`) }),
    ])
    trace(`[${name}] child ready pid=${childPid}`)

    // ---- CLOCK COMPARABILITY CONTROL. Without it the cross-process latency is
    // a subtraction of two numbers that may not share an origin.
    const brackets: Array<{ widthMs: number; inside: boolean }> = []
    for (let i = 0; i < 20; i += 1) {
      const before = process.hrtime.bigint()
      const pong = await new Promise<bigint>((resolve) => {
        pongResolve = resolve
        child.stdin.write('PING\n')
      })
      const after = process.hrtime.bigint()
      pongResolve = null
      brackets.push({
        widthMs: Number(after - before) / 1e6,
        inside: pong >= before && pong <= after,
      })
    }
    const clockComparable = brackets.every((b) => b.inside)
    const bracketWidths = brackets.map((b) => b.widthMs)

    // ---- establish
    let established = false
    let pingsUsed = 0
    for (let k = 0; k < PING_BUDGET && !established; k += 1) {
      pingsUsed = k + 1
      await invalidateWorkspaceCoverage(db.pool, { landscapeId, versionId: pingVid(k) }, 'm4 establish ping')
      for (let w = 0; w < 15 && pingArrivals.length === 0; w += 1) await sleep(20)
      established = pingArrivals.length > 0
    }
    if (!established) throw new Error(`[${name}] cross-process LISTEN never established`)

    // ---- measured window
    const startNs: bigint[] = []
    const endNs: bigint[] = []
    for (let seq = 0; seq < emits; seq += 1) {
      const a = process.hrtime.bigint()
      await invalidateWorkspaceCoverage(db.pool, { landscapeId, versionId: vid(seq) }, 'm4 measured emit')
      const b = process.hrtime.bigint()
      startNs[seq] = a
      endNs[seq] = b
      await sleep(emitIntervalMs)
    }

    // ---- drain on quiet
    const drainStart = performance.now()
    let drainEndedBy = 'ceiling'
    const before = arrivalsNs.size
    for (;;) {
      const now = performance.now()
      if (now - lastArrivalAt >= DRAIN_QUIET_MS) { drainEndedBy = 'quiet'; break }
      if (now - drainStart >= DRAIN_CEILING_MS) break
      await sleep(100)
    }
    const drainElapsedMs = round(performance.now() - drainStart)
    const arrivalsDuringDrain = arrivalsNs.size - before

    const postCommit: number[] = []
    const fromStart: number[] = []
    for (const [seq, at] of arrivalsNs) {
      postCommit.push(Number(at - endNs[seq]!) / 1e6)
      fromStart.push(Number(at - startNs[seq]!) / 1e6)
    }
    const lost = emits - arrivalsNs.size

    const result: Record<string, unknown> = {
      arm: name,
      topology: 'writer and listener in SEPARATE OS processes',
      reconnectMsConfigured: 1_000,
      reconnectCadenceIsShippedDefault: false,
      emits,
      emitIntervalMs,
      establishPingsUsed: pingsUsed,
      samples: arrivalsNs.size,
      lost,
      lossRatePct: round((100 * lost) / emits),
      // `null`, NOT 0, and the difference is the whole point: this arm runs the
      // listener in a CHILD PROCESS and does no `pg_stat_activity` polling at
      // all — `seenPids`/`pollPids` exist only in `runArm`. A literal 0 would
      // read as an observation that was never made. `null` is the claim
      // "not known", which is a different claim from zero.
      reconnects: null,
      kill: null,
      clockControl: {
        rounds: brackets.length,
        allChildReadingsInsideParentBracket: clockComparable,
        bracketWidthMs: stats(bracketWidths),
      },
      latencyPostCommitMs: stats(postCommit),
      latencyFromStatementStartMs: stats(fromStart),
      emitStatementMs: stats(startNs.map((a, i) => Number(endNs[i]! - a) / 1e6)),
      drain: { endedBy: drainEndedBy, elapsedMs: drainElapsedMs, quietMs: DRAIN_QUIET_MS, arrivalsDuringDrain },
      foreignCoverageNotifications: foreign,
      malformedPayloads: malformed,
    }
    trace(`[${name}] ${JSON.stringify(result)}`)
    return result
  } finally {
    const exited = new Promise<void>((r) => child.once('exit', () => r()))
    child.stdin.write('STOP\n')
    await Promise.race([exited, sleep(10_000)])
    if (child.exitCode === null) child.kill()
  }
}

async function main(): Promise<void> {
  writeFileSync(LOG, '')
  trace(`M4 run token ${RUN_TOKEN}`)
  // The run token is IN THE SCHEMA NAME, not only in the row identifiers.
  // `createIsolatedSchemaDb` opens with `DROP SCHEMA IF EXISTS … CASCADE`, so a
  // fixed name means two concurrent runs on this shared CI database destroy
  // each other mid-flight when several runs share one Postgres. `teardown()`
  // still drops it, so uniqueness costs nothing.
  const db = await createIsolatedSchemaDb(DATABASE_URL!, `sync_cell_m4_${RUN_TOKEN}`)
  const arms: Array<Record<string, unknown>> = []
  let pgVersion = ''
  try {
    await db.pool.query('CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT)')
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'active'
      )
    `)
    // The REAL DDL: both notify triggers, attached to THIS schema's tables.
    await ensureSyncCellOwnershipSchema(db.pool)
    pgVersion = (await db.pool.query<{ version: string }>('SELECT version()')).rows[0]!.version

    // SERIAL, never parallel: several listeners and emit loops on one database
    // would measure contention rather than the channel.
    arms.push(await runCrossProcessLatencyArm(db))
    for (const spec of ARMS) arms.push(await runArm(db, spec))
  } finally {
    await db.teardown().catch(() => {})
  }

  // ---- the harness asserts its own controls, and REFUSES to publish a number
  // it cannot attribute. A doubtful measurement is worse than a missing one.
  const control = arms.find((a) => a.arm === 'control-no-kill')!
  const xproc = arms.find((a) => a.arm === 'xproc-latency-no-kill')!
  const killArms = arms.filter((a) => a.kill !== null)
  const voids: string[] = []
  if ((xproc.samples as number) === 0) voids.push('cross-process arm delivered nothing — samples 0 is VOID, not PASS')
  if ((xproc.lost as number) !== 0) voids.push(`cross-process arm lost ${xproc.lost} with no kill`)
  if (!(xproc.clockControl as { allChildReadingsInsideParentBracket: boolean }).allChildReadingsInsideParentBracket) {
    voids.push('cross-process clocks are not comparable — the child hrtime reading fell outside the parent bracket, so the latency subtraction is not legal')
  }
  if ((xproc.drain as { endedBy: string }).endedBy !== 'quiet') voids.push('cross-process arm drain hit its ceiling')
  if ((control.samples as number) === 0) voids.push('control delivered nothing — samples 0 is VOID, not PASS')
  if ((control.lost as number) !== 0) voids.push(`control lost ${control.lost} with no kill — the loss counter is not measuring the gap`)
  if ((control.reconnects as number) !== 0) voids.push(`control reconnected ${control.reconnects} times with no kill`)
  if ((control.drain as { endedBy: string }).endedBy !== 'quiet') voids.push('control drain hit its ceiling — the drain may be the binding constraint')
  for (const a of killArms) {
    if (!a.kill) voids.push(`${a.arm}: no backend was terminated`)
    if ((a.samples as number) === 0) voids.push(`${a.arm}: samples 0 is VOID, not PASS`)
    if ((a.lost as number) === 0) voids.push(`${a.arm}: zero loss across a kill — either the kill missed or the emit window did not span the gap`)
    if (a.firstSeqAfterGap === null) voids.push(`${a.arm}: nothing was delivered after the kill — the listener never came back inside the window`)
    if ((a.reconnects as number) < 1) voids.push(`${a.arm}: the backend was killed but no new listener backend was observed`)
    if ((a.drain as { endedBy: string }).endedBy !== 'quiet') voids.push(`${a.arm}: drain hit its ceiling`)
  }

  const report = {
    measureId: 'M4',
    takenOn: new Date().toISOString().slice(0, 10),
    runToken: RUN_TOKEN,
    harness: 'server/qa/measure-m4.mts',
    node: process.version,
    postgres: pgVersion,
    shippedReconnectMs: WORKSPACE_CACHE_INVALIDATION_RECONNECT_MS,
    verdict: voids.length === 0 ? 'PASS' : 'VOID',
    voidReasons: voids,
    arms,
  }
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
  trace(`wrote ${OUT} verdict=${report.verdict}`)
  // One line to stdout, so a terminal run says something; the numbers are in
  // the file.
  process.stdout.write(`M4 ${report.verdict} -> ${OUT}\n`)
  if (voids.length > 0) process.exitCode = 2
}

await main()
