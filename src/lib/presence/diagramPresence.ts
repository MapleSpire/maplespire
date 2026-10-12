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

import type { DocHandle, DocHandleEphemeralMessagePayload } from '@automerge/automerge-repo'
import type { DiagramDoc } from '../automerge/types'
import {
  PRESENCE_CURSOR_INTERVAL_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_PEER_TTL_MS,
  clientPresenceMessage,
  parseDiagramPresenceServerMessage,
  type DiagramPresenceCursor,
  type DiagramPresenceIdentity,
} from './protocol'
import { hasDiagramPresencePeer, useDiagramPresenceStore } from '../../stores/diagramPresenceStore'

type Timer = ReturnType<typeof setTimeout>

function cursorChanged(previous: DiagramPresenceCursor | null, next: DiagramPresenceCursor | null): boolean {
  if (!previous || !next) return previous !== next
  if (previous.view !== next.view || previous.visible !== next.visible) return true
  return Math.abs(previous.x - next.x) >= 0.5 || Math.abs(previous.y - next.y) >= 0.5
}

export class DiagramPresenceSession {
  private readonly handle: DocHandle<DiagramDoc>
  private readonly localParticipant: DiagramPresenceIdentity
  private sequence = 0
  private running = false
  private heartbeatTimer: Timer | null = null
  private pruneTimer: Timer | null = null
  private cursorTimer: Timer | null = null
  private pendingCursor: DiagramPresenceCursor | null = null
  private lastQueuedCursor: DiagramPresenceCursor | null = null
  private lastSentAt = 0
  private readonly onPageHide = () => this.stop()
  private readonly onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.setCursor(null)
    else this.broadcastState()
  }

  private readonly onEphemeralMessage = ({ senderId, message }: DocHandleEphemeralMessagePayload<DiagramDoc>) => {
    const parsed = parseDiagramPresenceServerMessage(message)
    if (!parsed) return
    const wasUnknown = !hasDiagramPresencePeer(senderId)
    useDiagramPresenceStore.getState().receive(senderId, parsed)
    if (wasUnknown && parsed.kind !== 'goodbye') this.broadcastState()
  }

  constructor(handle: DocHandle<DiagramDoc>, localParticipant: DiagramPresenceIdentity) {
    this.handle = handle
    this.localParticipant = localParticipant
  }

  start(): void {
    if (this.running) return
    this.running = true
    useDiagramPresenceStore.getState().reset()
    useDiagramPresenceStore.getState().setLocalParticipant(this.localParticipant)
    this.handle.on('ephemeral-message', this.onEphemeralMessage)
    this.broadcastState()
    this.heartbeatTimer = setInterval(() => this.send('heartbeat'), PRESENCE_HEARTBEAT_MS)
    this.pruneTimer = setInterval(() => {
      useDiagramPresenceStore.getState().prune(Date.now() - PRESENCE_PEER_TTL_MS)
    }, PRESENCE_HEARTBEAT_MS)
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibilityChange)
  }

  setCursor(cursor: DiagramPresenceCursor | null): void {
    if (!this.running || !cursorChanged(this.lastQueuedCursor, cursor)) return
    this.lastQueuedCursor = cursor
    this.pendingCursor = cursor
    this.scheduleCursorFlush()
  }

  stop(): void {
    if (!this.running) return
    this.send('goodbye')
    this.running = false
    this.handle.off('ephemeral-message', this.onEphemeralMessage)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    this.heartbeatTimer = null
    this.pruneTimer = null
    this.cursorTimer = null
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibilityChange)
    useDiagramPresenceStore.getState().reset()
  }

  private scheduleCursorFlush(): void {
    if (this.cursorTimer) return
    const waitMs = Math.max(0, PRESENCE_CURSOR_INTERVAL_MS - (Date.now() - this.lastSentAt))
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null
      if (!this.running) return
      this.lastSentAt = Date.now()
      this.send('cursor', this.pendingCursor)
    }, waitMs)
  }

  private broadcastState(): void {
    if (!this.running) return
    this.send('state', this.lastQueuedCursor)
  }

  private send(
    kind: 'state' | 'cursor' | 'heartbeat' | 'goodbye',
    cursor?: DiagramPresenceCursor | null,
  ): void {
    if (!this.running) return
    try {
      this.handle.broadcast(clientPresenceMessage(kind, ++this.sequence, cursor))
    } catch (error) {
      if (import.meta.env.DEV) console.debug('[presence] broadcast skipped', error)
    }
  }
}

let activeSession: DiagramPresenceSession | null = null

export function startDiagramPresence(
  handle: DocHandle<DiagramDoc>,
  localParticipant: DiagramPresenceIdentity,
): () => void {
  activeSession?.stop()
  const session = new DiagramPresenceSession(handle, localParticipant)
  activeSession = session
  session.start()
  return () => {
    if (activeSession === session) activeSession = null
    session.stop()
  }
}

export function publishDiagramCursor(cursor: DiagramPresenceCursor | null): void {
  activeSession?.setCursor(cursor)
}
