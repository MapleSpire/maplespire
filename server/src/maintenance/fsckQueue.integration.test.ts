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
import { Repo } from '@automerge/automerge-repo'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureMaintenanceSchema } from './schema.js'
import { enqueueFsckSweep, recordFsckReport, runFsckQueueTick, FSCK_JOB } from './fsckQueue.js'
import type { WorkspaceFsckReport } from './workspaceFsck.js'

/**
 * The read-only fsck queue.
 *
 * THE KEY PROPERTY: fsck findings appear for NON-DEFAULT workspaces without
 * human intervention.
 *
 * WHY READ-ONLY. It separates proving the QUEUE from proving the LOCK: a
 * double-claim, a starved workspace or a lost lease shows up here, where the
 * worst outcome is a wrong row in a findings table.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('the read-only fsck queue (T-27)', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'fsck_queue')
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
    await db.pool.query('DELETE FROM workspace_fsck_finding')
    await db.pool.query('DELETE FROM versions')
  })

  const seed = async (rows: Array<[string, string]>) => {
    for (const [landscape, version] of rows) {
      await db.pool.query(
        'INSERT INTO versions (id, landscape_id, root_url) VALUES ($1, $2, $3)',
        [version, landscape, `automerge:${landscape}-${version}`],
      )
    }
  }

  it('enqueues EVERY maintainable workspace, not just the default one', async () => {
    // The heart of the property: a sweep must not only ever visit `default`.
    await seed([['default', 'v1'], ['other-landscape', 'v1'], ['third', 'v9']])
    const enqueued = await enqueueFsckSweep(db.pool, { intervalMs: 3_600_000 })
    expect(enqueued).toBe(3)

    const { rows } = await db.pool.query<{ landscape_id: string }>(
      'SELECT landscape_id FROM maintenance_due_work WHERE job_name = $1 ORDER BY landscape_id',
      [FSCK_JOB],
    )
    expect(rows.map((r) => r.landscape_id)).toEqual(['default', 'other-landscape', 'third'])
  })

  it('a second sweep in the same slot adds nothing — every cell may tick', async () => {
    // The dedup that removes leader election: both cells call this, one row
    // results. Without it, N cells would enqueue N copies of every workspace.
    await seed([['default', 'v1'], ['other', 'v1']])
    expect(await enqueueFsckSweep(db.pool, { intervalMs: 3_600_000 })).toBe(2)
    expect(await enqueueFsckSweep(db.pool, { intervalMs: 3_600_000 })).toBe(0)

    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM maintenance_due_work',
    )
    expect(rows[0]!.n).toBe('2')
  })

  it('a LATER slot re-enqueues — the sweep recurs rather than being deduped for ever', async () => {
    await seed([['default', 'v1']])
    const hour = 3_600_000
    expect(await enqueueFsckSweep(db.pool, {
      intervalMs: hour, now: () => new Date('2026-01-01T01:10:00Z'),
    })).toBe(1)
    expect(await enqueueFsckSweep(db.pool, {
      intervalMs: hour, now: () => new Date('2026-01-01T02:10:00Z'),
    })).toBe(1)
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM maintenance_due_work',
    )
    expect(rows[0]!.n).toBe('2')
  })

  it('a tick is BOUNDED — it claims its batch and no more', async () => {
    // A critical section is only safe once its duration is known, and an
    // unbounded tick has no known duration.
    await seed([['a', 'v1'], ['b', 'v1'], ['c', 'v1'], ['d', 'v1'], ['e', 'v1']])
    const tick = await runFsckQueueTick(db.pool, new Repo({}), 'cell-a', {
      intervalMs: 3_600_000, batchSize: 2,
    })
    expect(tick.enqueued).toBe(5)
    expect(tick.claimed, 'the tick claimed more than its batch').toBe(2)

    // THE REST STAY QUEUED AND UNTOUCHED — asserted on `attempts`, not on a row
    // count: the two claimed workspaces have no real Automerge documents here,
    // so their checks throw and the rows are RELEASED rather than completed.
    // The property under test is that a tick touches only its batch, which is
    // about what it ATTEMPTED.
    const { rows } = await db.pool.query<{ attempts: number; n: string }>(
      `SELECT attempts, count(*)::text AS n FROM maintenance_due_work
        GROUP BY attempts ORDER BY attempts`,
    )
    expect(rows.map((r) => [r.attempts, Number(r.n)]), 'a tick touched rows outside its batch')
      .toEqual([[0, 3], [1, 2]])
  })

  it('a workspace deleted between enqueue and claim is COMPLETED, not retried for ever', async () => {
    // And it is counted apart from `checked`: nothing was examined, so calling
    // it checked would be the table asserting something nobody looked at.
    await seed([['ghost', 'v1']])
    await enqueueFsckSweep(db.pool, { intervalMs: 3_600_000 })
    await db.pool.query('DELETE FROM versions')

    const tick = await runFsckQueueTick(db.pool, new Repo({}), 'cell-a', { intervalMs: 3_600_000 })
    expect(tick.vanished).toBe(1)
    expect(tick.checked).toBe(0)
    expect(tick.failed).toBe(0)
    // MARKED COMPLETED, not deleted: with the row gone, the unique key on the
    // quantized slot would have nothing to collapse a re-proposal against, and
    // the very next tick would re-enqueue and re-check the same workspace.
    const { rows } = await db.pool.query<{ n: string; completed: boolean }>(
      'SELECT count(*)::text AS n, bool_and(completed_at IS NOT NULL) AS completed FROM maintenance_due_work',
    )
    expect(rows[0]!.n).toBe('1')
    expect(rows[0]!.completed, 'a vanished workspace must not be retried for ever').toBe(true)
    const again = await runFsckQueueTick(db.pool, new Repo({}), 'cell-a', { intervalMs: 3_600_000 })
    expect(again.claimed, 'the completed row must not be claimable again in this slot').toBe(0)
  })

  it('THE FINDING LANDS IN THE TABLE, for a non-default workspace', async () => {
    // The criterion, stated as a row: a report reaches durable storage where an
    // operator can find it, without anybody having run anything by hand.
    const report: WorkspaceFsckReport = {
      workspace: { landscapeId: 'other-landscape', versionId: 'v1' },
      rootUrl: 'automerge:x',
      status: 'violations',
      findings: [
        { check: 'shared-root', severity: 'error', detail: 'two versions share a root' },
        { check: 'shared-root', severity: 'error', detail: 'and again' },
      ],
      checksRun: ['shared-root'],
      checksSkipped: [],
      reachableDocuments: 3,
    } as unknown as WorkspaceFsckReport

    await recordFsckReport(db.pool, report, 'cell-a')
    const { rows } = await db.pool.query<{
      status: string; finding_count: number; finding_codes: string[]; observed_by: string
    }>('SELECT status, finding_count, finding_codes, observed_by FROM workspace_fsck_finding')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'violations', finding_count: 2, observed_by: 'cell-a' })
    // DEDUPED CODES: two findings of one kind are one code, so an operator reads
    // "shared roots" rather than a list with the same word twice.
    expect(rows[0]!.finding_codes).toEqual(['shared-root'])
  })

  it('a re-check REPLACES the row — the table is current state, not a log', async () => {
    // An append-only table would grow without bound and bury the answer to the
    // only question it exists for: what is wrong NOW.
    const base = {
      workspace: { landscapeId: 'L1', versionId: 'v1' },
      rootUrl: 'automerge:x',
      findings: [],
      checksRun: [],
      checksSkipped: [],
      reachableDocuments: 0,
    }
    await recordFsckReport(db.pool, { ...base, status: 'violations', findings: [
      { check: 'shared-root', severity: 'error', detail: 'x' },
    ] } as unknown as WorkspaceFsckReport, 'cell-a')
    await recordFsckReport(db.pool, { ...base, status: 'clean' } as unknown as WorkspaceFsckReport, 'cell-b')

    const { rows } = await db.pool.query<{ status: string; finding_count: number; observed_by: string }>(
      'SELECT status, finding_count, observed_by FROM workspace_fsck_finding',
    )
    expect(rows, 'the table grew a second row — it is a log, not current state').toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'clean', finding_count: 0, observed_by: 'cell-b' })
  })
})
