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

import { createHash } from 'node:crypto'
import { decode, encode } from 'cbor-x'

export const DIAGRAM_PRESENCE_CHANNEL = 'maplespire.diagram-presence'
export const DIAGRAM_PRESENCE_VERSION = 1
export const MAX_PRESENCE_PAYLOAD_BYTES = 2_048

const MAX_COORDINATE = 10_000_000
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER

export interface DiagramPresenceIdentity {
  participantId: string
  firstName: string
  initials: string
}

export interface DiagramPresenceCursor {
  x: number
  y: number
  view: '2d' | '3d'
  visible: boolean
}

export interface DiagramPresenceClientMessage {
  channel: typeof DIAGRAM_PRESENCE_CHANNEL
  version: typeof DIAGRAM_PRESENCE_VERSION
  kind: 'state' | 'cursor' | 'heartbeat' | 'goodbye'
  sequence: number
  cursor?: DiagramPresenceCursor | null
}

export interface DiagramPresenceServerMessage extends DiagramPresenceClientMessage {
  participant: DiagramPresenceIdentity
}

/** Structural subset of automerge-repo's decoded ephemeral wire message. */
export interface DiagramPresenceGateMessage {
  type: string
  senderId: string
  documentId?: string
  data?: Uint8Array
}

export type DiagramPresenceDropReason =
  | 'access-denied'
  | 'identity-unavailable'
  | 'invalid-message'
  | 'oversized'
  | 'rate-limited'
  | 'stale-sequence'

export interface DiagramPresenceGateOptions {
  canRead: (peerId: string, documentId: string) => Promise<boolean>
  identityForPeer: (peerId: string) => Promise<DiagramPresenceIdentity | null>
  now?: () => number
  maxPayloadBytes?: number
  ratePerSecond?: number
  burst?: number
  onAccepted?: () => void
  onDropped?: (reason: DiagramPresenceDropReason) => void
}

export interface DiagramPresenceGate {
  process(message: DiagramPresenceGateMessage, socketKey: object, deliver: () => void): void
  disconnect(peerId: string, deliver: (message: DiagramPresenceGateMessage) => void): void
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE
}

export function parseDiagramPresenceClientMessage(value: unknown): DiagramPresenceClientMessage | null {
  if (!plainObject(value)) return null
  if (value.channel !== DIAGRAM_PRESENCE_CHANNEL || value.version !== DIAGRAM_PRESENCE_VERSION) return null
  if (value.kind !== 'state' && value.kind !== 'cursor' && value.kind !== 'heartbeat' && value.kind !== 'goodbye') return null
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || (value.sequence as number) > MAX_SEQUENCE) return null

  const cursorValue = value.cursor
  let cursor: DiagramPresenceCursor | null | undefined
  if (cursorValue === null) {
    cursor = null
  } else if (cursorValue !== undefined) {
    if (!plainObject(cursorValue)) return null
    if (!boundedCoordinate(cursorValue.x) || !boundedCoordinate(cursorValue.y)) return null
    if (cursorValue.view !== '2d' && cursorValue.view !== '3d') return null
    if (typeof cursorValue.visible !== 'boolean') return null
    cursor = {
      x: cursorValue.x,
      y: cursorValue.y,
      view: cursorValue.view,
      visible: cursorValue.visible,
    }
  }

  if ((value.kind === 'cursor' || value.kind === 'state') && cursor === undefined) return null
  if ((value.kind === 'heartbeat' || value.kind === 'goodbye') && cursor !== undefined) return null
  return {
    channel: DIAGRAM_PRESENCE_CHANNEL,
    version: DIAGRAM_PRESENCE_VERSION,
    kind: value.kind,
    sequence: value.sequence as number,
    ...(cursor !== undefined ? { cursor } : {}),
  }
}

export function participantIdForUser(userId: string): string {
  return `p_${createHash('sha256').update(`maplespire-presence-v1:${userId}`).digest('hex').slice(0, 16)}`
}

export function normalizePresenceIdentity(input: {
  userId: string
  givenName?: string | null
  name?: string | null
  email?: string | null
}): DiagramPresenceIdentity {
  const emailLocalPart = input.email?.trim().split('@')[0]?.split(/[._+-]/u)[0]
  const emailFirstName = emailLocalPart
    ? `${emailLocalPart.charAt(0).toLocaleUpperCase()}${emailLocalPart.slice(1)}`
    : undefined
  const candidate = input.givenName?.trim() || input.name?.trim().split(/\s+/u)[0] || emailFirstName || 'Collaborator'
  const firstName = candidate.replace(/\p{Cc}/gu, '').slice(0, 32) || 'Collaborator'
  const initials = Array.from(firstName)[0]?.toLocaleUpperCase() ?? 'C'
  return { participantId: participantIdForUser(input.userId), firstName, initials }
}

interface SocketState {
  peerId: string | null
  participant: DiagramPresenceIdentity | null
  tokens: number
  lastRefillAt: number
  lastSequenceByDocument: Map<string, number>
  readableDocuments: Set<string>
}

/**
 * Security boundary for app-owned Automerge ephemeral messages.
 *
 * automerge-repo intentionally routes ephemeral messages outside its durable
 * document access path. This gate runs before Repo sees the decoded wire
 * message: it validates and bounds the payload, verifies document read access,
 * rate-limits each authenticated socket, and overwrites untrusted client
 * identity with the canonical server-side participant identity.
 */
export function createDiagramPresenceGate(options: DiagramPresenceGateOptions): DiagramPresenceGate {
  const now = options.now ?? Date.now
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_PRESENCE_PAYLOAD_BYTES
  const ratePerSecond = options.ratePerSecond ?? 15
  const burst = options.burst ?? 30
  const socketStates = new WeakMap<object, SocketState>()
  const statesByPeer = new Map<string, SocketState>()
  const tails = new WeakMap<object, Promise<void>>()

  const stateFor = (socketKey: object): SocketState => {
    let state = socketStates.get(socketKey)
    if (!state) {
      state = {
        peerId: null,
        participant: null,
        tokens: burst,
        lastRefillAt: now(),
        lastSequenceByDocument: new Map(),
        readableDocuments: new Set(),
      }
      socketStates.set(socketKey, state)
    }
    return state
  }

  const consumeToken = (state: SocketState): boolean => {
    const at = now()
    const elapsedSeconds = Math.max(0, at - state.lastRefillAt) / 1_000
    state.tokens = Math.min(burst, state.tokens + elapsedSeconds * ratePerSecond)
    state.lastRefillAt = at
    if (state.tokens < 1) return false
    state.tokens -= 1
    return true
  }

  const decide = async (
    message: DiagramPresenceGateMessage,
    socketKey: object,
    deliver: () => void,
  ): Promise<void> => {
    const documentId = message.documentId
    const data = message.data
    if (!documentId || !data || data.byteLength === 0) {
      options.onDropped?.('invalid-message')
      return
    }
    if (data.byteLength > maxPayloadBytes) {
      options.onDropped?.('oversized')
      return
    }
    const socketState = stateFor(socketKey)
    if (!consumeToken(socketState)) {
      options.onDropped?.('rate-limited')
      return
    }

    let parsed: DiagramPresenceClientMessage | null = null
    try {
      parsed = parseDiagramPresenceClientMessage(decode(data))
    } catch {
      // Malformed CBOR is untrusted input and must never reach automerge-repo.
    }
    if (!parsed) {
      options.onDropped?.('invalid-message')
      return
    }

    const previousSequence = socketState.lastSequenceByDocument.get(documentId) ?? -1
    if (parsed.sequence <= previousSequence) {
      options.onDropped?.('stale-sequence')
      return
    }

    if (!socketState.readableDocuments.has(documentId)) {
      let allowed = false
      try {
        allowed = await options.canRead(message.senderId, documentId)
      } catch {
        // Fail closed on authorization failures.
      }
      if (!allowed) {
        options.onDropped?.('access-denied')
        return
      }
      socketState.readableDocuments.add(documentId)
    }

    let participant: DiagramPresenceIdentity | null = null
    try {
      participant = await options.identityForPeer(message.senderId)
    } catch {
      // Never fall back to client-supplied identity.
    }
    if (!participant) {
      options.onDropped?.('identity-unavailable')
      return
    }

    socketState.lastSequenceByDocument.set(documentId, parsed.sequence)
    if (socketState.peerId && socketState.peerId !== message.senderId) {
      statesByPeer.delete(socketState.peerId)
    }
    socketState.peerId = message.senderId
    socketState.participant = participant
    statesByPeer.set(message.senderId, socketState)
    const sanitized: DiagramPresenceServerMessage = { ...parsed, participant }
    message.data = encode(sanitized)
    options.onAccepted?.()
    deliver()
  }

  return {
    process(message, socketKey, deliver) {
      if (message.type !== 'ephemeral') {
        deliver()
        return
      }
      const tail = tails.get(socketKey) ?? Promise.resolve()
      const next = tail
        .then(() => decide(message, socketKey, deliver))
        .catch((error) => console.error('[diagram-presence-gate] unexpected failure; message dropped:', error))
      tails.set(socketKey, next)
    },
    disconnect(peerId, deliver) {
      const state = statesByPeer.get(peerId)
      if (!state?.participant) return
      statesByPeer.delete(peerId)
      for (const [documentId, sequence] of state.lastSequenceByDocument) {
        const goodbye: DiagramPresenceServerMessage = {
          channel: DIAGRAM_PRESENCE_CHANNEL,
          version: DIAGRAM_PRESENCE_VERSION,
          kind: 'goodbye',
          sequence: Math.min(MAX_SEQUENCE, sequence + 1),
          participant: state.participant,
        }
        deliver({ type: 'ephemeral', senderId: peerId, documentId, data: encode(goodbye) })
      }
    },
  }
}
