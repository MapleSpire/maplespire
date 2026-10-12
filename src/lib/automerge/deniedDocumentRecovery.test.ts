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

import { describe, it, expect, vi } from 'vitest'
import type { DocumentId } from '@automerge/automerge-repo'
import {
  applyDurableVerdicts,
  DeniedDocumentRecovery,
  DEFAULT_DENIED_RECOVERY_LIMITS,
  type DeniedRecoveryLimits,
} from './deniedDocumentRecovery'

const doc = (name: string): DocumentId => name as DocumentId

const LIMITS: DeniedRecoveryLimits = {
  failuresBeforeFirstRetry: 3,
  maxAttemptsPerDocument: 3,
  firstBackoffMs: 1_000,
  maxBackoffMs: 4_000,
  maxAttemptsPerSession: 5,
}

/** Drive one document to its first eligible retry. */
function makeDue(recovery: DeniedDocumentRecovery, id: DocumentId, limits = LIMITS): void {
  for (let i = 0; i < limits.failuresBeforeFirstRetry; i += 1) recovery.noteUnacknowledged(id)
}

describe('DeniedDocumentRecovery — when a refusal is re-presented, and when it stops', () => {
  it('does not retry before the refusal looks real', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const a = doc('a')
    // `durable:false` one round after a write is the ORDINARY state, not a
    // refusal: the heads simply have not reached the server's Repo yet. Only a
    // run of them distinguishes the two, which is why the threshold exists.
    recovery.noteUnacknowledged(a)
    expect(recovery.dueDocuments(0)).toEqual([])
    recovery.noteUnacknowledged(a)
    expect(recovery.dueDocuments(0)).toEqual([])
    recovery.noteUnacknowledged(a)
    expect(recovery.dueDocuments(0)).toEqual([a])
  })

  it('an acknowledgement wipes the state, so a later refusal gets a FULL budget', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const a = doc('a')
    makeDue(recovery, a)
    recovery.noteAttempt(a, 0)

    recovery.noteAcknowledged(a)
    expect(recovery.dueDocuments(1_000_000)).toEqual([])
    expect(recovery.snapshot().tracked).toBe(0)

    // A second, unrelated episode for the same document must not inherit the
    // first one's spent attempts — otherwise a document that is refused, healed
    // and refused again would be abandoned early.
    makeDue(recovery, a)
    expect(recovery.dueDocuments(0)).toEqual([a])
  })

  it('backs off exponentially and caps, so a refusing server costs bounded traffic', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const a = doc('a')
    makeDue(recovery, a)

    recovery.noteAttempt(a, 0)
    expect(recovery.dueDocuments(999)).toEqual([])
    expect(recovery.dueDocuments(1_000)).toEqual([a])

    recovery.noteAttempt(a, 1_000)
    expect(recovery.dueDocuments(2_999)).toEqual([])
    expect(recovery.dueDocuments(3_000)).toEqual([a])
  })

  it('stops after maxAttemptsPerDocument and says so EXACTLY ONCE', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const a = doc('a')
    makeDue(recovery, a)

    let now = 0
    for (let i = 0; i < LIMITS.maxAttemptsPerDocument; i += 1) {
      expect(recovery.dueDocuments(now)).toEqual([a])
      recovery.noteAttempt(a, now)
      now += LIMITS.maxBackoffMs
    }
    expect(recovery.dueDocuments(now)).toEqual([])

    // Reported once — a warning repeated every 750 ms round would be noise that
    // trains the reader to ignore it.
    expect(recovery.drainExhausted()).toEqual([a])
    expect(recovery.drainExhausted()).toEqual([])
  })

  it('a session-wide cap bounds a landscape whose server refuses EVERYTHING', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(doc)
    for (const id of ids) makeDue(recovery, id)

    let now = 0
    let spent = 0
    // Ten rounds is far more than the cap allows; the cap must bite regardless.
    for (let round = 0; round < 10; round += 1) {
      for (const id of recovery.dueDocuments(now)) {
        recovery.noteAttempt(id, now)
        spent += 1
      }
      now += LIMITS.maxBackoffMs
    }
    expect(spent).toBe(LIMITS.maxAttemptsPerSession)
    expect(recovery.dueDocuments(now)).toEqual([])
  })

  it('clear() restores a fresh budget for a new workspace session', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const a = doc('a')
    makeDue(recovery, a)
    recovery.noteAttempt(a, 0)
    expect(recovery.snapshot().attemptsThisSession).toBe(1)

    recovery.clear()
    expect(recovery.snapshot()).toEqual({ tracked: 0, attemptsThisSession: 0, exhausted: 0 })
  })

  it('the shipped defaults are bounded, and bounded LOW enough to be worth having', () => {
    // A regression guard on the constants themselves: these are the numbers that
    // decide what a permanently-refusing server costs, and they are the kind of
    // thing that gets "tuned" upward without anyone re-deriving the cost.
    const d = DEFAULT_DENIED_RECOVERY_LIMITS
    expect(d.failuresBeforeFirstRetry).toBeGreaterThanOrEqual(2)
    expect(d.maxAttemptsPerDocument).toBeGreaterThanOrEqual(1)
    expect(d.maxAttemptsPerSession).toBeLessThanOrEqual(1_000)
    expect(d.maxBackoffMs).toBeGreaterThanOrEqual(d.firstBackoffMs)
  })
})

/**
 * These exist because a mutation run proved the inline version untestable: with
 * this decision living in `runDurableAcknowledgement`, deleting it outright or
 * inverting its two branches both left the whole client suite green — 2606
 * passed, byte-identical counts. Every case below fails under one of those.
 */
describe('applyDurableVerdicts — one round of server verdicts', () => {
  const a = doc('a')
  const b = doc('b')

  it('counts a STILL-PENDING document as refused and an acknowledged one as clear', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const represent = vi.fn()

    // Three answered rounds where `a` stays pending and `b` is acknowledged.
    for (let round = 0; round < LIMITS.failuresBeforeFirstRetry; round += 1) {
      const out = applyDurableVerdicts({
        sent: [a, b],
        stillPending: new Set([a]),
        recovery,
        represent,
        now: 0,
      })
      if (round < LIMITS.failuresBeforeFirstRetry - 1) expect(out.represented).toEqual([])
    }

    // Inverting the polarity would re-present `b` and never `a`.
    expect(represent).toHaveBeenCalledWith(a)
    expect(represent).not.toHaveBeenCalledWith(b)
  })

  it('re-presents through the INJECTED function, once per due document', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const represent = vi.fn()
    for (let round = 0; round < LIMITS.failuresBeforeFirstRetry; round += 1) {
      applyDurableVerdicts({ sent: [a], stillPending: new Set([a]), recovery, represent, now: 0 })
    }
    // Guards against a `represent` that is never called: the bookkeeping
    // advances and nothing is actually re-presented.
    expect(represent).toHaveBeenCalledTimes(1)
    expect(represent).toHaveBeenCalledWith(a)
  })

  it('an acknowledgement mid-run RESETS the count, so the refusal must restart', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const represent = vi.fn()
    applyDurableVerdicts({ sent: [a], stillPending: new Set([a]), recovery, represent, now: 0 })
    applyDurableVerdicts({ sent: [a], stillPending: new Set([a]), recovery, represent, now: 0 })
    // Acknowledged: the two failures above must not carry over.
    applyDurableVerdicts({ sent: [a], stillPending: new Set(), recovery, represent, now: 0 })
    applyDurableVerdicts({ sent: [a], stillPending: new Set([a]), recovery, represent, now: 0 })
    expect(represent).not.toHaveBeenCalled()
  })

  it('reports each exhausted document once, so the failure is VISIBLE', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const represent = vi.fn()
    let now = 0
    const exhaustedSeen: DocumentId[] = []
    for (let round = 0; round < 12; round += 1) {
      const out = applyDurableVerdicts({
        sent: [a],
        stillPending: new Set([a]),
        recovery,
        represent,
        now,
      })
      exhaustedSeen.push(...out.exhausted)
      now += LIMITS.maxBackoffMs
    }
    expect(represent).toHaveBeenCalledTimes(LIMITS.maxAttemptsPerDocument)
    expect(exhaustedSeen).toEqual([a])
  })

  it('does nothing at all when the server acknowledged everything', () => {
    const recovery = new DeniedDocumentRecovery(LIMITS)
    const represent = vi.fn()
    const out = applyDurableVerdicts({
      sent: [a, b],
      stillPending: new Set(),
      recovery,
      represent,
      now: 0,
    })
    expect(out).toEqual({ represented: [], exhausted: [] })
    expect(represent).not.toHaveBeenCalled()
    expect(recovery.snapshot().tracked).toBe(0)
  })
})
