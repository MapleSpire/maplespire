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
import pg from 'pg'
import { guardIdleClientErrors } from './db/poolErrorGuard.js'
import { installedPoolConcurrencyGate } from './db/poolConcurrencyGate.js'
import { PostgresStorageAdapter } from './automergeStorage.js'
import {
  noteStorageWriteCeiling,
  STORAGE_WRITE_CEILING_RETRY_DELAYS_MS,
  storageWriteCeilingCode,
  storageWriteCeilingCounts,
} from './automergeStorageCeiling.js'
import { checkStorageWriteConnection, storageWriteConnectionProblems } from './db/storageWriteTag.js'

describe('storage write ceilings (G4-16d round 3)', () => {
  it('classifies exactly the three ceilings the write pool sets, by SQLSTATE', () => {
    expect(storageWriteCeilingCode({ code: '57014' })).toBe('57014')
    expect(storageWriteCeilingCode({ code: '55P03' })).toBe('55P03')
    expect(storageWriteCeilingCode({ code: '25P03' })).toBe('25P03')
    for (const other of [{ code: '40P01' }, { code: '57P01' }, { code: 57014 }, new Error('x'), null, undefined]) {
      expect(storageWriteCeilingCode(other)).toBeNull()
    }
  })
  it('counts per code, every code present from the start (a rate is defined from the first scrape)', () => {
    const before = new Map(storageWriteCeilingCounts().map(({ code, count }) => [code, count]))
    expect([...before.keys()]).toEqual(['57014', '55P03', '25P03'])
    noteStorageWriteCeiling('55P03')
    noteStorageWriteCeiling('55P03')
    const after = new Map(storageWriteCeilingCounts().map(({ code, count }) => [code, count]))
    expect(after.get('55P03')).toBe(before.get('55P03')! + 2)
    expect(after.get('57014')).toBe(before.get('57014'))
  })
  it('retries five times over about a minute', () => {
    expect(STORAGE_WRITE_CEILING_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 15_000, 30_000])
  })
  it('the permit gate on a dedicated write pool follows its max (AM_STORAGE_WRITE_DB_POOL_MAX), not the shared-pool bound', () => {
    const read = guardIdleClientErrors(new pg.Pool({ max: 10 }), 'ceiling-test:read')
    const write = guardIdleClientErrors(new pg.Pool({ max: 6 }), 'ceiling-test:write')
    new PostgresStorageAdapter({ db: read, writeDb: write })
    expect((installedPoolConcurrencyGate(write) as unknown as { max: number }).max).toBe(6)
    expect(installedPoolConcurrencyGate(read)).toBeUndefined()
    const shared = guardIdleClientErrors(new pg.Pool({ max: 10 }), 'ceiling-test:shared')
    new PostgresStorageAdapter({ db: shared })
    expect((installedPoolConcurrencyGate(shared) as unknown as { max: number }).max).toBe(4)
  })
})

describe('storage write connection check (the barrier\'s dependencies)', () => {
  it('C07: a connection whose tag is not the one set is logged loudly, not refused', async () => {
    const lines: string[] = []
    const client = { query: async () => ({ rows: [{ a: 'from-database-url', s: '2min', t: 'on' }] }) }
    expect(await checkStorageWriteConnection(client as never, 'ms-storage:c:b', 120_000, (line) => lines.push(line)))
      .toEqual(['application_name'])
    expect(lines.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({
      event: 'automerge.storage_write_pool_misconfigured', problems: ['application_name'],
      expectedApplicationName: 'ms-storage:c:b', applicationName: 'from-database-url',
    })])
    const quiet: string[] = []
    const good = { query: async () => ({ rows: [{ a: 'ms-storage:c:b', s: '2min', t: 'on' }] }) }
    expect(await checkStorageWriteConnection(good as never, 'ms-storage:c:b', 120_000, (line) => quiet.push(line))).toEqual([])
    expect(quiet).toEqual([])
  })
  const ok = { applicationName: 'ms-storage:c:b', statementTimeout: '2min', trackActivities: 'on' }
  it('reports an overridden tag, a dropped ceiling and track_activities off; nothing when all is as set', () => {
    expect(storageWriteConnectionProblems(ok, 'ms-storage:c:b', 120_000)).toEqual([])
    expect(storageWriteConnectionProblems({ ...ok, applicationName: 'from-url' }, 'ms-storage:c:b', 120_000))
      .toEqual(['application_name'])
    expect(storageWriteConnectionProblems({ ...ok, statementTimeout: '0' }, 'ms-storage:c:b', 120_000))
      .toEqual(['statement_timeout'])
    // 0 chosen by the operator is not a problem to report.
    expect(storageWriteConnectionProblems({ ...ok, statementTimeout: '0' }, 'ms-storage:c:b', 0)).toEqual([])
    expect(storageWriteConnectionProblems({ ...ok, trackActivities: 'off' }, 'ms-storage:c:b', 120_000))
      .toEqual(['track_activities'])
  })
})
