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
import { createDenyLedger, isClientLiftableDeny, isRecoverableDeny, type DenyLedgerOptions } from './denyLedger.js'

const WS = { landscapeId: 'L1', versionId: 'V1' }
const WS2 = { landscapeId: 'L2', versionId: 'V2' }

/** Drives the reconciliation loop by hand. A real interval would make every
 * assertion below a race. */
function harness(overrides: Partial<DenyLedgerOptions> = {}) {
  const onReevaluate = vi.fn()
  const scheduleRepair = vi.fn()
  let now = 1_000
  let tick: (() => void) | null = null
  const ledger = createDenyLedger({
    onReevaluate,
    scheduleRepair,
    clock: () => now,
    schedule: (fn) => { tick = fn; return { cancel: () => { tick = null } } },
    ...overrides,
  })
  return {
    ledger,
    onReevaluate,
    scheduleRepair,
    advance: (ms: number) => { now += ms },
    fire: () => { if (!tick) throw new Error('ledger has no scheduled reconciliation'); tick() },
    isScheduled: () => tick !== null,
  }
}

describe('deny ledger', () => {
  it('classifies which denials a repair could possibly reverse', () => {
    expect(isRecoverableDeny('unindexed-document')).toBe(true)
    expect(isRecoverableDeny('indexed-after-denial')).toBe(true)
    expect(isRecoverableDeny('gate-fault')).toBe(true)
    // These are correct refusals. Recording one would leave an entry that can
    // never drain, and the loop would re-run the share policy across every
    // document and peer on its behalf forever.
    expect(isRecoverableDeny('workspace-mismatch')).toBe(false)
    expect(isRecoverableDeny('missing-peer-route')).toBe(false)
    expect(isRecoverableDeny('rbac')).toBe(false)
    expect(isRecoverableDeny('server-managed-root')).toBe(false)
  })

  it('re-evaluates while a recoverable deny is outstanding', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)
    expect(h.ledger.snapshot().outstanding).toBe(1)

    h.fire()

    expect(h.onReevaluate).toHaveBeenCalledTimes(1)
    // Repair first — re-evaluating against an unrepaired index just re-denies.
    expect(h.scheduleRepair).toHaveBeenCalledWith(WS)
    expect(h.scheduleRepair.mock.invocationCallOrder[0])
      .toBeLessThan(h.onReevaluate.mock.invocationCallOrder[0]!)
  })

  it('does not record a permanent deny, and a permanent verdict supersedes a recoverable one', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'workspace-mismatch', WS)
    expect(h.ledger.snapshot().outstanding).toBe(0)

    h.ledger.recordDeny('peer-1', 'doc-2', 'unindexed-document', WS)
    h.ledger.recordDeny('peer-1', 'doc-2', 'rbac', WS)
    expect(h.ledger.snapshot().outstanding).toBe(0)

    h.fire()
    expect(h.onReevaluate).not.toHaveBeenCalled()
  })

  it('stops re-evaluating once the pair is allowed', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)
    h.ledger.clear('peer-1', 'doc-1')

    h.fire()

    expect(h.ledger.snapshot().outstanding).toBe(0)
    expect(h.onReevaluate).not.toHaveBeenCalled()
  })

  it('an idle tick costs nothing', () => {
    const h = harness()
    h.fire()
    h.fire()
    expect(h.onReevaluate).not.toHaveBeenCalled()
    expect(h.scheduleRepair).not.toHaveBeenCalled()
    expect(h.ledger.snapshot().reconciliations).toBe(0)
  })

  it('writes off an entry that never drains, so one stuck document cannot pin the fan-out', () => {
    const h = harness({ maxReconciliations: 3 })
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)

    for (let i = 0; i < 3; i += 1) h.fire()
    expect(h.ledger.snapshot().outstanding).toBe(1)
    expect(h.onReevaluate).toHaveBeenCalledTimes(3)

    h.fire()
    const snap = h.ledger.snapshot()
    expect(snap.outstanding).toBe(0)
    expect(snap.expired).toBe(1)

    // ...and the loop goes quiet rather than continuing on its behalf.
    h.fire()
    expect(h.onReevaluate).toHaveBeenCalledTimes(3)
  })

  it('a peer re-offering the same document cannot reset its own write-off clock', () => {
    const h = harness({ maxReconciliations: 2 })
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)
    h.fire()
    // The client retries, as a real one does on every sync frame.
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)
    h.fire()
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)
    h.fire()

    expect(h.ledger.snapshot().expired).toBe(1)
    expect(h.ledger.snapshot().outstanding).toBe(0)
  })

  it('is bounded, so a hostile or broken peer cannot grow it without limit', () => {
    const h = harness({ maxOutstanding: 3 })
    for (let i = 0; i < 10; i += 1) {
      h.ledger.recordDeny('peer-1', `doc-${i}`, 'unindexed-document', WS)
    }
    const snap = h.ledger.snapshot()
    expect(snap.outstanding).toBe(3)
    expect(snap.dropped).toBe(7)
  })

  it('drops a disconnected peer, since its verdicts died with its socket', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)
    h.ledger.recordDeny('peer-2', 'doc-1', 'unindexed-document', WS)

    h.ledger.forgetPeer('peer-1')

    expect(h.ledger.snapshot().outstanding).toBe(1)
    h.fire()
    expect(h.onReevaluate).toHaveBeenCalledTimes(1)
  })

  it('requests one repair per distinct workspace, not per entry', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)
    h.ledger.recordDeny('peer-1', 'doc-2', 'unindexed-document', WS)
    h.ledger.recordDeny('peer-2', 'doc-3', 'unindexed-document', WS2)

    h.fire()

    expect(h.scheduleRepair).toHaveBeenCalledTimes(2)
    expect(h.onReevaluate).toHaveBeenCalledTimes(1)
  })

  it('reports what an operator needs to see', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)
    h.advance(5_000)
    h.ledger.recordDeny('peer-1', 'doc-2', 'gate-fault', WS)

    const snap = h.ledger.snapshot()
    expect(snap.byReason).toEqual({ 'unindexed-document': 1, 'gate-fault': 1 })
    expect(snap.oldestAgeMs).toBe(5_000)
  })

  it('a failing re-evaluation does not take the loop down with it', () => {
    const h = harness({ onReevaluate: () => { throw new Error('repo is gone') } })
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)
    expect(() => h.fire()).not.toThrow()
    expect(h.ledger.snapshot().outstanding).toBe(1)
  })

  it('stop() cancels the loop', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'unindexed-document', WS)
    h.ledger.stop()
    expect(h.isScheduled()).toBe(false)
    expect(h.ledger.snapshot().outstanding).toBe(0)
  })
})

/**
 * Client-liftable denies. `hasOutstandingDocument` answers "will the server
 * retry this?", but the release guard needs "is a peer still waiting on it?".
 * For `workspace-mismatch` those differ, and the gap is a data-loss path: the
 * projector could detach a document (a terminal operation) while the tab
 * holding its bytes was on its way back.
 */
describe('client-liftable denies (the release guard\'s question)', () => {
  it('a workspace-mismatch is REFUSED but never retried', () => {
    expect(isClientLiftableDeny('workspace-mismatch')).toBe(true)
    expect(isRecoverableDeny('workspace-mismatch')).toBe(false)
    // Nothing else is liftable-but-not-retryable: an rbac refusal is not
    // something the client can undo by re-presenting the document.
    for (const reason of ['rbac', 'missing-peer-route', 'server-managed-root'] as const) {
      expect(isClientLiftableDeny(reason), reason).toBe(false)
    }
    // And a retryable deny is not liftable-by-client: the two sets are disjoint,
    // which is what lets the guard OR them without double-counting.
    for (const reason of ['unindexed-document', 'indexed-after-denial', 'gate-fault'] as const) {
      expect(isClientLiftableDeny(reason), reason).toBe(false)
    }
  })

  it('protects the document while the refused peer is still connected', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'workspace-mismatch', WS)
    // The retry ledger is deliberately untouched — no fan-out for a deny the
    // server cannot lift.
    expect(h.ledger.snapshot().outstanding).toBe(0)
    expect(h.ledger.hasOutstandingDocument('doc-1')).toBe(false)
    // ...and yet the guard's question answers yes.
    expect(h.ledger.hasClientLiftableDeny('doc-1')).toBe(true)
  })

  it('releases it when the peer is allowed', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'workspace-mismatch', WS)
    h.ledger.clear('peer-1', 'doc-1')
    expect(h.ledger.hasClientLiftableDeny('doc-1')).toBe(false)
  })

  it('releases it when the peer disconnects — a peer that is gone waits for nothing', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'workspace-mismatch', WS)
    h.ledger.forgetPeer('peer-1')
    expect(h.ledger.hasClientLiftableDeny('doc-1')).toBe(false)
  })

  it('holds while ANY refused peer remains', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'workspace-mismatch', WS)
    h.ledger.recordDeny('peer-2', 'doc-1', 'workspace-mismatch', WS)
    h.ledger.forgetPeer('peer-1')
    expect(h.ledger.hasClientLiftableDeny('doc-1')).toBe(true)
    h.ledger.forgetPeer('peer-2')
    expect(h.ledger.hasClientLiftableDeny('doc-1')).toBe(false)
  })

  it('does not inflate when the same peer re-presents the same document', () => {
    // A count would never fall back to zero here and the document would stay
    // pinned for the life of the process.
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'workspace-mismatch', WS)
    h.ledger.recordDeny('peer-1', 'doc-1', 'workspace-mismatch', WS)
    h.ledger.recordDeny('peer-1', 'doc-1', 'workspace-mismatch', WS)
    h.ledger.forgetPeer('peer-1')
    expect(h.ledger.hasClientLiftableDeny('doc-1')).toBe(false)
  })

  it('drops the protection when a LATER verdict is not liftable', () => {
    const h = harness()
    h.ledger.recordDeny('peer-1', 'doc-1', 'workspace-mismatch', WS)
    h.ledger.recordDeny('peer-1', 'doc-1', 'rbac', WS)
    expect(h.ledger.hasClientLiftableDeny('doc-1')).toBe(false)
  })

  it('fails OPEN at the ceiling rather than pinning the projector', () => {
    // Past the cap the guard stops protecting (fails open) rather than
    // wedging anything.
    const h = harness({ maxOutstanding: 2 })
    h.ledger.recordDeny('peer-1', 'doc-1', 'workspace-mismatch', WS)
    h.ledger.recordDeny('peer-2', 'doc-2', 'workspace-mismatch', WS)
    h.ledger.recordDeny('peer-3', 'doc-3', 'workspace-mismatch', WS)
    expect(h.ledger.hasClientLiftableDeny('doc-1')).toBe(true)
    expect(h.ledger.hasClientLiftableDeny('doc-2')).toBe(true)
    expect(h.ledger.hasClientLiftableDeny('doc-3')).toBe(false)
  })
})
