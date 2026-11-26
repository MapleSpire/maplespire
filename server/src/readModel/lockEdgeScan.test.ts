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
import { LIFECYCLE_LOCK_CLASS } from '../maintenance/lifecycleApplyLock.js'
import {
  LIFECYCLE_LOCK_CLASS_ON_THE_WIRE,
  lifecycleRotationEdges,
  modelEpochRotationEdges,
  projectionInboundEdges,
  unknownAdvisoryKeys,
  type LockEdgeCall,
} from './lockEdgeScan.js'

/**
 * G5 (task T-G5, decisions D8 and D16) — the inbound edge, not the global order.
 *
 * THE REWRITE THIS GATE IS. The subsystem's documented rule is "one global lock
 * order: `read-model-projection:` before `overlay-rotation:`", encoded by gate A8
 * as "never take the projection xact lock while holding any session lock". D8's
 * arbitration measured that this encoding is STRONGER than the invariant: the
 * maintenance lock it introduces is taken outside any projection transaction, so
 * a maintenance job that then projects takes the mutex while holding it — a
 * violation under A8, and safe.
 *
 * A cycle needs BOTH directions. A8 asserts the outbound one is absent and is
 * structurally blind to the inbound one. This gate asserts the inbound one, and
 * that is the assertion a NEW key has to satisfy.
 */
describe('G5 — the inbound edge into the projection mutex', () => {
  const take = (key: string, scope: 'session' | 'xact' = 'session'): LockEdgeCall => ({
    sql: scope === 'xact'
      ? 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'
      : 'SELECT pg_advisory_lock(hashtextextended($1, 0))',
    params: [key],
  })
  const tryTake = (key: string): LockEdgeCall => ({
    sql: 'SELECT pg_try_advisory_lock(hashtextextended($1, 0))', params: [key],
  })
  const release = (key: string): LockEdgeCall => ({
    sql: 'SELECT pg_advisory_unlock(hashtextextended($1, 0))', params: [key],
  })
  const commit: LockEdgeCall = { sql: 'COMMIT' }

  it('THE SHIPPED SHAPE IS CLEAN: the maintenance lock, then a projection', () => {
    // Exactly what D8 introduces, and exactly what A8 would call a violation.
    // The coordinator holds its per-workspace lock on its own client, OUTSIDE
    // any projection transaction, and the job then projects.
    expect(projectionInboundEdges([
      take('maintenance-workspace:compaction:land:v1'),
      { sql: 'BEGIN' },
      take('read-model-projection:land:v1', 'xact'),
      { sql: 'UPDATE ro_objects SET ...' },
      commit,
      release('maintenance-workspace:compaction:land:v1'),
    ])).toEqual([])
  })

  it('THE HAZARD: a key taken from INSIDE a projection transaction', () => {
    // The edge that completes a cycle. Somebody holding the projection mutex
    // reaches for another lock; anything that holds that lock and then waits for
    // the mutex now deadlocks against it.
    const violations = projectionInboundEdges([
      { sql: 'BEGIN' },
      take('read-model-projection:land:v1', 'xact'),
      take('overlay-rotation:land:v1:object'),
      commit,
    ])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('overlay-rotation:land:v1:object')
    expect(violations[0]).toContain('INBOUND edge')
  })

  it('the mutex is held until the TRANSACTION ends, not until an unlock', () => {
    // It is an xact lock. Clearing the held set on an unlock call instead would
    // make this gate stop looking after the first statement that resembles one.
    expect(projectionInboundEdges([
      { sql: 'BEGIN' },
      take('read-model-projection:land:v1', 'xact'),
      release('something-unrelated'),
      take('overlay-rotation:land:v1:object'),
      commit,
    ]), 'an unlock of an unrelated key cleared the projection mutex').toHaveLength(1)

    // ...and after the transaction ends, the same acquisition is fine.
    expect(projectionInboundEdges([
      { sql: 'BEGIN' },
      take('read-model-projection:land:v1', 'xact'),
      commit,
      take('overlay-rotation:land:v1:object'),
    ])).toEqual([])
  })

  it('ROLLBACK ends it too', () => {
    expect(projectionInboundEdges([
      { sql: 'BEGIN' },
      take('read-model-projection:land:v1', 'xact'),
      { sql: 'ROLLBACK' },
      take('overlay-rotation:land:v1:object'),
    ])).toEqual([])
  })

  it('sees the TRY spelling — the one the projector actually uses', () => {
    // A detector matching only the blocking form would track an empty stack for
    // ever and report zero violations because it stopped looking, not because
    // there are none. That failure mode is named in A8's own comment; repeating
    // it here would be repeating a known defect.
    const violations = projectionInboundEdges([
      { sql: 'BEGIN' },
      take('read-model-projection:land:v1', 'xact'),
      tryTake('overlay-rotation:land:v1:object'),
      commit,
    ])
    expect(violations, 'pg_try_advisory_lock was not recognised as an acquisition').toHaveLength(1)
  })

  it('taking the projection mutex itself is not an edge INTO it', () => {
    // Whether THAT acquisition is safe is A8's question. One gate, one
    // direction — mixing them is what produced an over-strong rule.
    expect(projectionInboundEdges([
      { sql: 'BEGIN' },
      take('read-model-projection:land:v1', 'xact'),
      take('read-model-projection:land:v2', 'xact'),
      commit,
    ])).toEqual([])
  })

  it('a NEW key nobody reasoned about is reported', () => {
    // The registry, not an ordering. A key outside it is one nobody has thought
    // about, and the thinking is what this gate exists to force.
    expect(unknownAdvisoryKeys([
      take('maintenance-workspace:compaction:land:v1'),
      take('overlay-rotation:land:v1:o'),
      take('read-model-projection:land:v1', 'xact'),
    ])).toEqual([])

    expect(unknownAdvisoryKeys([take('some-new-subsystem:land:v1')]))
      .toEqual(['some-new-subsystem:land:v1'])
  })

  it('ignores the legacy numeric namespaces', () => {
    // The maintenance coordinator's per-job key and the sync-cell fences are
    // int64 keys, not `hashtextextended` string keys, and are outside this
    // registry. Reporting them would be a false red on every run.
    expect(unknownAdvisoryKeys([
      { sql: 'SELECT pg_advisory_lock($1)', params: ['1111578706'] },
      { sql: 'SELECT pg_advisory_lock($1, $2)', params: [] },
    ])).toEqual([])
  })

  it('CAN FAIL — the control', () => {
    // A gate asserting a non-existence must be shown able to find one, or a
    // scanner that silently stopped matching reads as a clean subsystem.
    expect(projectionInboundEdges([
      { sql: 'BEGIN' },
      take('read-model-projection:l:v', 'xact'),
      take('anything-at-all:x'),
      commit,
    ]).length).toBeGreaterThan(0)
    expect(unknownAdvisoryKeys([take('anything-at-all:x')]).length).toBeGreaterThan(0)
  })
})

describe('G4-16f — the overlay-rotation ↔ lifecycle edge', () => {
  const rotation = 'overlay-rotation:l:v:objects'
  const takeRotation = (scope: 'session' | 'xact'): LockEdgeCall => ({
    sql: scope === 'xact'
      ? 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'
      : 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
    params: [rotation],
  })
  const releaseRotation: LockEdgeCall = { sql: 'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', params: [rotation] }
  // The spelling of `lifecycleApplyLock.ts`.
  const takeLifecycle = (form: 'try' | 'blocking'): LockEdgeCall => ({
    sql: form === 'try'
      ? 'SELECT pg_try_advisory_lock($1, $2) AS locked, pg_backend_pid() AS pid'
      : 'SELECT pg_advisory_lock($1, $2)',
    params: [LIFECYCLE_LOCK_CLASS, 12345],
  })
  const releaseLifecycle: LockEdgeCall = { sql: 'SELECT pg_advisory_unlock($1, $2) AS unlocked, pg_backend_pid() AS pid', params: [LIFECYCLE_LOCK_CLASS, 12345] }

  it('the wire class is the lifecycle lock\'s own', () => {
    expect(LIFECYCLE_LOCK_CLASS_ON_THE_WIRE).toBe(LIFECYCLE_LOCK_CLASS)
  })

  it('compaction (rotation keys, then a TRY on the lifecycle lock) against a promotion (lifecycle, then the rotation key): both edges, no cycle', () => {
    const compaction = [takeRotation('session'), takeLifecycle('try'), releaseLifecycle, releaseRotation]
    const promotion = [takeLifecycle('try'), { sql: 'BEGIN' }, { sql: "SET LOCAL lock_timeout = '5000ms'" }, takeRotation('xact'), { sql: 'COMMIT' }, releaseLifecycle]
    const a = lifecycleRotationEdges(compaction)
    const b = lifecycleRotationEdges(promotion)
    expect(a.edges).toEqual([{ direction: 'rotation→lifecycle', form: 'try' }])
    expect(b.edges).toEqual([{ direction: 'lifecycle→rotation', form: 'blocking' }])
    expect([...a.violations, ...b.violations]).toEqual([])
  })

  it('CAN FAIL — a BLOCKING lifecycle acquisition under a rotation key (session or xact) is the cycle', () => {
    expect(lifecycleRotationEdges([takeRotation('session'), takeLifecycle('blocking')]).violations).toHaveLength(1)
    expect(lifecycleRotationEdges([{ sql: 'BEGIN' }, takeRotation('xact'), takeLifecycle('blocking')]).violations).toHaveLength(1)
    // …and none once the key is given back or the transaction ended.
    expect(lifecycleRotationEdges([takeRotation('session'), releaseRotation, takeLifecycle('blocking')]).violations).toEqual([])
    expect(lifecycleRotationEdges([{ sql: 'BEGIN' }, takeRotation('xact'), { sql: 'COMMIT' }, takeLifecycle('blocking')]).violations).toEqual([])
  })
})

describe('G4-16f — the overlay-rotation → model-epoch edge', () => {
  const take = (key: string, form: 'try' | 'blocking' = 'try'): LockEdgeCall => ({
    sql: form === 'try' ? 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked' : 'SELECT pg_advisory_lock(hashtextextended($1, 0))',
    params: [key],
  })
  const give = (key: string): LockEdgeCall => ({ sql: 'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', params: [key] })
  const obj = 'overlay-rotation:l:v:object'
  const conn = 'overlay-rotation:l:v:connection'
  const epoch = 'model-epoch:l:v'

  it('the sweep\'s and compaction\'s order — rotation keys, then a TRY on model-epoch — is the one registered edge, no violation', () => {
    const r = modelEpochRotationEdges([take(obj), take(conn), take(epoch), give(epoch), give(conn), give(obj)])
    expect(r.edges).toEqual([{ direction: 'rotation→model-epoch', form: 'try' }])
    expect(r.violations).toEqual([])
    // The repair doors and the retirement pass take model-epoch alone: no edge.
    expect(modelEpochRotationEdges([take(epoch), give(epoch)])).toEqual({ edges: [], violations: [] })
  })

  it('CAN FAIL — the inverted order, and a blocking model-epoch under a rotation key', () => {
    expect(modelEpochRotationEdges([take(epoch), take(obj)]).violations).toHaveLength(1)
    expect(modelEpochRotationEdges([take(obj), take(epoch, 'blocking')]).violations).toHaveLength(1)
    // …and none once the key is given back.
    expect(modelEpochRotationEdges([take(epoch), give(epoch), take(obj)]).violations).toEqual([])
  })
})
