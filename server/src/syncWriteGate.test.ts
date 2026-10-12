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

import { describe, it, expect, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { createSyncWriteGate, messageCarriesChanges, throttledOnce, type GateMessage } from './syncWriteGate.js'

/**
 * SECURITY regression suite for the sync write gate (the "View-grant user can
 * edit any diagram" defect): automerge-repo applies inbound changes from any
 * peer its read gate serves, so this gate is the ONLY thing standing between
 * a read-only session and a persisted edit. Covers the payload classifier
 * (change-carrying vs handshake), the off/dual/on stage semantics, fail-closed
 * behavior on broken checks/payloads, and per-socket ordering.
 *
 * Real Automerge sync payloads are used throughout — a fabricated `changes`
 * array would not prove `decodeSyncMessage` interop.
 */

/** Pump a real two-peer Automerge sync until we hold BOTH a change-free
 * handshake payload and a change-carrying payload. */
function realSyncPayloads(): { carrying: Uint8Array; handshake: Uint8Array } {
  let a = A.from({ title: 'secured' })
  let b = A.init<{ title: string }>()
  let sa = A.initSyncState()
  let sb = A.initSyncState()
  let carrying: Uint8Array | null = null
  let handshake: Uint8Array | null = null

  for (let round = 0; round < 20 && (!carrying || !handshake); round++) {
    let msg: Uint8Array | null
    ;[sa, msg] = A.generateSyncMessage(a, sa)
    if (msg) {
      if (A.decodeSyncMessage(msg).changes.length > 0) carrying ??= msg
      else handshake ??= msg
      ;[b, sb] = A.receiveSyncMessage(b, sb, msg)
    }
    ;[sb, msg] = A.generateSyncMessage(b, sb)
    if (msg) {
      if (A.decodeSyncMessage(msg).changes.length > 0) carrying ??= msg
      else handshake ??= msg
      ;[a, sa] = A.receiveSyncMessage(a, sa, msg)
    }
  }
  if (!carrying || !handshake) throw new Error('sync pump never produced both payload kinds')
  return { carrying, handshake }
}

const { carrying, handshake } = realSyncPayloads()

function syncMsg(over: Partial<GateMessage> = {}): GateMessage {
  return { type: 'sync', senderId: 'peer-1', documentId: 'doc-1', data: carrying, ...over }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await tick()
}

describe('messageCarriesChanges — payload classifier', () => {
  it('detects a real change-carrying sync payload', () => {
    expect(messageCarriesChanges(syncMsg())).toBe(true)
  })

  it('passes a real change-free handshake payload', () => {
    expect(messageCarriesChanges(syncMsg({ data: handshake }))).toBe(false)
  })

  it('same classification for request messages (they carry the same payload shape)', () => {
    expect(messageCarriesChanges(syncMsg({ type: 'request' }))).toBe(true)
    expect(messageCarriesChanges(syncMsg({ type: 'request', data: handshake }))).toBe(false)
  })

  it('non-doc message types are never writes', () => {
    expect(messageCarriesChanges({ type: 'ephemeral', senderId: 'p', documentId: 'doc-1', data: carrying })).toBe(false)
    expect(messageCarriesChanges({ type: 'join', senderId: 'p' })).toBe(false)
  })

  it('empty/absent payload is not a write', () => {
    expect(messageCarriesChanges(syncMsg({ data: undefined }))).toBe(false)
    expect(messageCarriesChanges(syncMsg({ data: new Uint8Array(0) }))).toBe(false)
  })

  it('an UNDECODABLE payload counts as a write attempt (fail closed)', () => {
    expect(messageCarriesChanges(syncMsg({ data: new Uint8Array([1, 2, 3, 4, 5]) }))).toBe(true)
  })
})

describe('createSyncWriteGate — stage/permission matrix', () => {
  function makeGate(opts: {
    stage?: () => 'off' | 'dual' | 'on'
    canWrite?: (peerId: string, documentId: string) => Promise<boolean>
    onDenied?: (info: { peerId: string; documentId: string; enforced: boolean }) => void
  }) {
    return createSyncWriteGate({
      stage: opts.stage ?? (() => 'on'),
      canWrite: opts.canWrite ?? (async () => false),
      onDenied: opts.onDenied,
    })
  }

  it("stage 'off': delivers without consulting the write check", async () => {
    const canWrite = vi.fn(async () => false)
    const gate = makeGate({ stage: () => 'off', canWrite })
    const deliver = vi.fn()
    gate.process(syncMsg(), {}, deliver)
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(canWrite).not.toHaveBeenCalled()
  })

  it('non-doc messages (join/leave/ephemeral) always deliver synchronously', () => {
    const gate = makeGate({})
    const deliver = vi.fn()
    gate.process({ type: 'ephemeral', senderId: 'p', documentId: 'doc-1', data: carrying }, {}, deliver)
    gate.process({ type: 'leave', senderId: 'p' }, {}, deliver)
    expect(deliver).toHaveBeenCalledTimes(2) // no async hop for these
  })

  it('a WRITABLE peer’s change-carrying message is delivered', async () => {
    const gate = makeGate({ canWrite: async () => true })
    const deliver = vi.fn()
    gate.process(syncMsg(), {}, deliver)
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('a read-only peer’s HANDSHAKE message is delivered (reads stay alive)', async () => {
    const onDenied = vi.fn()
    const gate = makeGate({ canWrite: async () => false, onDenied })
    const deliver = vi.fn()
    gate.process(syncMsg({ data: handshake }), {}, deliver)
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(onDenied).not.toHaveBeenCalled()
  })

  it("THE DEFECT: a read-only peer’s change-carrying message is DROPPED at stage 'on'", async () => {
    const onDenied = vi.fn()
    const gate = makeGate({ canWrite: async () => false, onDenied })
    const deliver = vi.fn()
    gate.process(syncMsg(), {}, deliver)
    await settle()
    expect(deliver).not.toHaveBeenCalled()
    expect(onDenied).toHaveBeenCalledWith({ peerId: 'peer-1', documentId: 'doc-1', enforced: true })
  })

  it("stage 'dual': the same write is logged (enforced:false) but DELIVERED", async () => {
    const onDenied = vi.fn()
    const gate = makeGate({ stage: () => 'dual', canWrite: async () => false, onDenied })
    const deliver = vi.fn()
    gate.process(syncMsg(), {}, deliver)
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(onDenied).toHaveBeenCalledWith({ peerId: 'peer-1', documentId: 'doc-1', enforced: false })
  })

  it('request messages are gated identically to sync messages', async () => {
    const gate = makeGate({ canWrite: async () => false })
    const deliver = vi.fn()
    gate.process(syncMsg({ type: 'request' }), {}, deliver)
    await settle()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('a BROKEN write check fails closed for writes but keeps reads alive', async () => {
    const gate = makeGate({
      canWrite: async () => {
        throw new Error('db down')
      },
    })
    const deliverWrite = vi.fn()
    const deliverRead = vi.fn()
    gate.process(syncMsg(), {}, deliverWrite)
    gate.process(syncMsg({ data: handshake, documentId: 'doc-2' }), {}, deliverRead)
    await settle()
    expect(deliverWrite).not.toHaveBeenCalled()
    expect(deliverRead).toHaveBeenCalledTimes(1)
  })

  it('an UNDECODABLE payload from a read-only peer is dropped (fail closed)', async () => {
    const gate = makeGate({ canWrite: async () => false })
    const deliver = vi.fn()
    gate.process(syncMsg({ data: new Uint8Array([9, 9, 9]) }), {}, deliver)
    await settle()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('a runtime stage flip takes effect immediately (off -> on)', async () => {
    let stage: 'off' | 'dual' | 'on' = 'off'
    const gate = makeGate({ stage: () => stage, canWrite: async () => false })
    const first = vi.fn()
    const second = vi.fn()
    gate.process(syncMsg(), {}, first)
    await settle()
    expect(first).toHaveBeenCalledTimes(1) // off: passed through
    stage = 'on'
    gate.process(syncMsg(), {}, second)
    await settle()
    expect(second).not.toHaveBeenCalled() // on: dropped
  })

  it('per-socket FIFO: delivery order matches arrival order across the async check', async () => {
    const resolvers: Array<(v: boolean) => void> = []
    const gate = makeGate({
      canWrite: () => new Promise<boolean>((resolve) => resolvers.push(resolve)),
    })
    const delivered: string[] = []
    const socket = {}
    gate.process(syncMsg({ documentId: 'doc-A' }), socket, () => delivered.push('A'))
    gate.process(syncMsg({ documentId: 'doc-B' }), socket, () => delivered.push('B'))
    await settle()
    // The chain serializes: B's check must not even start until A's resolved.
    expect(resolvers).toHaveLength(1)
    expect(delivered).toEqual([])
    resolvers[0](true)
    await settle()
    expect(delivered).toEqual(['A'])
    expect(resolvers).toHaveLength(2)
    resolvers[1](true)
    await settle()
    expect(delivered).toEqual(['A', 'B'])
  })

  it('sockets do not share a queue: a slow check on one socket never stalls another', async () => {
    let releaseSlow: ((v: boolean) => void) | null = null
    const gate = makeGate({
      canWrite: (peerId) =>
        peerId === 'slow'
          ? new Promise<boolean>((resolve) => {
              releaseSlow = resolve
            })
          : Promise.resolve(true),
    })
    const delivered: string[] = []
    gate.process(syncMsg({ senderId: 'slow', documentId: 'doc-A' }), { s: 1 }, () => delivered.push('slow'))
    gate.process(syncMsg({ senderId: 'fast', documentId: 'doc-B' }), { s: 2 }, () => delivered.push('fast'))
    await settle()
    expect(delivered).toEqual(['fast'])
    releaseSlow!(true)
    await settle()
    expect(delivered).toEqual(['fast', 'slow'])
  })
})

describe('throttledOnce — the denial/fault log throttle (N8)', () => {
  // Times are absolute clock values ≥ one window: like the production inline
  // pattern it generalises, an unseen key reads as `seenAt 0`, so the epoch's
  // first minute is the one place a first sight could be suppressed — real
  // Date.now() can never be there.
  it('emits exactly ONE log per (key, window): spam AND silence both fall', () => {
    const seenAt = new Map<string, number>()
    // First sight of a key logs — an always-false throttle (silence) fails
    // here: it would hide the only visible trace of a refused write.
    expect(throttledOnce(seenAt, 'peer/doc', 60_000, 100_000)).toBe(true)
    // Repeats inside the window stay quiet — an always-true throttle (spam)
    // fails here: a stale client re-offers the same change every sync round,
    // and one line per message is noise burying signal.
    expect(throttledOnce(seenAt, 'peer/doc', 60_000, 100_001)).toBe(false)
    expect(throttledOnce(seenAt, 'peer/doc', 60_000, 159_999)).toBe(false)
    // A DIFFERENT key is its own window: the throttle is per (peer, doc)
    // subject, never a global mute.
    expect(throttledOnce(seenAt, 'peer/other-doc', 60_000, 100_002)).toBe(true)
    // Once the window rolls over, the key logs again — a persistent refusal
    // keeps a heartbeat in the logs instead of vanishing after line one.
    expect(throttledOnce(seenAt, 'peer/doc', 60_000, 160_000)).toBe(true)
    expect(throttledOnce(seenAt, 'peer/doc', 60_000, 160_001)).toBe(false)
  })

  it('is bounded: overflowing the map clears wholesale and keeps answering', () => {
    const seenAt = new Map<string, number>()
    for (let i = 0; i < 1_001; i += 1) throttledOnce(seenAt, `key-${i}`, 60_000, 100_000)
    // The 1_002nd distinct key crosses the bound: wholesale clear, then the
    // newcomer is recorded — it is only a throttle, losing it costs one
    // extra log line, never unbounded growth.
    expect(throttledOnce(seenAt, 'key-overflow', 60_000, 100_000)).toBe(true)
    expect(seenAt.size).toBe(1)
  })
})
