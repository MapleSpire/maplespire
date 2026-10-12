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
import { normalizeToolError } from './serialize.js'
import { WriteAuthorityLostError, WriteAuthorityUnavailableError } from '../../syncCells/writeAuthority.js'
import { StaleSyncCellWriteError } from '../../automergeStorageErrors.js'

/**
 * THE AI TOOL DOOR ANSWERS A DEPENDENCY OUTAGE LIKE THE OTHER DOORS.
 *
 * When `create_version|create_draft|merge_draft` reach the bootstrap family
 * with no router and no `placeMergeWrite` in front, the scope's refusal and
 * the storage fence's are what answer on a lease-less cell — and they must
 * not surface as a 500 "AI request failed", which blames the wrong subsystem.
 */
describe('normalizeToolError — a dependency outage keeps its status, headers and body', () => {
  const workspace = { landscapeId: 'L', versionId: 'V' }

  it('KILLS the missing consult: a scope refused at open is 503 with the shared body', () => {
    const normalized = normalizeToolError(new WriteAuthorityUnavailableError('not-owner', workspace))
    expect(normalized.status).toBe(503)
    expect(normalized.headers).toEqual({ 'Retry-After': '1' })
    expect(normalized.body).toMatchObject({ code: 'sync-cell-not-owner', reason: 'not-owner', retryable: true, wrote: 'nothing' })
    expect(normalized.error).toMatch(/does not own L\/V/)
  })

  it('a lost authority and a fence refusal map too, with their own codes', () => {
    expect(normalizeToolError(new WriteAuthorityLostError(workspace))).toMatchObject({
      status: 503, body: { code: 'sync-cell-write-authority-lost', retryable: true },
    })
    expect(normalizeToolError(new StaleSyncCellWriteError('snapshot', 'ownership-unavailable'))).toMatchObject({
      status: 503, body: { code: 'sync-cell-ownership-unavailable' },
    })
  })

  it('everything else keeps the 500 fallback with NO headers and NO body — the control', () => {
    const normalized = normalizeToolError(new Error('boom'))
    expect(normalized).toEqual({ error: 'AI request failed', status: 500 })
  })
})
