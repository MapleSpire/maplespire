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

import { describe, it, expect, afterEach } from 'vitest'
import { createDenyLedger, type DenyLedger } from './denyLedger.js'
import {
  installDenyLedgerReleaseGuard,
  mayReleaseDocument,
  setDocumentReleaseGuard,
} from '../readModel/documentReleaseGuard.js'

/**
 * `hasOutstandingDocument` is answered by a per-document COUNTER maintained
 * beside `outstanding`, not by scanning it — the caller is the projector's
 * release guard on the resolution-failure path, where a scan would be too
 * costly.
 *
 * A counter beside a map is a drift hazard: five paths remove entries
 * (a permanent verdict superseding a recoverable one, `clear`, `forgetPeer`,
 * write-off in `reconcile`, and the `maxOutstanding` refusal which must NOT
 * count). A missed decrement leaves the guard reporting "still denied" forever,
 * which silently disables the projector's release for that document.
 *
 * So this compares the ledger against an independent MODEL of the same state
 * after every mutation, rather than asserting only the known paths.
 */
function makeLedger(overrides: Parameters<typeof createDenyLedger>[0] extends infer T ? Partial<T> : never = {}): DenyLedger {
  return createDenyLedger({
    onReevaluate: () => {},
    schedule: () => ({ cancel: () => {} }),
    ...overrides,
  })
}

/** Mirrors what the ledger SHOULD hold, derived independently. */
class Model {
  private readonly pairs = new Set<string>()
  add(peerId: string, documentId: string): void {
    this.pairs.add(`${peerId}->${documentId}`)
  }
  remove(peerId: string, documentId: string): void {
    this.pairs.delete(`${peerId}->${documentId}`)
  }
  removePeer(peerId: string): void {
    for (const pair of [...this.pairs]) if (pair.startsWith(`${peerId}->`)) this.pairs.delete(pair)
  }
  clear(): void {
    this.pairs.clear()
  }
  has(documentId: string): boolean {
    return [...this.pairs].some((pair) => pair.endsWith(`->${documentId}`))
  }
  get size(): number {
    return this.pairs.size
  }
}

function assertAgrees(ledger: DenyLedger, model: Model, documents: readonly string[]): void {
  for (const documentId of documents) {
    expect({ documentId, has: ledger.hasOutstandingDocument(documentId) })
      .toEqual({ documentId, has: model.has(documentId) })
  }
  expect(ledger.snapshot().outstanding).toBe(model.size)
}

const DOCS = ['doc-a', 'doc-b', 'doc-c'] as const

describe('denyLedger — the per-document index cannot drift from the entries', () => {
  it('tracks a recoverable deny and forgets it on clear()', () => {
    const ledger = makeLedger()
    const model = new Model()
    assertAgrees(ledger, model, DOCS)

    ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)
    model.add('peer-1', 'doc-a')
    assertAgrees(ledger, model, DOCS)

    ledger.clear('peer-1', 'doc-a')
    model.remove('peer-1', 'doc-a')
    assertAgrees(ledger, model, DOCS)
  })

  it('counts PEERS, so one peer clearing does not free a document another still holds', () => {
    const ledger = makeLedger()
    const model = new Model()
    ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)
    ledger.recordDeny('peer-2', 'doc-a', 'unindexed-document', null)
    model.add('peer-1', 'doc-a')
    model.add('peer-2', 'doc-a')
    assertAgrees(ledger, model, DOCS)

    ledger.clear('peer-1', 'doc-a')
    model.remove('peer-1', 'doc-a')
    // Still denied for peer-2 — releasing now would detach a document whose
    // refusal is still outstanding for someone.
    expect(ledger.hasOutstandingDocument('doc-a')).toBe(true)
    assertAgrees(ledger, model, DOCS)

    ledger.clear('peer-2', 'doc-a')
    model.remove('peer-2', 'doc-a')
    expect(ledger.hasOutstandingDocument('doc-a')).toBe(false)
    assertAgrees(ledger, model, DOCS)
  })

  it('a re-recorded deny for the same pair does not double-count', () => {
    const ledger = makeLedger()
    const model = new Model()
    for (let i = 0; i < 5; i += 1) ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)
    model.add('peer-1', 'doc-a')
    assertAgrees(ledger, model, DOCS)

    ledger.clear('peer-1', 'doc-a')
    model.remove('peer-1', 'doc-a')
    // If the repeats had each incremented, the count would still be positive
    // here and the guard would block the release for the life of the process.
    expect(ledger.hasOutstandingDocument('doc-a')).toBe(false)
    assertAgrees(ledger, model, DOCS)
  })

  it('a PERMANENT verdict superseding a recoverable one decrements', () => {
    const ledger = makeLedger()
    const model = new Model()
    ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)
    model.add('peer-1', 'doc-a')
    assertAgrees(ledger, model, DOCS)

    ledger.recordDeny('peer-1', 'doc-a', 'rbac', null)
    model.remove('peer-1', 'doc-a')
    assertAgrees(ledger, model, DOCS)
  })

  it('forgetPeer decrements every document that peer held', () => {
    const ledger = makeLedger()
    const model = new Model()
    for (const documentId of DOCS) {
      ledger.recordDeny('peer-1', documentId, 'unindexed-document', null)
      ledger.recordDeny('peer-2', documentId, 'unindexed-document', null)
      model.add('peer-1', documentId)
      model.add('peer-2', documentId)
    }
    assertAgrees(ledger, model, DOCS)

    ledger.forgetPeer('peer-1')
    model.removePeer('peer-1')
    assertAgrees(ledger, model, DOCS)

    ledger.forgetPeer('peer-2')
    model.removePeer('peer-2')
    for (const documentId of DOCS) expect(ledger.hasOutstandingDocument(documentId)).toBe(false)
    assertAgrees(ledger, model, DOCS)
  })

  it('a write-off after maxReconciliations decrements', () => {
    const ledger = makeLedger({ maxReconciliations: 2 })
    const model = new Model()
    ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)
    model.add('peer-1', 'doc-a')
    assertAgrees(ledger, model, DOCS)

    ledger.reconcile()
    ledger.reconcile()
    expect(ledger.hasOutstandingDocument('doc-a')).toBe(true)

    ledger.reconcile()
    model.remove('peer-1', 'doc-a')
    // Written off. The guard must stop blocking the release, or a document the
    // ledger has itself given up on would never be releasable again.
    expect(ledger.hasOutstandingDocument('doc-a')).toBe(false)
    expect(ledger.snapshot().expired).toBe(1)
    assertAgrees(ledger, model, DOCS)
  })

  it('stop() empties BOTH indexes, so a stopped ledger stops answering', () => {
    const ledger = makeLedger()
    ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)
    // A SECOND document, refused for the client-liftable reason, which lands in
    // `liftableByDocument` instead. The release guard reads both indexes, so
    // both must be asserted.
    ledger.recordDeny('peer-2', 'doc-b', 'workspace-mismatch', null)
    expect(ledger.hasOutstandingDocument('doc-a')).toBe(true)
    expect(ledger.hasClientLiftableDeny('doc-b')).toBe(true)

    ledger.stop()
    // `stop()` clears `outstanding` without going through `removeEntry`. A
    // stopped ledger still answering "denied" would leave the projector's
    // release guard blocking releases for the life of the process.
    expect(ledger.hasOutstandingDocument('doc-a')).toBe(false)
    // And the same for the liftable index. This must hold for the object
    // itself, not only because automergeServer.ts happens to uninstall the
    // guard right after calling `stop()`.
    expect(ledger.hasClientLiftableDeny('doc-b')).toBe(false)
  })

  it('stop() also resets the liftable COUNT, so the ceiling does not outlive the map', () => {
    // The map is cleared but a stale count would still sit at the ceiling, and
    // `noteLiftable` would then refuse every new document on this ledger.
    const ledger = makeLedger({ maxOutstanding: 1 })
    ledger.recordDeny('peer-1', 'doc-a', 'workspace-mismatch', null)
    ledger.stop()

    ledger.recordDeny('peer-2', 'doc-b', 'workspace-mismatch', null)
    expect(ledger.hasClientLiftableDeny('doc-b')).toBe(true)
  })

  /**
   * The SECOND index, `liftableByDocument`.
   *
   * `assertAgrees` above mirrors `outstanding`/`byDocument` only, so the tests
   * below pin the liftable index's own edge cases directly: iteration over
   * several documents, dedup, and the ceiling.
   */
  it('a disconnecting peer loses EVERY liftable deny, not just the first', () => {
    const ledger = makeLedger()
    // Three documents, and peer-1 must be absent from the MIDDLE one — the
    // iteration reaches it, finds nothing to delete, and a `break` there stops
    // before doc-c. With one document `break` and `continue` are
    // indistinguishable.
    ledger.recordDeny('peer-1', 'doc-a', 'workspace-mismatch', null)
    ledger.recordDeny('peer-2', 'doc-b', 'workspace-mismatch', null)
    ledger.recordDeny('peer-1', 'doc-c', 'workspace-mismatch', null)
    expect(DOCS.map((d) => ledger.hasClientLiftableDeny(d))).toEqual([true, true, true])

    ledger.forgetPeer('peer-1')
    // doc-b survives because peer-2 still holds it; doc-a AND doc-c must go.
    expect(DOCS.map((d) => ledger.hasClientLiftableDeny(d))).toEqual([false, true, false])
  })

  it('re-recording one liftable pair does not consume the ceiling', () => {
    // The dedup in `noteLiftable` is invisible through `hasClientLiftableDeny`
    // — the answer is `true` either way — so the only observable is the CEILING
    // it protects. Dropping the dedup inflates the counter on every repeat, and
    // a denied peer re-presenting the same document is the whole scenario this
    // ledger exists for, so it reaches `maxOutstanding` quickly and then
    // silently stops protecting documents it has never seen.
    const ledger = makeLedger({ maxOutstanding: 2 })
    for (let i = 0; i < 3; i++) ledger.recordDeny('peer-1', 'doc-a', 'workspace-mismatch', null)

    // One pair is tracked, so a SECOND document still fits under a ceiling of 2.
    ledger.recordDeny('peer-1', 'doc-b', 'workspace-mismatch', null)
    expect(ledger.hasClientLiftableDeny('doc-b')).toBe(true)
  })

  it('clearing the last peer frees the document from the ceiling, not just from the answer', () => {
    // `forgetLiftable` decrements AND deletes the now-empty entry. Dropping the
    // delete keeps `hasClientLiftableDeny` correct — an empty Set answers
    // `false` — so nothing behavioural notices. What it breaks is the ceiling:
    // `noteLiftable` takes its `if (peers)` branch on the leftover empty Set and
    // adds WITHOUT the `>= maxOutstanding` check, so the bound stops binding.
    const ledger = makeLedger({ maxOutstanding: 1 })
    ledger.recordDeny('peer-1', 'doc-a', 'workspace-mismatch', null)
    // A non-liftable reason for the same pair calls `forgetLiftable`.
    ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)
    expect(ledger.hasClientLiftableDeny('doc-a')).toBe(false)

    // The single slot now goes to doc-b.
    ledger.recordDeny('peer-1', 'doc-b', 'workspace-mismatch', null)
    expect(ledger.hasClientLiftableDeny('doc-b')).toBe(true)

    // doc-a must NOT be re-admitted: the ceiling is full. With the stale empty
    // Set still present it is admitted anyway, and the ledger holds two.
    ledger.recordDeny('peer-2', 'doc-a', 'workspace-mismatch', null)
    expect(ledger.hasClientLiftableDeny('doc-a')).toBe(false)
  })

  it('an entry REFUSED by maxOutstanding is not counted', () => {
    const ledger = makeLedger({ maxOutstanding: 1 })
    const model = new Model()
    ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)
    model.add('peer-1', 'doc-a')

    ledger.recordDeny('peer-1', 'doc-b', 'unindexed-document', null)
    // Dropped, not stored — counting it would block doc-b's release forever on
    // the strength of an entry that does not exist.
    expect(ledger.snapshot().dropped).toBe(1)
    expect(ledger.hasOutstandingDocument('doc-b')).toBe(false)
    assertAgrees(ledger, model, DOCS)
  })
})

/**
 * The JOIN between the ledger and the projector's release guard.
 *
 * Driven through a REAL `createDenyLedger` rather than a stub, and through the
 * public `mayReleaseDocument`, so the guard's polarity is pinned outside
 * `startAutomergeSync` (which no unit test calls): an inverted guard would
 * release PRECISELY the refused documents.
 */
describe('installDenyLedgerReleaseGuard — the polarity, and the disposer', () => {
  afterEach(() => {
    // Module-level state: leaving a guard installed makes the next file's
    // expectations depend on test ORDER.
    setDocumentReleaseGuard(null)
  })

  it('refuses to release a refused document and allows every other one', () => {
    const ledger = makeLedger()
    installDenyLedgerReleaseGuard(ledger)
    ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)

    // Inverting the polarity flips BOTH of these, so either alone would catch
    // it; both together also catch a guard stuck at a constant.
    expect(mayReleaseDocument('automerge:doc-a')).toBe(false)
    expect(mayReleaseDocument('automerge:doc-b')).toBe(true)
  })

  it('refuses to release on the CLIENT-LIFTABLE conjunct alone', () => {
    const ledger = makeLedger()
    installDenyLedgerReleaseGuard(ledger)
    // `workspace-mismatch` is client-liftable and NOT recoverable, so
    // `recordDeny` notes it in the liftable index and returns before
    // `outstanding` — the one state in which the guard's two conjuncts
    // disagree.
    ledger.recordDeny('peer-1', 'doc-a', 'workspace-mismatch', null)

    // THE CONTROL, and the whole reason this test exists beside the polarity
    // one above. Without it the verdict below is also produced by the first
    // conjunct, and the test would pass over a guard that had lost the second
    // (`&& !ledger.hasClientLiftableDeny(documentId)` in
    // `installDenyLedgerReleaseGuard`), which nothing else pins.
    expect(ledger.hasOutstandingDocument('doc-a')).toBe(false)
    expect(ledger.hasClientLiftableDeny('doc-a')).toBe(true)

    expect(mayReleaseDocument('automerge:doc-a')).toBe(false)
    expect(mayReleaseDocument('automerge:doc-b')).toBe(true)

    // And it must not outlive the socket: the peer's verdicts die with it, or
    // the document is pinned against release for the life of the process.
    ledger.forgetPeer('peer-1')
    expect(ledger.hasClientLiftableDeny('doc-a')).toBe(false)
    expect(mayReleaseDocument('automerge:doc-a')).toBe(true)
  })

  it('allows the release again once the deny is lifted', () => {
    const ledger = makeLedger()
    installDenyLedgerReleaseGuard(ledger)
    ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)
    expect(mayReleaseDocument('automerge:doc-a')).toBe(false)

    ledger.clear('peer-1', 'doc-a')
    // The guard must not outlive the refusal, or the projector could never
    // release that document again and its terminal cache entry would be permanent.
    expect(mayReleaseDocument('automerge:doc-a')).toBe(true)
  })

  it('the disposer restores the unguarded default', () => {
    const ledger = makeLedger()
    const uninstall = installDenyLedgerReleaseGuard(ledger)
    ledger.recordDeny('peer-1', 'doc-a', 'unindexed-document', null)
    expect(mayReleaseDocument('automerge:doc-a')).toBe(false)

    uninstall()
    // A dead ledger must not answer for the next server in the same process —
    // which tests routinely create.
    expect(mayReleaseDocument('automerge:doc-a')).toBe(true)
  })

  it('a null ledger installs nothing, and the guard fails OPEN', () => {
    const uninstall = installDenyLedgerReleaseGuard(null)
    expect(mayReleaseDocument('automerge:anything')).toBe(true)
    uninstall()
    expect(mayReleaseDocument('automerge:anything')).toBe(true)
  })
})
