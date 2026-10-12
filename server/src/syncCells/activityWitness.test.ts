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

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { CLAIM_PROTOCOL_VERSION } from '../rbac/documentClaims.js'
import { ActivityWitness, type ActivityVerdict, type ActivityWitnessOptions } from './activityWitness.js'

const workspace = { landscapeId: 'activity-land', versionId: 'activity-version' }
const now = Date.parse('2026-09-13T12:00:00.000Z')
type Rows = { rows: Record<string, unknown>[]; rowCount: number }
type Database = ConstructorParameters<typeof ActivityWitness>[0]
function row(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { workspace_status: 'active', observed_at: new Date(now), claim_coverage_current: true,
    admitted_documents: '2', missing_content_documents: '0', latest_content_at: new Date(now - 120_000), ...changes }
}
const rows = (value = row()): Rows => ({ rows: [value], rowCount: 1 })
const witnesses: ActivityWitness[] = []
const releasePending: (() => void)[] = []

function deferred() {
  let resolve!: (result: Rows) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Rows>((yes, no) => { resolve = yes; reject = no })
  releasePending.push(() => resolve(rows()))
  return { promise, resolve, reject }
}

function fixture(result: () => Promise<Rows> = async () => rows(), options: Partial<ActivityWitnessOptions> = {}) {
  const query = vi.fn(result)
  const end = vi.fn()
  const db = { query, end, options: { connectionTimeoutMillis: 10_000, statement_timeout: 30_000 } } as unknown as Database
  const witness = new ActivityWitness(db, { idleAfterMs: 60_000,
    clock: { wall: Date.now, monotonic: Date.now }, ...options })
  witnesses.push(witness)
  return { witness, query, end, db }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now) })
afterEach(async () => {
  for (const release of releasePending.splice(0)) release()
  for (const witness of witnesses.splice(0)) await witness.stop()
  const timers = vi.getTimerCount()
  vi.useRealTimers()
  expect(timers).toBe(0)
})

describe('durable content activity witness (T-14b)', () => {
  it('has three typed verdicts and exposes facts only after narrowing away unknown', () => {
    expectTypeOf<ActivityVerdict['kind']>().toEqualTypeOf<'active' | 'idle' | 'unknown'>()
    expectTypeOf<ActivityVerdict>().extract<{ kind: 'unknown' }>().toHaveProperty('reason')
    expectTypeOf<ActivityVerdict>().extract<{ kind: 'idle' }>().toHaveProperty('facts')
    expectTypeOf<ActivityVerdict>().not.toMatchTypeOf<number>()
  })

  it('observes a covered quiet inventory and preserves its database time and query count', async () => {
    const { witness, query } = fixture()
    expect(witness.snapshot()).toBeNull()
    expect(await witness.sample(workspace)).toMatchObject({ kind: 'idle', workspace,
      observedAt: '2026-09-13T12:00:00.000Z', sampleCount: 1, ageMs: 0,
      facts: { admittedDocuments: 2, missingContentDocuments: 0 } })
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(String),
      [workspace.landscapeId, workspace.versionId, CLAIM_PROTOCOL_VERSION])
  })

  it.each([
    ['within', now - 59_999, 'active'],
    ['boundary', now - 60_000, 'active'],
    ['outside', now - 60_001, 'idle'],
  ] as const)('classifies the explicit lookback at its %s point', async (_label, at, kind) => {
    const { witness } = fixture(async () => rows(row({ latest_content_at: new Date(at) })))
    expect(await witness.sample(workspace)).toMatchObject({ kind, sampleCount: 1 })
  })

  it('recent content proves activity even when another admitted document is missing or coverage is absent', async () => {
    const { witness } = fixture(async () => rows(row({ latest_content_at: new Date(now - 1),
      missing_content_documents: '1', claim_coverage_current: false })))
    expect(await witness.sample(workspace)).toMatchObject({ kind: 'active', facts: { claimCoverageCurrent: false } })
  })

  it.each([
    ['workspace absent', { workspace_status: null }, 'workspace-not-active'],
    ['workspace retired', { workspace_status: 'retired' }, 'workspace-not-active'],
    ['coverage absent', { claim_coverage_current: false }, 'uncovered'],
    ['inventory empty', { admitted_documents: '0', latest_content_at: null }, 'no-documents'],
    ['content absent', { missing_content_documents: '1' }, 'missing-content'],
    ['all content absent', { missing_content_documents: '2', latest_content_at: null }, 'missing-content'],
    ['content clock ahead', { latest_content_at: new Date(now + 1) }, 'future-content-clock'],
  ])('refuses to infer idle when %s', async (_label, changes, reason) => {
    const { witness } = fixture(async () => rows(row(changes as Record<string, unknown>)))
    expect(await witness.sample(workspace)).toMatchObject({ kind: 'unknown', reason, sampleCount: 1,
      observedAt: '2026-09-13T12:00:00.000Z' })
  })

  it.each([
    ['zero rows', { rows: [], rowCount: 0 }],
    ['duplicate rows', { rows: [row(), row()], rowCount: 2 }],
    ['unsafe count', rows(row({ admitted_documents: '9007199254740992' }))],
    ['malformed count', rows(row({ admitted_documents: '2oops' }))],
    ['negative count', rows(row({ missing_content_documents: '-1' }))],
    ['inconsistent count', rows(row({ missing_content_documents: '3' }))],
    ['missing coverage', rows(row({ claim_coverage_current: undefined }))],
    ['invalid timestamp', rows(row({ observed_at: new Date(NaN) }))],
    ['empty inventory with a timestamp', rows(row({ admitted_documents: '0' }))],
    ['content present without a timestamp', rows(row({ latest_content_at: null }))],
  ])('makes malformed input unknown: %s', async (_label, result) => {
    const { witness } = fixture(async () => result as Rows)
    expect(await witness.sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'invalid-result',
      observedAt: null, ageMs: null, sampleCount: 1 })
  })

  it.each(['synchronous throw', 'rejection'])('reports query %s without leaking error text', async form => {
    const result = () => {
      if (form === 'synchronous throw') throw new Error('private-database-details')
      return Promise.reject(new Error('private-database-details'))
    }
    const { witness } = fixture(result)
    const verdict = await witness.sample(workspace)
    expect(verdict).toMatchObject({ kind: 'unknown', reason: 'query-failed', sampleCount: 1, observedAt: null })
    expect(JSON.stringify(verdict)).not.toContain('private-database-details')
    expect(await witness.sample(workspace)).toMatchObject({ kind: 'unknown', sampleCount: 2 })
  })

  it('times out at 10,000 ms and retains the actual query until it settles', async () => {
    const pending = deferred()
    const { witness, query } = fixture(() => pending.promise)
    let verdict: ActivityVerdict | undefined
    void witness.sample(workspace).then(value => { verdict = value })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(verdict).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(verdict).toMatchObject({ kind: 'unknown', reason: 'query-timeout', sampleCount: 1, observedAt: null })
    expect(await witness.sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'query-in-flight', sampleCount: 1 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await witness.sample({ ...workspace, versionId: 'another' })).toMatchObject({
      kind: 'unknown', reason: 'query-in-flight', workspace: { versionId: 'another' }, sampleCount: 1, observedAt: null })
    expect(query).toHaveBeenCalledTimes(1)
    pending.resolve(rows())
    await vi.advanceTimersByTimeAsync(0)
    expect(witness.snapshot()).toMatchObject({ kind: 'unknown', reason: 'query-timeout', observedAt: null })
    query.mockResolvedValue(rows(row({ observed_at: new Date(Date.now()) })))
    expect(await witness.sample(workspace)).toMatchObject({ kind: 'idle', sampleCount: 2 })
  })

  it('handles a late rejection without rewriting a timeout as a newly observed result', async () => {
    const pending = deferred()
    const { witness } = fixture(() => pending.promise)
    const visible = witness.sample(workspace)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await visible).toMatchObject({ reason: 'query-timeout', sampleCount: 1 })
    pending.reject(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(witness.snapshot()).toMatchObject({ reason: 'query-timeout', observedAt: null, sampleCount: 1 })
  })

  it('does not turn a delayed result green when its timer callback has not run yet', async () => {
    let mono = 0
    const pending = deferred()
    const { witness } = fixture(() => pending.promise, { clock: { wall: Date.now, monotonic: () => mono } })
    const visible = witness.sample(workspace)
    await Promise.resolve()
    mono = 10_000
    pending.resolve(rows())
    expect(await visible).toMatchObject({ kind: 'unknown', reason: 'query-timeout', observedAt: null })
  })

  it('ages a successful snapshot on the monotonic clock without another query', async () => {
    const { witness, query } = fixture()
    await witness.sample(workspace)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(witness.snapshot()).toMatchObject({ kind: 'idle', ageMs: 9_999, sampleCount: 1 })
    await vi.advanceTimersByTimeAsync(1)
    expect(witness.snapshot()).toMatchObject({ kind: 'unknown', reason: 'expired', ageMs: 10_000,
      observedAt: '2026-09-13T12:00:00.000Z', sampleCount: 1 })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('keeps the observed time and age independent from later wall-clock changes', async () => {
    let mono = 0
    let wall = now
    const { witness } = fixture(undefined, { clock: { wall: () => wall, monotonic: () => mono } })
    await witness.sample(workspace)
    wall -= 86_400_000
    mono += 1_000
    expect(witness.snapshot()).toMatchObject({ kind: 'idle', ageMs: 1_000,
      observedAt: '2026-09-13T12:00:00.000Z' })
    mono = -1
    expect(witness.snapshot()).toMatchObject({ kind: 'unknown', reason: 'invalid-clock', ageMs: null })
  })

  it('joins stop with the raw work after timeout, without closing the caller pool', async () => {
    const pending = deferred()
    const { witness, query, end } = fixture(() => pending.promise)
    const visible = witness.sample(workspace)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await visible).toMatchObject({ kind: 'unknown', reason: 'query-timeout' })
    let stopped = false
    const stopping = witness.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(100_000)
    expect(stopped).toBe(false)
    expect(await witness.sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'stopped', sampleCount: 1 })
    expect(query).toHaveBeenCalledTimes(1)
    pending.resolve(rows())
    await stopping
    expect(stopped).toBe(true)
    expect(end).not.toHaveBeenCalled()
    expect(witness.snapshot()).toMatchObject({ kind: 'unknown', reason: 'stopped', observedAt: null })
  })

  it('settles a pending visible read as stopped and discards its later content', async () => {
    const pending = deferred()
    const { witness } = fixture(() => pending.promise)
    const visible = witness.sample(workspace)
    await Promise.resolve()
    const stopping = witness.stop()
    expect(await visible).toMatchObject({ kind: 'unknown', reason: 'stopped', sampleCount: 1 })
    pending.resolve(rows())
    await stopping
    expect(witness.snapshot()).toMatchObject({ kind: 'unknown', reason: 'stopped', observedAt: null })
  })

  it('does not dispatch or count a query when stopped before its scheduled dispatch', async () => {
    const { witness, query } = fixture()
    const visible = witness.sample(workspace)
    await witness.stop()
    expect(await visible).toMatchObject({ kind: 'unknown', reason: 'stopped', sampleCount: 0 })
    expect(query).not.toHaveBeenCalled()
  })

  it('keeps the copied workspace identity stable while the caller mutates its key', async () => {
    const { witness, query } = fixture()
    const key = { ...workspace }
    const visible = witness.sample(key)
    key.versionId = 'changed'
    expect(await visible).toMatchObject({ workspace })
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(String),
      [workspace.landscapeId, workspace.versionId, CLAIM_PROTOCOL_VERSION])
  })

  it.each([undefined, 0, -1, Infinity, 10_001])('refuses an unbounded pool or a verdict ceiling shorter than its patience (%s)', patience => {
    const db = { query: vi.fn(), options: { connectionTimeoutMillis: patience } } as unknown as Database
    expect(() => new ActivityWitness(db, { idleAfterMs: 60_000 })).toThrow('connectionTimeoutMillis')
  })

  it.each([undefined, false, true, 0, -1, Infinity, 0.5])('requires the pool to bound SQL work (%s)', statementTimeout => {
    const db = { query: vi.fn(), options: { connectionTimeoutMillis: 10_000, statement_timeout: statementTimeout } } as unknown as Database
    expect(() => new ActivityWitness(db, { idleAfterMs: 60_000 })).toThrow('statement_timeout')
  })

  it.each([0, -1, NaN, Infinity, 0.5])('rejects invalid activity lookback %s', idleAfterMs => {
    expect(() => fixture(undefined, { idleAfterMs })).toThrow('lookback')
  })
})
