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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_BINDING_TYPE, installWorkspaceBindingHandler } from './workspaceBinding'
import { cbor, type PeerId } from '@automerge/automerge-repo/slim'
import { reconnectDelayMs } from './adaptiveWebSocketClientAdapter'
import { AdaptiveWebSocketClientAdapter } from './adaptiveWebSocketClientAdapter'

class DelayedHandshakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: DelayedHandshakeWebSocket[] = []

  readyState = DelayedHandshakeWebSocket.CONNECTING
  binaryType = ''
  readonly url: string
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(url: string) {
    this.url = url
    DelayedHandshakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(): void {}

  close(): void {
    this.readyState = DelayedHandshakeWebSocket.CLOSED
  }

  open(): void {
    this.readyState = DelayedHandshakeWebSocket.OPEN
    for (const listener of this.listeners.get('open') ?? []) listener(new Event('open'))
  }

  closeWith(code: number): void {
    this.readyState = DelayedHandshakeWebSocket.CLOSED
    for (const listener of this.listeners.get('close') ?? []) {
      listener({ code } as CloseEvent)
    }
  }

  /** An arbitrary inbound frame — the shape the progress witness counts.
   * Deliberately NOT a `peer` message and deliberately not valid
   * CBOR: the counter must sit before the decode. */
  message(data: ArrayBuffer): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data } as MessageEvent)
    }
  }

  peer(senderId = 'server-peer'): void {
    const bytes = Uint8Array.from(cbor.encode({ type: 'peer', senderId, peerMetadata: {} }))
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data } as MessageEvent)
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  DelayedHandshakeWebSocket.instances.length = 0
})

describe('adaptive Automerge reconnect delay', () => {
  it('reconnects quickly with jitter after an ownership drain', () => {
    expect(reconnectDelayMs(1012, 0, { random: () => 0 })).toBe(50)
    expect(reconnectDelayMs(1012, 0, { random: () => 1 })).toBe(200)
    expect(reconnectDelayMs(1013, 8, { random: () => 0.5 })).toBe(250)
  })

  it('backs off and caps retries for a real outage', () => {
    expect(reconnectDelayMs(1006, 0, { random: () => 0.5 })).toBe(500)
    expect(reconnectDelayMs(1006, 2, { random: () => 0.5 })).toBe(2_000)
    expect(reconnectDelayMs(1006, 20, { random: () => 0.5 })).toBe(5_000)
  })

  it('does not report network readiness before the server peer handshake', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    const adapter = new AdaptiveWebSocketClientAdapter('ws://delayed.test/automerge')

    adapter.connect('browser-peer' as PeerId)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(adapter.isReady()).toBe(false)
    const ready = adapter.whenReady()
    DelayedHandshakeWebSocket.instances[0].peer()
    await expect(ready).resolves.toBeUndefined()
    expect(adapter.isReady()).toBe(true)
    adapter.disconnect()
  })

  it('keeps fast retries after a handoff attempt races a transient 503', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    const adapter = new AdaptiveWebSocketClientAdapter('ws://handoff.test/automerge', {
      fastMinimumMs: 100,
      fastMaximumMs: 100,
      baseMs: 1_000,
      random: () => 0,
    })

    adapter.connect('browser-peer' as PeerId)
    DelayedHandshakeWebSocket.instances[0].open()
    DelayedHandshakeWebSocket.instances[0].peer('owner-a')
    DelayedHandshakeWebSocket.instances[0].closeWith(1012)

    await vi.advanceTimersByTimeAsync(100)
    expect(DelayedHandshakeWebSocket.instances).toHaveLength(2)
    // The replacement route is not ready yet. Browsers surface the failed
    // upgrade as 1006, but it is still part of the 1012 handoff sequence.
    DelayedHandshakeWebSocket.instances[1].closeWith(1006)
    await vi.advanceTimersByTimeAsync(100)
    expect(DelayedHandshakeWebSocket.instances).toHaveLength(3)

    DelayedHandshakeWebSocket.instances[2].open()
    DelayedHandshakeWebSocket.instances[2].peer('owner-c')
    DelayedHandshakeWebSocket.instances[2].closeWith(1006)
    await vi.advanceTimersByTimeAsync(749)
    expect(DelayedHandshakeWebSocket.instances).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(DelayedHandshakeWebSocket.instances).toHaveLength(4)
    adapter.disconnect()
  })
})

/**
 * The transport's answer to "is a peer still on its way?".
 *
 * The waiver in `handleRetry` is only as good as this predicate, and it is
 * asymmetric: a wrong YES costs up to twenty seconds of hourglass on every
 * offline boot, a wrong NO makes a boot give up on a document moments before
 * its peer answers. So each of the three exclusions gets its own case.
 */
describe('handshakePending', () => {
  function connectedAdapter() {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    const adapter = new AdaptiveWebSocketClientAdapter('ws://pending.test/automerge', {
      fastMinimumMs: 10, fastMaximumMs: 10, baseMs: 10, maximumMs: 10, random: () => 0,
    })
    adapter.connect('browser-peer' as PeerId)
    return adapter
  }

  it('is TRUE for the state the defect was measured in: socket up, no peer yet', () => {
    const adapter = connectedAdapter()
    // CONNECTING — the workspace switch has just built this adapter and
    // `getRootHandle` is already issuing its find().
    expect(adapter.handshakePending()).toBe(true)
    DelayedHandshakeWebSocket.instances[0].open()
    // OPEN, join sent, no `peer` frame back yet — the window in which the
    // root's find() can reject shortly before the answer arrives.
    expect(adapter.handshakePending()).toBe(true)
    adapter.disconnect()
  })

  it('is FALSE once a peer has answered on this transport', () => {
    const adapter = connectedAdapter()
    DelayedHandshakeWebSocket.instances[0].open()
    DelayedHandshakeWebSocket.instances[0].peer()
    // A later rejection is now that peer's verdict on the document, not a race
    // with its handshake — and waiting for a second peer buys nothing.
    expect(adapter.handshakePending()).toBe(false)
    adapter.disconnect()
  })

  it('T1: is TRUE while a RECONNECT is armed — the state #37bis was measured in', async () => {
    // The socket fell with 1006 and a retry is armed: a peer IS on its way.
    // Excluding "has reconnected before" here would let a boot die moments
    // before its peer comes back. What bounds the waiting instead is the
    // waiver's allowance, SHARED by the whole boot (see `handleRetry.test.ts`).
    const adapter = connectedAdapter()
    DelayedHandshakeWebSocket.instances[0].closeWith(1006)
    expect(adapter.handshakePending()).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    // …and across the reconnect, on the replacement socket, still true.
    expect(DelayedHandshakeWebSocket.instances).toHaveLength(2)
    expect(adapter.handshakePending()).toBe(true)
    adapter.disconnect()
  })

  it('T2: `ready` does NOT survive a close', async () => {
    // Independent of T1: with `ready` latched across a close, T1 above still
    // passes but the waiver stays mute for every socket that has ever
    // handshaked — which is every socket in a real session.
    const adapter = connectedAdapter()
    DelayedHandshakeWebSocket.instances[0].open()
    DelayedHandshakeWebSocket.instances[0].peer()
    expect(adapter.isReady()).toBe(true)
    expect(adapter.handshakePending()).toBe(false)

    DelayedHandshakeWebSocket.instances[0].closeWith(1006)
    expect(adapter.isReady()).toBe(false)
    expect(adapter.handshakePending()).toBe(true)

    // …and a peer on the replacement socket ends it again, so the waiver stops
    // arming the moment there is someone to answer.
    await vi.advanceTimersByTimeAsync(10)
    DelayedHandshakeWebSocket.instances[1].open()
    DelayedHandshakeWebSocket.instances[1].peer('owner-b')
    expect(adapter.handshakePending()).toBe(false)
    adapter.disconnect()
  })

  it('T3: a transport that has STOPPED reconnecting expects nothing — the offline guard', () => {
    // THE guard at transport level, and the one that keeps "the server is
    // down" from becoming "wait for it" forever. `disconnect()` is deliberate:
    // no timer is armed, nothing is coming, and nothing is meant to.
    //
    // Note what this is NOT: it is not "an adapter exists". The router keeps
    // exactly one attached at all times, including with the server down, so an
    // existence test would be permanently true and the waiver permanently
    // armed (see `peerAwareness.ts`).
    const adapter = connectedAdapter()
    DelayedHandshakeWebSocket.instances[0].open()
    DelayedHandshakeWebSocket.instances[0].peer()
    adapter.disconnect()
    expect(adapter.handshakePending()).toBe(false)
  })

  it('is FALSE with no socket at all', () => {
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    const adapter = new AdaptiveWebSocketClientAdapter('ws://never.test/automerge')
    expect(adapter.handshakePending()).toBe(false)
  })
})

/**
 * The transport says what it is DOING, so an incident (e.g. a 1006 close
 * followed by a rejection and a reconnect ~500 ms later) can be read from the
 * app's own timeline without an external probe. These cases pin each phase to
 * a transport state a socket can really be in, so `boot.document.retry`
 * cannot carry a fabricated one.
 */
describe('transportPhase', () => {
  function connectedAdapter() {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    const adapter = new AdaptiveWebSocketClientAdapter('ws://phase.test/automerge', {
      fastMinimumMs: 10, fastMaximumMs: 10, baseMs: 10, maximumMs: 10, random: () => 0,
    })
    adapter.connect('browser-peer' as PeerId)
    return adapter
  }

  it('walks handshaking → connected → reconnecting → connected across a socket that falls', async () => {
    const adapter = connectedAdapter()
    expect(adapter.transportPhase()).toBe('handshaking')
    expect(adapter.lastCloseCode()).toBeNull()

    DelayedHandshakeWebSocket.instances[0].open()
    // OPEN, join sent, no `peer` frame back yet.
    expect(adapter.transportPhase()).toBe('handshaking')
    DelayedHandshakeWebSocket.instances[0].peer()
    expect(adapter.transportPhase()).toBe('connected')

    // The pipe let go and a retry is armed; the boot has to survive the
    // reconnect window.
    DelayedHandshakeWebSocket.instances[0].closeWith(1006)
    expect(adapter.transportPhase()).toBe('reconnecting')
    expect(adapter.lastCloseCode()).toBe(1006)

    await vi.advanceTimersByTimeAsync(10)
    expect(DelayedHandshakeWebSocket.instances).toHaveLength(2)
    expect(adapter.transportPhase()).toBe('handshaking')

    // The replacement socket is OPEN and no peer has answered on it yet. This
    // is the instant that tells a phase derived from a latched `ready` apart
    // from one derived from `remotePeerId`: it must read 'handshaking', not
    // 'connected'.
    DelayedHandshakeWebSocket.instances[1].open()
    expect(adapter.isReady()).toBe(false)
    expect(adapter.transportPhase()).toBe('handshaking')

    DelayedHandshakeWebSocket.instances[1].peer('owner-b')
    expect(adapter.transportPhase()).toBe('connected')
    adapter.disconnect()
  })

  it('is idle with no socket and no timer', () => {
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    const adapter = new AdaptiveWebSocketClientAdapter('ws://idle.test/automerge')
    expect(adapter.transportPhase()).toBe('idle')
    expect(adapter.lastCloseCode()).toBeNull()
  })
})

describe('inboundBytes (the progress witness, #37ter)', () => {
  /** A frame of `size` bytes that is NOT a `peer` message, delivered on the
   * adapter's current socket. */
  function deliver(socket: DelayedHandshakeWebSocket, size: number): void {
    const payload = new ArrayBuffer(size)
    socket.message(payload)
  }

  it('counts every inbound frame, including one it cannot decode', async () => {
    // The counter has to sit BEFORE the CBOR decode. A frame this adapter
    // cannot parse is still the server proving it is alive and serving this
    // client, which is the only claim `progressBudget.ts` makes of it — and a
    // witness that went quiet on an unparseable frame would read as "the
    // server stopped", the one answer that ends a boot early.
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    const adapter = new AdaptiveWebSocketClientAdapter('ws://localhost/automerge')
    adapter.connect('peer-a' as PeerId, {})
    const socket = DelayedHandshakeWebSocket.instances[0]!
    socket.open()

    expect(adapter.inboundBytes()).toBe(0)
    deliver(socket, 1_000)          // undecodable garbage
    expect(adapter.inboundBytes()).toBe(1_000)
    socket.peer()                   // a real, decodable message
    expect(adapter.inboundBytes()).toBeGreaterThan(1_000)
  })

  it('stays MONOTONE across a reconnect — the transfer restarts, the witness does not', async () => {
    // A socket can fall mid-boot and come back ~500 ms later. If the counter
    // reset with the socket, the comparison
    // across a window that spanned the fall would go NEGATIVE, and a negative
    // delta must never read as progress — so the counter is a fact about the
    // adapter, not about the socket.
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    vi.useFakeTimers()
    const adapter = new AdaptiveWebSocketClientAdapter('ws://localhost/automerge')
    adapter.connect('peer-a' as PeerId, {})
    const first = DelayedHandshakeWebSocket.instances[0]!
    first.open()
    first.peer()
    deliver(first, 500_000)
    const beforeFall = adapter.inboundBytes()
    expect(beforeFall).toBeGreaterThanOrEqual(500_000)

    first.closeWith(1006)
    await vi.advanceTimersByTimeAsync(5_000)
    const second = DelayedHandshakeWebSocket.instances[1]!
    second.open()
    second.peer()
    deliver(second, 250_000)

    expect(adapter.inboundBytes()).toBeGreaterThanOrEqual(beforeFall + 250_000)
  })
})

/**
 * The workspace-binding frame. Filtered HERE, below the
 * NetworkSubsystem, because this is the only layer that sees every frame on
 * every socket unconditionally — and because handing an unknown type upward
 * would give the NetworkSubsystem something it only warns about and drops.
 */
describe('the workspace-binding frame', () => {
  function bindingFrame(socket: DelayedHandshakeWebSocket, landscapeId: string, versionId: string): void {
    const bytes = Uint8Array.from(cbor.encode({
      type: WORKSPACE_BINDING_TYPE,
      landscapeId,
      versionId,
    }))
    socket.message(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  }

  it('reaches the handler and is NOT emitted as an Automerge message', () => {
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    const seen: { landscapeId: string; versionId: string }[] = []
    const uninstall = installWorkspaceBindingHandler((b) => seen.push(b))
    try {
      const adapter = new AdaptiveWebSocketClientAdapter('ws://localhost/automerge')
      const messages: unknown[] = []
      adapter.on('message', (m) => messages.push(m))
      adapter.connect('peer-a' as PeerId, {})
      const socket = DelayedHandshakeWebSocket.instances[0]!
      socket.open()

      bindingFrame(socket, 'L1', 'V2')

      expect(seen).toEqual([{ landscapeId: 'L1', versionId: 'V2' }])
      expect(messages).toEqual([])
    } finally {
      uninstall()
    }
  })

  it('arrives again on EVERY reconnect, which is the only moment it matters', async () => {
    // The alias is re-resolved by the server on every upgrade, so a detector
    // that only saw the first socket would miss every repoint after boot.
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    vi.useFakeTimers()
    const seen: string[] = []
    const uninstall = installWorkspaceBindingHandler((b) => seen.push(b.versionId))
    try {
      const adapter = new AdaptiveWebSocketClientAdapter('ws://localhost/automerge')
      adapter.connect('peer-a' as PeerId, {})
      const first = DelayedHandshakeWebSocket.instances[0]!
      first.open()
      bindingFrame(first, 'L1', 'V1')

      first.closeWith(1006)
      await vi.advanceTimersByTimeAsync(5_000)
      const second = DelayedHandshakeWebSocket.instances[1]!
      second.open()
      bindingFrame(second, 'L1', 'V2')
      expect(seen).toEqual(['V1', 'V2'])
    } finally {
      uninstall()
    }
  })

  it('still counts toward the progress witness — it is the server proving it is alive', () => {
    vi.stubGlobal('WebSocket', DelayedHandshakeWebSocket)
    const uninstall = installWorkspaceBindingHandler(() => {})
    try {
      const adapter = new AdaptiveWebSocketClientAdapter('ws://localhost/automerge')
      adapter.connect('peer-a' as PeerId, {})
      const socket = DelayedHandshakeWebSocket.instances[0]!
      socket.open()
      expect(adapter.inboundBytes()).toBe(0)
      bindingFrame(socket, 'L1', 'V2')
      expect(adapter.inboundBytes()).toBeGreaterThan(0)
    } finally {
      uninstall()
    }
  })
})
