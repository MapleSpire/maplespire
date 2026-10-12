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

import { describe, expect, it, vi } from 'vitest'
import { FairInboundQueue, inboundFrameBatchSize } from './fairInboundQueue.js'

describe('FairInboundQueue', () => {
  it('yields between bounded batches and rotates across sockets', () => {
    const callbacks: Array<() => void> = []
    const received: string[] = []
    const socketA = {}
    const socketB = {}
    const queue = new FairInboundQueue<object, string>(
      2,
      (item) => received.push(item),
      () => true,
      (callback) => callbacks.push(callback),
    )

    queue.enqueue(socketA, 'a1')
    queue.enqueue(socketA, 'a2')
    queue.enqueue(socketA, 'a3')
    queue.enqueue(socketB, 'b1')
    queue.enqueue(socketB, 'b2')

    expect(callbacks).toHaveLength(1)
    callbacks.shift()?.()
    expect(received).toEqual(['a1', 'b1'])
    expect(queue.snapshot()).toMatchObject({ activeKeys: 2, queuedItems: 3, maxQueueDepth: 5 })
    expect(callbacks).toHaveLength(1)

    callbacks.shift()?.()
    expect(received).toEqual(['a1', 'b1', 'a2', 'b2'])
    callbacks.shift()?.()
    expect(received).toEqual(['a1', 'b1', 'a2', 'b2', 'a3'])
    expect(queue.snapshot()).toMatchObject({ activeKeys: 0, queuedItems: 0 })
  })

  it('discards delayed work for a socket that closed before its turn', () => {
    const callbacks: Array<() => void> = []
    const process = vi.fn()
    const socket = { active: true }
    const queue = new FairInboundQueue<typeof socket, string>(
      1,
      process,
      (key) => key.active,
      (callback) => callbacks.push(callback),
    )

    queue.enqueue(socket, 'frame')
    socket.active = false
    callbacks.shift()?.()

    expect(process).not.toHaveBeenCalled()
    expect(queue.snapshot()).toMatchObject({ activeKeys: 0, queuedItems: 0 })
  })

  it('bounds the deployment setting and defaults to one frame per turn', () => {
    expect(inboundFrameBatchSize({})).toBe(1)
    expect(inboundFrameBatchSize({ AM_INBOUND_FRAME_BATCH: '0' })).toBe(1)
    expect(inboundFrameBatchSize({ AM_INBOUND_FRAME_BATCH: '500' })).toBe(64)
    expect(inboundFrameBatchSize({ AM_INBOUND_FRAME_BATCH: '8.9' })).toBe(8)
  })
})
