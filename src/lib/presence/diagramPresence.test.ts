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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocHandle, DocHandleEphemeralMessagePayload, PeerId } from '@automerge/automerge-repo'
import type { DiagramDoc } from '../automerge/types'
import { DiagramPresenceSession } from './diagramPresence'
import { DIAGRAM_PRESENCE_CHANNEL, PRESENCE_CURSOR_INTERVAL_MS } from './protocol'
import { useDiagramPresenceStore } from '../../stores/diagramPresenceStore'

function fakeHandle() {
  let handler: ((payload: DocHandleEphemeralMessagePayload<DiagramDoc>) => void) | null = null
  const broadcasts: unknown[] = []
  const handle = {
    on: vi.fn((_event: string, next: typeof handler) => { handler = next }),
    off: vi.fn((_event: string, next: typeof handler) => { if (handler === next) handler = null }),
    broadcast: vi.fn((message: unknown) => broadcasts.push(message)),
  } as unknown as DocHandle<DiagramDoc>
  return {
    handle,
    broadcasts,
    receive(message: unknown, senderId = 'peer-remote') {
      handler?.({ handle, senderId: senderId as PeerId, message })
    },
  }
}

const identity = { participantId: 'p_aaaaaaaaaaaaaaaa', firstName: 'Alice', initials: 'A' }

describe('DiagramPresenceSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDiagramPresenceStore.getState().reset()
  })
  afterEach(() => vi.useRealTimers())

  it('announces on start and coalesces rapid pointer movement', () => {
    const fake = fakeHandle()
    const session = new DiagramPresenceSession(fake.handle, identity)
    session.start()
    expect(fake.broadcasts[0]).toMatchObject({ kind: 'state', cursor: null })
    session.setCursor({ x: 1, y: 1, view: '2d', visible: true })
    session.setCursor({ x: 2, y: 3, view: '2d', visible: true })
    vi.advanceTimersByTime(PRESENCE_CURSOR_INTERVAL_MS)
    expect(fake.broadcasts[1]).toMatchObject({ kind: 'cursor', cursor: { x: 2, y: 3 } })
    session.stop()
  })

  it('accepts only a server-sanitized peer and stays non-blocking offline', () => {
    const fake = fakeHandle()
    const session = new DiagramPresenceSession(fake.handle, identity)
    session.start()
    fake.receive({
      channel: DIAGRAM_PRESENCE_CHANNEL,
      version: 1,
      kind: 'cursor',
      sequence: 1,
      cursor: { x: 4, y: 5, view: '3d', visible: true },
      participant: { participantId: 'p_bbbbbbbbbbbbbbbb', firstName: 'Bob', initials: 'B' },
    })
    expect(useDiagramPresenceStore.getState().peers['peer-remote']?.participant.firstName).toBe('Bob')
    session.stop()

    const offline = fakeHandle()
    ;(offline.handle.broadcast as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('offline') })
    const offlineSession = new DiagramPresenceSession(offline.handle, identity)
    expect(() => offlineSession.start()).not.toThrow()
    expect(() => offlineSession.stop()).not.toThrow()
  })
})
