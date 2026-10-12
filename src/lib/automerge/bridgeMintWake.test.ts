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
// `wireConnectionStatus` registers `window`/`document` listeners; the default
// `node` environment has neither.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentId, PeerId, SyncMessage } from '@automerge/automerge-repo'
import * as mintedIdSupply from './mintedIdSupply'

/** A real `SyncMessage`, not a cast: the listener ignores the payload, but a
 *  fixture the emitter's own type rejects would stop modelling the event the
 *  day its shape changes. */
const syncFrame: SyncMessage = {
  type: 'sync',
  senderId: 'peer-1' as PeerId,
  targetId: 'me' as PeerId,
  documentId: 'doc-1' as DocumentId,
  data: new Uint8Array(),
}

vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
  }),
}))

/**
 * The WIRE, not the behaviour behind it.
 *
 * `mintedIdSupply.test.ts` covers what `notifyMintedIdSupplyHostReachable` does
 * once called — but every one of those tests calls the export directly, so
 * deleting the ONE production call site in `bridge.ts` (the mint never learning
 * the host is back) would leave them all green.
 *
 * This drives the real `networkSubsystem` listeners through the real wiring
 * function. Deliberately NOT a source-text assertion that the call exists:
 * those say "these differ" and never "which is right".
 */
describe('the bridge tells the minted-id supply when the host answers', () => {
  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  it('an inbound sync frame reaches the supply, and a disconnect does not', async () => {
    const wake = vi
      .spyOn(mintedIdSupply, 'notifyMintedIdSupplyHostReachable')
      .mockImplementation(() => {})

    const { __wireConnectionStatusForTest } = await import('./bridge')
    const { repo } = await import('./repo')
    const unwire = __wireConnectionStatusForTest()
    try {
      expect(wake, 'wiring alone must not claim the host answered').not.toHaveBeenCalled()

      // automerge-repo does not re-fire 'peer' on a reconnect to the same
      // server, so 'message' is the signal the bridge marks connected from.
      repo.networkSubsystem.emit('message', syncFrame)
      const afterFirstFrame = wake.mock.calls.length
      expect(afterFirstFrame, 'a frame from the server is evidence').toBeGreaterThan(0)

      // Direction matters: a disconnect is not evidence of reachability. This
      // fails if the `if (connected)` guard at the call site is dropped.
      repo.networkSubsystem.emit('peer-disconnected', { peerId: 'peer-1' as PeerId })
      expect(wake.mock.calls.length).toBe(afterFirstFrame)

      // …and reconnecting is evidence again. The supply, not the bridge, is
      // what stops this from becoming one request per frame — it is a no-op
      // unless a backoff is armed, and rate-limited by that backoff.
      repo.networkSubsystem.emit('message', syncFrame)
      expect(wake.mock.calls.length).toBeGreaterThan(afterFirstFrame)
    } finally {
      unwire()
    }
  })
})
