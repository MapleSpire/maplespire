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
 * T-DIAGDEF — the background build of the static write-head index:
 *
 *  - CANCEL: `stop()` cancels a `CREATE INDEX CONCURRENTLY` in flight (from
 *        another connection) and, past its bound, destroys the connection:
 *        `pool.end()` no longer waits for the build;
 *  - RETRY: an attempt that did not end on a valid index is tried again,
 *        every `retryIntervalMs`, until one does; `stop()` ends the retries;
 *  - DESTROY ON FAILURE: a failed build, or a failed unlock, DESTROYS its
 *        connection: the session — and its advisory lock — never goes back
 *        to the pool;
 *  - DESTROY ON STOP: a STOPPED attempt destroys its connection whatever its
 *        outcome, so a cancel `stop()` sent never lands on another user of
 *        the pool.
 *
 * Its OWN database: advisory locks are per database, and the open snapshot of
 * the cancel test would hold every other suite's concurrent index build.
 */

import pg from 'pg'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import {
  ensureReadModelSchema,
  STATIC_MEMBERSHIP_HEAD_INDEX,
  StaticMembershipHeadIndexBuilder,
  startStaticMembershipHeadIndexBuild,
} from './schema.js'

const CONNECTION = process.env.TEST_DATABASE_URL
/** The cluster-wide key of the build (`schema.ts`), as the other cells use it. */
const STATIC_MEMBERSHIP_HEAD_INDEX_BUILD_KEY = 'maplespire:read-model:static-membership-head-index'

describe.skipIf(!CONNECTION)('T-DIAGDEF — the background head index build', () => {
  const database = `diagdef_builder_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let databaseUrl: string
  const pools: pg.Pool[] = []
  const newPool = (options = '', max = 4) => {
    const pool = guardIdleClientErrors(
      new pg.Pool({ connectionString: databaseUrl, max, ...(options ? { options } : {}) }), 'headIndexBuilderTest:pool')
    pools.push(pool)
    return pool
  }
  const indexState = async (): Promise<'valid' | 'invalid' | 'absent'> => {
    const { rows } = await admin.query<{ valid: boolean }>(
      `SELECT index.indisvalid AS valid FROM pg_index index JOIN pg_class class ON class.oid = index.indexrelid
        WHERE class.relname = $1`, [STATIC_MEMBERSHIP_HEAD_INDEX])
    return !rows[0] ? 'absent' : rows[0].valid ? 'valid' : 'invalid'
  }
  const dropIndex = async () => { await admin.query(`DROP INDEX IF EXISTS ${STATIC_MEMBERSHIP_HEAD_INDEX}`) }
  const buildsRunning = async () => (await admin.query(
    `SELECT pid FROM pg_stat_activity WHERE datname = $1 AND state = 'active' AND query ILIKE 'CREATE INDEX CONCURRENTLY%'`,
    [database])).rows
  const keyFree = async (): Promise<boolean> => {
    const probe = new pg.Client({ connectionString: databaseUrl })
    await probe.connect()
    try {
      const { rows } = await probe.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [STATIC_MEMBERSHIP_HEAD_INDEX_BUILD_KEY])
      return rows[0]!.locked
    } finally {
      await probe.end()
    }
  }
  const until = async (predicate: () => boolean | Promise<boolean>, ms: number, what: string) => {
    const by = Date.now() + ms
    while (!(await predicate())) {
      if (Date.now() > by) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  beforeAll(async () => {
    const server = new pg.Client({ connectionString: CONNECTION })
    await server.connect()
    await server.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
    await server.end()
    const url = new URL(CONNECTION!)
    url.pathname = `/${database}`
    databaseUrl = url.toString()
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    const setup = newPool()
    await ensureReadModelSchema(setup)
    await setup.query(
      `INSERT INTO read_model_static_membership_deltas (landscape_id, version_id, membership_kind, owner_id, entity_id, generation)
       SELECT 'ls-builder', 'head', 'registry_shard_diagram', 'head', 'dg-' || n, 1 FROM generate_series(1, 50) AS n`)
  }, 60_000)
  afterAll(async () => {
    for (const pool of pools) await pool.end().catch(() => undefined)
    await admin?.end().catch(() => undefined)
    const server = new pg.Client({ connectionString: CONNECTION })
    await server.connect()
    await server.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined)
    await server.end()
  }, 60_000)

  // ── cancel ──────────────────────────────────────────────────────────────
  it('stop() cancels the CREATE INDEX CONCURRENTLY in flight; pool.end() then returns at once', async () => {
    await dropIndex()
    // The build's CREATE waits 80 % of deadlock_timeout: ~48 s here.
    const pool = newPool('-c deadlock_timeout=60s')
    const holder = new pg.Client({ connectionString: databaseUrl })
    await holder.connect()
    try {
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await holder.query('SELECT 1') // an old snapshot the build must wait for
      const lines: string[] = []
      const builder = new StaticMembershipHeadIndexBuilder(pool, { log: (line) => lines.push(line) })
      builder.start()
      await until(async () => (await buildsRunning()).length === 1, 15_000, 'the build to wait on the snapshot')

      const stoppedAt = performance.now()
      const how = await builder.stop()
      const stopMs = performance.now() - stoppedAt
      const endedAt = performance.now()
      await pool.end()
      const endMs = performance.now() - endedAt
      console.log(JSON.stringify({ event: 'tdiagdef.builder_stop', how, stopMs: Math.round(stopMs), poolEndMs: Math.round(endMs), outcomes: builder.outcomes }))
      expect(how).toBe('cancelled')
      expect(stopMs).toBeLessThan(1_500)
      expect(endMs).toBeLessThan(1_000)
      expect(builder.outcomes).toEqual(['stopped'])
      expect(lines.some((line) => line.includes('"outcome":"stopped"'))).toBe(true)
      expect(await buildsRunning()).toEqual([]) // cancelled server-side, not orphaned
      expect(await builder.runOnce()).toBe('stopped') // no attempt after stop()
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    // The invalid index the cancelled build left is dropped by the next one.
    expect(['invalid', 'absent']).toContain(await indexState())
    expect(await startStaticMembershipHeadIndexBuild(newPool(), { log: () => undefined })).toBe('built')
    expect(await indexState()).toBe('valid')
  }, 60_000)

  it('past its bound, stop() destroys the build connection (the cancel could not be sent)', async () => {
    await dropIndex()
    const pool = newPool('-c deadlock_timeout=60s')
    // A pool whose OTHER connections are unavailable: the cancel never goes.
    const noCancel = { connect: () => pool.connect(), query: () => new Promise<never>(() => undefined) }
    const holder = new pg.Client({ connectionString: databaseUrl })
    await holder.connect()
    try {
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await holder.query('SELECT 1')
      const builder = new StaticMembershipHeadIndexBuilder(noCancel, { log: () => undefined })
      builder.start()
      await until(async () => (await buildsRunning()).length === 1, 15_000, 'the build to wait on the snapshot')
      const stoppedAt = performance.now()
      const how = await builder.stop(400)
      const stopMs = performance.now() - stoppedAt
      const endedAt = performance.now()
      await pool.end()
      const endMs = performance.now() - endedAt
      console.log(JSON.stringify({ event: 'tdiagdef.builder_stop_destroy', how, stopMs: Math.round(stopMs), poolEndMs: Math.round(endMs) }))
      expect(how).toBe('destroyed')
      expect(stopMs).toBeLessThan(1_000)
      expect(endMs).toBeLessThan(1_000)
      await until(() => builder.outcomes.length === 1, 5_000, 'the attempt to settle')
      expect(builder.outcomes).toEqual(['stopped'])
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    // The orphaned backend ends once the snapshot is gone.
    await until(async () => (await buildsRunning()).length === 0, 15_000, 'the orphaned build to end')
  }, 60_000)

  // ── retry ───────────────────────────────────────────────────────────────
  it('a skipped attempt is tried again until the index is valid, then no more', async () => {
    await dropIndex()
    const builder = new StaticMembershipHeadIndexBuilder(newPool(), { log: () => undefined, retryIntervalMs: 150 })
    const other = new pg.Client({ connectionString: databaseUrl })
    await other.connect()
    await other.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [STATIC_MEMBERSHIP_HEAD_INDEX_BUILD_KEY])
    let otherEnded = false
    try {
      builder.start()
      await until(() => builder.outcomes.length >= 2, 5_000, 'two attempts')
      expect(builder.outcomes.slice(0, 2)).toEqual(['skipped', 'skipped'])
      // The other cell dies without building: the next attempt builds.
      otherEnded = true
      await other.end()
      await until(() => builder.outcomes.includes('built'), 10_000, 'the retried build')
      expect(await indexState()).toBe('valid')
      const attempts = builder.outcomes.length
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(builder.outcomes.length).toBe(attempts) // valid: no further attempt
      expect(builder.outcomes.at(-1)).toBe('built')
    } finally {
      if (!otherEnded) await other.end().catch(() => undefined)
      expect(await builder.stop()).toBe('idle')
    }
  }, 60_000)

  it('stop() ends the retries', async () => {
    await dropIndex()
    const other = new pg.Client({ connectionString: databaseUrl })
    await other.connect()
    await other.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [STATIC_MEMBERSHIP_HEAD_INDEX_BUILD_KEY])
    try {
      const builder = new StaticMembershipHeadIndexBuilder(newPool(), { log: () => undefined, retryIntervalMs: 100 })
      builder.start()
      await until(() => builder.outcomes.length >= 1, 5_000, 'the first attempt')
      await builder.stop()
      const attempts = builder.outcomes.length
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(builder.outcomes.length).toBe(attempts)
      expect(builder.outcomes.every((outcome) => outcome === 'skipped')).toBe(true)
    } finally {
      await other.end()
    }
  }, 60_000)

  // ── destroy on failure ──────────────────────────────────────────────────
  /** A pool whose connections fail the statements `fail` matches, and record
   * what they were released with. */
  const failingPool = (fail: (text: string) => boolean) => {
    const pool = newPool()
    const releases: unknown[] = []
    return {
      releases,
      connect: async (): Promise<PoolClient> => {
        const client = await pool.connect()
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>
        ;(client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) => {
          const text = typeof args[0] === 'string' ? args[0] : ''
          if (fail(text)) return Promise.reject(Object.assign(new Error(`injected failure: ${text.slice(0, 40)}`), { code: 'XX000' }))
          return query(...args)
        }
        const release = client.release.bind(client)
        client.release = (error?: Error | boolean) => { releases.push(error); release(error) }
        return client
      },
    }
  }

  it('a failed build destroys its connection (never back to the pool)', async () => {
    await dropIndex()
    const pool = failingPool((text) => text.startsWith('CREATE INDEX CONCURRENTLY'))
    expect(await startStaticMembershipHeadIndexBuild(pool, { log: () => undefined })).toBe('failed')
    expect(pool.releases).toHaveLength(1)
    expect(pool.releases[0]).toBeInstanceOf(Error)
    expect(await keyFree()).toBe(true)
  }, 60_000)

  it('a failed unlock destroys the connection: the advisory key does not stay held', async () => {
    await dropIndex()
    const pool = failingPool((text) => text.includes('pg_advisory_unlock'))
    expect(await startStaticMembershipHeadIndexBuild(pool, { log: () => undefined })).toBe('built')
    // Before: `release()` — an idle pooled session still holding the key, and
    // every later attempt of every cell `skipped` while it lived.
    expect(await keyFree()).toBe(true)
    expect(pool.releases).toHaveLength(1)
    expect(pool.releases[0]).toBeInstanceOf(Error)
  }, 60_000)

  // ── destroy on stop ─────────────────────────────────────────────────────
  // The two outcomes that ended without looking at the stop: `already-valid`
  // (stopped while it read the catalogue) and `skipped` (stopped while it
  // tried the key another cell holds).
  for (const scenario of [
    { outcome: 'already-valid', gateOn: 'to_regclass', keyHeld: false, before: ['cancel', 'unlock', 'released-clean', 'cancel-delivered'], after: ['cancel', 'unlock', 'released-destroyed', 'cancel-delivered'] },
    { outcome: 'skipped', gateOn: 'pg_try_advisory_lock', keyHeld: true, before: ['cancel', 'released-clean', 'cancel-delivered'], after: ['cancel', 'released-destroyed', 'cancel-delivered'] },
  ] as const) it(`stop() during a ${scenario.outcome} attempt: the cancel never reaches another user of the pool`, async () => {
    // A VALID index and no legacy one: the attempt has no statement of its
    // own left to cancel when the cancel arrives.
    expect(await startStaticMembershipHeadIndexBuild(newPool(), { log: () => undefined })).not.toBe('failed')
    expect(await indexState()).toBe('valid')
    const holder = new pg.Client({ connectionString: databaseUrl })
    await holder.connect()
    if (scenario.keyHeld) await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [STATIC_MEMBERSHIP_HEAD_INDEX_BUILD_KEY])

    // The PRIMARY pool in miniature: ONE connection, so the next user gets
    // the build's backend if it came back clean.
    const primary = newPool('', 1)
    const canceller = new pg.Client({ connectionString: databaseUrl })
    await canceller.connect()
    const events: string[] = []
    const latch = () => { let open!: () => void; const opened = new Promise<void>((resolve) => { open = resolve }); return { open, opened } }
    const atCatalogue = latch()
    const catalogueGate = latch()
    const released = latch()
    const otherRunning = latch()
    let buildPid = 0
    let delivered: Promise<unknown> = Promise.resolve()
    const pool = {
      connect: async (): Promise<PoolClient> => {
        const client = await primary.connect()
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<{ rows: Array<{ pid: number }> }>
        ;(client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) => {
          const text = typeof args[0] === 'string' ? args[0] : ''
          if (text.includes(scenario.gateOn)) { atCatalogue.open(); return catalogueGate.opened.then(() => query(...args)) }
          if (text.includes('pg_advisory_unlock')) events.push('unlock')
          if (text.includes('pg_backend_pid')) return query(...args).then((result) => { buildPid = result.rows[0]!.pid; return result })
          return query(...args)
        }
        const release = client.release.bind(client)
        client.release = (error?: Error | boolean) => {
          events.push(error ? 'released-destroyed' : 'released-clean')
          release(error)
          released.open()
        }
        return client
      },
      // stop()'s cancel, delivered only once the attempt has given its
      // connection up and another user is in a query on the pool.
      query: (text: string, values?: unknown[]) => {
        if (!text.includes('pg_cancel_backend')) return primary.query(text, values)
        events.push('cancel')
        delivered = (async () => {
          await released.opened
          await otherRunning.opened
          const result = await canceller.query(text, values)
          events.push('cancel-delivered')
          return result
        })()
        return delivered
      },
    }
    try {
      const builder = new StaticMembershipHeadIndexBuilder(pool, { log: () => undefined })
      builder.start()
      await atCatalogue.opened
      const stopping = builder.stop() // the cancel leaves now, for the build's pid
      catalogueGate.open() // the attempt reads on, and ends
      await released.opened

      const other = await primary.connect()
      try {
        const { rows } = await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        const otherQuery = other.query('SELECT pg_sleep(0.6)').then(() => 'ok', (error: { code?: string }) => error.code ?? 'error')
        await new Promise((resolve) => setTimeout(resolve, 100))
        otherRunning.open()
        await delivered
        const otherOutcome = await otherQuery
        await stopping
        console.log(JSON.stringify({ event: 'tdiagdef.cancel_after_clean_release', scenario: scenario.outcome, events, outcomes: builder.outcomes, sameBackend: rows[0]!.pid === buildPid, otherOutcome }))
        expect(builder.outcomes).toEqual([scenario.outcome])
        // Before: `scenario.before` — the connection back in the pool CLEAN.
        expect(events).toEqual([...scenario.after])
        expect(rows[0]!.pid).not.toBe(buildPid) // the build's backend serves no one
        expect(otherOutcome).toBe('ok') // before: 57014, the other user's query cancelled
      } finally {
        other.release()
      }
    } finally {
      await canceller.end()
      await holder.end()
    }
  }, 60_000)
})
