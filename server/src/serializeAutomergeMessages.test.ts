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

import { describe, expect, it } from 'vitest'
import { serializeAutomergeDocumentMessages } from './serializeAutomergeMessages.js'

describe('serializeAutomergeDocumentMessages', () => {
  it('leaves the synchronous 2.6 state-machine receive path direct', () => {
    const received: string[] = []
    const synchronizer = {
      receiveMessage(message: { documentId?: string; id: string }): void {
        received.push(message.id)
      },
    }
    const original = synchronizer.receiveMessage
    const queue = serializeAutomergeDocumentMessages(synchronizer)

    synchronizer.receiveMessage({ documentId: 'a', id: 'a1' })
    expect(received).toEqual(['a1'])
    expect(synchronizer.receiveMessage).toBe(original)
    expect(queue.snapshot()).toEqual({ activeDocuments: 0, queuedMessages: 0, maxQueueDepth: 0 })
  })

  it('serializes one document while allowing different documents to overlap', async () => {
    const entered: string[] = []
    const releases = new Map<string, () => void>()
    const synchronizer = {
      async receiveMessage(message: { documentId?: string; id: string }): Promise<void> {
        entered.push(message.id)
        await new Promise<void>((resolve) => releases.set(message.id, resolve))
      },
    }
    const queue = serializeAutomergeDocumentMessages(synchronizer)

    const a1 = synchronizer.receiveMessage({ documentId: 'a', id: 'a1' })
    const a2 = synchronizer.receiveMessage({ documentId: 'a', id: 'a2' })
    const b1 = synchronizer.receiveMessage({ documentId: 'b', id: 'b1' })
    await Promise.resolve()
    await Promise.resolve()
    expect(entered).toEqual(['a1', 'b1'])
    expect(queue.snapshot()).toMatchObject({ activeDocuments: 2, queuedMessages: 3, maxQueueDepth: 2 })

    releases.get('a1')?.()
    await a1
    await Promise.resolve()
    expect(entered).toEqual(['a1', 'b1', 'a2'])
    releases.get('a2')?.()
    releases.get('b1')?.()
    await Promise.all([a2, b1])
    expect(queue.snapshot()).toMatchObject({ activeDocuments: 0, queuedMessages: 0 })
  })

  it('continues after a failed message', async () => {
    const entered: string[] = []
    const synchronizer = {
      async receiveMessage(message: { documentId?: string; id: string }): Promise<void> {
        entered.push(message.id)
        if (message.id === 'bad') throw new Error('bad message')
      },
    }
    serializeAutomergeDocumentMessages(synchronizer)
    const bad = synchronizer.receiveMessage({ documentId: 'a', id: 'bad' })
    const good = synchronizer.receiveMessage({ documentId: 'a', id: 'good' })
    await expect(bad).rejects.toThrow('bad message')
    await expect(good).resolves.toBeUndefined()
    expect(entered).toEqual(['bad', 'good'])
  })

})
