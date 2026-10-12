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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureMaintenanceSchema } from './schema.js'
import {
  COMPACTION_JOB,
  createCompactionQueue,
  dueWorkSeam,
  type CompactionPassOutcome,
  type CompactionQueueWorkspace,
} from './compactionQueue.js'

/**
 * The compaction queue: the half a fake cannot answer.
 *
 * `compactionQueue.test.ts` drives the POLICY through an in-memory seam: which
 * unit runs, in what order, under which bound. It says nothing about whether the
 * claim is atomic, whether the slot dedup holds across two cells, or whether a
 * lease actually expires — those are properties of the SQL in `dueWork.ts`, and
 * a fake that pattern-matches SQL text would only test the test's copy of it.
 *
 * So this file drives the REAL `dueWorkSeam` against a real Postgres, and keeps
 * `measure`/`preview`/`compact` as fakes: the Automerge half has its own
 * coverage in `compaction.preview.test.ts` and `workspaceCompaction.test.ts`,
 * and dragging a Repo in here would make a queue test fail for reasons that have
 * nothing to do with the queue.
 *
 * TWO CELLS ARE SIMULATED BY TWO SEAMS ON ONE DATABASE, which is what the
 * production topology is: `claimDueWork` excludes by row, not by process.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('the compaction queue against Postgres (T-28f)', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'compaction_queue')
    await ensureMaintenanceSchema(db.pool)
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT NOT NULL,
        landscape_id TEXT NOT NULL,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        PRIMARY KEY (landscape_id, id)
      )
    `)
  }, 120_000)

  afterAll(async () => { await db?.teardown() })

  beforeEach(async () => {
    await db.pool.query('DELETE FROM maintenance_due_work')
    await db.pool.query('DELETE FROM versions')
  })

  const seed = async (count: number) => {
    for (let n = 1; n <= count; n += 1) {
      await db.pool.query(
        'INSERT INTO versions (id, landscape_id, root_url) VALUES ($1, $2, $3)',
        [`ver-${n}`, `land-${n}`, `automerge:land-${n}-ver-${n}`],
      )
    }
  }

  const compacted = (): CompactionPassOutcome =>
    ({ ran: true, objectsFolded: 5, connectionsFolded: 2, reattach: 'reattached' })

  const cell = (
    cellId: string,
    overrides: Partial<Parameters<typeof createCompactionQueue>[0]> = {},
    leaseMs = 15 * 60 * 1_000,
  ) => createCompactionQueue({
    queue: dueWorkSeam(db.pool, cellId, leaseMs),
    killSwitch: () => true,
    measure: async () => ({ objects: 10, connections: 1 }),
    preview: async () => ({ folded: 3, deleted: 0 }),
    compact: async () => compacted(),
    log: () => undefined,
    warn: () => undefined,
    ...overrides,
  })

  const dueRows = async () => {
    const { rows } = await db.pool.query<{
      landscape_id: string
      claimed_by: string | null
      attempts: number
      completed_at: Date | null
    }>(
      `SELECT landscape_id, claimed_by, attempts, completed_at FROM maintenance_due_work
        WHERE job_name = $1 ORDER BY landscape_id`,
      [COMPACTION_JOB],
    )
    return rows
  }

  /** Rows still available to a future window — the only ones that matter to the
   *  claim scan. Completed rows are kept for their slot on purpose. */
  const openRows = async () => (await dueRows()).filter((row) => row.completed_at === null)

  it('proposes every ADMITTED workspace once per slot, and only those', async () => {
    await seed(3)
    const queue = cell('cell-a', { admit: (w: CompactionQueueWorkspace) => w.landscapeId !== 'land-2' })

    const first = await queue.tick()

    expect(first.enqueued).toBe(2)
    expect(first.compacted).toBe(2)
    // Both rows are MARKED completed and kept for this slot, so nothing is left
    // for a later window to claim. They are pruned once the slot has passed.
    expect(await openRows()).toEqual([])
    expect(await dueRows()).toHaveLength(2)
  })

  it('the slot DEDUPS across cells — two cells proposing the same window write one row', async () => {
    // The leaderless dedup: both cells may
    // propose, the unique key on the quantized slot collapses it. Tested with
    // `compact` blocked so the rows are still there to count.
    await seed(2)
    const blocked = { compact: async () => ({ ran: false as const, reason: 'skipped_locked' }) }
    const cellA = cell('cell-a', { ...blocked, windowCap: 0 })
    const cellB = cell('cell-b', { ...blocked, windowCap: 0 })

    const a = await cellA.tick()
    const b = await cellB.tick()

    expect(a.enqueued).toBe(2)
    expect(b.enqueued).toBe(0)
    expect((await dueRows()).map((row) => row.landscape_id)).toEqual(['land-1', 'land-2'])
  })

  it('BOUND (ii) against the real claim — the surplus is left UNCLAIMED, not claimed and refused', async () => {
    // The whole point of putting the cap on the claim: a row the window will not
    // work on must not carry this cell's lease, or it is invisible to every
    // other cell for the length of that lease.
    await seed(4)
    const queue = cell('cell-a', { windowCap: 2, compact: async () => ({ ran: false as const, reason: 'skipped_locked' }) })

    const tick = await queue.tick()

    expect(tick.claimed).toBe(2)
    const rows = await dueRows()
    expect(rows).toHaveLength(4)
    // The two the window declined to run were released; the two it never claimed
    // were never touched. Either way nothing is left leased.
    expect(rows.filter((row) => row.claimed_by !== null)).toEqual([])
    expect(rows.filter((row) => row.attempts > 0)).toHaveLength(2)
  })

  it('TWO CELLS DO NOT TAKE THE SAME WORKSPACE — `FOR UPDATE SKIP LOCKED`, not a leader', async () => {
    await seed(4)
    const seen: string[] = []
    const record = async (workspace: CompactionQueueWorkspace) => {
      seen.push(workspace.landscapeId)
      return compacted()
    }
    const cellA = cell('cell-a', { windowCap: 2, compact: record })
    const cellB = cell('cell-b', { windowCap: 2, compact: record })

    // Serially, because two Node clients on one pool would interleave their
    // statements unpredictably and this asserts about the OUTCOME, not the
    // interleaving: cell B must find only what cell A did not take.
    const a = await cellA.tick()
    const b = await cellB.tick()

    expect(a.compacted).toBe(2)
    expect(b.compacted).toBe(2)
    // FOUR DISTINCT workspaces, which is the property: no workspace was taken
    // twice while another was never taken. If completion DELETED the row, cell
    // B's sweep would re-create land-1 and land-2, sorted ahead of the two that
    // never ran, and the same pair would be compacted twice.
    expect(new Set(seen).size).toBe(4)
    expect(await openRows()).toEqual([])
  })

  it('THE SLOT IS A CADENCE — a completed workspace is NOT re-proposed inside the same slot', async () => {
    // The property `completeDueWork`'s marking exists for: with the row
    // deleted, the unique key on the quantized slot would have nothing to
    // collapse a re-proposal against, so the very next tick would re-enqueue
    // and RE-COMPACT the same workspace (24 destructive passes a day on an
    // hourly tick). The `nothing_to_fold` gate would absorb most of the cost,
    // but bounded waste is not the cadence the queue promises.
    await seed(1)
    let overlayHasWork = true
    const compactCalls: string[] = []
    const queue = cell('cell-a', {
      preview: async () => (overlayHasWork ? { folded: 3, deleted: 0 } : { folded: 0, deleted: 0 }),
      compact: async (workspace: CompactionQueueWorkspace) => {
        compactCalls.push(workspace.landscapeId)
        overlayHasWork = false
        return compacted()
      },
    })

    const first = await queue.tick()
    const second = await queue.tick()

    expect(first.compacted).toBe(1)
    expect(second.enqueued, 'the completed row must refuse the re-proposal').toBe(0)
    expect(second.claimed).toBe(0)
    expect(second.compacted).toBe(0)
    expect(compactCalls).toEqual(['land-1'])
  })

  it('the PRUNE frees the workspace once its slot has passed, and not before', async () => {
    // The other half. Without the prune the table would grow without bound;
    // with a prune that took the current slot too, the cadence above would
    // collapse.
    await seed(1)
    const day = 24 * 60 * 60 * 1_000
    let clock = new Date('2026-08-31T09:00:00.000Z')
    const compactCalls: string[] = []
    const queue = cell('cell-a', {
      intervalMs: day,
      now: () => clock,
      compact: async (workspace: CompactionQueueWorkspace) => {
        compactCalls.push(`${workspace.landscapeId}@${clock.toISOString()}`)
        return compacted()
      },
    })

    await queue.tick()
    clock = new Date('2026-08-31T23:00:00.000Z')   // same slot
    await queue.tick()
    expect(compactCalls).toHaveLength(1)

    clock = new Date('2026-09-01T01:00:00.000Z')   // next slot
    await queue.tick()

    expect(compactCalls).toHaveLength(2)
    // Yesterday's completed row was pruned by this tick's sweep, so the table is
    // still one row per workspace rather than one per workspace per day.
    expect(await dueRows()).toHaveLength(1)
  })

  it('A DEAD CELL RETURNS ITS WORK TO THE LEASE, with no reaper and no restart', async () => {
    // Lease expiry, exercised through the mutating job. `cell-dead`
    // claims with a lease of 1 ms and then never finishes; `cell-live` must be
    // able to take the same row once that deadline has passed.
    await seed(1)
    const dead = cell('cell-dead', { compact: async () => { throw new Error('cell died mid-pass') } }, 1)
    const deadTick = await dead.tick()
    expect(deadTick.failed).toBe(1)

    // The failure released it explicitly; to test the LEASE rather than the
    // release, re-claim it and leave it claimed with an expired deadline.
    await db.pool.query(
      `UPDATE maintenance_due_work SET claimed_by = 'cell-dead', claimed_until = NOW() - INTERVAL '1 second'
        WHERE job_name = $1`,
      [COMPACTION_JOB],
    )

    const live = cell('cell-live')
    const liveTick = await live.tick()

    expect(liveTick.compacted).toBe(1)
    expect(await openRows()).toEqual([])
  })

  it('a row still under a LIVE lease is not stolen', async () => {
    // The other direction, and the one that matters for a MUTATING job: if the
    // lease did not exclude, two cells would compact one workspace at once.
    await seed(1)
    await cell('cell-a', { compact: async () => ({ ran: false as const, reason: 'skipped_locked' }), windowCap: 0 }).tick()
    await db.pool.query(
      `UPDATE maintenance_due_work SET claimed_by = 'cell-a', claimed_until = NOW() + INTERVAL '1 hour'
        WHERE job_name = $1`,
      [COMPACTION_JOB],
    )

    const tick = await cell('cell-b').tick()

    expect(tick.claimed).toBe(0)
    expect(tick.compacted).toBe(0)
  })

  it('a POLICY refusal completes the row; a FAILURE holds it back with its reason', async () => {
    // The starvation argument, against the real claim: a refused workspace that
    // stayed OPEN would be re-claimed and turned away again in every window,
    // spending one of the cap's slots on nothing.
    await seed(2)
    const queue = cell('cell-a', {
      measure: async (w: CompactionQueueWorkspace) =>
        (w.landscapeId === 'land-1' ? { objects: 999_999, connections: 0 } : { objects: 1, connections: 0 }),
      compact: async () => { throw new Error('the pass exploded') },
      maxWorkspaceObjects: 1_000,
      retryAfterMs: 60_000,
    })

    const tick = await queue.tick()

    expect(tick.skipped).toBe(1)
    expect(tick.failed).toBe(1)
    // land-1 was refused on size and is CLOSED for this slot; land-2 failed and
    // stays open, carrying the error and its attempt count.
    expect((await openRows()).map((row) => row.landscape_id)).toEqual(['land-2'])
    const { rows } = await db.pool.query<{ last_error: string; held_back: boolean }>(
      `SELECT last_error, claimed_until > NOW() AS held_back FROM maintenance_due_work
        WHERE job_name = $1 AND landscape_id = 'land-2'`,
      [COMPACTION_JOB],
    )
    expect(rows[0]?.last_error).toBe('the pass exploded')
    // HELD BACK, not handed straight back: an immediate release on a mutating
    // job is a retry every tick on a pass that takes the read plane down.
    expect(rows[0]?.held_back, 'a failed unit must not be instantly re-claimable').toBe(true)
    expect((await cell('cell-b').tick()).claimed).toBe(0)
  })

  it('the SWITCH OFF leaves the table untouched — nothing proposed, nothing claimed', async () => {
    await seed(3)

    const tick = await cell('cell-a', { killSwitch: () => false }).tick()

    expect(tick.ran).toBe(false)
    expect(tick.refused).toBe('kill_switch')
    expect(await dueRows()).toEqual([])
  })
})
