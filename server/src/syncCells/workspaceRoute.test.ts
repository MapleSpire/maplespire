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

import { describe, expect, it, vi } from 'vitest'
import {
  createSingleFlightWorkspaceRouteResolver,
  parseWorkspaceRoute,
  resolveWorkspaceRoute,
  resolveWorkspaceRouteForUpgrade,
} from './workspaceRoute.js'

describe('parseWorkspaceRoute', () => {
  it('accepts one explicit workspace and rejects ambiguous or malformed routes', () => {
    expect(parseWorkspaceRoute('/automerge?landscapeId=L_1&versionId=current')).toEqual({
      kind: 'workspace',
      workspace: { landscapeId: 'L_1', versionId: 'current' },
    })
    expect(parseWorkspaceRoute('/automerge')).toEqual({ kind: 'legacy' })
    expect(parseWorkspaceRoute('/automerge?landscapeId=L1')).toEqual({ kind: 'invalid' })
    expect(parseWorkspaceRoute('/automerge?landscapeId=L1&landscapeId=L2&versionId=V1')).toEqual({ kind: 'invalid' })
    expect(parseWorkspaceRoute('/automerge?landscapeId=../L1&versionId=V1')).toEqual({ kind: 'invalid' })
    expect(parseWorkspaceRoute('/automerge-other?landscapeId=L1&versionId=V1')).toEqual({ kind: 'not-automerge' })
  })
})

describe('resolveWorkspaceRoute', () => {
  it('canonicalizes current and returns only the server-validated row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ landscape_id: 'L1', version_id: 'V9' }] })
    await expect(resolveWorkspaceRoute({ query } as never, { landscapeId: 'L1', versionId: 'current' }))
      .resolves.toEqual({ landscapeId: 'L1', versionId: 'V9' })
    expect(query.mock.calls[0][1]).toEqual(['L1'])
  })

  it('returns null for an unknown or inactive concrete version', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await expect(resolveWorkspaceRoute({ query } as never, { landscapeId: 'L1', versionId: 'V1' }))
      .resolves.toBeNull()
    expect(query.mock.calls[0][1]).toEqual(['L1', 'V1'])
  })

  it('admits a concrete route immediately when fenced local ownership already proves it', async () => {
    const requested = { landscapeId: 'L1', versionId: 'V1' }
    const fallback = vi.fn()
    await expect(resolveWorkspaceRouteForUpgrade(
      {} as never,
      requested,
      (workspace) => workspace === requested,
      fallback,
    )).resolves.toBe(requested)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('keeps database validation for current aliases and non-owned concrete routes', async () => {
    const fallback = vi.fn().mockResolvedValue({ landscapeId: 'L1', versionId: 'V9' })
    await resolveWorkspaceRouteForUpgrade(
      {} as never,
      { landscapeId: 'L1', versionId: 'current' },
      () => true,
      fallback,
    )
    await resolveWorkspaceRouteForUpgrade(
      {} as never,
      { landscapeId: 'L1', versionId: 'V2' },
      () => false,
      fallback,
    )
    expect(fallback).toHaveBeenCalledTimes(2)
  })

  it('coalesces a cold burst and absorbs staggered reconnect waves within the TTL', async () => {
    let now = 1_000
    let release!: (value: { landscapeId: string; versionId: string } | null) => void
    const first = new Promise<{ landscapeId: string; versionId: string } | null>((resolve) => {
      release = resolve
    })
    const base = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ landscapeId: 'L1', versionId: 'V2' })
    const resolve = createSingleFlightWorkspaceRouteResolver(base, { cacheTtlMs: 500, now: () => now })
    const db = {} as never
    const requested = { landscapeId: 'L1', versionId: 'current' }

    const burst = Array.from({ length: 50 }, () => resolve(db, requested))
    expect(base).toHaveBeenCalledTimes(1)
    release({ landscapeId: 'L1', versionId: 'V1' })
    await expect(Promise.all(burst)).resolves.toEqual(
      Array.from({ length: 50 }, () => ({ landscapeId: 'L1', versionId: 'V1' })),
    )

    await expect(resolve(db, requested)).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })
    expect(base).toHaveBeenCalledTimes(1)

    now += 501
    await expect(resolve(db, requested)).resolves.toEqual({ landscapeId: 'L1', versionId: 'V2' })
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('does not cache unknown workspaces', async () => {
    const base = vi.fn().mockResolvedValue(null)
    const resolve = createSingleFlightWorkspaceRouteResolver(base, { cacheTtlMs: 500 })
    const requested = { landscapeId: 'L1', versionId: 'missing' }

    await expect(resolve({} as never, requested)).resolves.toBeNull()
    await expect(resolve({} as never, requested)).resolves.toBeNull()
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('keeps validated concrete routes warm longer than a moving current alias', async () => {
    let now = 1_000
    const base = vi.fn().mockImplementation(async (_db, requested) => requested)
    const resolve = createSingleFlightWorkspaceRouteResolver(base, {
      cacheTtlMs: 500,
      concreteCacheTtlMs: 30_000,
      now: () => now,
    })
    const concrete = { landscapeId: 'L1', versionId: 'V1' }
    await resolve({} as never, concrete)
    now += 5_000
    await resolve({} as never, concrete)
    expect(base).toHaveBeenCalledTimes(1)

    now += 25_001
    await resolve({} as never, concrete)
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('forgets one landscape on invalidate and reports how much it forgot', async () => {
    const base = vi.fn().mockImplementation(async (_db, requested) => requested)
    const resolve = createSingleFlightWorkspaceRouteResolver(base, { cacheTtlMs: 500 })
    await resolve({} as never, { landscapeId: 'L1', versionId: 'V1' })
    await resolve({} as never, { landscapeId: 'L1', versionId: 'V2' })
    await resolve({} as never, { landscapeId: 'L2', versionId: 'V1' })
    expect(base).toHaveBeenCalledTimes(3)

    expect(resolve.invalidate('L1')).toBe(2)

    await resolve({} as never, { landscapeId: 'L2', versionId: 'V1' })
    expect(base).toHaveBeenCalledTimes(3) // the neighbour is untouched
    await resolve({} as never, { landscapeId: 'L1', versionId: 'V1' })
    expect(base).toHaveBeenCalledTimes(4)
  })

  it('does not treat a longer landscape id as a match on a shorter one', async () => {
    const base = vi.fn().mockImplementation(async (_db, requested) => requested)
    const resolve = createSingleFlightWorkspaceRouteResolver(base, { cacheTtlMs: 500 })
    await resolve({} as never, { landscapeId: 'L1', versionId: 'V1' })
    await resolve({} as never, { landscapeId: 'L1-extra', versionId: 'V1' })

    expect(resolve.invalidate('L1')).toBe(1)
  })

  it('separates having invalidated from having had nothing to invalidate', () => {
    const resolve = createSingleFlightWorkspaceRouteResolver(vi.fn(), { cacheTtlMs: 500 })
    // A repoint that drains sockets on the strength of an invalidation is
    // entitled to know the invalidation touched nothing.
    expect(resolve.invalidate('L1')).toBe(0)
  })

  it('refuses the answer of a flight ISSUED before the invalidation', async () => {
    // The window a naive invalidate leaves open, and the one a repoint is
    // racing: the stale resolution is already at the database when the default
    // moves, and its `.then` runs afterwards. Dropping the entry is not enough
    // if the flight is allowed to put it back.
    let release!: (value: { landscapeId: string; versionId: string }) => void
    const inFlight = new Promise<{ landscapeId: string; versionId: string }>((resolve) => {
      release = resolve
    })
    const base = vi.fn()
      .mockReturnValueOnce(inFlight)
      .mockResolvedValue({ landscapeId: 'L1', versionId: 'V2' })
    const resolve = createSingleFlightWorkspaceRouteResolver(base, { cacheTtlMs: 500 })
    const requested = { landscapeId: 'L1', versionId: 'current' }

    const stale = resolve({} as never, requested)
    resolve.invalidate('L1')
    release({ landscapeId: 'L1', versionId: 'V1' })
    await expect(stale).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })

    await expect(resolve({} as never, requested)).resolves.toEqual({ landscapeId: 'L1', versionId: 'V2' })
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('does not let a caller arriving after the invalidation join the stale flight', async () => {
    let release!: (value: { landscapeId: string; versionId: string }) => void
    const inFlight = new Promise<{ landscapeId: string; versionId: string }>((resolve) => {
      release = resolve
    })
    const base = vi.fn()
      .mockReturnValueOnce(inFlight)
      .mockResolvedValue({ landscapeId: 'L1', versionId: 'V2' })
    const resolve = createSingleFlightWorkspaceRouteResolver(base, { cacheTtlMs: 500 })
    const requested = { landscapeId: 'L1', versionId: 'current' }

    const before = resolve({} as never, requested)
    resolve.invalidate('L1')
    const after = resolve({} as never, requested)

    release({ landscapeId: 'L1', versionId: 'V1' })
    await expect(before).resolves.toEqual({ landscapeId: 'L1', versionId: 'V1' })
    await expect(after).resolves.toEqual({ landscapeId: 'L1', versionId: 'V2' })
  })

  it('clears a rejected flight so a later upgrade can recover', async () => {
    const base = vi.fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ landscapeId: 'L1', versionId: 'V1' })
    const resolve = createSingleFlightWorkspaceRouteResolver(base)
    const requested = { landscapeId: 'L1', versionId: 'V1' }

    await expect(resolve({} as never, requested)).rejects.toThrow('database unavailable')
    await expect(resolve({} as never, requested)).resolves.toEqual(requested)
    expect(base).toHaveBeenCalledTimes(2)
  })
})
