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
 * `canonicalWorkspaceKey` and `workspaceAccessEnforced`, without a database.
 *
 * The first used to answer null — "no such workspace" — when its read FAILED,
 * so every caller 404ed a workspace that existed, and the routes that skip the
 * access check for an unknown key skipped it. `landscapes.repoint.integration
 * .test.ts` pins the same throw against a real failed read.
 */
import type { Pool } from 'pg'
import type { Request } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalWorkspaceKey, workspaceAccessEnforced } from './workspaceGate.js'
import { WorkspaceRegistryUnavailableError } from './workspaceRegistryErrors.js'

function poolAnswering(query: (...args: unknown[]) => Promise<unknown>): Pool {
  return { query: vi.fn(query) } as unknown as Pool
}

describe('canonicalWorkspaceKey', () => {
  it('resolves `current` to the landscape\'s default version', async () => {
    const pool = poolAnswering(async () => ({ rows: [{ default_version_id: 'v1' }] }))
    await expect(canonicalWorkspaceKey(pool, { landscapeId: 'L', versionId: 'current' }))
      .resolves.toEqual({ landscapeId: 'L', versionId: 'v1' })
  })

  it('answers null for a landscape that is not there, or has no default', async () => {
    await expect(canonicalWorkspaceKey(poolAnswering(async () => ({ rows: [] })), { landscapeId: 'L', versionId: 'current' }))
      .resolves.toBeNull()
    await expect(canonicalWorkspaceKey(
      poolAnswering(async () => ({ rows: [{ default_version_id: null }] })),
      { landscapeId: 'L', versionId: 'current' },
    )).resolves.toBeNull()
  })

  it('THROWS a typed refusal when the read fails — a failure is not a miss', async () => {
    const failure = new Error('connect ECONNREFUSED 10.0.0.7:5432')
    const pending = canonicalWorkspaceKey(poolAnswering(async () => { throw failure }), { landscapeId: 'L', versionId: 'current' })
    await expect(pending).rejects.toBeInstanceOf(WorkspaceRegistryUnavailableError)
    await expect(pending).rejects.toMatchObject({ code: 'workspace-registry-unavailable', cause: failure })
    // The message reaches clients; the database error does not.
    await expect(pending).rejects.not.toThrow(/ECONNREFUSED|5432/)
  })

  it('passes a concrete version through without a read', async () => {
    const pool = poolAnswering(async () => { throw new Error('must not be asked') })
    await expect(canonicalWorkspaceKey(pool, { landscapeId: 'L', versionId: 'v7' }))
      .resolves.toEqual({ landscapeId: 'L', versionId: 'v7' })
  })
})

describe('workspaceAccessEnforced — whether the access check can refuse', () => {
  const previous = process.env.AUTH
  afterEach(() => {
    if (previous === undefined) delete process.env.AUTH
    else process.env.AUTH = previous
  })
  const withSession = { auth: { userId: 'u', orgId: 'o', isPlatformAdmin: false } } as unknown as Request
  const anonymous = {} as Request

  it('only at stage on, and only with a session', () => {
    process.env.AUTH = 'on'
    expect(workspaceAccessEnforced(withSession)).toBe(true)
    expect(workspaceAccessEnforced(anonymous)).toBe(false)
    process.env.AUTH = 'dual'
    expect(workspaceAccessEnforced(withSession)).toBe(false)
    process.env.AUTH = 'off'
    expect(workspaceAccessEnforced(withSession)).toBe(false)
    delete process.env.AUTH
    expect(workspaceAccessEnforced(withSession)).toBe(false)
  })
})
