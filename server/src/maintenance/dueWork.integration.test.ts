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
  claimDueWork,
  completeDueWork,
  enqueueDueWork,
  pruneCompletedDueWork,
  quantizeSlot,
  releaseDueWork,
} from './dueWork.js'

/**
 * Per-workspace due work, claimed under a lease.
 *
 * IT MUST BE AN INTEGRATION TEST. Every property here is PostgreSQL semantics:
 * `ON CONFLICT DO NOTHING` against a real unique key, `FOR UPDATE SKIP LOCKED`
 * between two real transactions, and a lease compared against the server's own
 * `NOW()`. A fake pool would be a re-implementation of exactly the behaviour
 * under test.
 *
 * WHAT IT REPLACES: one advisory lock per job NAME, cluster-wide, so compacting
 * one workspace blocked compacting every other on every cell.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('per-workspace due work (T-24)', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'maintenance_due_work')
    await ensureMaintenanceSchema(db.pool)
  }, 120_000)

  afterAll(async () => { await db?.teardown() })

  beforeEach(async () => { await db.pool.query('DELETE FROM maintenance_due_work') })

  const key = (landscapeId: string, versionId = 'v1') => ({
    job: 'default_compaction' as const, landscapeId, versionId,
  })

  it('quantizes on the EPOCH, not on calendar fields', () => {
    // The dedup key: two cells must compute the same slot for the same instant,
    // or the unique index collapses nothing.
    //
    // THE HOUR CASE CANNOT TELL THE TWO APART ON THIS HOST, and a mutant proved
    // it: truncating to the local hour (`setMinutes(0,0,0)`) gives identical
    // answers to epoch arithmetic wherever the zone is a whole-hour offset from
    // UTC — which Toronto is. The calendar version only diverges in a
    // half-hour-offset zone, or across a DST change, so a test written at one
    // hour in this timezone asserts nothing about the property it names.
    //
    // A NON-HOUR interval separates them everywhere: epoch arithmetic lands on
    // 90-minute boundaries from the epoch, calendar truncation always lands on
    // the hour.
    const ninety = 90 * 60_000
    expect(quantizeSlot(new Date('2026-01-01T02:45:00.000Z'), ninety).toISOString())
      .toBe('2026-01-01T01:30:00.000Z')

    // ...and the general property, which no calendar truncation can satisfy:
    // every slot is an exact multiple of the interval from the epoch. That is
    // what makes two cells in DIFFERENT zones agree.
    for (const interval of [ninety, 7 * 60_000, 3_600_000]) {
      for (const at of ['2026-03-08T06:59:59.999Z', '2026-07-04T13:22:31.500Z', '2026-11-01T05:30:00.000Z']) {
        const slot = quantizeSlot(new Date(at), interval)
        expect(
          slot.getTime() % interval,
          `slot for ${at} at ${interval}ms is not aligned to the epoch — two zones would disagree`,
        ).toBe(0)
        expect(slot.getTime()).toBeLessThanOrEqual(new Date(at).getTime())
      }
    }
    expect(() => quantizeSlot(new Date(), 0)).toThrow('positive number')
  })

  it('two cells proposing the same work produce ONE row, with no leader', async () => {
    // Both cells call this on their own tick; the unique key collapses
    // them. Exactly one insert reports having created the row, and the loser is
    // not disadvantaged — neither has any privilege over it afterwards.
    const slot = quantizeSlot(new Date(), 3_600_000)
    const first = await enqueueDueWork(db.pool, key('L1'), slot)
    const second = await enqueueDueWork(db.pool, key('L1'), slot)

    expect([first, second].filter(Boolean)).toHaveLength(1)
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM maintenance_due_work',
    )
    expect(rows[0]!.n).toBe('1')
  })

  it('a DIFFERENT slot is different work — the queue is not permanently deduped', async () => {
    // The other half of the dedup, and the half a naive unique key gets wrong: dedup
    // must collapse proposals WITHIN a window, not suppress the work for ever.
    const hour = 3_600_000
    await enqueueDueWork(db.pool, key('L1'), quantizeSlot(new Date('2026-01-01T01:30:00Z'), hour))
    await enqueueDueWork(db.pool, key('L1'), quantizeSlot(new Date('2026-01-01T02:30:00Z'), hour))
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM maintenance_due_work',
    )
    expect(rows[0]!.n).toBe('2')
  })

  it('TWO WORKSPACES ARE CLAIMED CONCURRENTLY — the point of the whole task', async () => {
    // THE DEFECT THIS REPLACES, stated as a test. With one advisory lock per job
    // name, the second cell would block on the first until it finished. Here it
    // takes a DIFFERENT row and proceeds.
    const slot = quantizeSlot(new Date(), 3_600_000)
    await enqueueDueWork(db.pool, key('L1'), slot)
    await enqueueDueWork(db.pool, key('L2'), slot)

    // Two real transactions, both open at once — the only way to observe
    // SKIP LOCKED rather than assume it.
    const a = await db.pool.connect()
    const b = await db.pool.connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      const claimedByA = await claimDueWork(a, 'default_compaction', 'cell-a', 60_000, 1)
      const claimedByB = await claimDueWork(b, 'default_compaction', 'cell-b', 60_000, 1)

      expect(claimedByA).toHaveLength(1)
      expect(claimedByB, 'the second cell blocked or came back empty — SKIP LOCKED is not in effect')
        .toHaveLength(1)
      expect(claimedByA[0]!.landscapeId).not.toBe(claimedByB[0]!.landscapeId)
      await a.query('COMMIT')
      await b.query('COMMIT')
    } finally {
      a.release()
      b.release()
    }
  })

  it('a claimed row is not handed to a second claimant while its lease holds', async () => {
    const slot = quantizeSlot(new Date(), 3_600_000)
    await enqueueDueWork(db.pool, key('L1'), slot)

    expect(await claimDueWork(db.pool, 'default_compaction', 'cell-a', 60_000)).toHaveLength(1)
    expect(await claimDueWork(db.pool, 'default_compaction', 'cell-b', 60_000)).toEqual([])
  })

  it('A DEAD CELL RETURNS ITS CLAIM TO THE LEASE, not to a restart', async () => {
    // THE EXIT CRITERION. Nothing here notices the death, runs a reaper, or
    // restarts anything: the deadline passes and the row is claimable again.
    const slot = quantizeSlot(new Date(), 3_600_000)
    await enqueueDueWork(db.pool, key('L1'), slot)

    // A lease of 1 ms stands in for a cell that died the instant it claimed.
    const claimed = await claimDueWork(db.pool, 'default_compaction', 'cell-that-dies', 1)
    expect(claimed).toHaveLength(1)
    // The lease is compared against the SERVER's clock, so let the server pass it.
    await db.pool.query("SELECT pg_sleep(0.05)")

    const recovered = await claimDueWork(db.pool, 'default_compaction', 'cell-b', 60_000)
    expect(recovered, 'the row was not reclaimable after its lease expired').toHaveLength(1)
    // ...and the attempt count carries across, so a row that keeps being claimed
    // and lost is visible as such rather than looking brand new each time.
    expect(recovered[0]!.attempts).toBe(2)
  })

  it('completing the work deletes the row; releasing it hands it straight back', async () => {
    const slot = quantizeSlot(new Date(), 3_600_000)
    await enqueueDueWork(db.pool, key('L1'), slot)
    const [claim] = await claimDueWork(db.pool, 'default_compaction', 'cell-a', 60_000)

    await releaseDueWork(db.pool, { ...claim! }, 'compaction threw')
    const retried = await claimDueWork(db.pool, 'default_compaction', 'cell-b', 60_000)
    expect(retried, 'a released row must be immediately claimable, not held to its lease')
      .toHaveLength(1)
    // The error travels ON THE ROW, because the next claimant is a different
    // process and "why did this fail" is otherwise only in a log somebody has to
    // find.
    const { rows } = await db.pool.query<{ last_error: string }>(
      'SELECT last_error FROM maintenance_due_work',
    )
    expect(rows[0]!.last_error).toBe('compaction threw')

    // COMPLETION MARKS THE ROW; IT DOES NOT DELETE IT. A deleted row would let
    // the workspace be re-proposed inside its own window — a unique key can only
    // collapse a proposal against a row that still exists. The row survives,
    // and it is NOT CLAIMABLE.
    await completeDueWork(db.pool, { ...claim! })
    const { rows: after } = await db.pool.query<{ n: string; completed: boolean }>(
      'SELECT count(*)::text AS n, bool_and(completed_at IS NOT NULL) AS completed FROM maintenance_due_work',
    )
    expect(after[0]!.n, 'a completed row is kept for its slot, so it cannot be re-proposed').toBe('1')
    expect(after[0]!.completed).toBe(true)
    expect(
      await claimDueWork(db.pool, 'default_compaction', 'cell-c', 60_000, 5),
      'a completed row must never be claimable again',
    ).toEqual([])
  })

  it('the claim orders FRESH work ahead of work that keeps failing', async () => {
    // The anti-starvation half of the claim order, and it is asserted in BOTH
    // insertion orders on purpose. Under the mutant that drops `attempts` from
    // the ORDER BY, every row shares a slot and PostgreSQL is free to return them
    // in any order — in practice heap order, i.e. insertion order. A single-arm
    // test would therefore pass by luck in one of the two arrangements. With
    // both arms, the mutant must get one of them wrong.
    const slot = new Date(Date.UTC(2026, 0, 1))
    for (const [first, second] of [['tired', 'fresh'], ['fresh', 'tired']] as const) {
      await db.pool.query('DELETE FROM maintenance_due_work')
      for (const name of [first, second]) {
        await enqueueDueWork(db.pool, { job: 'default_compaction', landscapeId: name, versionId: 'v1' }, slot)
      }
      await db.pool.query(
        "UPDATE maintenance_due_work SET attempts = 9 WHERE landscape_id = 'tired'",
      )

      const [claim] = await claimDueWork(db.pool, 'default_compaction', 'cell-a', 60_000, 1)

      expect(claim?.landscapeId, `inserted ${first} then ${second}`).toBe('fresh')
    }
  })

  it('a completed row is PRUNED once its slot has passed, so the table stays bounded', async () => {
    // The other half of marking rather than deleting. Without this the claim
    // scan walks an ever-growing completed tail, which is the exact objection
    // the original DELETE existed to answer.
    const older = new Date(Date.UTC(2026, 0, 1))
    const newer = new Date(Date.UTC(2026, 0, 2))
    const key = { job: 'default_compaction' as const, landscapeId: 'land', versionId: 'v1' }
    await enqueueDueWork(db.pool, key, older)
    const [claim] = await claimDueWork(db.pool, 'default_compaction', 'cell-a', 60_000, 1)
    await completeDueWork(db.pool, { ...claim! })
    await enqueueDueWork(db.pool, key, newer)

    const pruned = await pruneCompletedDueWork(db.pool, 'default_compaction', newer)

    expect(pruned).toBe(1)
    const { rows } = await db.pool.query<{ slot: Date }>('SELECT slot FROM maintenance_due_work')
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0]!.slot).toISOString()).toBe(newer.toISOString())
  })

  it('the prune leaves the CURRENT slot alone, completed or not', async () => {
    // Pruning the current slot would delete the very record that stops a
    // workspace being proposed again inside its own window — the defect the
    // marking was introduced to fix, reintroduced by its own cleanup.
    const slot = new Date(Date.UTC(2026, 0, 2))
    const key = { job: 'default_compaction' as const, landscapeId: 'land', versionId: 'v1' }
    await enqueueDueWork(db.pool, key, slot)
    const [claim] = await claimDueWork(db.pool, 'default_compaction', 'cell-a', 60_000, 1)
    await completeDueWork(db.pool, { ...claim! })

    expect(await pruneCompletedDueWork(db.pool, 'default_compaction', slot)).toBe(0)
    expect(await enqueueDueWork(db.pool, key, slot), 're-proposal inside the same slot must be refused')
      .toBe(false)
  })

  it('one job does not claim another job\'s work', async () => {
    const slot = quantizeSlot(new Date(), 3_600_000)
    await enqueueDueWork(db.pool, { job: 'automerge_gc', landscapeId: 'L1', versionId: 'v1' }, slot)
    expect(await claimDueWork(db.pool, 'default_compaction', 'cell-a', 60_000)).toEqual([])
    expect(await claimDueWork(db.pool, 'automerge_gc', 'cell-a', 60_000)).toHaveLength(1)
  })
})
