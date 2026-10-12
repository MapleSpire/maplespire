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

import { create } from 'zustand'
import type { DiagramPresenceCursor, DiagramPresenceIdentity, DiagramPresenceServerMessage } from '../lib/presence/protocol'

export interface DiagramPresencePeer {
  peerId: string
  participant: DiagramPresenceIdentity
  cursor: DiagramPresenceCursor | null
  lastSeenAt: number
}

export interface DiagramPresenceParticipant extends DiagramPresenceIdentity {
  isLocal: boolean
  peerCount: number
}

interface DiagramPresenceState {
  localParticipant: DiagramPresenceIdentity | null
  peers: Record<string, DiagramPresencePeer>
  rosterVersion: number
  cursorVersion: number
  setLocalParticipant: (participant: DiagramPresenceIdentity | null) => void
  receive: (peerId: string, message: DiagramPresenceServerMessage, receivedAt?: number) => boolean
  removePeer: (peerId: string) => void
  prune: (olderThan: number) => void
  reset: () => void
}

export const useDiagramPresenceStore = create<DiagramPresenceState>((set, get) => ({
  localParticipant: null,
  peers: {},
  rosterVersion: 0,
  cursorVersion: 0,

  setLocalParticipant: (participant) => set((state) => {
    const changed = state.localParticipant?.participantId !== participant?.participantId
      || state.localParticipant?.firstName !== participant?.firstName
    return {
      localParticipant: participant,
      rosterVersion: changed ? state.rosterVersion + 1 : state.rosterVersion,
    }
  }),

  receive: (peerId, message, receivedAt = Date.now()) => {
    if (message.kind === 'goodbye') {
      const existed = Boolean(get().peers[peerId])
      if (existed) get().removePeer(peerId)
      return false
    }
    const previous = get().peers[peerId]
    const isNewPeer = !previous
    const participantChanged = previous?.participant.participantId !== message.participant.participantId
      || previous?.participant.firstName !== message.participant.firstName
      || previous?.participant.initials !== message.participant.initials
    const cursor = message.kind === 'cursor' || message.kind === 'state'
      ? (message.cursor ?? null)
      : (previous?.cursor ?? null)
    const cursorChanged = previous?.cursor?.x !== cursor?.x
      || previous?.cursor?.y !== cursor?.y
      || previous?.cursor?.view !== cursor?.view
      || previous?.cursor?.visible !== cursor?.visible

    set((state) => ({
      peers: {
        ...state.peers,
        [peerId]: { peerId, participant: message.participant, cursor, lastSeenAt: receivedAt },
      },
      rosterVersion: isNewPeer || participantChanged ? state.rosterVersion + 1 : state.rosterVersion,
      cursorVersion: cursorChanged ? state.cursorVersion + 1 : state.cursorVersion,
    }))
    return isNewPeer
  },

  removePeer: (peerId) => set((state) => {
    if (!state.peers[peerId]) return state
    const peers = { ...state.peers }
    delete peers[peerId]
    return {
      peers,
      rosterVersion: state.rosterVersion + 1,
      cursorVersion: state.cursorVersion + 1,
    }
  }),

  prune: (olderThan) => set((state) => {
    const peers = Object.fromEntries(
      Object.entries(state.peers).filter(([, peer]) => peer.lastSeenAt >= olderThan),
    )
    if (Object.keys(peers).length === Object.keys(state.peers).length) return state
    return {
      peers,
      rosterVersion: state.rosterVersion + 1,
      cursorVersion: state.cursorVersion + 1,
    }
  }),

  reset: () => set((state) => ({
    localParticipant: null,
    peers: {},
    rosterVersion: state.rosterVersion + 1,
    cursorVersion: state.cursorVersion + 1,
  })),
}))

export function diagramPresenceParticipants(): DiagramPresenceParticipant[] {
  const { localParticipant, peers } = useDiagramPresenceStore.getState()
  const participants = new Map<string, DiagramPresenceParticipant>()
  if (localParticipant) {
    participants.set(localParticipant.participantId, { ...localParticipant, isLocal: true, peerCount: 1 })
  }
  for (const peer of Object.values(peers)) {
    const existing = participants.get(peer.participant.participantId)
    if (existing) {
      existing.peerCount += 1
      continue
    }
    participants.set(peer.participant.participantId, {
      ...peer.participant,
      isLocal: false,
      peerCount: 1,
    })
  }
  return [...participants.values()].sort((left, right) => {
    if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1
    return left.firstName.localeCompare(right.firstName)
  })
}

export function diagramPresenceRemoteCursors(): DiagramPresencePeer[] {
  return Object.values(useDiagramPresenceStore.getState().peers)
    .filter((peer) => peer.cursor?.visible)
}

export function hasDiagramPresencePeer(peerId: string): boolean {
  return Boolean(useDiagramPresenceStore.getState().peers[peerId])
}
