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

import { decode, encode } from 'cbor-x'
import { describe, expect, it, vi } from 'vitest'
import {
  DIAGRAM_PRESENCE_CHANNEL,
  DIAGRAM_PRESENCE_VERSION,
  createDiagramPresenceGate,
  normalizePresenceIdentity,
  parseDiagramPresenceClientMessage,
  type DiagramPresenceGateMessage,
  type DiagramPresenceServerMessage,
} from './diagramPresenceGate.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settle(times = 5): Promise<void> {
  for (let index = 0; index < times; index += 1) await tick()
}

function payload(overrides: Record<string, unknown> = {}): Uint8Array {
  return encode({
    channel: DIAGRAM_PRESENCE_CHANNEL,
    version: DIAGRAM_PRESENCE_VERSION,
    kind: 'cursor',
    sequence: 1,
    cursor: { x: 120, y: -32.5, view: '2d', visible: true },
    ...overrides,
  })
}

function message(overrides: Partial<DiagramPresenceGateMessage> = {}): DiagramPresenceGateMessage {
  return {
    type: 'ephemeral',
    senderId: 'peer-1',
    documentId: 'diagram-doc-1',
    data: payload(),
    ...overrides,
  }
}

function identity() {
  return normalizePresenceIdentity({ userId: 'user-123', givenName: 'Alice' })
}

describe('diagram presence protocol validation', () => {
  it('accepts the bounded shape while stripping injected identity', () => {
    expect(parseDiagramPresenceClientMessage({
      channel: DIAGRAM_PRESENCE_CHANNEL,
      version: 1,
      kind: 'cursor',
      sequence: 2,
      cursor: { x: 1, y: 2, view: '3d', visible: false, injected: 'ignored' },
      participant: { firstName: 'Mallory' },
    })).toEqual({
      channel: DIAGRAM_PRESENCE_CHANNEL,
      version: 1,
      kind: 'cursor',
      sequence: 2,
      cursor: { x: 1, y: 2, view: '3d', visible: false },
    })
  })

  it('derives a bounded canonical identity without raw ids or email', () => {
    const result = normalizePresenceIdentity({ userId: 'secret-user-id', name: 'Élodie Martin' })
    expect(result.firstName).toBe('Élodie')
    expect(result.participantId).toMatch(/^p_[a-f0-9]{16}$/)
    expect(JSON.stringify(result)).not.toContain('secret-user-id')
  })
})

describe('createDiagramPresenceGate', () => {
  it('replaces spoofed identity with the canonical server identity', async () => {
    const gate = createDiagramPresenceGate({
      canRead: vi.fn(async () => true),
      identityForPeer: vi.fn(async () => identity()),
    })
    const candidate = message({ data: payload({ participant: { firstName: 'Mallory' } }) })
    const deliver = vi.fn()
    gate.process(candidate, {}, deliver)
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect((decode(candidate.data!) as DiagramPresenceServerMessage).participant).toEqual(identity())
  })

  it('fails closed on access denial, malformed CBOR and oversized payloads', async () => {
    const onDropped = vi.fn()
    const identityForPeer = vi.fn(async () => identity())
    const denied = createDiagramPresenceGate({ canRead: async () => false, identityForPeer, onDropped })
    denied.process(message(), {}, vi.fn())
    const bounded = createDiagramPresenceGate({
      canRead: async () => true,
      identityForPeer,
      onDropped,
      maxPayloadBytes: 64,
    })
    bounded.process(message({ data: new Uint8Array([0xff, 0xff]) }), {}, vi.fn())
    bounded.process(message({ data: new Uint8Array(65) }), {}, vi.fn())
    await settle()
    expect(onDropped.mock.calls.flat()).toEqual(expect.arrayContaining([
      'access-denied', 'invalid-message', 'oversized',
    ]))
  })

  it('rate-limits per socket and drops replayed sequences', async () => {
    const onDropped = vi.fn()
    const gate = createDiagramPresenceGate({
      canRead: async () => true,
      identityForPeer: async () => identity(),
      now: () => 1_000,
      ratePerSecond: 1,
      burst: 2,
      onDropped,
    })
    const socket = {}
    gate.process(message({ data: payload({ sequence: 9 }) }), socket, vi.fn())
    gate.process(message({ data: payload({ sequence: 9 }) }), socket, vi.fn())
    gate.process(message({ data: payload({ sequence: 10 }) }), socket, vi.fn())
    await settle()
    expect(onDropped.mock.calls.flat()).toEqual(expect.arrayContaining(['stale-sequence', 'rate-limited']))
  })

  it('emits a canonical goodbye when the peer disconnects', async () => {
    const gate = createDiagramPresenceGate({ canRead: async () => true, identityForPeer: async () => identity() })
    gate.process(message(), {}, vi.fn())
    await settle()
    const delivered: DiagramPresenceGateMessage[] = []
    gate.disconnect('peer-1', (goodbye) => delivered.push(goodbye))
    expect(delivered).toHaveLength(1)
    expect(decode(delivered[0].data!)).toEqual(expect.objectContaining({
      kind: 'goodbye', sequence: 2, participant: identity(),
    }))
  })
})
