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

import { describe, expect, it } from 'vitest'
import type { Queryable } from '../readModel/types.js'
import {
  ceilingIsUnbounded,
  isLockTimeout,
  isServerImposedCeiling,
  isStatementTimeout,
  LOCK_NOT_AVAILABLE,
  QUERY_CANCELED,
  readEffectiveCeilings,
  timedQueryable,
  type QuerySample,
} from './statementTimeout.js'

/**
 * Classifying and timing the ceilings; APPLYING them is the pool's job
 * (`syncCellDatabasePoolConfig`).
 */
describe('server-imposed ceilings — classification', () => {
  const withCode = (code: unknown): unknown => Object.assign(new Error('x'), { code })

  it('separates a cancelled statement from a lock that could not be taken', () => {
    // A lock wait and a slow statement are different failures; conflating them
    // would hide which ceiling fired.
    expect(isStatementTimeout(withCode(QUERY_CANCELED))).toBe(true)
    expect(isLockTimeout(withCode(QUERY_CANCELED))).toBe(false)
    expect(isLockTimeout(withCode(LOCK_NOT_AVAILABLE))).toBe(true)
    expect(isStatementTimeout(withCode(LOCK_NOT_AVAILABLE))).toBe(false)
    expect(isServerImposedCeiling(withCode(QUERY_CANCELED))).toBe(true)
    expect(isServerImposedCeiling(withCode(LOCK_NOT_AVAILABLE))).toBe(true)
  })

  it('does not claim a ceiling fired for any other failure', () => {
    // `25P03` is idle_in_transaction_session_timeout and `42P01` is a missing
    // table: both are things that go wrong, neither is our ceiling, and counting
    // them would make the counter mean "something failed".
    for (const code of ['25P03', '42P01', '25P02', 57014, null, undefined, {}]) {
      expect(isServerImposedCeiling(withCode(code))).toBe(false)
    }
    expect(isServerImposedCeiling(new Error('no code at all'))).toBe(false)
    expect(isServerImposedCeiling(null)).toBe(false)
  })

  it('reads PostgreSQL\'s spellings of "no ceiling" as unbounded', () => {
    // `0` is what a dangling `SYNC_CELL_STATEMENT_TIMEOUT_MS=` produces and what
    // PostgreSQL means by "never time out", so it must not be mistaken for a
    // configured ceiling.
    expect(ceilingIsUnbounded('0')).toBe(true)
    expect(ceilingIsUnbounded('0ms')).toBe(true)
    expect(ceilingIsUnbounded(' 0 ')).toBe(true)
    expect(ceilingIsUnbounded('0 s')).toBe(true)
    expect(ceilingIsUnbounded('30s')).toBe(false)
    expect(ceilingIsUnbounded('2000ms')).toBe(false)
    expect(ceilingIsUnbounded('1min')).toBe(false)
  })
})

describe('timedQueryable', () => {
  function recorder(): { samples: QuerySample[]; observe: (sample: QuerySample) => void } {
    const samples: QuerySample[] = []
    return { samples, observe: (sample) => samples.push(sample) }
  }

  const answering = (impl: (text: string, params?: unknown[]) => Promise<unknown>): Queryable => ({
    query: impl as Queryable['query'],
  })

  it('passes the statement and its parameters through untouched', async () => {
    // A decorator that alters what runs is not an instrument. This is the arm
    // that would catch it starting to wrap, prefix or re-order anything.
    const seen: Array<{ text: string; params?: unknown[] }> = []
    const db = timedQueryable(
      answering(async (text, params) => { seen.push({ text, params }); return { rows: [{ a: 1 }], rowCount: 1 } }),
      recorder().observe,
    )
    const result = await db.query('SELECT $1::int AS a', [7])
    expect(seen).toEqual([{ text: 'SELECT $1::int AS a', params: [7] }])
    expect(result).toEqual({ rows: [{ a: 1 }], rowCount: 1 })
  })

  it('reports a duration on the failing path as well as the happy one', async () => {
    // If it only fired on success, the statements that matter most — the slow
    // ones and the cancelled ones — would be exactly the ones never seen.
    const ok = recorder()
    await timedQueryable(answering(async () => ({ rows: [], rowCount: 0 })), ok.observe).query('SELECT 1')
    expect(ok.samples).toHaveLength(1)
    expect(ok.samples[0]!.cancelled).toBe(false)

    const bad = recorder()
    await expect(
      timedQueryable(answering(async () => { throw new Error('nope') }), bad.observe).query('SELECT 2'),
    ).rejects.toThrow('nope')
    expect(bad.samples).toHaveLength(1)
    expect(bad.samples[0]!.text).toBe('SELECT 2')
  })

  it('marks a sample cancelled only when PostgreSQL stopped it', async () => {
    // This flag decides whether a duration enters the "how close are we to the
    // ceiling" gauge. A cancelled statement's duration IS the ceiling, so
    // mislabelling one pins that gauge at the ceiling for good.
    const cancelled = recorder()
    await expect(
      timedQueryable(
        answering(async () => { throw Object.assign(new Error('canceling statement'), { code: QUERY_CANCELED }) }),
        cancelled.observe,
      ).query('SELECT pg_sleep(60)'),
    ).rejects.toThrow()
    expect(cancelled.samples[0]!.cancelled).toBe(true)

    const ordinary = recorder()
    await expect(
      timedQueryable(
        answering(async () => { throw Object.assign(new Error('missing'), { code: '42P01' }) }),
        ordinary.observe,
      ).query('SELECT 1'),
    ).rejects.toThrow()
    expect(ordinary.samples[0]!.cancelled).toBe(false)
  })

  it('a broken observer cannot fail the statement it is measuring', async () => {
    // An instrument that can break its subject is worse than no instrument: a
    // throwing observer must not turn a successful query into a rejection.
    const db = timedQueryable(
      answering(async () => ({ rows: [{ ok: 1 }], rowCount: 1 })),
      () => { throw new Error('the gauge is broken') },
    )
    await expect(db.query('SELECT 1')).resolves.toEqual({ rows: [{ ok: 1 }], rowCount: 1 })
  })

  it('a broken observer does not replace the error the caller needs either', async () => {
    const db = timedQueryable(
      answering(async () => { throw new Error('the real failure') }),
      () => { throw new Error('the gauge is broken') },
    )
    await expect(db.query('SELECT 1')).rejects.toThrow('the real failure')
  })
})

describe('readEffectiveCeilings', () => {
  it('asks the SERVER what is in force rather than trusting the wiring', async () => {
    // A pool-level ceiling cannot be bypassed per call site, but it can be
    // absent, so the coordinator asks.
    let asked = ''
    const db: Queryable = {
      query: (async (text: string) => {
        asked = text
        return { rows: [{ statement_timeout: '30s', lock_timeout: '2s' }], rowCount: 1 }
      }) as Queryable['query'],
    }
    await expect(readEffectiveCeilings(db)).resolves.toEqual({ statementTimeout: '30s', lockTimeout: '2s' })
    expect(asked).toContain('current_setting')
  })

  it('reports an empty answer as unbounded, not as absent', async () => {
    // A server that returned no row must not read as "fine". `'0'` is
    // PostgreSQL's own spelling of no ceiling, so it is the honest default and
    // `ceilingIsUnbounded` then flags it.
    const db: Queryable = { query: (async () => ({ rows: [], rowCount: 0 })) as Queryable['query'] }
    const ceilings = await readEffectiveCeilings(db)
    expect(ceilings).toEqual({ statementTimeout: '0', lockTimeout: '0' })
    expect(ceilingIsUnbounded(ceilings.statementTimeout)).toBe(true)
  })
})
