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

import { describe, it, expect, vi } from 'vitest'
import { analyzeWithinCeiling } from './derivedStats.js'
import type { Queryable } from './types.js'

/**
 * `analyzeWithinCeiling` absorbs ONE failure — the lock ceiling expiring
 * (55P03) — and nothing else. A fake transaction that models the two
 * settings that matter (`lock_timeout`, undone by ROLLBACK TO SAVEPOINT as
 * PostgreSQL undoes a `SET LOCAL` made after the savepoint) and fails the
 * statements it is told to. The real-PostgreSQL arms are in
 * `analyzeWithinCeiling.integration.test.ts`.
 */
const KEY = { landscapeId: 'ws-analyze', versionId: 'v1' }

function fakeTx(fail: { analyze?: unknown; rollback?: unknown } = {}) {
  let lockTimeout = '7s'
  const savepoints: string[] = []
  const statements: string[] = []
  const tx: Queryable & { lockTimeout: () => string; statements: string[] } = {
    statements,
    lockTimeout: () => lockTimeout,
    query: (async (text: string, params?: unknown[]) => {
      statements.push(text)
      if (text.startsWith('SELECT current_setting')) return { rows: [{ lock_timeout: lockTimeout }], rowCount: 1 }
      if (text.startsWith('SAVEPOINT')) { savepoints.push(lockTimeout); return { rows: [], rowCount: 0 } }
      if (text.startsWith('SET LOCAL lock_timeout')) { lockTimeout = /'(.*)'/.exec(text)![1]!; return { rows: [], rowCount: 0 } }
      if (text.startsWith('ANALYZE')) { if (fail.analyze) throw fail.analyze; return { rows: [], rowCount: 0 } }
      if (text.startsWith('ROLLBACK TO SAVEPOINT')) {
        if (fail.rollback) throw fail.rollback
        lockTimeout = savepoints.at(-1)!
        return { rows: [], rowCount: 0 }
      }
      if (text.startsWith('RELEASE SAVEPOINT')) { savepoints.pop(); return { rows: [], rowCount: 0 } }
      if (text.startsWith('SELECT set_config')) { lockTimeout = String(params![0]); return { rows: [], rowCount: 1 } }
      throw new Error(`unexpected statement ${text}`)
    }) as Queryable['query'],
  }
  return tx
}

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code })

describe('analyzeWithinCeiling', () => {
  it('runs, and restores the caller\'s lock_timeout after its own SET LOCAL', async () => {
    const tx = fakeTx()
    const skipped: string[] = []
    await expect(analyzeWithinCeiling(tx, KEY, ['ro_objects', 'ro_groups'], { skipped, lockWaitMs: 50 })).resolves.toBe(true)
    expect(tx.statements).toContain(`SET LOCAL lock_timeout = '50ms'`)
    expect(tx.lockTimeout()).toBe('7s')
    expect(skipped).toEqual([])
  })

  it('55P03: skipped, recorded, warned, and the lock_timeout restored', async () => {
    const tx = fakeTx({ analyze: pgError('55P03', 'canceling statement due to lock timeout') })
    const skipped: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const warned = await (async () => {
      try {
        await expect(analyzeWithinCeiling(tx, KEY, ['ro_objects', 'ro_groups'], { skipped, lockWaitMs: 50 })).resolves.toBe(false)
        return [...warn.mock.calls]
      } finally {
        warn.mockRestore()
      }
    })()
    expect(skipped).toEqual(['ro_objects', 'ro_groups'])
    expect(tx.lockTimeout()).toBe('7s')
    expect(warned).toHaveLength(1)
    expect(String(warned[0]![0])).not.toMatch(/4x/)
    expect(tx.statements.filter((text) => text.startsWith('ROLLBACK TO SAVEPOINT'))).toHaveLength(1)
  })

  it('57014 (a cancel, statement_timeout) PROPAGATES — after the savepoint is rolled back', async () => {
    const cancel = pgError('57014', 'canceling statement due to user request')
    const tx = fakeTx({ analyze: cancel })
    const skipped: string[] = []
    await expect(analyzeWithinCeiling(tx, KEY, ['ro_objects'], { skipped })).rejects.toBe(cancel)
    expect(skipped).toEqual([])
    // The SET LOCAL was undone by the rollback: the caller's value is back.
    expect(tx.lockTimeout()).toBe('7s')
    expect(tx.statements.filter((text) => text.startsWith('ROLLBACK TO SAVEPOINT'))).toHaveLength(1)
  })

  it('the default ceiling is 15 000 ms per lock wait — the LITERAL, not the constant', async () => {
    // Derived from `ANALYZE_LOCK_WAIT_MS`, this would agree with any value
    // of it; the worst case documented beside it (8 x 15 s) rests on 15 000.
    const tx = fakeTx()
    await expect(analyzeWithinCeiling(tx, KEY, ['ro_objects'])).resolves.toBe(true)
    expect(tx.statements.filter((text) => text.startsWith('SET LOCAL lock_timeout'))).toEqual([`SET LOCAL lock_timeout = '15000ms'`])
  })

  it.each([0, -1, -15_000, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'refuses lockWaitMs %s before touching the transaction (0 would mean NO ceiling)', async (lockWaitMs) => {
      const tx = fakeTx()
      await expect(analyzeWithinCeiling(tx, KEY, ['ro_objects'], { lockWaitMs })).rejects.toBeInstanceOf(RangeError)
      expect(tx.statements).toEqual([])
    })

  it('accepts the edges of the setting\'s range, 1 and 2^31 - 1', async () => {
    for (const lockWaitMs of [1, 2_147_483_647]) {
      const tx = fakeTx()
      await expect(analyzeWithinCeiling(tx, KEY, ['ro_objects'], { lockWaitMs })).resolves.toBe(true)
      expect(tx.statements).toContain(`SET LOCAL lock_timeout = '${lockWaitMs}ms'`)
    }
  })

  it('an error with no code propagates too', async () => {
    const boom = new Error('connection terminated')
    await expect(analyzeWithinCeiling(fakeTx({ analyze: boom }), KEY, ['ro_objects'])).rejects.toBe(boom)
  })

  it('a failing ROLLBACK TO SAVEPOINT is thrown with the ANALYZE error as its cause', async () => {
    const timeout = pgError('55P03', 'canceling statement due to lock timeout')
    const tx = fakeTx({ analyze: timeout, rollback: new Error('connection lost') })
    const thrown = await analyzeWithinCeiling(tx, KEY, ['ro_objects']).then(() => null, (error: unknown) => error)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).cause).toBe(timeout)
    expect((thrown as Error).message).toMatch(/connection lost/)
  })
})
