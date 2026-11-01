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
import type { DocumentId, PeerId } from '@automerge/automerge-repo'
import { ActiveDocumentShare } from './activeDocumentShare'

const doc = (value: string) => value as DocumentId
const peer = 'peer' as PeerId

describe('ActiveDocumentShare', () => {
  it('announces only active-workspace documents but allows explicit requests', async () => {
    const share = new ActiveDocumentShare()
    share.beginSession('landscape-a/version-1')
    share.pin(doc('root-a'), 'root')

    await expect(share.shareConfig.announce(peer, doc('root-a'))).resolves.toBe(true)
    await expect(share.shareConfig.announce(peer, doc('cached-other-workspace'))).resolves.toBe(false)
    await expect(share.shareConfig.announce(peer, undefined)).resolves.toBe(false)
    await expect(share.shareConfig.access(peer, doc('cached-other-workspace'))).resolves.toBe(true)
  })

  it('drops the old workspace on switch and coalesces reevaluation', async () => {
    const share = new ActiveDocumentShare()
    const changed = vi.fn()
    share.bindLeaseChanged(changed)
    share.beginSession('a/v1')
    share.pin(doc('root-a'), 'root')
    share.pin(doc('diagram-a'), 'active-diagram')
    share.beginSession('b/v2')
    share.pin(doc('root-b'), 'root')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(share.snapshot()).toEqual({
      session: 'b/v2', documents: 1, leases: 1, byRole: { root: 1 },
    })
    await expect(share.shareConfig.announce(peer, doc('root-a'))).resolves.toBe(false)
    await expect(share.shareConfig.announce(peer, doc('root-b'))).resolves.toBe(true)
  })

  it('keeps a document until its last role is released', async () => {
    const share = new ActiveDocumentShare()
    share.beginSession('a/v1')
    share.pin(doc('diagram'), 'active-diagram')
    share.pin(doc('diagram'), 'dirty')
    share.unpin(doc('diagram'), 'active-diagram')
    await expect(share.shareConfig.announce(peer, doc('diagram'))).resolves.toBe(true)
    share.unpin(doc('diagram'), 'dirty')
    await expect(share.shareConfig.announce(peer, doc('diagram'))).resolves.toBe(false)
  })

  it('a WITHHELD document neither announces nor answers, pinned or not, until released', async () => {
    const share = new ActiveDocumentShare()
    const changed = vi.fn()
    share.bindLeaseChanged(changed)
    share.beginSession('a/current')
    share.pin(doc('old-shard'), 'durability-pending')
    share.withhold([doc('old-shard'), doc('old-diagram')])

    // Synchronous: the very next evaluation sees it — the live path withholds
    // on the binding frame, before the handshake that would start the sync.
    await expect(share.shareConfig.announce(peer, doc('old-shard'))).resolves.toBe(false)
    await expect(share.shareConfig.access(peer, doc('old-shard'))).resolves.toBe(false)
    await expect(share.shareConfig.access(peer, doc('old-diagram'))).resolves.toBe(false)
    await expect(share.shareConfig.access(peer, doc('anything-else'))).resolves.toBe(true)
    expect(share.isPinned(doc('old-shard'))).toBe(false)
    expect(share.isWithheld(doc('old-diagram'))).toBe(true)

    // The lift is a re-evaluation, not just a set deletion.
    await new Promise((resolve) => setTimeout(resolve, 0))
    changed.mockClear()
    share.release([doc('old-shard')])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(changed).toHaveBeenCalledWith([doc('old-shard')])
    await expect(share.shareConfig.announce(peer, doc('old-shard'))).resolves.toBe(true)
    await expect(share.shareConfig.access(peer, doc('old-diagram'))).resolves.toBe(false)
  })

  it('a withhold outlives a stop and restart of the SAME session and ends with a switch', async () => {
    // A FOLLOW stops the bridge (endSession) and restarts it under the same
    // `L/current` session while the socket stays up, and the server announces
    // its root's registry shards to every peer: the documents it withheld must
    // stay off the socket through the gap. Another workspace decides afresh
    // (and re-evaluates what it lifts).
    const share = new ActiveDocumentShare()
    const changed = vi.fn()
    share.bindLeaseChanged(changed)
    share.beginSession('a/current')
    share.withhold([doc('old-shard')])
    share.endSession()
    await expect(share.shareConfig.access(peer, doc('old-shard'))).resolves.toBe(false)
    share.beginSession('a/current')
    await expect(share.shareConfig.access(peer, doc('old-shard'))).resolves.toBe(false)
    share.endSession()
    await new Promise((resolve) => setTimeout(resolve, 0))
    changed.mockClear()
    share.beginSession('a/V1')
    await expect(share.shareConfig.access(peer, doc('old-shard'))).resolves.toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(changed).toHaveBeenCalledWith([doc('old-shard')])
  })
})
