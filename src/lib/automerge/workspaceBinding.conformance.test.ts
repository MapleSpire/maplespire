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
import { cbor, type PeerId } from '@automerge/automerge-repo/slim'
import {
  WORKSPACE_BINDING_TYPE,
  installWorkspaceBindingHandler,
  parseWorkspaceBindingFrame,
  type WorkspaceBinding,
} from './workspaceBinding'
import {
  WORKSPACE_BINDING_TYPE as SERVER_TYPE,
  encodeWorkspaceBinding,
} from '../../../server/src/syncCells/workspaceBinding.js'
import { AdaptiveWebSocketClientAdapter } from './adaptiveWebSocketClientAdapter'

/**
 * THE WORKSPACE-BINDING WIRE, driven from the server's encoder to the client's
 * handler in one program.
 *
 * The two halves live in two packages: `server/src/syncCells/workspaceBinding.ts`
 * encodes, `src/lib/automerge/workspaceBinding.ts` parses, and the type string
 * is a hand-copied constant on both sides; this suite asserts they agree.
 *
 * ## What this suite adds
 *
 * `adaptiveWebSocketClientAdapter.test.ts` covers the adapter from bytes it
 * builds by hand. This suite tests the composition — the server's real encoder
 * reaching the client's real adapter. The wire is the half that breaks, and it
 * is usually the half with no test.
 *
 * ## Two deliberate choices, both of which change what can be caught
 *
 * 1. **Decoding goes through `cbor` re-exported by `@automerge/automerge-repo/
 *    slim`, not through `cbor-x` directly.** That is what
 *    `adaptiveWebSocketClientAdapter.ts` uses in production, so the decode is
 *    the production path. Because the SERVER module this file imports does
 *    `import { encode } from 'cbor-x'`, the root declares `cbor-x` in
 *    `devDependencies`; without it a change in hoisting would fail this suite
 *    with a module-resolution error that says nothing about the wire.
 * 2. **Every negative carries a liveness witness in the same window.** "The
 *    binding frame was not emitted as an Automerge message" and "this adapter
 *    emits nothing at all" are the same green otherwise.
 *
 * ## What this suite CANNOT see
 *
 * Everything runs under the ROOT `node_modules`. The server encodes with
 * `server/node_modules/cbor-x` in production; nothing here would notice if the
 * two installs diverged. That is the same caveat
 * `documentResolution.conformance.test.ts` records for automerge-repo, and it is
 * a smaller risk here only because the frame is three strings.
 */

/** The minimum `AdaptiveWebSocketClientAdapter` touches, plus two drivers. */
class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: FakeSocket[] = []

  readyState = FakeSocket.CONNECTING
  binaryType = ''
  readonly sent: unknown[] = []
  readonly url: string
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  // Not a parameter property (`constructor(readonly url: string)`):
  // `erasableSyntaxOnly` is on, so `tsc -p tsconfig.app.json` rejects it, while
  // vitest (which transpiles without typechecking) would stay green.
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(payload: unknown): void { this.sent.push(payload) }

  close(): void { this.readyState = FakeSocket.CLOSED }

  open(): void {
    this.readyState = FakeSocket.OPEN
    for (const listener of this.listeners.get('open') ?? []) listener(new Event('open'))
  }

  /**
   * Deliver bytes the way a browser does — and ONLY if the adapter asked for
   * them that way.
   *
   * A browser socket defaults to `binaryType === 'blob'`. The adapter sets
   * `'arraybuffer'` (in `adaptiveWebSocketClientAdapter.ts`), and `onMessage`
   * does `cbor.decode(new Uint8Array(event.data as ArrayBuffer))` inside a
   * `try { … } catch { return }`. So without that one line the decode throws on
   * a Blob, the catch swallows it, and the client receives NOTHING — no
   * binding, no sync, no error, silently.
   *
   * A fake that handed over an `ArrayBuffer` unconditionally would stay green
   * with that production line deleted; this guard is what makes the fake able
   * to fail on it.
   */
  deliver(bytes: Uint8Array): void {
    if (this.binaryType !== 'arraybuffer') {
      throw new Error(
        `the adapter never set binaryType='arraybuffer' (it is '${this.binaryType}'), `
        + 'so a real browser would hand this frame over as a Blob and the decode would '
        + 'throw into onMessage\'s catch — the client would receive nothing, silently',
      )
    }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: buffer } as unknown as MessageEvent)
    }
  }
}

/** Boot a real adapter over a fake socket and return both, plus what it emitted. */
function connectedAdapter(): { socket: FakeSocket; emitted: unknown[] } {
  FakeSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
  const adapter = new AdaptiveWebSocketClientAdapter('ws://localhost/automerge')
  const emitted: unknown[] = []
  adapter.on('message', (message) => emitted.push(message))
  adapter.connect('peer-conformance' as PeerId, {})
  const socket = FakeSocket.instances[0]!
  socket.open()
  return { socket, emitted }
}

afterEach(() => {
  installWorkspaceBindingHandler(null)
  vi.unstubAllGlobals()
})

describe('workspace-binding wire — client/server conformance', () => {
  it('is the same type string on both sides', () => {
    // Drift here makes the adapter stop recognising the frame: the detector
    // never fires again, and every test around it stays green because each side
    // agrees with itself. This row is deliberately value-free — what it asserts
    // is that the two AGREE, at whatever string; the SHAPE is pinned separately
    // below, for the reason `overlayWriteHead.conformance.test.ts` gives about
    // splitting agreement from the value.
    expect(WORKSPACE_BINDING_TYPE).toBe(SERVER_TYPE)
  })

  it('is namespaced, so it can never collide with an automerge-repo message type', () => {
    // `NetworkSubsystem` warns and drops on `!isRepoMessage(msg)`; a collision
    // would instead route our frame into automerge-repo's own handling.
    expect(WORKSPACE_BINDING_TYPE).toMatch(/^maplespire\./)
  })

  it('round-trips the bytes the server actually sends, through the decoder the client actually uses', () => {
    const bytes = encodeWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' })
    expect(parseWorkspaceBindingFrame(cbor.decode(bytes))).toEqual({ landscapeId: 'L1', versionId: 'V2' })
  })

  it('carries exactly the three fields the parser requires — no more, no fewer', () => {
    // Derived from the ENCODER's own output rather than from a literal, so a
    // field ADDED or RENAMED server-side is a red here. Without it the round
    // trip above passes on a frame carrying anything at all, since the parser
    // reads three keys and ignores the rest — which is correct for forward
    // compatibility on the wire and useless as a description of the contract.
    const decoded = cbor.decode(encodeWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' })) as Record<string, unknown>
    expect(Object.keys(decoded).sort()).toEqual(['landscapeId', 'type', 'versionId'])
  })

  it('refuses the server frame with any single field removed', () => {
    // Each field individually, from the real encoder's output — a frame missing
    // half its payload is not a weaker answer, it is no answer, and admitting
    // one would let the detector compare a real workspace against `undefined`.
    const decoded = cbor.decode(encodeWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' })) as Record<string, unknown>
    for (const field of Object.keys(decoded)) {
      const damaged: Record<string, unknown> = { ...decoded }
      delete damaged[field]
      expect(parseWorkspaceBindingFrame(damaged), `dropping ${field} must be refused`).toBeNull()
    }
    // THE CONTROL. Without it the loop above passes against a parser that
    // refuses everything, including the intact frame.
    expect(parseWorkspaceBindingFrame(decoded)).toEqual({ landscapeId: 'L1', versionId: 'V2' })
  })

  it('reaches the handler through the REAL adapter, and is not emitted as an Automerge message', () => {
    const seen: WorkspaceBinding[] = []
    const uninstall = installWorkspaceBindingHandler((binding) => seen.push(binding))
    try {
      const { socket, emitted } = connectedAdapter()

      socket.deliver(encodeWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }))

      expect(seen).toEqual([{ landscapeId: 'L1', versionId: 'V2' }])
      expect(emitted).toEqual([])

      // THE LIVENESS WITNESS, in the same window and on the same socket. Without
      // it, `emitted` being empty is equally consistent with an adapter that
      // never emits anything — a dead socket and a correctly-filtered frame are
      // the same green.
      socket.deliver(Uint8Array.from(cbor.encode({ type: 'sync', documentId: 'd1', senderId: 'a', targetId: 'b' })))
      expect(emitted).toHaveLength(1)
      expect(seen).toHaveLength(1)
    } finally {
      uninstall()
    }
  })

  it('delivers a binding on EVERY frame, not only the first of a socket', () => {
    // The defect this whole mechanism exists for is a REPOINT under an
    // open tab: the second binding is the one that carries the news. An adapter
    // that filtered the frame once — on connect, say — would pass every case
    // above and miss the only scenario that matters.
    const seen: WorkspaceBinding[] = []
    const uninstall = installWorkspaceBindingHandler((binding) => seen.push(binding))
    try {
      const { socket } = connectedAdapter()
      socket.deliver(encodeWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }))
      socket.deliver(encodeWorkspaceBinding({ landscapeId: 'L1', versionId: 'V3' }))
      expect(seen).toEqual([
        { landscapeId: 'L1', versionId: 'V2' },
        { landscapeId: 'L1', versionId: 'V3' },
      ])
    } finally {
      uninstall()
    }
  })
})
