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

import { beforeEach, describe, expect, it } from 'vitest'
import { DIAGRAM_PRESENCE_CHANNEL, type DiagramPresenceServerMessage } from '../lib/presence/protocol'
import {
  diagramPresenceParticipants,
  diagramPresenceRemoteCursors,
  useDiagramPresenceStore,
} from './diagramPresenceStore'

function serverMessage(
  participantId: string,
  firstName: string,
  sequence: number,
): DiagramPresenceServerMessage {
  return {
    channel: DIAGRAM_PRESENCE_CHANNEL,
    version: 1,
    kind: 'cursor',
    sequence,
    cursor: { x: sequence, y: 2, view: '2d', visible: true },
    participant: { participantId, firstName, initials: firstName[0] },
  }
}

describe('diagramPresenceStore', () => {
  beforeEach(() => useDiagramPresenceStore.getState().reset())

  it('aggregates tabs into people while keeping every remote cursor', () => {
    const store = useDiagramPresenceStore.getState()
    store.setLocalParticipant({ participantId: 'p_aaaaaaaaaaaaaaaa', firstName: 'Alice', initials: 'A' })
    store.receive('peer-tab-2', serverMessage('p_aaaaaaaaaaaaaaaa', 'Alice', 1), 100)
    store.receive('peer-bob', serverMessage('p_bbbbbbbbbbbbbbbb', 'Bob', 2), 100)
    expect(diagramPresenceParticipants()).toEqual([
      { participantId: 'p_aaaaaaaaaaaaaaaa', firstName: 'Alice', initials: 'A', isLocal: true, peerCount: 2 },
      { participantId: 'p_bbbbbbbbbbbbbbbb', firstName: 'Bob', initials: 'B', isLocal: false, peerCount: 1 },
    ])
    expect(diagramPresenceRemoteCursors()).toHaveLength(2)
  })

  it('does not rerender the roster for cursor-only movement', () => {
    const store = useDiagramPresenceStore.getState()
    store.receive('peer-1', serverMessage('p_aaaaaaaaaaaaaaaa', 'Alice', 1), 100)
    const joined = useDiagramPresenceStore.getState()
    store.receive('peer-1', serverMessage('p_aaaaaaaaaaaaaaaa', 'Alice', 2), 110)
    const moved = useDiagramPresenceStore.getState()
    expect(moved.rosterVersion).toBe(joined.rosterVersion)
    expect(moved.cursorVersion).toBeGreaterThan(joined.cursorVersion)
  })

  it('removes goodbye and expired peers', () => {
    const store = useDiagramPresenceStore.getState()
    store.receive('old', serverMessage('p_aaaaaaaaaaaaaaaa', 'Alice', 1), 100)
    store.receive('fresh', serverMessage('p_bbbbbbbbbbbbbbbb', 'Bob', 1), 200)
    store.prune(150)
    expect(Object.keys(useDiagramPresenceStore.getState().peers)).toEqual(['fresh'])
    store.receive('fresh', { ...serverMessage('p_bbbbbbbbbbbbbbbb', 'Bob', 2), kind: 'goodbye', cursor: undefined }, 210)
    expect(useDiagramPresenceStore.getState().peers).toEqual({})
  })
})
