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

import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { requireSessionAuth } from './sessionGuard.js'

function fakeRes() {
  const sent: { status?: number; body?: unknown } = {}
  const res = {
    status(code: number) {
      sent.status = code
      return res
    },
    json(body: unknown) {
      sent.body = body
      return res
    },
  }
  return { res: res as unknown as Response, sent }
}

describe('requireSessionAuth', () => {
  it('returns the verified claims and sends nothing', () => {
    const auth = { userId: 'u1' } as unknown as NonNullable<Request['auth']>
    const { res, sent } = fakeRes()
    expect(requireSessionAuth({ auth } as Request, res)).toBe(auth)
    expect(sent).toEqual({})
  })

  it('answers 401 with the default error when there is no session', () => {
    const { res, sent } = fakeRes()
    expect(requireSessionAuth({} as Request, res)).toBeNull()
    expect(sent).toEqual({ status: 401, body: { error: 'Authentication required' } })
  })

  it('keeps a route-specific error code', () => {
    const { res, sent } = fakeRes()
    expect(requireSessionAuth({} as Request, res, 'sign_in_required')).toBeNull()
    expect(sent).toEqual({ status: 401, body: { error: 'sign_in_required' } })
  })
})
