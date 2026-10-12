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
import { ColdBuildAdmissionStoppedError, ColdBuildQueueFullError } from './coldBuildAdmission.js'
import { ProjectorOwnershipError, ProjectorStaticWorkspaceError } from './projectorService.js'
import {
  classifyWarmupFailure,
  createWarmupOutcomeLog,
  isWarmupReasonRetryable,
} from './warmupOutcome.js'

const KEY = { landscapeId: 'land', versionId: 'v1' }
const OTHER = { landscapeId: 'land', versionId: 'v2' }

describe('classifyWarmupFailure', () => {
  it('reads each reason off the class itself, so a renamed code cannot drift', () => {
    // The values are NOT retyped here either: comparing against `error.code`
    // means a rename moves both sides at once. The union in the module is built
    // from `ClassName['code']`, so the rename is also a compile error.
    const cases = [
      new ProjectorOwnershipError(),
      new ProjectorStaticWorkspaceError(KEY),
      new ColdBuildQueueFullError(),
      new ColdBuildAdmissionStoppedError(),
    ]
    for (const error of cases) {
      expect(classifyWarmupFailure(error)).toEqual({ reason: error.code, expected: true })
    }
  })

  it('reports an unrecognised failure as unexpected, so the caller still logs a stack', () => {
    expect(classifyWarmupFailure(new Error('boom')))
      .toEqual({ reason: 'cold_build_failed', expected: false })
    expect(classifyWarmupFailure('not even an error'))
      .toEqual({ reason: 'cold_build_failed', expected: false })
    expect(classifyWarmupFailure(undefined))
      .toEqual({ reason: 'cold_build_failed', expected: false })
  })

  it('does NOT classify a foreign error that merely carries a `code`', () => {
    // The four classes all expose `code`, so reading it off an arbitrary error
    // would be shorter and would swallow this one silently — a missing relation
    // reported as expected backpressure.
    const relationMissing = Object.assign(new Error('relation does not exist'), {
      code: 'read_model_cold_build_queue_full',
    })
    expect(classifyWarmupFailure(relationMissing))
      .toEqual({ reason: 'cold_build_failed', expected: false })
  })
})

describe('isWarmupReasonRetryable', () => {
  it('marks ONLY the unresolvable root permanent', () => {
    // The classes' own `retryable` answers a different question. Static is the
    // one that proves it: the class says false, but retrying the REQUEST hits
    // the static short-circuit before `ensure()` and very likely succeeds.
    expect(isWarmupReasonRetryable('workspace_root_unresolved')).toBe(false)
    expect(new ProjectorStaticWorkspaceError(KEY).retryable).toBe(false)
    expect(isWarmupReasonRetryable('read_model_workspace_is_static')).toBe(true)

    expect(isWarmupReasonRetryable('cold_build_in_flight')).toBe(true)
    expect(isWarmupReasonRetryable('read_model_workspace_not_owned')).toBe(true)
    expect(isWarmupReasonRetryable('read_model_cold_build_queue_full')).toBe(true)
    expect(isWarmupReasonRetryable('read_model_cold_build_admission_stopped')).toBe(true)
    expect(isWarmupReasonRetryable('cold_build_failed')).toBe(true)
  })
})

describe('createWarmupOutcomeLog', () => {
  it('answers the in-flight default before anything has reported back', () => {
    const log = createWarmupOutcomeLog({ log: () => {} })
    expect(log.verdictFor(KEY)).toEqual({
      reason: 'cold_build_in_flight', retryable: true, reasonAgeMs: 0,
    })
    expect(log.size()).toBe(0)
  })

  it('records the no-root case, which `ensure()` reports by RESOLVING false', () => {
    const log = createWarmupOutcomeLog({ log: () => {} })
    log.noteSettled(KEY, false)
    expect(log.verdictFor(KEY)).toMatchObject({
      reason: 'workspace_root_unresolved', retryable: false,
    })
  })

  it('READING a verdict does not destroy it', () => {
    // A poller at 1 Hz must get the same cause on every poll; a read-eviction
    // would answer it once and then `cold_build_in_flight` forever after.
    const log = createWarmupOutcomeLog({ log: () => {} })
    log.noteSettled(KEY, false)
    const first = log.verdictFor(KEY)
    const second = log.verdictFor(KEY)
    expect(second.reason).toBe(first.reason)
    expect(log.size()).toBe(1)
  })

  it('carries the AGE of the verdict, because a stored reason is a fact about the past', () => {
    let clock = 1_000
    const log = createWarmupOutcomeLog({ log: () => {}, now: () => clock })
    log.noteFailed(KEY, new ColdBuildQueueFullError())
    expect(log.verdictFor(KEY).reasonAgeMs).toBe(0)
    clock += 30_000
    expect(log.verdictFor(KEY)).toEqual({
      reason: 'read_model_cold_build_queue_full', retryable: true, reasonAgeMs: 30_000,
    })
  })

  it('drops the entry when the workspace becomes resident', () => {
    const log = createWarmupOutcomeLog({ log: () => {} })
    log.noteSettled(KEY, false)
    log.noteSettled(KEY, true)
    expect(log.verdictFor(KEY).reason).toBe('cold_build_in_flight')
    expect(log.size()).toBe(0)
  })

  it('logs once per (workspace, reason) transition, not once per request', () => {
    const lines: string[] = []
    const log = createWarmupOutcomeLog({ log: (line) => lines.push(line) })
    for (let i = 0; i < 20; i += 1) log.noteSettled(KEY, false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('land/v1')
    expect(lines[0]).toContain('workspace_root_unresolved')

    log.noteFailed(KEY, new ColdBuildQueueFullError())
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('read_model_cold_build_queue_full')
    expect(lines[1]).toContain('was workspace_root_unresolved')
  })

  it('refreshes recency on an UNCHANGED reason, so a live entry survives a flood', () => {
    // Without the refresh, a stable correctly-recorded workspace keeps its
    // original slot, drifts to the head of the map, and is the FIRST thing a
    // flood of novel keys evicts — silently disarming the detector.
    const log = createWarmupOutcomeLog({ log: () => {}, maxEntries: 2 })
    log.noteSettled({ landscapeId: 'a', versionId: '1' }, false)
    log.noteSettled({ landscapeId: 'b', versionId: '1' }, false)
    // Touch `a` again with the SAME reason — the early-return path.
    log.noteSettled({ landscapeId: 'a', versionId: '1' }, false)
    log.noteSettled({ landscapeId: 'c', versionId: '1' }, false)

    expect(log.verdictFor({ landscapeId: 'a', versionId: '1' }).reason)
      .toBe('workspace_root_unresolved')
    expect(log.verdictFor({ landscapeId: 'b', versionId: '1' }).reason)
      .toBe('cold_build_in_flight')
  })

  it('bounds the log for the ONE reason an unvalidated workspace id can reach', () => {
    // `canonicalWorkspaceKey` returns its argument unchanged unless the version
    // is `current`, and with AUTH off the access check passes, so an arbitrary
    // `?versionId=<anything>` lands on `workspace_root_unresolved`. Unbounded,
    // that is one log line per novel key from an unauthenticated caller.
    const lines: string[] = []
    const log = createWarmupOutcomeLog({
      log: (line) => lines.push(line), maxEntries: 1_000, maxLoggedUnresolved: 3,
    })
    for (let i = 0; i < 50; i += 1) {
      log.noteSettled({ landscapeId: 'flood', versionId: `v${i}` }, false)
    }
    // Three real lines plus exactly one "further lines are suppressed" notice.
    expect(lines).toHaveLength(4)
    expect(lines[3]).toContain('suppressed')
    expect(log.suppressedLogCount()).toBe(47)
  })

  it('does NOT bound the reasons only a real workspace can reach', () => {
    const lines: string[] = []
    const log = createWarmupOutcomeLog({
      log: (line) => lines.push(line), maxLoggedUnresolved: 1,
    })
    for (let i = 0; i < 10; i += 1) {
      log.noteFailed({ landscapeId: 'real', versionId: `v${i}` }, new ProjectorOwnershipError())
    }
    expect(lines).toHaveLength(10)
    expect(log.suppressedLogCount()).toBe(0)
  })

  it('bounds the map, evicting the oldest entry first', () => {
    const log = createWarmupOutcomeLog({ log: () => {}, maxEntries: 2 })
    log.noteSettled({ landscapeId: 'a', versionId: '1' }, false)
    log.noteSettled({ landscapeId: 'b', versionId: '1' }, false)
    log.noteSettled({ landscapeId: 'c', versionId: '1' }, false)
    expect(log.size()).toBe(2)
    expect(log.verdictFor({ landscapeId: 'a', versionId: '1' }).reason).toBe('cold_build_in_flight')
    expect(log.verdictFor({ landscapeId: 'c', versionId: '1' }).reason)
      .toBe('workspace_root_unresolved')
  })

  it('keeps workspaces apart', () => {
    const log = createWarmupOutcomeLog({ log: () => {} })
    log.noteSettled(KEY, false)
    expect(log.verdictFor(OTHER).reason).toBe('cold_build_in_flight')
  })
})
