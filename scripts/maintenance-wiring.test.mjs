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
 * A MAINTENANCE JOB THAT NOTHING SCHEDULES IS NOT A MAINTENANCE JOB.
 *
 * The failure is silent by construction: every unit and integration test
 * passes, the module is exported and imported, and the job simply never runs.
 * Deleting the one line in `index.ts` that schedules it would turn a working
 * feature off without turning anything red.
 *
 * So this asserts the wiring exists, from the outside, on the shipped source.
 *
 * WHAT IT CANNOT DO, said plainly rather than left to be assumed: it is a source
 * check, not an execution. It proves a scheduler call is present and reaches the
 * tick; it does not prove the scheduler fires, that the interval is sane, or
 * that the job does anything. `server/qa/t28f-window.mts` executes the window;
 * this stops the window from being disconnected afterwards.
 *
 * THE FSCK TICK IS DELIBERATELY NOT REQUIRED HERE. `runFsckQueueTick` exists
 * and is tested but is not yet scheduled in production; it is listed as
 * `KNOWN_UNWIRED` so this file documents the gap instead of going red on it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(ROOT, 'server', 'src', 'index.ts')
const source = readFileSync(INDEX, 'utf8')

/**
 * Each entry: a queue-driven job, the symbol whose presence proves the tick is
 * reached, and the scheduler call that must appear with it.
 */
const WIRED = [
  {
    job: 'compaction queue (T-28f)',
    // The tick call itself, not merely the import: an import that nothing calls
    // is exactly the state this file exists to reject.
    tick: 'compactionQueue.tick()',
    scheduler: 'setInterval',
    // The stop must be registered too, or a shutdown leaves a timer holding the
    // event loop open with a destructive job on it.
    stop: 'clearInterval(compactionQueueTimer)',
  },
]

const KNOWN_UNWIRED = [
  {
    symbol: 'runFsckQueueTick',
    owner: 'T-26 / T-27',
  },
]

test('every wired maintenance tick is actually reached from a scheduler', () => {
  for (const entry of WIRED) {
    assert.ok(
      source.includes(entry.tick),
      `${entry.job}: index.ts no longer contains \`${entry.tick}\`. The job is exported, imported and `
      + 'tested, and nothing runs it — the state the fsck tick is still in.',
    )
    assert.ok(
      source.includes(entry.scheduler),
      `${entry.job}: no \`${entry.scheduler}\` in index.ts, so nothing repeats the tick.`,
    )
  }
})

test('every wired tick registers a way to stop it', () => {
  for (const entry of WIRED) {
    assert.ok(
      source.includes(entry.stop),
      `${entry.job}: \`${entry.stop}\` is gone, so shutdown leaves the timer running.`,
    )
    assert.ok(
      source.includes('maintenanceScheduleStops.push(() => clearInterval'),
      `${entry.job}: the stop is not registered in \`maintenanceScheduleStops\`, so shutdown never calls it.`,
    )
  }
})

test('the compaction queue is wired OFF by default, at two independent switches', () => {
  // The wiring existing is not the same as the wiring being armed, and the two
  // must not drift: an unattended destructive job must stay behind both an
  // explicit `COMPACTION_QUEUE=on` and a non-empty allow-list.
  assert.ok(
    source.includes('compactionQueueEnabled()'),
    'the queue no longer consults COMPACTION_QUEUE, so it would run on every deployment',
  )
  assert.ok(
    source.includes("admission.scope === 'allowlisted'"),
    'the queue no longer restricts itself to allow-listed workspaces',
  )
  assert.ok(
    source.includes('workspaceKeyedMaintenanceEnabled()'),
    'the queue no longer refuses to run under the job-name-keyed exclusion, which cannot tell '
    + 'two workspaces apart in `maintenance_job_status`',
  )
})

test('the known-unwired jobs are still the ones the record says they are', () => {
  // A LIST THAT IS ALLOWED TO SHRINK, NEVER TO GROW SILENTLY. If somebody wires
  // the fsck tick, this test fails and the entry must be moved to `WIRED` — so
  // the exemption cannot outlive the gap it documents.
  for (const entry of KNOWN_UNWIRED) {
    assert.ok(
      !source.includes(`${entry.symbol}(`),
      `${entry.symbol} is now called from index.ts. That is good news: move it from KNOWN_UNWIRED to `
      + `WIRED in this file.`,
    )
  }
})

test('this file names a real file, and would notice if it did not', () => {
  // The check above reads a path. A renamed or moved `index.ts` would make every
  // `source.includes` fail loudly here rather than pass vacuously somewhere else
  // — but only because the read throws. Asserted so the reason is on the record.
  assert.ok(source.length > 10_000, 'server/src/index.ts is implausibly small; the path is probably wrong')
})
