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

import {
  NetworkAdapter,
  cbor,
  type Message,
  type PeerId,
  type PeerMetadata,
} from '@automerge/automerge-repo/slim'
import { forgetWorkspaceBindingFrom, noteWorkspaceBinding, parseWorkspaceBindingFrame } from './workspaceBinding'

const SERVICE_RESTART_CODES = new Set([1012, 1013])

/**
 * What the transport is DOING right now.
 *
 * Reported alongside `boot.document.retry` so a rejection can be read against
 * the socket underneath it (e.g. a socket that fell and came back ~500 ms
 * later) without an external probe.
 *
 *  - `connected`    a peer has answered on THIS socket.
 *  - `handshaking`  the socket is connecting or open, no peer answer yet.
 *  - `reconnecting` the socket fell and a retry is armed — a peer IS still on
 *                   its way.
 *  - `idle`         no socket, no timer: nothing is on its way at all.
 */
export type TransportPhase = 'connected' | 'handshaking' | 'reconnecting' | 'idle'

export interface ReconnectDelayOptions {
  fastMinimumMs?: number
  fastMaximumMs?: number
  baseMs?: number
  maximumMs?: number
  random?: () => number
}

/** A bounded, jittered delay: ownership drains reconnect quickly, while a real
 * outage backs off exponentially instead of making every browser retry on the
 * same fixed five-second boundary. */
export function reconnectDelayMs(
  closeCode: number,
  attempt: number,
  options: ReconnectDelayOptions = {},
): number {
  const random = Math.max(0, Math.min(1, options.random?.() ?? Math.random()))
  if (SERVICE_RESTART_CODES.has(closeCode)) {
    const minimum = options.fastMinimumMs ?? (closeCode === 1012 ? 50 : 100)
    const maximum = Math.max(minimum, options.fastMaximumMs ?? (closeCode === 1012 ? 200 : 400))
    return Math.round(minimum + random * (maximum - minimum))
  }
  const base = options.baseMs ?? 500
  const maximum = options.maximumMs ?? 5_000
  const exponential = Math.min(maximum, base * 2 ** Math.min(Math.max(0, attempt), 8))
  return Math.round(exponential * (0.75 + random * 0.5))
}

type PeerWireMessage = {
  type: 'peer'
  senderId: PeerId
  peerMetadata?: PeerMetadata
}

type ErrorWireMessage = { type: 'error'; message?: string }

function webSocketPayload(value: unknown): ArrayBuffer {
  return Uint8Array.from(cbor.encode(value)).buffer
}

function peerWireMessage(value: unknown): PeerWireMessage | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PeerWireMessage>
  return candidate.type === 'peer' && typeof candidate.senderId === 'string'
    ? candidate as PeerWireMessage
    : null
}

/** One unintended close of a sync socket. `opened` is false when the socket
 * never reached `open` — which is how a browser reports an upgrade the server
 * REFUSED (401 for a stale session): a bare 1006, details hidden on purpose. */
export interface TransportClose {
  code: number
  opened: boolean
}
export type TransportCloseObserver = (close: TransportClose) => void

let transportCloseObserver: TransportCloseObserver | null = null

/** Install the page's one listener for unintended transport closes (the session
 * watcher, lib/auth/sessionWatch.ts). The transport only reports; whatever the
 * listener decides, reconnecting carries on unchanged. */
export function setTransportCloseObserver(observer: TransportCloseObserver | null): void {
  transportCloseObserver = observer
}

/**
 * DEV/E2E: the adapters alive in this page, so a test can drop the CURRENT
 * socket the way an outage would. A Playwright WebSocket route only intercepts
 * sockets opened AFTER it is installed, and `context.setOffline` does not end
 * an open localhost socket either (measured 2026-10-15: sync frames kept
 * arriving, the badge went back to 'ready') — so without this, "go offline"
 * on a live page left the client connected.
 */
const liveAdaptersForTest = new Set<AdaptiveWebSocketClientAdapter>()
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __dropSyncSocketsForTest?: () => number }).__dropSyncSocketsForTest = () => {
    let dropped = 0
    for (const adapter of liveAdaptersForTest) dropped += adapter.dropSocketForTest()
    return dropped
  }
}

/** Browser Automerge adapter with failover-aware reconnect semantics. It keeps
 * the upstream wire contract, but replaces the fixed 5 s retry interval with a
 * fast jittered 1012/1013 retry and bounded exponential backoff for outages. */
export class AdaptiveWebSocketClientAdapter extends NetworkAdapter {
  readonly url: string
  private readonly delayOptions: ReconnectDelayOptions
  private socket: WebSocket | undefined
  private remotePeerId: PeerId | undefined
  private ready = false
  private readonly readyPromise: Promise<void>
  private resolveReady: (() => void) | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0
  private handoffRetry = false
  private intentionalClose = false
  /** The code of the last close seen on this transport, or `null` before the
   * first one. Instrument only: nothing decides on it. */
  private closeCode: number | null = null
  /** Did the CURRENT socket reach `open`? Reset per socket in `openSocket`. */
  private socketOpened = false
  /** Bytes this transport has received, monotone for the life of the adapter
   * and ACROSS reconnects. It is the witness a boot document consults
   * to tell "the server is busy with someone else's turn" from "the server has
   * gone quiet" — see `progressBudget.ts` for what it can and cannot say. It
   * counts the wire frame, before CBOR decoding, so a frame this adapter fails
   * to parse still counts as the server being alive. */
  private inboundBytesTotal = 0

  constructor(url: string, delayOptions: ReconnectDelayOptions = {}) {
    super()
    this.url = url
    this.delayOptions = delayOptions
    this.readyPromise = new Promise<void>((resolve) => { this.resolveReady = resolve })
    if (import.meta.env.DEV) liveAdaptersForTest.add(this)
  }

  /** DEV/E2E: close the current socket as a network failure would (NOT an
   *  intentional close), so the adapter reconnects with its outage backoff.
   *  Returns 1 when there was a socket to drop. */
  dropSocketForTest(): number {
    const socket = this.socket
    if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) return 0
    socket.close(4000, 'e2e: simulated outage')
    return 1
  }

  isReady(): boolean {
    return this.ready
  }

  /**
   * Is a peer still ON ITS WAY through this transport?
   *
   * "The server is down" must stay a FAST failure, but "the socket just
   * bounced" (a ~500 ms reconnect) must not be read as "nothing is coming" —
   * otherwise a boot concludes a document is unavailable LOCALLY, from
   * `peers.size === 0`, moments before the peer comes back. So neither a
   * previous successful handshake nor a previous reconnect attempt excludes it.
   *
   * What does exclude it:
   *  - `ready` — a peer has answered on the CURRENT socket, so a later
   *    rejection is that peer's verdict, not a race with its handshake.
   *    Cleared by `onClose`, because it is a fact about a socket.
   *  - `intentionalClose` — `disconnect()` was called. Nothing is coming and
   *    nothing is meant to.
   *  - no armed reconnect and a closed (or absent) socket — nothing is in
   *    flight at all. THE offline guard at transport level.
   *
   * A server that is down keeps this true for the whole outage (`onClose` arms
   * retry after retry). What bounds the waiting is the waiver's own allowance,
   * SHARED BY THE WHOLE BOOT (`createWaiverAllocation`), so an unreachable
   * server costs ~2 000 ms once, not per document (see `handleRetry.test.ts`).
   */
  handshakePending(): boolean {
    if (this.ready) return false
    if (this.intentionalClose) return false
    if (this.reconnectTimer !== undefined) return true
    const state = this.socket?.readyState
    return state === WebSocket.CONNECTING || state === WebSocket.OPEN
  }

  /**
   * What this transport is doing, for the retry mark.
   *
   * Derived from `remotePeerId`, not from `ready`: it is the direct fact ("has
   * a peer answered on the socket we have RIGHT NOW"). The two agree in every
   * reachable state today, but the phase should not depend on a derived flag.
   *
   * It reports; it decides nothing. `handshakePending()` below is the
   * predicate, and it is deliberately narrower than `phase !== 'idle'`.
   */
  transportPhase(): TransportPhase {
    if (this.reconnectTimer !== undefined) return 'reconnecting'
    const state = this.socket?.readyState
    if (state === WebSocket.OPEN) return this.remotePeerId === undefined ? 'handshaking' : 'connected'
    if (state === WebSocket.CONNECTING) return 'handshaking'
    return 'idle'
  }

  /** The code of the last close on this transport, `null` before the first.
   * 1006 is an abnormal close with no close frame — a pipe that let go — and
   * it is NOT in `SERVICE_RESTART_CODES`, so it takes the outage cadence. */
  lastCloseCode(): number | null {
    return this.closeCode
  }

  /** Bytes received over the life of this adapter, monotone across reconnects.
   * The progress witness of `progressBudget.ts`; nothing else reads it. */
  inboundBytes(): number {
    return this.inboundBytesTotal
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  connect(peerId: PeerId, peerMetadata: PeerMetadata = {}): void {
    if (this.peerId && this.peerId !== peerId) throw new Error('Automerge peer id changed during reconnect')
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.intentionalClose = false
    this.openSocket()
  }

  disconnect(): void {
    liveAdaptersForTest.delete(this)
    this.intentionalClose = true
    this.handoffRetry = false
    this.clearTimers()
    const socket = this.socket
    this.detachSocket()
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, 'Client shutdown')
    }
    this.emitRemoteDisconnected()
  }

  send(message: Message): void {
    if ('data' in message && message.data?.byteLength === 0) {
      throw new Error('Tried to send a zero-length message')
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket not ready (${this.socket?.readyState ?? 'disconnected'})`)
    }
    this.socket.send(webSocketPayload(message))
  }

  private openSocket(): void {
    const previous = this.socket
    this.detachSocket()
    if (previous && (previous.readyState === WebSocket.OPEN || previous.readyState === WebSocket.CONNECTING)) {
      previous.close(1000, 'Replacing connection')
    }
    const socket = new WebSocket(this.url)
    this.socket = socket
    this.socketOpened = false
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', this.onOpen)
    socket.addEventListener('close', this.onClose)
    socket.addEventListener('message', this.onMessage)
    socket.addEventListener('error', this.onError)
  }

  private readonly onOpen = (): void => {
    this.socketOpened = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.reconnectAttempt = 0
    this.join()
  }

  private readonly onClose = (event: CloseEvent): void => {
    this.closeCode = event.code
    // A binding frame this socket sent and no handler took describes a socket
    // that is gone; the reconnect will send its own (workspaceBinding.ts).
    forgetWorkspaceBindingFrom(this)
    // `ready` is a fact about a SOCKET, and this one is gone. Leaving it set
    // would make `handshakePending()` false while the transport is busy getting
    // a peer back. `whenReady()` is unaffected: its promise stays resolved, and
    // `Repo` reads it once at construction.
    this.ready = false
    this.emitRemoteDisconnected()
    if (!this.intentionalClose && transportCloseObserver) {
      try {
        transportCloseObserver({ code: event.code, opened: this.socketOpened })
      } catch (error) {
        console.warn('[automerge] transport close observer failed', error)
      }
    }
    if (this.intentionalClose || this.reconnectTimer || !this.peerId) return
    if (SERVICE_RESTART_CODES.has(event.code)) this.handoffRetry = true
    // A first handoff retry can race the replacement owner's readiness and be
    // rejected as a generic 1006/HTTP 503. Keep the fast 1012 cadence until a
    // peer handshake proves the new route is usable; otherwise one transient
    // refusal incorrectly switches the browser to outage backoff.
    const effectiveCode = this.handoffRetry ? 1012 : event.code
    const delay = reconnectDelayMs(effectiveCode, this.reconnectAttempt, this.delayOptions)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.intentionalClose && this.peerId) this.openSocket()
    }, delay)
  }

  private readonly onMessage = (event: MessageEvent): void => {
    // Counted BEFORE the decode, and outside the try: a frame this adapter
    // cannot parse is still the server proving it is alive and serving this
    // client, which is the only claim the progress witness makes.
    const frameBytes = (event.data as ArrayBuffer | undefined)?.byteLength
    if (typeof frameBytes === 'number') this.inboundBytesTotal += frameBytes
    let message: unknown
    try {
      message = cbor.decode(new Uint8Array(event.data as ArrayBuffer))
    } catch {
      return
    }
    // The server names the workspace it bound THIS socket to, before any sync
    // traffic. Filtered here, below the NetworkSubsystem, for two reasons: this
    // is the only layer that sees every frame on every socket unconditionally —
    // so a reconnect cannot be missed the way a `peer` re-fire can — and
    // emitting an unknown type upward would hand the NetworkSubsystem something
    // it would only warn about and drop.
    const binding = parseWorkspaceBindingFrame(message)
    if (binding) {
      noteWorkspaceBinding(binding, this)
      return
    }
    const peer = peerWireMessage(message)
    if (peer) {
      this.handoffRetry = false
      this.remotePeerId = peer.senderId
      this.forceReady()
      this.emit('peer-candidate', {
        peerId: peer.senderId,
        peerMetadata: peer.peerMetadata ?? {},
      })
    } else if ((message as Partial<ErrorWireMessage> | null)?.type !== 'error') {
      this.emit('message', message as Message)
    }
  }

  private readonly onError = (): void => {
    // Browsers deliberately hide WebSocket failure details; close schedules the
    // retry and provides the only portable signal.
  }

  private join(): void {
    if (!this.peerId || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(webSocketPayload({
      type: 'join',
      senderId: this.peerId,
      peerMetadata: this.peerMetadata ?? {},
      supportedProtocolVersions: ['1'],
    }))
  }

  private forceReady(): void {
    if (this.ready) return
    this.ready = true
    this.resolveReady?.()
  }

  private emitRemoteDisconnected(): void {
    if (this.remotePeerId) this.emit('peer-disconnected', { peerId: this.remotePeerId })
    this.remotePeerId = undefined
  }

  private detachSocket(): void {
    const socket = this.socket
    if (!socket) return
    socket.removeEventListener('open', this.onOpen)
    socket.removeEventListener('close', this.onClose)
    socket.removeEventListener('message', this.onMessage)
    socket.removeEventListener('error', this.onError)
    this.socket = undefined
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }
}
