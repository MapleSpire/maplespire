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

export type ImmediateScheduler = (callback: () => void) => void

export interface FairInboundQueueSnapshot {
  activeKeys: number
  queuedItems: number
  maxQueueDepth: number
}

/**
 * Drains inbound work in bounded, round-robin batches. Node's ws package may
 * deliver many frames from one poll callback; forwarding all of them directly
 * to Automerge keeps the event loop inside one synchronous burst even when
 * every individual receive is fast.
 */
export class FairInboundQueue<K extends object, V> {
  private readonly queues = new Map<K, V[]>()
  private readonly readyKeys: K[] = []
  private scheduled = false
  private queuedItems = 0
  private maxQueueDepth = 0

  constructor(
    private readonly batchSize: number,
    private readonly process: (item: V, key: K) => void,
    private readonly isActive: (key: K) => boolean,
    private readonly schedule: ImmediateScheduler = (callback) => setImmediate(callback),
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error('FairInboundQueue batchSize must be a positive integer')
    }
  }

  enqueue(key: K, item: V): void {
    const existing = this.queues.get(key)
    if (existing) {
      existing.push(item)
    } else {
      this.queues.set(key, [item])
      this.readyKeys.push(key)
    }
    this.queuedItems += 1
    this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queuedItems)
    this.scheduleDrain()
  }

  snapshot(): FairInboundQueueSnapshot {
    return {
      activeKeys: this.queues.size,
      queuedItems: this.queuedItems,
      maxQueueDepth: this.maxQueueDepth,
    }
  }

  private scheduleDrain(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => this.drain())
  }

  private drain(): void {
    this.scheduled = false
    let visited = 0
    while (visited < this.batchSize && this.readyKeys.length > 0) {
      const key = this.readyKeys.shift()!
      const queue = this.queues.get(key)
      if (!queue || queue.length === 0) continue

      const item = queue.shift()!
      this.queuedItems -= 1
      if (queue.length > 0) this.readyKeys.push(key)
      else this.queues.delete(key)

      if (this.isActive(key)) this.process(item, key)
      visited += 1
    }
    if (this.readyKeys.length > 0) this.scheduleDrain()
  }
}

export function inboundFrameBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.AM_INBOUND_FRAME_BATCH)
  // One Automerge frame can synchronously decode, merge, and advance several
  // peer states. Processing more than one per turn made a 50-client reconnect
  // burst exceed the 100 ms event-loop SLO even though each frame stayed fast.
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(64, Math.trunc(configured)))
    : 1
}
