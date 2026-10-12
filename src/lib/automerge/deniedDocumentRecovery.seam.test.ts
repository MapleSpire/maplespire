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
import { Repo, type PeerId } from '@automerge/automerge-repo'
import { resetDocumentSyncState } from './deniedDocumentRecovery'

/**
 * The primitive, against a REAL `Repo` from the ROOT install.
 *
 * Two reasons this is a separate file rather than more cases in
 * `deniedDocumentRecovery.test.ts`:
 *
 * 1. It is the only assertion in the browser tree that runs
 *    `resetDocumentSyncState` against real automerge-repo objects. Iterating
 *    zero peers, or returning a count without touching a peer, is invisible to
 *    the bookkeeping tests, which by design do no I/O and touch no repo.
 * 2. It pins the ROOT `@automerge/automerge-repo`. The sibling invariant in
 *    `server/src/rbac/shareConfigLift.seam.test.ts` runs against
 *    `server/node_modules`, which is a SECOND real directory here, not a link.
 *    A cross-package test credits nothing to the other install unless it
 *    actually loads it.
 *
 * No socket: `CollectionSynchronizer.addPeer` is declared public and is all the
 * peer registration this needs. Keeping it socket-free is deliberate — the three
 * slowest tests in the tree are all Automerge module-graph imports under worker
 * contention, and a loopback WebSocket here would buy nothing this cannot say.
 */
describe('resetDocumentSyncState — against a real Repo', () => {
  it('replaces the sync state for EVERY connected peer, and says how many', async () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ marker: 'x' })
    await handle.whenReady()

    repo.synchronizer.addPeer('peer-1' as PeerId)
    repo.synchronizer.addPeer('peer-2' as PeerId)

    const docSynchronizer = repo.synchronizer.docSynchronizers[handle.documentId]
    expect(docSynchronizer).toBeTruthy()
    const addPeer = vi.spyOn(docSynchronizer, 'addPeer')

    const count = resetDocumentSyncState(repo, handle.documentId)

    // The count alone would pass for a function that counts without acting;
    // the spy is what makes "iterate zero peers" fail.
    expect(count).toBe(2)
    expect(addPeer).toHaveBeenCalledTimes(2)
    expect(addPeer.mock.calls.map(([peerId]) => peerId).sort()).toEqual(['peer-1', 'peer-2'])
  })

  it('hands each peer a FRESH sync state — that is the whole mechanism', async () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ marker: 'x' })
    await handle.whenReady()
    repo.synchronizer.addPeer('peer-1' as PeerId)

    const docSynchronizer = repo.synchronizer.docSynchronizers[handle.documentId]
    const addPeer = vi.spyOn(docSynchronizer, 'addPeer')
    resetDocumentSyncState(repo, handle.documentId)

    const [, syncStatePromise] = addPeer.mock.calls[0]
    const syncState = await syncStatePromise
    // A reused or persisted state is what makes `generateSyncMessage` return
    // null — which is why `syncAllPeers()` alone recovers nothing. Fresh
    // means sharedHeads empty.
    expect(syncState).toBeTruthy()
    expect(syncState?.sharedHeads ?? []).toEqual([])
  })

  it('is a no-op, not a throw, for a document with no synchronizer', () => {
    const repo = new Repo({ network: [] })
    // The ordinary state for a document nobody is syncing. The recovery loop
    // calls this for anything in the durable ledger, so it must tolerate it.
    expect(resetDocumentSyncState(repo, 'not-a-real-document-id' as never)).toBe(0)
  })

  it('returns 0 when no peer is connected, without touching the document', async () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ marker: 'x' })
    await handle.whenReady()

    const docSynchronizer = repo.synchronizer.docSynchronizers[handle.documentId]
    const addPeer = vi.spyOn(docSynchronizer, 'addPeer')

    expect(resetDocumentSyncState(repo, handle.documentId)).toBe(0)
    expect(addPeer).not.toHaveBeenCalled()
  })
})
