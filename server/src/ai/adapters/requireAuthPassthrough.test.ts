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

import { afterEach, describe, expect, it } from 'vitest'
import type { Request, Response } from 'express'
import { requireAuth } from '../../auth/middleware.js'

/**
 * The AI bearer bridge sets `req.auth` BEFORE requireAuth runs; requireAuth
 * must treat a pre-authenticated request like a verified cookie (pass
 * through), while unauthenticated requests keep the exact staged behavior.
 */
describe('requireAuth pre-authenticated passthrough (AI bearer bridge)', () => {
  const savedAuth = process.env.AUTH
  afterEach(() => {
    if (savedAuth === undefined) delete process.env.AUTH
    else process.env.AUTH = savedAuth
  })

  function run(req: Partial<Request>): { nexted: boolean; status: number | null } {
    const state = { nexted: false, status: null as number | null }
    const res = {
      status(code: number) {
        state.status = code
        return this
      },
      json() {
        return this
      },
    } as unknown as Response
    requireAuth()(
      { headers: {}, path: '/ai/chat', method: 'POST', ...req } as Request,
      res,
      () => {
        state.nexted = true
      }
    )
    return state
  }

  it('passes through when req.auth is already set at stage on', () => {
    process.env.AUTH = 'on'
    const result = run({
      auth: { userId: 'u1', orgId: 'o1', isPlatformAdmin: false, epoch: 0 },
    })
    expect(result.nexted).toBe(true)
    expect(result.status).toBeNull()
  })

  it('still 401s an unauthenticated request at stage on', () => {
    process.env.AUTH = 'on'
    const result = run({})
    expect(result.nexted).toBe(false)
    expect(result.status).toBe(401)
  })

  it('stays a pure pass-through at stage off', () => {
    delete process.env.AUTH
    const result = run({})
    expect(result.nexted).toBe(true)
  })
})
