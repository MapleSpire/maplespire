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
 * THE SAMPLER FOR THE POOL METER.
 *
 * `b25e-pool-census.mjs` samples `pg_stat_activity` from outside the process:
 * it cannot tell a client that HOLDS a pooled connection from one that has just
 * been handed one, so its verdict is only a lower bound on demand.
 *
 * This one asks the cell instead. `GET /api/health/pools` is served by
 * `db/poolMeter.ts` from counters kept in the process, so it distinguishes the
 * three states `pg_stat_activity` collapses into `idle`:
 *
 *   checkedOut  handed to a caller. Postgres sees an idle backend; the pool
 *               sees a connection nobody else can have.
 *   idle        on the free list, available to the next `connect()`.
 *   connecting  owned by the pool and still being ESTABLISHED — inside
 *               `totalCount`, not in `_idle`, never acquired.
 *
 * And those three are exactly the discriminator needed. A plateau
 * whose cause is a full queue shows `waiting > 0` with `checkedOut` at `max`.
 * A plateau whose cause is a stalled ESTABLISHMENT shows `connecting > 0` with
 * `waiting` at zero, because `connect()` only enqueues when the pool is already
 * full (pg-pool's `connect()`). The census cannot separate those two.
 *
 * ## What it does NOT claim
 *
 * It names the MECHANISM, not the code. `oldestBorrowMs` says a borrow has been
 * held for N ms; it does not say by whom. The stacks in the cell's own stderr
 * remain the authority on that.
 *
 * A missed poll is DATA, not a gap: every failure is recorded in the series
 * with its reason, and the summary reports how many there were. A sampler that
 * quietly skipped the samples it could not take would report its calmest
 * readings from the moment the cell was least able to answer.
 *
 * Run from the repo root, with the bench up, WHILE a b25a run is in flight:
 *   node server/scripts/b25f-pool-meter-sampler.mjs
 * Stop it with SIGINT; it writes its file on the way out.
 */

import { appendFileSync, writeFileSync } from 'node:fs'

/**
 * Every numeric knob goes through here, and `??` alone is why it has to:
 * `process.env.X ?? '250'` does NOT catch `X=""`, and `Number('')` is 0 — a
 * silent zero interval. Declared in `scripts/env-knob-declarations.mjs` and
 * enforced by `local/no-bare-env-number` under `ci-local.mjs --static`.
 */
function boundedEnvNumber(name, fallback, minimum) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number >= ${minimum}; got ${JSON.stringify(raw)}`)
  }
  return value
}

const CELLS = (process.env.B25F_CELLS ?? 'a=http://127.0.0.1:3321,b=http://127.0.0.1:3322,c=http://127.0.0.1:3313')
  .split(',')
  .map((entry) => {
    const [name, url] = entry.split('=')
    return { name: name.trim(), url: url.trim().replace(/\/$/, '') }
  })

const INTERVAL_MS = boundedEnvNumber('B25F_INTERVAL_MS', 250, 25)
const TIMEOUT_MS = boundedEnvNumber('B25F_TIMEOUT_MS', 2_000, 100)
const MAX_SECONDS = boundedEnvNumber('B25F_MAX_SECONDS', 900, 5)
const OUT = process.env.B25F_OUT ?? 'reports/B2-5f-meter-series.json'
const SERIES_OUT = OUT.replace(/\.json$/, '.ndjson')
/** Samples between summary rewrites. The NDJSON is written every sample. */
const FLUSH_EVERY = boundedEnvNumber('B25F_FLUSH_EVERY', 25, 1)

const startedAt = Date.now()
const series = []
let failures = 0
let stopping = false

async function poll(cell) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${cell.url}/api/health/pools`, { signal: controller.signal })
    if (!response.ok) return { cell: cell.name, error: `http ${response.status}` }
    const body = await response.json()
    return { cell: cell.name, pools: body.pools }
  } catch (error) {
    // RECORDED, never dropped. A cell too wedged to answer is the single most
    // informative sample in the run.
    return { cell: cell.name, error: error?.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Peak per (cell, pool) across the run, plus where each peak was seen. */
function summarise() {
  const peaks = new Map()
  for (const sample of series) {
    for (const reading of sample.readings) {
      if (!reading.pools) continue
      for (const pool of reading.pools) {
        const key = `${reading.cell}/${pool.pool}`
        const current = peaks.get(key) ?? {
          cell: reading.cell,
          pool: pool.pool,
          max: pool.max,
          peakCheckedOut: 0,
          peakWaiting: 0,
          peakConnecting: 0,
          peakOldestBorrowMs: 0,
          /** The SECOND queue. A caller parked here holds no pg client. */
          gateLimit: null,
          peakGateInFlight: 0,
          peakGateLiveQueueDepth: 0,
          atPeakGateQueue: null,
          borrowHighWater: 0,
          waitHighWaterObserved: 0,
          connectingHighWaterObserved: 0,
          underflows: 0,
          handlerFailures: 0,
          samples: 0,
          atPeakCheckedOut: null,
          atPeakWaiting: null,
          atPeakConnecting: null,
        }
        current.samples += 1
        if (pool.checkedOut > current.peakCheckedOut) {
          current.peakCheckedOut = pool.checkedOut
          current.atPeakCheckedOut = { atSeconds: sample.atSeconds, ...pool }
        }
        if (pool.waiting > current.peakWaiting) {
          current.peakWaiting = pool.waiting
          current.atPeakWaiting = { atSeconds: sample.atSeconds, ...pool }
        }
        if (pool.connecting > current.peakConnecting) {
          current.peakConnecting = pool.connecting
          current.atPeakConnecting = { atSeconds: sample.atSeconds, ...pool }
        }
        if ((pool.oldestBorrowMs ?? 0) > current.peakOldestBorrowMs) {
          current.peakOldestBorrowMs = pool.oldestBorrowMs ?? 0
        }
        if (pool.gate) {
          current.gateLimit = pool.gate.limit
          current.peakGateInFlight = Math.max(current.peakGateInFlight, pool.gate.inFlight)
          if (pool.gate.liveQueueDepth > current.peakGateLiveQueueDepth) {
            current.peakGateLiveQueueDepth = pool.gate.liveQueueDepth
            current.atPeakGateQueue = { atSeconds: sample.atSeconds, ...pool }
          }
        }
        current.borrowHighWater = Math.max(current.borrowHighWater, pool.borrowHighWater)
        current.waitHighWaterObserved = Math.max(current.waitHighWaterObserved, pool.waitHighWaterObserved)
        current.connectingHighWaterObserved = Math.max(current.connectingHighWaterObserved, pool.connectingHighWaterObserved)
        current.underflows = Math.max(current.underflows, pool.connectingUnderflows)
        current.handlerFailures = Math.max(current.handlerFailures, pool.handlerFailures)
        current.max = pool.max
        peaks.set(key, current)
      }
    }
  }
  return [...peaks.values()]
}

/**
 * Write the summary. Called every `FLUSH_EVERY` samples as well as at the end,
 * and this is not belt-and-braces: on Windows this process refuses `taskkill`
 * without `/F`, so the only way to stop it early is the way that runs no exit
 * handler. With the per-sample NDJSON beside it, a force-kill costs one
 * sample, not all of them.
 */
function writeSummary(reason) {
  const summary = summarise()
  const report = {
    task: 'B2-5f',
    reason,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    intervalMs: INTERVAL_MS,
    samples: series.length,
    /** Polls that returned nothing. Reported, because a gap read as calm is a lie. */
    pollFailures: failures,
    cells: CELLS,
    /** The full per-sample series, appended as it was taken. */
    seriesFile: SERIES_OUT,
    peaks: summary,
  }
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
  return summary
}

function finish(reason) {
  const summary = writeSummary(reason)
  console.log(`\n${series.length} samples, ${failures} failed polls -> ${OUT}`)
  for (const peak of summary) {
    console.log(
      `  ${peak.cell}/${peak.pool} max=${peak.max} peakCheckedOut=${peak.peakCheckedOut}`
      + ` peakWaiting=${peak.peakWaiting} peakConnecting=${peak.peakConnecting}`
      + ` peakOldestBorrowMs=${Math.round(peak.peakOldestBorrowMs)}`
      + ` gate=${peak.gateLimit === null ? 'none' : `${peak.peakGateInFlight}/${peak.gateLimit} q${peak.peakGateLiveQueueDepth}`}`
      + ` underflows=${peak.underflows} handlerFailures=${peak.handlerFailures}`,
    )
  }
}

process.on('SIGINT', () => { stopping = true })
process.on('SIGTERM', () => { stopping = true })

const main = async () => {
  console.log(`sampling ${CELLS.map((c) => c.name).join(', ')} every ${INTERVAL_MS} ms; SIGINT to stop`)
  // Truncate: the series file is APPENDED to, so without this a second run
  // against the same output silently concatenates itself onto the first and
  // every peak in the summary is a peak of two runs.
  writeFileSync(SERIES_OUT, '')
  while (!stopping && (Date.now() - startedAt) / 1000 < MAX_SECONDS) {
    const readings = await Promise.all(CELLS.map(poll))
    for (const reading of readings) if (reading.error) failures += 1
    const sample = {
      atSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      readings,
    }
    series.push(sample)
    appendFileSync(SERIES_OUT, `${JSON.stringify(sample)}\n`)
    if (series.length % FLUSH_EVERY === 0) writeSummary('in-flight')
    // NOT unref'd. An awaited promise is not a handle, so an unref'd timer with
    // no other referenced handle lets Node exit the moment `fetch` settles —
    // the sampler would take one sample and stop, reporting a calm run.
    await new Promise((resolve) => { setTimeout(resolve, INTERVAL_MS) })
  }
  finish(stopping ? 'signal' : 'max-seconds')
}

main().catch((error) => {
  console.error(error)
  finish('error')
  process.exitCode = 1
})
