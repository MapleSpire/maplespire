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

import { describe, it, expect, afterAll, vi } from 'vitest'
import pg from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { analyzeWithinCeiling, DERIVED_STATS_ANALYZED_TABLES } from './derivedStats.js'
import { coldBuildReadModel, type WorkspaceKey } from './projector.js'

/**
 * `analyzeWithinCeiling` against a real PostgreSQL: a rival transaction
 * holds `SHARE UPDATE EXCLUSIVE` on a table (what another ANALYZE holds to
 * its commit), so the bounded ANALYZE either times out at its ceiling
 * (55P03: skipped, recorded) or is cancelled while it waits (57014:
 * propagated). In both, the caller's transaction stays usable with its own
 * `lock_timeout`. Skips without DATABASE_URL.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 4, connectionTimeoutMillis: 3000 }), 'analyze-ceiling')
  try {
    const c = await p.connect()
    c.release()
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[readModel integration] no Postgres at ${URL} — skipping analyzeWithinCeiling tests`)

const WS: WorkspaceKey = { landscapeId: 'ws-analyze-ceiling', versionId: 'v1' }

/** Run `body` with `table` locked by a rival transaction; released after. */
async function withRivalLock<T>(table: string, body: () => Promise<T>): Promise<T> {
  const rival = await pool!.connect()
  try {
    await rival.query('BEGIN')
    await rival.query(`LOCK TABLE ${table} IN SHARE UPDATE EXCLUSIVE MODE`)
    return await body()
  } finally {
    await rival.query('ROLLBACK').catch(() => {})
    rival.release()
  }
}

suite('analyzeWithinCeiling (Postgres)', () => {
  afterAll(async () => {
    await pool!.end()
  })

  const inCallerTransaction = async <T>(body: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL lock_timeout = '7s'`)
      return await body(client)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }
  const lockTimeout = async (client: pg.PoolClient) =>
    (await client.query<{ t: string }>(`SELECT current_setting('lock_timeout') AS t`)).rows[0]!.t

  it('CONTROL: without a rival it runs, and the caller keeps its lock_timeout', async () => {
    await inCallerTransaction(async (client) => {
      const skipped: string[] = []
      // A GENEROUS ceiling: in a parallel run another suite's ANALYZE holds
      // this table's lock to its commit (measured: a 300 ms ceiling timed out
      // here in ci:local), and this arm is about the no-rival outcome.
      expect(await analyzeWithinCeiling(client, WS, ['ro_objects'], { skipped, lockWaitMs: 30_000 })).toBe(true)
      expect(skipped).toEqual([])
      expect(await lockTimeout(client)).toBe('7s')
    })
  })

  it('55P03 at the ceiling: skipped and recorded; the transaction is usable with the caller\'s lock_timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await inCallerTransaction(async (client) => {
        const skipped: string[] = []
        const started = performance.now()
        const ran = await withRivalLock('ro_objects', () => analyzeWithinCeiling(client, WS, ['ro_objects'], { skipped, lockWaitMs: 300 }))
        expect(ran).toBe(false)
        expect(performance.now() - started).toBeGreaterThanOrEqual(250)
        expect(skipped).toEqual(['ro_objects'])
        expect(await lockTimeout(client)).toBe('7s')
        // Not aborted: a statement still runs in it.
        expect((await client.query('SELECT 1 AS one')).rows[0]).toEqual({ one: 1 })
      })
    } finally {
      warn.mockRestore()
    }
  })

  it('57014 (cancelled while waiting) PROPAGATES; the savepoint is rolled back, the lock_timeout restored', async () => {
    await inCallerTransaction(async (client) => {
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      const skipped: string[] = []
      const outcome = await withRivalLock('ro_objects', async () => {
        const pending = analyzeWithinCeiling(client, WS, ['ro_objects'], { skipped, lockWaitMs: 20_000 })
          .then(() => null, (error: unknown) => error)
        // Cancel it once it is genuinely waiting on the lock.
        for (let attempt = 0; attempt < 200; attempt++) {
          const { rows } = await pool!.query<{ waiting: boolean }>(
            `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`, [pid])
          if (rows[0]?.waiting) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        await pool!.query('SELECT pg_cancel_backend($1)', [pid])
        return pending
      })
      expect((outcome as { code?: string } | null)?.code).toBe('57014')
      expect(skipped).toEqual([])
      expect(await lockTimeout(client)).toBe('7s')
      expect((await client.query('SELECT 1 AS one')).rows[0]).toEqual({ one: 1 })
    })
  })

  it('a cold build whose derived ANALYZE is skipped still builds, and records the eight tables', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await inCallerTransaction(async (client) => {
        const analyzeSkipped: string[] = []
        // ro_connection_flows: one of the eight, and the build only DELETEs
        // from it (RowExclusiveLock, no conflict with the rival).
        await withRivalLock('ro_connection_flows', () => coldBuildReadModel(client, WS, 'org-1',
          [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }], [], [], [],
          { analyzeSkipped, analyzeLockWaitMs: 300 }))
        expect(analyzeSkipped).toEqual([...DERIVED_STATS_ANALYZED_TABLES])
        const { rows } = await client.query<{ object_count: string; root_object_count: string }>(
          'SELECT object_count, root_object_count FROM ro_workspace_stats WHERE landscape_id = $1 AND version_id = $2',
          [WS.landscapeId, WS.versionId])
        expect(rows.map((row) => [Number(row.object_count), Number(row.root_object_count)])).toEqual([[2, 1]])
      })
    } finally {
      warn.mockRestore()
    }
  })
})
