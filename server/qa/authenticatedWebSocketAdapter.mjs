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

import { NetworkAdapter, cbor } from '@automerge/automerge-repo/slim'
import WebSocket from 'ws'

export function qaReconnectDelayMs(closeCode, attempt, baseMs = 500, random = Math.random) {
  const jitter = Math.max(0, Math.min(1, random()))
  if (closeCode === 1012) return Math.round(50 + jitter * 150)
  if (closeCode === 1013) return Math.round(100 + jitter * 300)
  const exponential = Math.min(5_000, baseMs * 2 ** Math.min(Math.max(0, attempt), 8))
  return Math.round(exponential * (0.75 + jitter * 0.5))
}

export function closeQaSocket(socket) {
  if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) return
  // ws emits an `error` when close() aborts a socket that is still CONNECTING.
  // disconnect() has already detached the normal listener, so retain a one-shot
  // sink before closing to keep an intentional shutdown from crashing Node.
  if (socket.readyState === WebSocket.CONNECTING) socket.once('error', () => undefined)
  socket.close(1000, 'QA peer shutdown')
}

/**
 * Node-only Automerge adapter for protected QA environments. The upstream
 * browser-compatible adapter does not expose WebSocket request headers, so it
 * cannot send the session cookie required by AUTH=on.
 */
export class AuthenticatedWebSocketClientAdapter extends NetworkAdapter {
  constructor(
    url,
    sessionCookie,
    retryInterval = 500,
    WebSocketImpl = WebSocket,
    random = Math.random,
  ) {
    super()
    this.url = url
    this.sessionCookie = sessionCookie
    this.retryInterval = retryInterval
    this.WebSocketImpl = WebSocketImpl
    this.random = random
    this.socket = undefined
    this.remotePeerId = undefined
    this.retryTimer = undefined
    this.intentionalClose = false
    this.retryAttempt = 0
    this.handoffRetry = false
    this.connectionHistory = []
    this.connectionTimeline = []
    this.openTimeline = []
    this.attemptTimeline = []
    this.retryTimeline = []
    this.closeCodes = []
    this.closeTimeline = []
    this.sendWhileDisconnected = 0
    this.ready = false
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve })
  }

  isReady() {
    return this.ready
  }

  whenReady() {
    return this.readyPromise
  }

  connect(peerId, peerMetadata = {}) {
    if (this.peerId && this.peerId !== peerId) throw new Error('Automerge peer id changed during reconnect')
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.intentionalClose = false
    this.attemptTimeline.push({ at: Date.now() })
    this.detachSocket()

    this.socket = new this.WebSocketImpl(this.url, {
      headers: this.sessionCookie ? { Cookie: this.sessionCookie } : {},
    })
    this.socket.binaryType = 'arraybuffer'
    this.socket.addEventListener('open', this.onOpen)
    this.socket.addEventListener('close', this.onClose)
    this.socket.addEventListener('message', this.onMessage)
    this.socket.addEventListener('error', this.onError)
  }

  disconnect() {
    this.intentionalClose = true
    this.handoffRetry = false
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const socket = this.socket
    this.detachSocket()
    closeQaSocket(socket)
    if (this.remotePeerId) this.emit('peer-disconnected', { peerId: this.remotePeerId })
    this.remotePeerId = undefined
  }

  send(message) {
    if ('data' in message && message.data?.byteLength === 0) {
      throw new Error('Tried to send a zero-length message')
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.sendWhileDisconnected += 1
      throw new Error(`WebSocket not ready (${this.socket?.readyState ?? 'disconnected'})`)
    }
    this.socket.send(cbor.encode(message))
  }

  onOpen = () => {
    this.openTimeline.push({ at: Date.now() })
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.retryAttempt = 0
    this.join()
  }

  onClose = (event) => {
    const closeCode = event?.code ?? 1006
    this.closeCodes.push(closeCode)
    this.closeTimeline.push({ at: Date.now(), code: closeCode })
    if (this.remotePeerId) this.emit('peer-disconnected', { peerId: this.remotePeerId })
    this.remotePeerId = undefined
    if (this.intentionalClose || this.retryInterval <= 0 || this.retryTimer) return
    if (closeCode === 1012 || closeCode === 1013) this.handoffRetry = true
    const delay = qaReconnectDelayMs(
      this.handoffRetry ? 1012 : closeCode,
      this.retryAttempt,
      this.retryInterval,
      this.random,
    )
    this.retryTimeline.push({ at: Date.now(), closeCode, delay })
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      // A fired timer is no longer pending. Clear the marker before opening so
      // a 503/1006 from this attempt can schedule the next handoff retry.
      this.retryTimer = undefined
      this.connect(this.peerId, this.peerMetadata)
    }, delay)
    // A pending top-level document resolution does not keep Node alive. This
    // retry is the only runnable work after a transient 503 during failover,
    // so it must stay referenced until connect() or disconnect() clears it.
  }

  onMessage = (event) => {
    let message
    try {
      message = cbor.decode(new Uint8Array(event.data))
    } catch (error) {
      console.error('QA WebSocket message decode failed:', error)
      return
    }
    if (message.type === 'peer') {
      this.handoffRetry = false
      this.remotePeerId = message.senderId
      this.connectionHistory.push(message.senderId)
      this.connectionTimeline.push({ at: Date.now(), peerId: message.senderId })
      this.forceReady()
      this.emit('peer-candidate', {
        peerId: message.senderId,
        peerMetadata: message.peerMetadata,
      })
    } else if (message.type !== 'error') {
      this.emit('message', message)
    }
  }

  onError = (event) => {
    const message = event?.error?.message ?? event?.message ?? 'unknown WebSocket error'
    console.error(`QA WebSocket connection failed: ${message}`)
  }

  join() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(cbor.encode({
      type: 'join',
      senderId: this.peerId,
      peerMetadata: this.peerMetadata ?? {},
      supportedProtocolVersions: ['1'],
    }))
  }

  forceReady() {
    if (this.ready) return
    this.ready = true
    this.resolveReady?.()
  }

  detachSocket() {
    if (!this.socket) return
    this.socket.removeEventListener('open', this.onOpen)
    this.socket.removeEventListener('close', this.onClose)
    this.socket.removeEventListener('message', this.onMessage)
    this.socket.removeEventListener('error', this.onError)
    this.socket = undefined
  }

  diagnostics() {
    return {
      connectionHistory: [...this.connectionHistory],
      connectionTimeline: [...this.connectionTimeline],
      openTimeline: [...this.openTimeline],
      attemptTimeline: [...this.attemptTimeline],
      retryTimeline: [...this.retryTimeline],
      closeCodes: [...this.closeCodes],
      closeTimeline: [...this.closeTimeline],
      sendWhileDisconnected: this.sendWhileDisconnected,
      retryAttempt: this.retryAttempt,
    }
  }
}
