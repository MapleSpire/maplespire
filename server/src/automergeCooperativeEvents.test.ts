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

interface Hub {
  addPeer(id: string, state: Promise<ReturnType<typeof A.initSyncState>>): void
  removePeer(id: string): void
  hasPeer(id: string): boolean
  receiveMessage(message: Record<string, unknown>): void
  reevaluateSharePolicy(): void
  syncAllPeers(): void
  on(event: string, callback: (event: Record<string, unknown>) => void): void
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
  let document = A.from({ title: 'cooperative events', value: 0 })
  const listeners = new Map<string, () => void>()
  const queryListeners = new Set<() => void>()
  const generated: string[] = []
  const messages: Record<string, unknown>[] = []
  const activated = new Map<string, () => void>()
  const policyResolved: string[] = []
  const denied = new Set<string>()
  let markNetworkReady!: () => void
  const networkReady = new Promise<void>(resolve => { markNetworkReady = resolve })
  const query = {
    sourcePending: vi.fn(), sourceReady: vi.fn(), sourceUnavailable: vi.fn(),
    subscribe: (listener: () => void) => { queryListeners.add(listener) },
    peek: () => ({ state: 'ready' }), shouldDeferAvailability: () => false,
  }
  const hub = new DocSynchronizer({
    handle: {
      documentId: 'cooperative-document',
      fullDoc: () => document,
      on: (event: string, listener: () => void) => { listeners.set(event, listener) },
      _receiveInboundEphemeral: vi.fn(),
      update: (update: (doc: typeof document) => typeof document) => {
        const before = A.getHeads(document)
        document = update(document)
        if (JSON.stringify(before) !== JSON.stringify(A.getHeads(document))) listeners.get('heads-changed')?.()
      },
    },
    query, networkReady,
    shareConfig: {
      announce: async (peer: string) => !denied.has(peer),
      access: async (peer: string) => { policyResolved.push(peer); return !denied.has(peer) },
    },
  })
  hub.on('sync-state', event => { activated.get(String(event.peerId))?.() })
  hub.on('metrics', event => { if (event.type === 'generate-sync-message') generated.push(String(event.forPeer)) })
  hub.on('message', event => messages.push(event))
  const add = async (id: string) => {
    const ready = new Promise<void>(resolve => { activated.set(id, resolve) })
    hub.addPeer(id, Promise.resolve(A.initSyncState()))
    await ready
    // Activation emits sync-state before it marks the peer dirty / schedules.
    await Promise.resolve()
  }
  const tick = async () => {
    expect(callbacks.length, 'a real scheduler callback must be queued').toBeGreaterThan(0)
    callbacks.shift()!()
    await Promise.resolve()
    await Promise.resolve()
  }
  const drain = async () => {
    let turns = 0
    while (callbacks.length) {
      expect(++turns).toBeLessThan(1000)
      await tick()
    }
  }
  const settlePromises = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  return {
    hub, query, generated, messages, callbacks, denied, policyResolved,
    add, tick, drain, settlePromises, markNetworkReady,
    queryChanged: () => { for (const listener of queryListeners) listener() },
    release: async () => { await drain(); A.free(document) },
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('all synchronizer event entries preserve cooperative fan-out', () => {
  const events = ['network-ready', 'remove-peer', 'doc-unavailable', 'ephemeral', 'policy', 'explicit-sync', 'denied-activation']
  it.each(events.flatMap(entry => [
    { entry, queue: 'pending' }, { entry, queue: 'idle' },
  ]))(
    '$entry queues cooperative evaluation with an initially $queue scheduler', async ({ entry, queue }) => {
      const h = await harness()
      try {
        for (const id of ['one', 'two', 'three', 'four']) await h.add(id)
        if (queue === 'idle') {
          await h.drain()
          expect(h.callbacks).toHaveLength(0)
          h.generated.length = 0
        }
        expect(h.generated).toEqual([])
        switch (entry) {
          case 'network-ready': h.markNetworkReady(); break
          case 'remove-peer': h.hub.removePeer('four'); expect(h.hub.hasPeer('four')).toBe(false); break
          case 'doc-unavailable': h.hub.receiveMessage({ type: 'doc-unavailable', senderId: 'four', documentId: 'cooperative-document' }); break
          case 'ephemeral': h.hub.receiveMessage({ type: 'ephemeral', senderId: 'four', documentId: 'cooperative-document', sessionId: 'session', count: 1, data: encode({ cursor: 1 }) }); break
          case 'policy': h.denied.add('four'); h.hub.reevaluateSharePolicy(); break
          case 'explicit-sync': h.hub.syncAllPeers(); break
          case 'denied-activation': h.denied.add('denied'); await h.add('denied'); break
        }
        await h.settlePromises()
        expect(h.generated, 'the entry point must return before protocol generation').toEqual([])
        await h.tick()
        expect(h.generated).toEqual(['one'])
        expect(h.callbacks.length, 'remaining peers yield to another turn').toBeGreaterThan(0)
        await h.drain()
        expect(new Set(h.generated)).toEqual(new Set(entry === 'remove-peer' || entry === 'policy'
          ? ['one', 'two', 'three'] : ['one', 'two', 'three', 'four']))
        expect(h.generated).not.toContain('denied')
      } finally { await h.release() }
    },
  )

  it('removal during a yielded pass stays immediate and never sends to the removed peer', async () => {
    const h = await harness()
    try {
      for (const id of ['one', 'two', 'three', 'four']) await h.add(id)
      await h.tick()
      expect(h.generated).toEqual(['one'])
      h.hub.removePeer('three')
      expect(h.hub.hasPeer('three')).toBe(false)
      expect(h.generated).toEqual(['one'])
      await h.drain()
      expect(new Set(h.generated)).toEqual(new Set(['one', 'two', 'four']))
      expect(h.messages.filter(message => message.targetId === 'three')).toEqual([])
    } finally { await h.release() }
  })

  it('finalizes availability for an empty peer set and subsequently activates a new peer', async () => {
    const h = await harness()
    try {
      await h.add('one')
      h.markNetworkReady()
      await h.settlePromises()
      h.hub.removePeer('one')
      expect(h.query.sourceUnavailable).not.toHaveBeenCalled()
      await h.drain()
      expect(h.query.sourceUnavailable).toHaveBeenCalledWith('automerge-sync')
      expect(h.generated).toEqual([])
      await h.add('later')
      await h.drain()
      expect(h.generated).toEqual(['later'])
    } finally { await h.release() }
  })
})
