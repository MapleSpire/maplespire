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

// @vitest-environment jsdom
// `wireConnectionStatus` registers `window`/`document` listeners.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentId, PeerId, SyncMessage } from '@automerge/automerge-repo'
import { next as A } from '@automerge/automerge'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'

/** A DECODABLE sync frame: the repo processes what this emits, and an empty
 *  payload surfaces later as an unhandled RangeError. */
const [, syncPayload] = A.generateSyncMessage(A.init(), A.initSyncState())
const syncFrame: SyncMessage = {
  type: 'sync',
  senderId: 'peer-1' as PeerId,
  targetId: 'me' as PeerId,
  documentId: 'doc-1' as DocumentId,
  data: syncPayload!,
}

vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
  }),
}))

/**
 * `transportEpoch` is what an inline expansion laid out offline re-reads on
 * (`useInlineExpansionContents`). The badge's `status` could not serve: while
 * the backend is down and the browser online, a failed durable-heads
 * acknowledgement sets 'saving', which is a rising edge into "connected" during
 * the outage — and the real reconnect, 'saving' -> 'ready', is none.
 *
 * Driven through the REAL listeners, so deleting the bump from the bridge's
 * transport setter turns this red.
 */
describe('the bridge counts transport reconnections', () => {
  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
  })

  it('bumps once per down -> up, not per frame and not on a badge change', async () => {
    const { __wireConnectionStatusForTest } = await import('./bridge')
    const { repo } = await import('./repo')
    const epoch = () => useAutomergeStatus.getState().transportEpoch
    const unwire = __wireConnectionStatusForTest()
    try {
      const start = epoch()
      repo.networkSubsystem.emit('message', syncFrame)
      const up = epoch()
      expect(up, 'the first frame after wiring is a connection').toBe(start + 1)

      repo.networkSubsystem.emit('message', syncFrame)
      repo.networkSubsystem.emit('message', syncFrame)
      expect(epoch(), 'frames on a live transport are not reconnections').toBe(up)

      // The outage shape that fooled `status`: the badge moves, the transport
      // does not come back.
      repo.networkSubsystem.emit('peer-disconnected', { peerId: 'peer-1' as PeerId })
      useAutomergeStatus.getState().setStatus('saving')
      useAutomergeStatus.getState().setStatus('ready')
      expect(epoch(), 'a badge change is not a reconnection').toBe(up)

      repo.networkSubsystem.emit('message', syncFrame)
      expect(epoch(), 'the first frame after a disconnect is').toBe(up + 1)
    } finally {
      unwire()
    }
  })
})
