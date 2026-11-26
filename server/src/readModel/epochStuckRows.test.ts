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

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MetricSample } from '../runtime/metrics.js'
import {
  CLIENT_DEADLINE_CODE,
  CLIENT_DEADLINE_MARGIN_MS,
  EPOCH_STUCK_REPOINTING_AFTER_MS,
  EPOCH_STUCK_SAMPLE_STALE_MS,
  EPOCH_STUCK_SAMPLE_TIMEOUT_MS,
  EpochStuckRowsSampler,
  epochStuckRowsMetricSamples,
  epochStuckSampleStaleMs,
  poolConnectionTimeoutMs,
  queryWithStatementTimeout,
  startEpochStuckRowsSampler,
  stuckRepointingRows,
} from './epochStuckRows.js'

type Row = { landscape_id: string; version_id: string; epoch_no: number; meta_url: string | null; stuck_seconds: number }

/** A pool double: every connect hands out a client that answers the
 * transaction statements and runs `rows()` for the sample query. */
const fakeDb = (rows: () => Row[] | Error | Promise<Row[]>) => {
  const statements: string[] = []
  const released: Array<Error | undefined> = []
  let connects = 0
  return {
    statements, released, connects: () => connects,
    connect: async () => {
      connects += 1
      return {
        query: async (sql: string) => {
          statements.push(sql)
          if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] }
          const r = await rows()
          if (r instanceof Error) throw r
          return { rows: r }
        },
        release: (error?: Error) => { released.push(error) },
      }
    },
  }
}
const row = (landscape: string, epoch: number, seconds: number): Row =>
  ({ landscape_id: landscape, version_id: 'V', epoch_no: epoch, meta_url: `automerge:${landscape}${epoch}`, stuck_seconds: seconds })
const value = (samples: MetricSample[], name: string) => samples.find((m) => m.name === name)?.values[0]?.value
const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('G4-16j (decision b) — epoch rows stuck repointing', () => {
  it('the gauge counts the rows the query returns, and the oldest age', async () => {
    let rows: Row[] = [row('L1', 2, 700), row('L2', 5, 1_800)]
    const sampler = new EpochStuckRowsSampler(fakeDb(() => rows), () => true, () => undefined)
    await sampler.sample()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(2)
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing_oldest_seconds')).toBe(1_800)
    rows = []
    await sampler.sample()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(0)
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing_oldest_seconds')).toBe(0)
  })

  it('asks for repointing rows of existing versions older than the constant, under a statement timeout', async () => {
    const db = fakeDb(() => [])
    await stuckRepointingRows(db)
    const query = db.statements.find((s) => s.includes('read_model_model_epochs'))!
    expect(query).toMatch(/e\.state = 'repointing'/)
    expect(query).toMatch(/updated_at < now\(\) - make_interval/)
    expect(query).toMatch(/EXISTS \(SELECT 1 FROM versions v WHERE v\.landscape_id = e\.landscape_id AND v\.id = e\.version_id\)/)
    expect(db.statements).toEqual(['BEGIN', `SET LOCAL statement_timeout = '${EPOCH_STUCK_SAMPLE_TIMEOUT_MS}ms'`, query, 'COMMIT'])
    expect(db.released).toEqual([undefined])
    expect(EPOCH_STUCK_REPOINTING_AFTER_MS).toBe(10 * 60_000)
  })

  it('a failed statement rolls back and gives the client back; a failed rollback destroys it', async () => {
    const db = fakeDb(() => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))
    await expect(queryWithStatementTimeout(db, 'SELECT 1', [], 10)).rejects.toThrow(/statement timeout/)
    expect(db.statements.at(-1)).toBe('ROLLBACK')
    expect(db.released).toEqual([undefined])
    const broken = new Error('connection lost')
    const dead = {
      connect: async () => ({
        query: async (sql: string) => { if (sql === 'BEGIN') return { rows: [] }; throw broken },
        release: vi.fn(),
      }),
    }
    const client = await dead.connect()
    const db2 = { connect: async () => client }
    await expect(queryWithStatementTimeout(db2 as never, 'SELECT 1', [], 10)).rejects.toBe(broken)
    expect(client.release).toHaveBeenCalledWith(broken)
  })

  it('NaN before the first sample and after a failed one — even after a good one —, the failure counted; no table reads as none', async () => {
    let result: Row[] | Error = [row('L1', 2, 700), row('L2', 3, 900)]
    const sampler = new EpochStuckRowsSampler(fakeDb(() => result), () => true, () => undefined)
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBeNaN()
    await sampler.sample()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(2)
    quiet()
    result = new Error('db down')
    await sampler.sample()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBeNaN()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing_oldest_seconds')).toBeNaN()
    expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_sample_failures_total')).toBe(1)
    result = Object.assign(new Error('no table'), { code: '42P01' })
    await sampler.sample()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(0)
  })

  it('ONE sample in flight: a tick that finds one running is skipped and counted, never a second client', async () => {
    let release!: (rows: Row[]) => void
    let held = true
    const db = fakeDb(() => (held ? new Promise<Row[]>((resolve) => { held = false; release = resolve }) : []))
    const sampler = new EpochStuckRowsSampler(db, () => true, () => undefined)
    const first = sampler.sample()
    await new Promise((resolve) => setImmediate(resolve))
    await sampler.sample()
    await sampler.sample()
    expect(db.connects()).toBe(1)
    expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_samples_skipped_total')).toBe(2)
    release([row('L1', 2, 700)])
    await first
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1)
    await sampler.sample()
    expect(db.connects()).toBe(2) // free again once the first one ended
  })

  it('a query the server never answers: the client deadline releases WITH an error, once; a late settle changes nothing', async () => {
    vi.useFakeTimers()
    let settle!: (rows: Row[]) => void
    const released: Array<Error | undefined> = []
    const client = {
      query: (sql: string) => (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)
        ? Promise.resolve({ rows: [] })
        : new Promise((resolve) => { settle = (rows) => resolve({ rows }) })),
      release: (error?: Error) => { released.push(error) },
    }
    const pending = queryWithStatementTimeout({ connect: async () => client } as never, 'SELECT 1', [], EPOCH_STUCK_SAMPLE_TIMEOUT_MS)
    const outcome = pending.then(() => 'resolved', (e: { code?: string }) => e.code)
    await vi.advanceTimersByTimeAsync(EPOCH_STUCK_SAMPLE_TIMEOUT_MS + CLIENT_DEADLINE_MARGIN_MS - 1)
    expect(released).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe(CLIENT_DEADLINE_CODE)
    expect(released).toHaveLength(1)
    expect(released[0]).toBeInstanceOf(Error)
    settle([row('L1', 2, 700)]) // the abandoned query answers at last
    await vi.advanceTimersByTimeAsync(0)
    expect(released).toHaveLength(1) // never released twice
  })

  it('a sample that never settles: NaN past its client deadline, abandoned and counted after the stale bound, its late answer ignored', async () => {
    vi.useFakeTimers()
    quiet()
    // The first connect() hangs: the part of a sample the client deadline
    // does not cover (the pool bounds it, but the sampler must not trust that).
    const late = fakeDb(() => [row('OLD-A', 1, 700), row('OLD-B', 2, 700)])
    let handFirst!: () => void
    const fresh = fakeDb(() => [row('NEW', 1, 700)])
    let connects = 0
    const db = {
      connect: async () => {
        connects += 1
        if (connects === 1) {
          await new Promise<void>((resolve) => { handFirst = resolve })
          return late.connect()
        }
        return fresh.connect()
      },
    }
    const sampler = new EpochStuckRowsSampler(db, () => true, () => undefined)
    const first = sampler.sample()
    await vi.advanceTimersByTimeAsync(0)
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBeNaN() // no answer yet
    // Past the client deadline: NaN, never a last value (seeded here by none).
    await vi.advanceTimersByTimeAsync(EPOCH_STUCK_SAMPLE_TIMEOUT_MS + CLIENT_DEADLINE_MARGIN_MS + 1)
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBeNaN()
    // Before the stale bound a tick is skipped; past it, the hung sample is
    // abandoned (a failure) and a new one runs.
    await sampler.sample()
    expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_samples_skipped_total')).toBe(1)
    await vi.advanceTimersByTimeAsync(EPOCH_STUCK_SAMPLE_STALE_MS)
    await sampler.sample()
    expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_sample_failures_total')).toBe(1)
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1) // NEW
    // The abandoned one gets its client at last and answers: ignored, its
    // client released once.
    handFirst()
    await first
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1)
    expect(late.released).toEqual([undefined])
  })

  describe('an abandoned sample that settles LATE', () => {
    type Pending = { resolve: (client: unknown) => void; reject: (error: Error) => void }
    const okRows: Row[] = [row('L', 1, 700)]
    const clientOf = (rows: Row[] | Error) => ({
      query: async (sql: string) => {
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] }
        if (rows instanceof Error) throw rows
        return { rows }
      },
      release: () => undefined,
    })
    const setup = () => {
      let clock = 0
      const pending: Pending[] = []
      let connects = 0
      const db = { connect: () => { connects += 1; return new Promise<unknown>((resolve, reject) => pending.push({ resolve, reject })) } }
      const sampler = new EpochStuckRowsSampler(db as never, () => true, () => undefined, () => clock)
      return { sampler, pending, connects: () => connects, at: (ms: number) => { clock = ms } }
    }

    it('a late SUCCESS of A neither clears B\'s token nor overwrites B: the next tick is skipped, B\'s answer kept (kills X1)', async () => {
      quiet()
      const { sampler, pending, connects, at } = setup()
      const a = sampler.sample() // A: its connect hangs
      at(EPOCH_STUCK_SAMPLE_STALE_MS + 5_000)
      const b = sampler.sample() // A abandoned, B starts and hangs
      pending[0]!.resolve(clientOf([])) // A answers at last: 0 rows
      await a
      expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBeNaN() // A's 0 not written
      at(EPOCH_STUCK_SAMPLE_STALE_MS + 6_000)
      await sampler.sample() // B still in flight: skipped, no second client
      expect(connects()).toBe(2)
      expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_samples_skipped_total')).toBe(1)
      pending[1]!.resolve(clientOf(okRows))
      await b
      expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1)
    })

    it('a late FAILURE of A is not counted again and does not stamp the snapshot (kills X8)', async () => {
      quiet()
      const { sampler, pending, at } = setup()
      const a = sampler.sample()
      at(EPOCH_STUCK_SAMPLE_STALE_MS + 5_000)
      const b = sampler.sample()
      expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_sample_failures_total')).toBe(1) // the abandonment
      const sampledAt = sampler.snapshot().sampledAt
      at(EPOCH_STUCK_SAMPLE_STALE_MS + 7_000)
      pending[0]!.reject(new Error('late failure'))
      await a
      expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_sample_failures_total')).toBe(1)
      expect(sampler.snapshot().sampledAt).toBe(sampledAt)
      pending[1]!.resolve(clientOf(okRows))
      await b
      expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1)
    })
  })

  it('the abandon bound follows the pool\'s own connect patience, never shorter', async () => {
    quiet()
    expect(epochStuckSampleStaleMs(10_000)).toBe(EPOCH_STUCK_SAMPLE_STALE_MS)
    expect(EPOCH_STUCK_SAMPLE_STALE_MS).toBe(20_000)
    // A pool that waits 30 s for a client: the bound is 40 s.
    let clock = 0
    let connects = 0
    const db = { options: { connectionTimeoutMillis: 30_000 }, connect: () => { connects += 1; return new Promise(() => undefined) } }
    expect(poolConnectionTimeoutMs(db)).toBe(30_000)
    const sampler = new EpochStuckRowsSampler(db as never, () => true, () => undefined, () => clock)
    expect(sampler.staleMs).toBe(30_000 + EPOCH_STUCK_SAMPLE_TIMEOUT_MS + CLIENT_DEADLINE_MARGIN_MS + 3_000)
    void sampler.sample()
    clock = 25_000 // the default bound is passed, the pool's patience is not
    await sampler.sample()
    expect(connects).toBe(1)
    expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_samples_skipped_total')).toBe(1)
    clock = sampler.staleMs
    void sampler.sample() // abandons the first; its own connect hangs too
    await new Promise((resolve) => setImmediate(resolve))
    expect(connects).toBe(2)
    expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_sample_failures_total')).toBe(1)
    // No option, or a pg 0 ("wait for ever"): the default.
    expect(poolConnectionTimeoutMs({})).toBe(10_000)
    expect(poolConnectionTimeoutMs({ options: { connectionTimeoutMillis: 0 } })).toBe(10_000)
  })

  it('a last good value is not published while a sample waits for a client past the deadline: NaN', async () => {
    vi.useFakeTimers()
    const good = fakeDb(() => [row('L1', 2, 700)])
    let connects = 0
    const db = { connect: async () => { connects += 1; if (connects === 2) await new Promise(() => undefined); return good.connect() } }
    const sampler = new EpochStuckRowsSampler(db, () => true, () => undefined)
    await sampler.sample()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1)
    void sampler.sample() // waits for a client for ever
    await vi.advanceTimersByTimeAsync(EPOCH_STUCK_SAMPLE_TIMEOUT_MS + CLIENT_DEADLINE_MARGIN_MS)
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBeNaN()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing_oldest_seconds')).toBeNaN()
  })

  it('a last good value turns NaN while the next sample is in flight past its client deadline', async () => {
    vi.useFakeTimers()
    let hang = false
    const db = fakeDb(() => (hang ? new Promise<Row[]>(() => undefined) : [row('L1', 2, 700)]))
    const sampler = new EpochStuckRowsSampler(db, () => true, () => undefined)
    await sampler.sample()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1)
    hang = true
    const next = sampler.sample()
    await vi.advanceTimersByTimeAsync(EPOCH_STUCK_SAMPLE_TIMEOUT_MS)
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1) // within its bound
    quiet()
    await vi.advanceTimersByTimeAsync(CLIENT_DEADLINE_MARGIN_MS + 1)
    await next // the client deadline rejected it: a failure, NaN
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBeNaN()
    expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_sample_failures_total')).toBe(1)
    expect(db.released).toHaveLength(2)
    expect(db.released[1]).toBeInstanceOf(Error) // destroyed, not given back
  })

  it('a throwing owns() or log() neither rejects nor hides the rows, and frees the sampler', async () => {
    quiet()
    const db = fakeDb(() => [row('L1', 2, 700)])
    const sampler = new EpochStuckRowsSampler(db, () => { throw new Error('owns broke') }, () => undefined)
    await expect(sampler.sample()).resolves.toBeUndefined()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1)
    await sampler.sample()
    expect(db.connects()).toBe(2)
    expect(value(sampler.samples(), 'maplespire_model_epoch_stuck_rows_samples_skipped_total')).toBe(0)
    const logging = new EpochStuckRowsSampler(fakeDb(() => [row('L1', 2, 700)]), () => true, () => { throw new Error('log broke') })
    await expect(logging.sample()).resolves.toBeUndefined()
    expect(value(logging.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(1)
  })

  it('logs each stuck row ONCE, only on the cell that owns its workspace; again if it comes back', async () => {
    let rows: Row[] = [row('L1', 2, 700), row('L2', 3, 900)]
    const lines: string[] = []
    const sampler = new EpochStuckRowsSampler(fakeDb(() => rows), (key) => key.landscapeId === 'L1', (line) => lines.push(line))
    await sampler.sample()
    await sampler.sample()
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toMatchObject([
      { event: 'model_epoch.roll_stuck_repointing', landscapeId: 'L1', versionId: 'V', epochNo: 2, metaUrl: 'automerge:L12' },
    ])
    rows = []
    await sampler.sample()
    rows = [row('L1', 2, 800)]
    await sampler.sample()
    expect(lines).toHaveLength(2)
    // The gauge counts every row, owned or not (a fleet fact).
    rows = [row('L1', 2, 800), row('L2', 3, 900)]
    await sampler.sample()
    expect(value(sampler.samples(), 'maplespire_model_epoch_rows_stuck_repointing')).toBe(2)
  })

  it('a row this cell did not own is logged once it does (it was not marked)', async () => {
    let owned = false
    const lines: string[] = []
    const sampler = new EpochStuckRowsSampler(fakeDb(() => [row('L1', 2, 700)]), () => owned, (line) => lines.push(line))
    await sampler.sample()
    expect(lines).toEqual([])
    owned = true
    await sampler.sample()
    await sampler.sample()
    expect(lines).toHaveLength(1)
  })

  it('the started sampler samples AT ONCE, then once per tick, and stops', async () => {
    vi.useFakeTimers()
    const db = fakeDb(() => [])
    const sampler = new EpochStuckRowsSampler(db, () => true, () => undefined)
    const stop = startEpochStuckRowsSampler(db, 60_000, undefined, sampler)
    await vi.advanceTimersByTimeAsync(0)
    expect(db.connects()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(db.connects()).toBe(2)
    stop()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(db.connects()).toBe(2)
    expect(epochStuckRowsMetricSamples().length).toBeGreaterThan(0)
  })

  it('index.ts starts the sampler beside the growth sampler and pushes its samples (source pin)', async () => {
    const source = await readFile(path.resolve(import.meta.dirname, '..', 'index.ts'), 'utf8')
    expect(source).toMatch(/startDocumentGrowthSampler\(pool, growthIntervalMs\)[\s\S]{0,800}startEpochStuckRowsSampler\(pool, growthIntervalMs,/)
    expect(source).toContain('metrics.push(...epochStuckRowsMetricSamples())')
    expect(epochStuckRowsMetricSamples(null)).toEqual([])
  })
})
