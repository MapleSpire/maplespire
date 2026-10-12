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
 * Pool census — WHO IS HOLDING THE PRIMARY POOL WHILE `promote-summary` WAITS.
 *
 * The hypothesis it tests is arithmetic: `DB_POOL_MAX` is 10; three clients are
 * held for the process's lifetime by the LISTEN subscribers; the storage
 * adapter's borrow bound lets it hold four more. 3 + 4 = 7, leaving THREE
 * free — while the promotion preflight (`readStaticSource` and its siblings in
 * a five-wide `Promise.all`) asks for FIVE at once. The tail callers then wait
 * on adapter operations that are slow during an outage, and hit
 * `connectionTimeoutMillis`.
 *
 * WHY IT SAMPLES FROM OUTSIDE THE PROCESS. `pg_stat_activity` is the only
 * witness that cannot be distorted by the saturation it is measuring — an
 * in-process probe would need the very pool under test to report on it.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. `pg_stat_activity` cannot tell a client
 * that HOLDS a pooled connection from one that has just been handed it: an
 * `idle` backend is a checked-out-but-quiet client OR a free one sitting in
 * `_idle`, so a holder list drawn from it can mislabel a victim as a holder
 * (`b25f-pool-meter-sampler.mjs` asks the process instead). So the verdict
 * here is stated in terms of the number of
 * SIMULTANEOUSLY NON-IDLE backends per cell, which is a lower bound on demand,
 * and the stacks in the cell's own stderr remain the authority on who waited.
 *
 * Run from the repo root, with the bench up, WHILE a b25a run is in flight:
 *   node server/scripts/b25e-pool-census.mjs > census.jsonl
 */

import { execFileSync } from 'node:child_process'

const PG = process.env.B25E_PG_CONTAINER ?? 'maplespire-sync-active-active-postgres-1'
/**
 * Every numeric knob goes through here, and `??` alone is why it has to.
 *
 * `??` does NOT catch a BLANK: a dangling `B25E_INTERVAL_MS=` in a shell line
 * is `''`, and `Number('')` is 0 — finite, and it passes any `>= 0` check. This
 * is the hazard `local/no-bare-env-number` exists for (enforced under
 * `ci-local.mjs --static`, not by unit tests).
 *
 * A blank is treated as UNSET (the documented fallback) rather than as an
 * error, because a sampler that refuses to start is an instrument outage, and
 * anything non-finite or below the floor THROWS rather than silently sampling
 * at a rate that would make the record meaningless.
 */
function boundedEnvNumber(name, fallback, minimum) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name}='${raw}' is unusable: it must be a number >= ${minimum}`)
  }
  return parsed
}

const INTERVAL_MS = boundedEnvNumber('B25E_INTERVAL_MS', 250, 50)
const DURATION_MS = boundedEnvNumber('B25E_DURATION_MS', 260_000, 1_000)

/**
 * `state <> 'idle'` is the discriminator, and `wait_event_type` comes with it so
 * a backend blocked on a lock is distinguishable from one doing work.
 */
const SQL = `SELECT client_addr::text AS addr, state, wait_event_type AS wait,
       left(regexp_replace(query, '\\s+', ' ', 'g'), 90) AS q
FROM pg_stat_activity
WHERE datname = 'maplespire' AND backend_type = 'client backend'`

/**
 * A multi-character separator, because the last column is SQL and a single
 * `|` would be split by any query containing one.
 *
 * Visible on purpose: a control byte such as \u0001 is INVISIBLE in a
 * terminal, in `grep` output and in a diff (`scripts/source-nul.mjs` rejects
 * such bytes in source).
 */
const SEP = '|~|'
function sample() {
  const raw = execFileSync('docker', [
    'exec', PG, 'psql', '-U', 'maplespire', '-d', 'maplespire', '-t', '-A', '-F', SEP, '-c', SQL,
  ], { encoding: 'utf8', timeout: 10_000 })

  const rows = raw.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const [addr, state, wait, q] = line.split(SEP)
      return { addr, state, wait, q }
    })

  const byCell = new Map()
  for (const row of rows) {
    const cell = byCell.get(row.addr) ?? { addr: row.addr, total: 0, busy: 0, busyQueries: [] }
    cell.total += 1
    if (row.state !== 'idle') {
      cell.busy += 1
      cell.busyQueries.push(`${row.state}/${row.wait ?? '-'}: ${row.q}`)
    }
    byCell.set(row.addr, cell)
  }
  return [...byCell.values()].sort((a, b) => b.busy - a.busy)
}

const startedAt = Date.now()
let peakBusy = 0
let peakAt = null
let peakDetail = null

while (Date.now() - startedAt < DURATION_MS) {
  let cells
  try {
    cells = sample()
  } catch (error) {
    // NEVER let an instrument outage masquerade as a measurement of the system:
    // record the gap and keep going, so the record shows a hole rather than a
    // quiet stretch that reads as "nothing was happening".
    console.log(JSON.stringify({ at: new Date().toISOString(), sampleFailed: String(error).slice(0, 200) }))
    continue
  }
  for (const cell of cells) {
    if (cell.busy > peakBusy) {
      peakBusy = cell.busy
      peakAt = new Date().toISOString()
      peakDetail = cell
    }
  }
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    cells: cells.map((c) => ({ addr: c.addr, total: c.total, busy: c.busy })),
    busiest: cells[0]?.busyQueries?.slice(0, 8) ?? [],
  }))
}

console.log(JSON.stringify({ summary: true, peakBusy, peakAt, peakDetail }))
