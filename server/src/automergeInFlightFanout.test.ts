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
import * as A from '@automerge/automerge'
import { encode } from 'cbor-x'

type State = ReturnType<typeof A.initSyncState>
type Wire = { type: string; data: Uint8Array; targetId: string }
interface Hub {
  addPeer(id: string, state: Promise<State>): void
  removePeer(id: string): void
  receiveMessage(message: Record<string, unknown>): void
  syncAllPeers(): void
  on(event: string, listener: (event: Record<string, unknown>) => void): void
}

async function harness() {
  const installed = new URL('../node_modules/@automerge/automerge-repo/dist/synchronizer/DocSynchronizer.js', import.meta.url)
  const { DocSynchronizer } = await import(installed.href) as {
    DocSynchronizer: new (options: Record<string, unknown>) => Hub
  }
  const callbacks: Array<() => void> = []
  vi.stubEnv('AM_SYNC_FANOUT_COALESCE_MS', '0')
  vi.stubEnv('AM_SYNC_FANOUT_BATCH', '1')
  vi.stubGlobal('setImmediate', (callback: () => void) => { callbacks.push(callback) })
  let doc = A.from({ edits: [] as number[] })
  for (let index = 0; index < 12; index++) doc = A.change(doc, d => { d.edits.push(index) })
  let remote = A.init<typeof doc>()
  let remoteState = A.initSyncState()
  const states = new Map<string, State>()
  const generated: string[] = []
  const emitted: State[] = []
  const messages: Wire[] = []
  const listeners = new Map<string, () => void>()
  const queryListeners: Array<() => void> = []
  const activations = new Map<string, () => void>()
  let ephemeralSequence = 0
  const query = {
    sourcePending: vi.fn(), sourceReady: vi.fn(), sourceUnavailable: vi.fn(),
    subscribe: (listener: () => void) => { queryListeners.push(listener) },
    peek: () => ({ state: 'ready' }), shouldDeferAvailability: () => false,
  }
  const hub = new DocSynchronizer({
    handle: {
      documentId: 'inflight-document', fullDoc: () => doc,
      on: (event: string, listener: () => void) => { listeners.set(event, listener) },
      _receiveInboundEphemeral: vi.fn(),
      update: (update: (doc: typeof doc) => typeof doc) => {
        const before = A.getHeads(doc)
        doc = update(doc)
        if (JSON.stringify(before) !== JSON.stringify(A.getHeads(doc))) listeners.get('heads-changed')?.()
      },
    },
    query, networkReady: Promise.resolve(),
    shareConfig: { announce: async () => true, access: async () => true },
  })
  hub.on('sync-state', event => {
    states.set(String(event.peerId), event.syncState as State)
    emitted.push(event.syncState as State)
    activations.get(String(event.peerId))?.()
  })
  hub.on('metrics', event => { if (event.type === 'generate-sync-message') generated.push(String(event.forPeer)) })
  hub.on('message', event => { if (event.type === 'sync' || event.type === 'request') messages.push(event as Wire) })
  const tick = async () => {
    expect(callbacks.length).toBeGreaterThan(0)
    callbacks.shift()!()
    for (let index = 0; index < 4; index++) await Promise.resolve()
  }
  const drain = async () => {
    let turns = 0
    while (callbacks.length) {
      expect(++turns).toBeLessThan(1000)
      await tick()
    }
  }
  const add = async (id: string) => {
    const activated = new Promise<void>(resolve => { activations.set(id, resolve) })
    hub.addPeer(id, Promise.resolve(A.initSyncState()))
    await activated
    await Promise.resolve()
  }
  const receive = (bytes: Uint8Array, id = 'cold') => hub.receiveMessage({
    type: 'sync', senderId: id, documentId: 'inflight-document', data: bytes,
  })
  const deliverToRemote = (message: Wire) => {
    ;[remote, remoteState] = A.receiveSyncMessage(remote, remoteState, message.data)
  }
  const respond = () => {
    const [state, message] = A.generateSyncMessage(remote, remoteState)
    remoteState = state
    if (message) receive(message)
    return message
  }
  const coldMessageInFlight = async () => {
    await add('cold')
    await drain()
    expect(messages).toHaveLength(1)
    deliverToRemote(messages.shift()!)
    expect(respond()).not.toBeNull()
    await drain()
    expect(messages).toHaveLength(1)
    const state = states.get('cold')! as State & { inFlight: boolean; haveResponded: boolean; theirHave: Array<{ lastSync: string[] }> }
    expect(state.inFlight).toBe(true)
    expect(state.haveResponded).toBe(true)
    expect(state.theirHave[0].lastSync).toEqual([])
    expect(A.getHeads(remote)).toEqual([])
    generated.length = 0
    emitted.length = 0
  }
  const settle = async () => {
    for (let round = 0; round < 24; round++) {
      for (const message of messages.splice(0)) {
        expect(message.targetId).toBe('cold')
        deliverToRemote(message)
      }
      const response = respond()
      await drain()
      if (!response && messages.length === 0) {
        expect(A.getHeads(remote)).toEqual(A.getHeads(doc))
        expect(A.toJS(remote)).toEqual(A.toJS(doc))
        expect(A.getMissingDeps(remote, [])).toEqual([])
        return
      }
    }
    throw new Error('real bidirectional protocol did not settle')
  }
  return {
    hub, states, generated, emitted, messages, callbacks, query,
    add, tick, drain, coldMessageInFlight, settle,
    current: () => doc,
    reschedule: () => hub.receiveMessage({ type: 'ephemeral', senderId: 'cold', documentId: 'inflight-document',
      sessionId: 'cursor', count: ++ephemeralSequence, data: encode({ cursor: 1 }) }),
    queryChanged: () => { for (const listener of queryListeners) listener() },
    change: (value: number) => { doc = A.change(doc, d => { d.edits.push(value) }); listeners.get('heads-changed')?.() },
    release: async () => { await drain(); A.free(doc); A.free(remote) },
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('implicit fan-out while a cold peer awaits a reply', () => {
  it('omits only a proven native null without replacing state or inventing metrics, then accepts the real ACK', async () => {
    const h = await harness()
    try {
      await h.coldMessageInFlight()
      const state = h.states.get('cold')!
      const [nativeState, nativeMessage] = A.generateSyncMessage(h.current(), state)
      expect(nativeMessage).toBeNull()
      expect(nativeState).toEqual(state)
      expect(nativeState).not.toBe(state)
      for (let index = 0; index < 5; index++) { h.reschedule(); await h.drain() }
      expect(h.generated).toEqual([])
      expect(h.emitted).toEqual([])
      expect(h.states.get('cold')).toBe(state)
      expect(h.messages).toHaveLength(1)
      await h.settle()
      expect(h.generated.length).toBeGreaterThan(0)
    } finally { await h.release() }
  })

  it.each(['query', 'syncAll'])('preserves explicit dirty priority from %s', async trigger => {
    const h = await harness()
    try {
      await h.coldMessageInFlight()
      const state = h.states.get('cold')
      if (trigger === 'query') h.queryChanged()
      else h.hub.syncAllPeers()
      await h.drain()
      expect(h.generated).toEqual(['cold'])
      expect(h.states.get('cold')).not.toBe(state)
      await h.settle()
    } finally { await h.release() }
  })

  it('sends a new local change before the earlier history message is acknowledged', async () => {
    const h = await harness()
    try {
      await h.coldMessageInFlight()
      h.change(101)
      await h.drain()
      expect(h.generated).toEqual(['cold'])
      expect(h.messages).toHaveLength(2)
      await h.settle()
    } finally { await h.release() }
  })

  it('reads backend changes made after the prepared view during a cooperative yield', async () => {
    const h = await harness()
    try {
      await h.add('first')
      await h.drain()
      h.messages.length = 0
      await h.coldMessageInFlight()
      h.reschedule()
      await h.tick()
      expect(h.generated).toEqual(['first'])
      expect(h.callbacks.length).toBeGreaterThan(0)
      h.change(202)
      await h.tick()
      expect(h.generated).toContain('cold')
      expect(h.messages.filter(message => message.targetId === 'cold')).toHaveLength(2)
      h.hub.removePeer('first')
      await h.drain()
      h.messages.splice(0, h.messages.length, ...h.messages.filter(message => message.targetId === 'cold'))
      await h.settle()
    } finally { await h.release() }
  })

  it.each(['inFlight', 'haveResponded'])('keeps the SDK path when %s is false', async flag => {
    const h = await harness()
    try {
      await h.coldMessageInFlight()
      const state = h.states.get('cold')! as State & Record<string, unknown>
      state[flag] = false
      h.reschedule()
      await h.drain()
      expect(h.generated).toEqual(['cold'])
      await h.settle()
    } finally { await h.release() }
  })

  it('preserves a native reset for an unknown first lastSync despite inFlight', async () => {
    const h = await harness()
    const other = A.from({ unrelated: true })
    try {
      await h.coldMessageInFlight()
      const state = h.states.get('cold')! as State & { theirHave: Array<{ lastSync: string[] }> }
      state.theirHave[0].lastSync = A.getHeads(other)
      const [, nativeReset] = A.generateSyncMessage(h.current(), state)
      expect(nativeReset).not.toBeNull()
      h.reschedule()
      await h.drain()
      expect(h.generated).toEqual(['cold'])
      expect(h.messages.at(-1)!.data).toEqual(nativeReset)
      const reset = A.decodeSyncMessage(h.messages.at(-1)!.data)
      expect(reset.changes).toHaveLength(0)
      expect(reset.have[0].lastSync).toEqual([])
      await h.settle()
    } finally { await h.release(); A.free(other) }
  })

  it('does not confuse an isolated backend view with its complete sync heads', async () => {
    const h = await harness()
    try {
      await h.coldMessageInFlight()
      const sentHeads = A.getHeads(h.current())
      h.change(303)
      expect(() => A.changeAt(h.current(), sentHeads, () => { throw new Error('leave native isolation') }))
        .toThrow('leave native isolation')
      expect(A.getBackend(h.current()).getHeads()).toEqual(sentHeads)
      expect(A.getChangesMetaSince(h.current(), sentHeads)).toHaveLength(1)
      await h.drain()
      expect(h.generated).toEqual(['cold'])
      expect(h.messages).toHaveLength(2)
      A.getBackend(h.current()).integrate()
      await h.settle()
    } finally { A.getBackend(h.current()).integrate(); await h.release() }
  })
})
