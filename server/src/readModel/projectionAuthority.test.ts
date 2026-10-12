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
import { ReadModelWriteFenceError } from './health.js'
import {
  LOCK_NOT_AVAILABLE,
  PROJECTION_MUTEX_WAIT_MS,
  ReadModelPlaneError,
  STATIC_PLANE_LOCK_WAIT_MS,
  assertReadModelPlane,
  isProjectionMutexTimeout,
  isReadModelAuthorityLoss,
  projectionMutexKey,
} from './projectionAuthority.js'
import type { Queryable } from './types.js'

const WS = { landscapeId: 'land', versionId: 'version' }

/**
 * The pure half of the plane protocol. These are PURE functions, so testing
 * them directly is the cheapest place to pin them; the wrapped-cause case in
 * particular is seen by only one call site. Both call sites are also driven by
 * the projector service tests.
 */
describe('isReadModelAuthorityLoss', () => {
  const fence = () => new ReadModelWriteFenceError(WS, 'mine', 'theirs')
  const plane = () => new ReadModelPlaneError(WS, 'ordinary')

  it('recognises both authority losses, raw', () => {
    expect(isReadModelAuthorityLoss(fence())).toBe(true)
    expect(isReadModelAuthorityLoss(plane())).toBe(true)
  })

  it('recognises both through a WRAPPER, which is how the retry-budget guard sees them', () => {
    // `attachDiagramDoc` rethrows into `new DiagramFlowProjectionError(id, fn,
    // { cause })`, so `handleDiagramAttachFailure` — the site that decides
    // whether to schedule a reprojection — never sees the raw error. The
    // predicate unwraps it so that site cannot disagree with the others about
    // what counts.
    expect(isReadModelAuthorityLoss(new Error('wrapped', { cause: fence() }))).toBe(true)
    expect(isReadModelAuthorityLoss(new Error('wrapped', { cause: plane() }))).toBe(true)
  })

  it('is not a catch-all — the anti-void control', () => {
    // Without these, a predicate that returned `true` unconditionally would
    // pass everything above, and every caller would silently stop degrading,
    // stop retrying and stop reporting REAL faults.
    expect(isReadModelAuthorityLoss(new Error('the projection genuinely failed'))).toBe(false)
    expect(isReadModelAuthorityLoss(new Error('outer', { cause: new Error('inner') }))).toBe(false)
    expect(isReadModelAuthorityLoss(undefined)).toBe(false)
    expect(isReadModelAuthorityLoss(null)).toBe(false)
    expect(isReadModelAuthorityLoss('a string')).toBe(false)
    // A cause that is a plain object rather than an Error must not match on
    // shape alone.
    expect(isReadModelAuthorityLoss({ cause: { name: 'ReadModelPlaneError' } })).toBe(false)
  })
})

describe('isProjectionMutexTimeout', () => {
  const busy = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })

  it('recognises a lock timeout, raw and wrapped', () => {
    expect(isProjectionMutexTimeout(busy())).toBe(true)
    // Wrapped, because `attachDiagramDoc` rethrows into
    // `DiagramFlowProjectionError` before the guards downstream see it. The two
    // predicates must agree about what they can see or a caller asking both
    // gets "neither" for something that is plainly one of them.
    expect(isProjectionMutexTimeout(new Error('wrapped', { cause: busy() }))).toBe(true)
    expect(LOCK_NOT_AVAILABLE).toBe('55P03')
  })

  it('is not an authority loss, and an authority loss is not it — they are DISJOINT', () => {
    // The split is the whole design: an authority loss is permanent and must
    // not be retried; a busy mutex clears when the holder commits and must be.
    // Merging them would make a diagram abandon over transient contention.
    expect(isReadModelAuthorityLoss(busy())).toBe(false)
    expect(isProjectionMutexTimeout(new ReadModelPlaneError(WS, 'ordinary'))).toBe(false)
    expect(isProjectionMutexTimeout(new ReadModelWriteFenceError(WS, 'mine', 'theirs'))).toBe(false)
  })

  it('is not a catch-all — the anti-void control', () => {
    // A near-miss SQLSTATE matters: `55P03` is `lock_not_available`, and the
    // neighbouring codes are unrelated faults that MUST still be recorded.
    expect(isProjectionMutexTimeout(Object.assign(new Error('x'), { code: '55P04' }))).toBe(false)
    expect(isProjectionMutexTimeout(Object.assign(new Error('x'), { code: '57P01' }))).toBe(false)
    expect(isProjectionMutexTimeout(new Error('canceling statement due to lock timeout'))).toBe(false)
    expect(isProjectionMutexTimeout(undefined)).toBe(false)
    expect(isProjectionMutexTimeout(null)).toBe(false)
    expect(isProjectionMutexTimeout('55P03')).toBe(false)
  })
})

describe('projectionMutexKey', () => {
  it('is the one definition both planes derive from', () => {
    // Spelled out as well as derived: asserting only `projectionMutexKey(WS)`
    // would agree with any string the builder returned, including a constant
    // one — and a constant key serializes every workspace against every other.
    expect(projectionMutexKey(WS)).toBe('read-model-projection:land:version')
    expect(projectionMutexKey({ landscapeId: 'a', versionId: 'b' })).toBe('read-model-projection:a:b')
    // Both components participate. A key that dropped one would silently make
    // two versions of a landscape share a mutex — or, worse, not share one.
    expect(projectionMutexKey({ landscapeId: 'a', versionId: 'b' }))
      .not.toBe(projectionMutexKey({ landscapeId: 'a', versionId: 'c' }))
    expect(projectionMutexKey({ landscapeId: 'a', versionId: 'b' }))
      .not.toBe(projectionMutexKey({ landscapeId: 'z', versionId: 'b' }))
  })
})

describe('assertReadModelPlane', () => {
  const db = (present: boolean) => ({
    query: vi.fn(async () => ({ rows: [{ present }], rowCount: 1 })),
  } as unknown as Queryable)

  it('admits each plane on its own workspace and refuses it on the other', async () => {
    await expect(assertReadModelPlane(db(true), WS, 'static')).resolves.toBeUndefined()
    await expect(assertReadModelPlane(db(false), WS, 'ordinary')).resolves.toBeUndefined()
    await expect(assertReadModelPlane(db(true), WS, 'ordinary')).rejects.toBeInstanceOf(ReadModelPlaneError)
    await expect(assertReadModelPlane(db(false), WS, 'static')).rejects.toBeInstanceOf(ReadModelPlaneError)
  })

  it('names the workspace and the plane, because the log line is the only witness a reader gets', async () => {
    const error = await assertReadModelPlane(db(true), WS, 'ordinary').catch((caught) => caught)
    expect((error as ReadModelPlaneError).plane).toBe('ordinary')
    expect((error as ReadModelPlaneError).code).toBe('read_model_plane_lost')
    expect(String((error as Error).message)).toContain('land/version')
  })

  it('asks about THIS workspace, not some other one', async () => {
    const probe = db(false)
    await assertReadModelPlane(probe, WS, 'ordinary')
    const calls = (probe.query as unknown as { mock: { calls: [string, unknown[]?][] } }).mock.calls
    expect(calls[0]?.[1]).toEqual(['land', 'version'])
  })

  it('A10 — the two ceilings are SEPARATE constants, pinned to literals', () => {
    // They currently agree but are not the same fact. The mutex ceiling is
    // argued from "whoever holds it fails an authority check in one round
    // trip"; the row-lock ceiling's holder is a demotion or a `clearWorkspace`,
    // bulk deletes whose duration scales with the workspace. Reusing one
    // constant for both silently inherits an argument that does not transfer —
    // an invariant stated as a PROXY.
    //
    // LITERALS on both sides, and no assertion relating them: a bound derived
    // from the constant under test agrees with any value that constant is
    // given, and an equality between the two would re-create exactly the
    // coupling this separation exists to break.
    expect(PROJECTION_MUTEX_WAIT_MS).toBe(5_000)
    expect(STATIC_PLANE_LOCK_WAIT_MS).toBe(5_000)
  })
})
