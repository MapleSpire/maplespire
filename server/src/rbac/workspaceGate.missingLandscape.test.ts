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

import { describe, it, expect, afterEach } from 'vitest'
import type { Pool } from 'pg'
import type { Request, Response } from 'express'
import { requireVersionWrite } from './workspaceGate.js'

/**
 * V0-03 (S2), DB-free: the write gate's behaviour when the target landscape row
 * does NOT exist. Share-link manage routes ask for `missingLandscape: 'deny'`
 * and must be refused (404) — a deleted landscape has no owner to check write
 * against. Every other caller keeps the historical "missing passes, the
 * endpoint's own lookup 404s" contract.
 *
 * The pool answers every query with zero rows, which is exactly what the
 * gate's `SELECT … FROM landscapes … WHERE l.id = $1` returns for a missing id.
 */

function emptyPool(): Pool & { queries: string[] } {
  const queries: string[] = []
  return {
    queries,
    query: async (sql: string) => {
      queries.push(sql)
      return { rows: [], rowCount: 0 }
    },
  } as unknown as Pool & { queries: string[] }
}

function fakeRes(): Response & { statusCode: number; body: unknown } {
  const r = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(payload: unknown) { this.body = payload; return this },
  }
  return r as unknown as Response & { statusCode: number; body: unknown }
}

const member = { userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 1 }
const reqFor = (auth: unknown) => ({ auth }) as unknown as Request

describe('requireVersionWrite on a missing landscape', () => {
  const originalAuth = process.env.AUTH
  afterEach(() => {
    if (originalAuth === undefined) delete process.env.AUTH
    else process.env.AUTH = originalAuth
  })

  for (const stage of ['on', 'dual'] as const) {
    it(`missingLandscape:'deny' refuses with 404 at stage ${stage}`, async () => {
      process.env.AUTH = stage
      const pool = emptyPool()
      const res = fakeRes()
      expect(await requireVersionWrite(pool, reqFor(member), res, 'gone', 'v1', { missingLandscape: 'deny' })).toBe(false)
      expect(res.statusCode).toBe(404)
      expect(pool.queries.some((q) => /FROM landscapes/.test(q))).toBe(true)
    })
  }

  it('default (no option) keeps the historical contract: a missing landscape passes at stage on', async () => {
    process.env.AUTH = 'on'
    const res = fakeRes()
    expect(await requireVersionWrite(emptyPool(), reqFor(member), res, 'gone', 'v1')).toBe(true)
    expect(res.statusCode).toBe(200)
  })

  it("a platform admin is not refused by missingLandscape:'deny' (operates across orgs, no lookup)", async () => {
    process.env.AUTH = 'on'
    const pool = emptyPool()
    const pa = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    expect(await requireVersionWrite(pool, reqFor(pa), fakeRes(), 'gone', 'v1', { missingLandscape: 'deny' })).toBe(true)
    expect(pool.queries).toEqual([])
  })
})
