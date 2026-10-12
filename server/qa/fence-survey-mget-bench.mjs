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
 * How much does one chunk of the boot fence survey cost, and what is that cost
 * a function of?
 *
 * WHY IT IS WORTH ASKING. `workspacesWithoutSequence` runs on the LEASE Redis
 * runtime, whose `commandTimeoutMs` is derived to fit inside the partition lease
 * TTL — 550 ms on the shipped defaults. A timeout there does not merely null the
 * survey: `RedisRuntime.send` calls `recycleTimedOutConnection`, which DESTROYS
 * the socket. And the survey runs inside `start()`, two lines before an
 * unguarded `await this.reconcileNow()`.
 *
 * ─── READ BEFORE TRUSTING A NUMBER ───────────────────────────────────────────
 *
 * 1. A SINGLE NUMBER CANNOT BE CHECKED AGAINST ITSELF. Short synthetic key names
 *    produce a different command from production's (see `fenceKey`), hence the
 *    size SWEEP, which exposes contradictions a lone figure hides.
 * 2. MEASURE THE AFTER AS WELL AS THE BEFORE. A budget set exactly ON the step
 *    (16 384 B) measures the same as the old chunk. Hence `wholeSurveyBefore`
 *    and `wholeSurveyAfter`.
 *
 * WHAT IS ESTABLISHED is a correlation, not a cause: the cost tracks REQUEST
 * BYTES and almost nothing else. `EXISTS` over the same keys — same request, one
 * integer back instead of N values — steps at the same size, so it is not the
 * reply. `qa/fence-survey-cliff-cause.mjs` carries the rest: not the argument
 * count, not the key lookups, not Nagle, and not the next command waiting on
 * `drain`. No cause is asserted here.
 *
 * WHAT THIS DOES NOT MEASURE, so it is not over-read:
 *   - CONTENTION. One idle client. A Redis serving a fleet's renew traffic is
 *     strictly worse; these numbers are a FLOOR on the risk.
 *   - THE REAL NETWORK, and this one cuts AGAINST the remedy. Loopback to a
 *     container through a Windows userspace relay. The remedy trades 20 round
 *     trips for 80, so if the step is host-specific the survey gets SLOWER off
 *     loopback: +60 x RTT, which is +300 ms on a 5 ms link.
 *   - LINUX. Unmeasured; nothing here shows the threshold travels.
 *
 *   TEST_REDIS_URL=redis://localhost:6389 node qa/fence-survey-mget-bench.mjs
 */
import { createHash } from 'node:crypto'
import { createClient } from 'redis'

const URL = process.env.TEST_REDIS_URL
if (!URL) {
  console.error('TEST_REDIS_URL is required — this bench measures a real Redis or nothing')
  process.exit(1)
}

/** The shipped derivation, restated so the output can name the ceiling it
 * compares against. `fenceSurveyBudget.test.ts` asserts this against
 * `syncCellOwnershipConfig({})` — the DEFAULTS, not the formula under explicit
 * inputs — so the copy cannot drift silently. */
const PARTITION_LEASE_TTL_MS = 1_500
const PARTITION_RENEW_INTERVAL_MS = 400
const LEASE_COMMAND_TIMEOUT_MS = Math.max(
  100,
  Math.floor((PARTITION_LEASE_TTL_MS - PARTITION_RENEW_INTERVAL_MS) / 2),
)
/** The previous fixed chunk size, kept as the "before" comparison. */
const OLD_CHUNK = 512
/** Mirrors `FENCE_SURVEY_REQUEST_BUDGET_BYTES`. Restated rather than imported: a
 * bench that read the constant back would agree with any value it is given. */
const BUDGET_BYTES = 12_288

const PREFIX = `bench-fence-survey-${process.pid}`
/** Every key this bench writes expires, so a SIGKILL cannot leave residue in a
 * shared CI Redis. The `finally` sweep is the fast path, not the only one. */
const KEY_TTL_SECONDS = 900

/** The REAL key shape: `<prefix>:sync-cell:fence:<sha256 hex>`. The digest is
 * 64 hex characters, so a production key is ~91 bytes on the shipped prefix
 * whatever the workspace ids are. Since the cost is a function of request
 * bytes, a bench with short synthetic keys measures a different command from
 * the one that ships.
 *
 * THE SEPARATOR IS A PIPE AND NOT PRODUCTION'S NUL, deliberately. Nothing in
 * this measurement depends on the digest's INPUT — only on its length, which is
 * 64 hex characters either way — and a raw NUL byte that slips into this source
 * (editors and shells mangle the escape) makes `grep` treat the whole file as
 * binary. */
const fenceKey = (index) => {
  const digest = createHash('sha256').update(`landscape-${index}|version-${index}`).digest('hex')
  return `${PREFIX}:sync-cell:fence:${digest}`
}

/** What one key costs on the wire in a RESP array — the same accounting the
 * production chunker uses. */
const keyBytes = (key) => Buffer.byteLength(key) + String(Buffer.byteLength(key)).length + 5
const requestBytes = (keys) => keys.reduce((total, key) => total + keyBytes(key), 0) + 15

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  // `p50` and `worst`, NOT `p50`/`p99`/`max`. At 20 iterations a 99th percentile
  // IS the maximum, so publishing both would show one number under two names.
  return {
    samples: sorted.length,
    p50: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    worst: Number(sorted.at(-1).toFixed(3)),
  }
}

async function timeIt(client, args, iterations) {
  await client.sendCommand(args) // warm, not counted
  const samples = []
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now()
    await client.sendCommand(args)
    samples.push(performance.now() - started)
  }
  return summarise(samples)
}

async function sweepPrefix(client, match) {
  const doomed = []
  for await (const batch of client.scanIterator({ MATCH: match, COUNT: 500 })) {
    if (Array.isArray(batch)) doomed.push(...batch)
    else doomed.push(batch)
  }
  for (let offset = 0; offset < doomed.length; offset += 500) {
    await client.sendCommand(['DEL', ...doomed.slice(offset, offset + 500)])
  }
  return doomed.length
}

async function main() {
  const client = createClient({ url: URL })
  await client.connect()
  const report = {
    redis: URL.replace(/\/\/.*@/, '//'),
    platform: `${process.platform}-${process.arch}`,
    leaseCommandTimeoutMs: LEASE_COMMAND_TIMEOUT_MS,
    budgetBytes: BUDGET_BYTES,
  }

  try {
    // CLEANED ON THE WAY IN as well as out. A bench that only tidies in a
    // `finally` leaves residue on SIGKILL, and the next run then measures a
    // Redis it did not seed.
    report.sweptOnEntry = await sweepPrefix(client, `${PREFIX}*`)

    // CONTROL. If a bare round trip is slow, nothing below is about the survey.
    report.ping = await timeIt(client, ['PING'], 50)

    const total = 10_000
    const keys = Array.from({ length: total }, (unused, index) => fenceKey(index))
    report.bytesPerKey = keyBytes(keys[0])
    // The chunk the production loop would ACTUALLY produce for these keys —
    // derived, never a literal, or the "after" chunk measured could be larger
    // than the code can emit.
    const budgetedChunk = Math.max(1, Math.floor(BUDGET_BYTES / report.bytesPerKey))
    report.budgetedChunk = budgetedChunk

    // HALF present. A partially rebuilt Redis is the state the survey exists to find.
    for (let offset = 0; offset < total; offset += 500) {
      const present = keys.slice(offset, offset + 500).filter((unused, index) => index % 2 === 0)
      await client.sendCommand(['MSET', ...present.flatMap((key) => [key, '42'])])
      for (const key of present) await client.sendCommand(['EXPIRE', key, String(KEY_TTL_SECONDS)])
    }

    // THE SWEEP — what makes the shape visible instead of asserted. Each size
    // runs as MGET (N values back) and as EXISTS (same request, one integer
    // back). Where the two agree, the reply is not what costs.
    //
    // 144 and 160 BRACKET the step, and they are in the committed sweep rather
    // than a throwaway probe: a constant chosen against a number no committed
    // instrument reproduces is folklore by the next reader.
    report.sweep = []
    for (const size of [1, 64, budgetedChunk, 144, 160, OLD_CHUNK, 2048]) {
      const slice = keys.slice(0, Math.min(size, total))
      const args = Array.from({ length: size }, (unused, index) => slice[index % slice.length])
      report.sweep.push({
        keys: size,
        bytes: requestBytes(args),
        mget: await timeIt(client, ['MGET', ...args], 20),
        exists: await timeIt(client, ['EXISTS', ...args], 20),
      })
    }

    // THE STEP, located rather than assumed: the largest jump in per-key cost
    // between ADJACENT sweep points. Measuring against the whole sweep would
    // include the `keys: 1` point, whose fixed round-trip
    // overhead forces a huge ratio even for a perfectly linear cost — a guard
    // that cannot fail.
    let step = { ratio: 1, fromBytes: null, toBytes: null }
    for (let i = 1; i < report.sweep.length; i += 1) {
      const previous = report.sweep[i - 1]
      const current = report.sweep[i]
      const ratio = (current.mget.p50 / current.keys) / (previous.mget.p50 / previous.keys)
      if (ratio > step.ratio) {
        step = { ratio: Number(ratio.toFixed(1)), fromBytes: previous.bytes, toBytes: current.bytes }
      }
    }
    report.step = step

    // THE WHOLE SURVEY, BOTH WAYS — the only number that says whether the remedy
    // is worth its constant.
    const survey = async (chunk) => {
      const runs = []
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now()
        for (let offset = 0; offset < total; offset += chunk) {
          await client.sendCommand(['MGET', ...keys.slice(offset, offset + chunk)])
        }
        runs.push(performance.now() - started)
      }
      return { ...summarise(runs), chunks: Math.ceil(total / chunk), keysPerChunk: chunk }
    }
    report.wholeSurveyBefore = await survey(OLD_CHUNK)
    report.wholeSurveyAfter = await survey(budgetedChunk)
    report.speedup = Number((report.wholeSurveyBefore.p50 / report.wholeSurveyAfter.p50).toFixed(1))

    const before = report.sweep.find((row) => row.keys === OLD_CHUNK)
    const after = report.sweep.find((row) => row.keys === budgetedChunk)
    report.headroom = {
      before: Number((LEASE_COMMAND_TIMEOUT_MS / before.mget.worst).toFixed(1)),
      after: Number((LEASE_COMMAND_TIMEOUT_MS / after.mget.worst).toFixed(1)),
    }
    report.verdict = {
      // Computed, not narrated, and about the chunk that SHIPS, not the old
      // 512-key one.
      budgetedChunkIsBelowTheStep: step.toBytes === null || after.bytes < step.toBytes,
      readsAs: report.headroom.after >= 100
        ? `the ${budgetedChunk}-key chunk is far inside the lease command ceiling on this host`
        : `the ${budgetedChunk}-key chunk is NOT comfortably inside the ceiling — re-size`,
      andWhatItDoesNotSay:
        'nothing here bounds the risk off loopback; the remedy costs 60 more round trips per 10k survey (B4-7f)',
    }
  } finally {
    report.sweptOnExit = await sweepPrefix(client, `${PREFIX}*`).catch(() => null)
    await client.close()
  }

  console.log(JSON.stringify(report, null, 1))
}

await main()
