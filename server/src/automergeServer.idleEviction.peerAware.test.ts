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

// The binding between the idle sweep and the gate that grades it.
//
// `qa/eviction-peeraware.mjs` asks the server whether it spared a document with
// an active peer. Its verdict is a pure function (`qa/evictionPeerAwareCore.mjs`)
// whose own unit tests feed it hand-written snapshots, so they cannot tell
// whether the gate reads fields the server actually moves.
//
// This file runs the REAL sweep and feeds its REAL snapshot to the gate. It pins:
//
//   1. the sweep's peer skip does not reach `AutomergeResidencyLeases.evict()`,
//      so `evictionSkippedActivePeer` stays at zero on a healthy pass — a gate
//      grading that counter would fail a correct server.
//   2. `documentsWithPeers` — what the gate reads instead — does move when a
//      held document is wrongly evicted, and does not when the orphan goes.
//   3. the gate, given the snapshots this sweep produces, says `passed`.

import { describe, it, expect, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import { startIdleEviction } from './automergeServer.js'
import { AutomergeResidencyLeases } from './automergeResidency.js'
import { lightweightSynchronizerPeerSnapshot } from './automergeTransportTelemetry.js'
import { currentProcessBootId } from './processIdentity.js'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- the QA cores are plain ESM with no type declarations; server
// production code never imports them, and this is a test.
import { evaluatePeerAwareEviction } from '../qa/evictionPeerAwareCore.mjs'
import { PEER_CHECK_METHOD } from '../qa/peerCheckFault.mjs'

describe('the idle sweep and the gate that grades it', () => {
  /** Bind a peer to every resident document, then release the orphan's — which
   *  is what `repoA.shutdown()` does in the live script.
   *
   *  Through the REAL `CollectionSynchronizer` API, not a stub: a stubbed
   *  `docSynchronizers` silently destroys the control arm, because
   *  `removeFromCache` deletes from the synchronizer's own private map, so a
   *  fake map never loses an entry and `documentsWithPeers` cannot fall.
   *
   *  Two facts this relies on (pinned 2.6.0-alpha.2): `repo.create()` attaches the document to the
   *  synchronizer, and `addPeer` binds it to every attached document — so the
   *  orphan has to be UNBOUND afterwards rather than created unbound. Both
   *  behaviours are conditional on `AM_SELECTIVE_SYNC` being unset, which
   *  `CollectionSynchronizer` reads process-wide; the assertions below fail
   *  loudly rather than vacuously if that ever changes. */
  function bindPeer(repo: Repo, peerId: string, releaseIds: string[] = []) {
    const synchronizer = repo.synchronizer as unknown as {
      readonly peers: string[]
      readonly docSynchronizers: Record<string, { hasPeer(id: string): boolean; removePeer(id: string): void }>
      addPeer(id: string): void
    }
    synchronizer.addPeer(peerId)
    for (const id of releaseIds) synchronizer.docSynchronizers[id]?.removePeer(peerId)
  }

  /** What the connected peer holds, from the peer's own point of view.
   *
   * Captured ONCE and passed as both edges of the window, and that is faithful
   * rather than lazy: this suite runs one in-process Repo playing both roles,
   * so there is no client cache to read, and the scenario opens nothing after
   * the snapshot — which is what the field means. In the live script the value
   * comes from the CLIENT's own `repo.handles`, which is why a server-side
   * eviction does not move it: the client still holds the document locally
   * after the server drops it. Deriving it from the SERVER's synchronizer here
   * would be wrong in exactly the control arm, where the eviction removes the
   * DocSynchronizer and the set would appear to change. */
  const peerDocuments = (repo: Repo, peerId: string) => {
    const synchronizer = repo.synchronizer as unknown as {
      docSynchronizers: Record<string, { hasPeer(id: string): boolean }>
    }
    return Object.entries(synchronizer.docSynchronizers)
      .filter(([, document]) => document.hasPeer(peerId))
      .map(([id]) => id)
      .sort()
  }

  /** The `/api/automerge/stats` body, built from the REAL telemetry function
   *  over the REAL synchronizer — never hand-written numbers.
   *
   *  `joinedConnections` is DERIVED from the synchronizer's peer list rather
   *  than written as `1` (the endpoint publishes
   *  `connectionRegistry.liveConnectionCount()`, which this in-process test
   *  lacks; here one socket is one peer). A literal would keep agreeing if the
   *  test grew a second peer — exactly the case the gate's netting
   *  precondition exists to refuse. */
  const statsBody = (repo: Repo) => ({
    processBootId: currentProcessBootId(),
    joinedConnections: (repo.synchronizer as unknown as { peers: string[] }).peers.length,
    synchronizer: {
      ...lightweightSynchronizerPeerSnapshot(repo.synchronizer as never),
      retiredDocuments: { count: 0, limit: 0, overLimit: false },
    },
  })

  /** One tracking sweep, then one evicting sweep — the same two-phase shape the
   *  access-count suite uses, because the first pass only starts the grace. */
  async function runSweep(repo: Repo, residency: AutomergeResidencyLeases, rootUrl: string) {
    const timer = startIdleEviction(repo, rootUrl, residency, 1, 10)
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    clearInterval(timer)
    await residency.drain()
  }

  it('the sweep spares a peer-held document WITHOUT reaching the counter the gate first graded', async () => {
    vi.useFakeTimers()
    try {
      const repo = new Repo({ network: [], saveDebounceRate: 0 })
      const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
      const held = repo.create({ kind: 'viewed' })
      const orphan = repo.create({ kind: 'orphan' })
      const residency = new AutomergeResidencyLeases(repo)
      residency.protect(root)
      // The orphan's client has left; root and `held` are still held by peer-b.
      bindPeer(repo, 'peer-b', [orphan.documentId])

      const before = await residency.snapshot()
      const statsBefore = statsBody(repo)
      expect(statsBefore.synchronizer.documentsWithPeers, 'root + held must really look held').toBe(2)

      // (0) The producer side of the three fields the gate requires. Each is
      // asserted explicitly: a field the producer stops publishing would
      // otherwise turn every gate run into a VOID without saying which field
      // went missing.
      expect(typeof before.processBootId, 'the residency snapshot must identify its process').toBe('string')
      expect(before.processBootId.length, 'an empty identity compares equal to itself').toBeGreaterThan(0)
      expect(statsBefore.joinedConnections, 'the netting precondition needs exactly one connected client').toBe(1)
      expect(statsBefore.synchronizer.totalPeerBindings, 'the redundancy witness must be published, not inferred').toBe(2)
      // What the peer holds. Captured before the sweep and reused for both
      // edges — see `peerDocuments`: the peer opens nothing here, and in the
      // live script this comes from the CLIENT's cache, which a server-side
      // eviction does not touch.
      const heldByPeer = peerDocuments(repo, 'peer-b')
      expect(heldByPeer, 'the peer must really hold root + viewed').toHaveLength(2)
      expect(residency.hasActivePeers(held.documentId), 'the sweep asks this, so the scenario is void if it is false').toBe(true)
      expect(residency.hasActivePeers(orphan.documentId), 'the orphan must be unbound, or nothing is evictable').toBe(false)

      await runSweep(repo, residency, root.url)

      const after = await residency.snapshot()
      const statsAfter = statsBody(repo)

      // (1) The orphan went — without this the run proves nothing, and every
      // "nothing was wrongly evicted" phrasing below is true of the empty set.
      expect(after.evictedDocuments - before.evictedDocuments,
        'the orphan must be collected, or no eviction pass is being observed').toBeGreaterThanOrEqual(1)
      expect(Object.keys(repo.handles)).not.toContain(orphan.documentId)

      // (2) The held document survived.
      expect(Object.keys(repo.handles), 'a document with an active peer must not be evicted').toContain(held.documentId)

      // (3) THE TRACE. `automergeServer.ts` short-circuits on
      // `residency.hasActivePeers()` into a sweep-LOCAL counter and never calls
      // `evict()`, so the residency counter cannot move — even though a document
      // was, in fact, spared for having an active peer. A gate reading this
      // delta would call a healthy server `failed`.
      expect(after.evictionSkippedActivePeer - before.evictionSkippedActivePeer,
        'if this ever becomes non-zero the sweep changed and the gate may read it again').toBe(0)

      // (4) What the gate reads instead is stable across a correct sweep —
      // both witnesses, because the gate grades both and a level that saturates
      // can hold still while the sum it is supposed to agree with moves.
      expect(statsAfter.synchronizer.documentsWithPeers).toBe(statsBefore.synchronizer.documentsWithPeers)
      expect(statsAfter.synchronizer.totalPeerBindings).toBe(statsBefore.synchronizer.totalPeerBindings)

      // (4b) …and it was ONE process throughout, which is the premise every
      // delta above rests on. A sweep cannot restart the process, so this can
      // only fail if the identity stops being stable — which is the one way
      // `processIdentity.ts` could be wrong.
      expect(after.processBootId, 'the deltas above are only subtractable within one process')
        .toBe(before.processBootId)

      // (5) The halves meet: the real snapshots, through the real verdict.
      const verdict = evaluatePeerAwareEviction({
        before, after, statsBefore, statsAfter, serverAlive: true,
        clientDocumentsBefore: heldByPeer, clientDocumentsAfter: heldByPeer,
      })
      expect(verdict.reasons, 'a correct sweep must produce no reason at all').toEqual([])
      expect(verdict.outcome).toBe('passed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('and the gate FAILS the same sweep once the held document is evicted anyway', async () => {
    // The control arm, and the reason (4) above is worth anything: the witness
    // has to move when the defect happens. Here the peer check is disabled, so
    // the sweep treats the held document as any other idle one — exactly the
    // indiscriminate eviction the check exists to forbid.
    vi.useFakeTimers()
    try {
      const repo = new Repo({ network: [], saveDebounceRate: 0 })
      const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
      const held = repo.create({ kind: 'viewed' })
      const residency = new AutomergeResidencyLeases(repo)
      residency.protect(root)
      bindPeer(repo, 'peer-b')

      const before = await residency.snapshot()
      const statsBefore = statsBody(repo)
      expect(statsBefore.synchronizer.documentsWithPeers).toBe(2)
      const heldByPeer = peerDocuments(repo, 'peer-b')

      // Break the subject, do not simulate the breakage: the sweep asks
      // `residency.hasActivePeers`, so making it answer `false` is precisely the
      // defect and nothing else changes.
      // `PEER_CHECK_METHOD`, not the literal `'hasActivePeers'`, so the QA
      // preload and this control arm inject the SAME fault. `tsconfig.check.json`
      // excludes `src/**/*.test.ts`, so a literal here would be checked by
      // nothing; the imported constant comes from a file that IS checked.
      vi.spyOn(residency, PEER_CHECK_METHOD).mockReturnValue(false)
      await runSweep(repo, residency, root.url)

      const after = await residency.snapshot()
      const statsAfter = statsBody(repo)

      expect(Object.keys(repo.handles), 'the control must actually evict the held document').not.toContain(held.documentId)
      expect(statsAfter.synchronizer.documentsWithPeers)
        .toBeLessThan(statsBefore.synchronizer.documentsWithPeers)

      const verdict = evaluatePeerAwareEviction({
        before, after, statsBefore, statsAfter, serverAlive: true,
        // The peer opened nothing; the SERVER took the document away. A client
        // holds its own copy after a server-side eviction, so this set is what
        // the live script would report.
        clientDocumentsBefore: heldByPeer, clientDocumentsAfter: heldByPeer,
      })
      expect(verdict.outcome).toBe('failed')
      expect(verdict.failures.join(' ')).toMatch(/lost their peer binding/)
    } finally {
      vi.useRealTimers()
    }
  })
})
