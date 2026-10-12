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

import type { Notification, Pool, PoolClient } from 'pg'
import { READ_MODEL_CHANGE_CHANNEL } from './changeFeed.js'
import type { WorkspaceKey } from './projector.js'

export interface ReadModelChangeNotification extends WorkspaceKey {
  generation: number
}

type ChangeListener = (event: ReadModelChangeNotification) => void

function keyOf(key: WorkspaceKey): string {
  return `${key.landscapeId}\u0000${key.versionId}`
}

export function parseReadModelChangeNotification(payload: string | undefined): ReadModelChangeNotification | null {
  if (!payload) return null
  try {
    const value = JSON.parse(payload) as Partial<ReadModelChangeNotification>
    if (
      typeof value.landscapeId !== 'string'
      || typeof value.versionId !== 'string'
      || !Number.isSafeInteger(value.generation)
      || Number(value.generation) < 0
    ) return null
    return {
      landscapeId: value.landscapeId,
      versionId: value.versionId,
      generation: Number(value.generation),
    }
  } catch {
    return null
  }
}

/** One PostgreSQL LISTEN connection per server process, fanned out to every SSE
 * response in memory. Notifications may be missed during a DB/network outage;
 * correctness comes from replaying read_model_change_events, not from this hub. */
export class ReadModelChangeNotificationHub {
  private readonly listeners = new Map<string, Set<ChangeListener>>()
  private client: PoolClient | null = null
  private connecting: Promise<void> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(private readonly pool: Pool) {}

  start(): Promise<void> {
    if (this.client) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.stopped = false
    this.connecting = this.connect()
      .catch((error) => {
        this.scheduleReconnect()
        throw error
      })
      .finally(() => { this.connecting = null })
    return this.connecting
  }

  subscribe(key: WorkspaceKey, listener: ChangeListener): () => void {
    const workspace = keyOf(key)
    const set = this.listeners.get(workspace) ?? new Set<ChangeListener>()
    set.add(listener)
    this.listeners.set(workspace, set)
    void this.start().catch((error) => {
      console.warn('[read-model-events] LISTEN unavailable; durable polling remains active', error)
      this.scheduleReconnect()
    })
    return () => {
      set.delete(listener)
      if (!set.size) this.listeners.delete(workspace)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    await this.connecting?.catch(() => undefined)
    const client = this.client
    this.client = null
    if (!client) return
    client.removeAllListeners('notification')
    client.removeAllListeners('error')
    await client.query(`UNLISTEN ${READ_MODEL_CHANGE_CHANNEL}`).catch(() => undefined)
    client.release()
  }

  private async connect(): Promise<void> {
    let candidate: PoolClient | null = null
    try {
      candidate = await this.pool.connect()
      if (this.stopped) {
        candidate.release()
        return
      }
      await candidate.query(`LISTEN ${READ_MODEL_CHANGE_CHANNEL}`)
      candidate.on('notification', this.onNotification)
      candidate.once('error', () => this.dropAndReconnect(candidate!))
      this.client = candidate
    } catch (error) {
      candidate?.release(true)
      throw error
    }
  }

  private readonly onNotification = (notification: Notification): void => {
    if (notification.channel !== READ_MODEL_CHANGE_CHANNEL) return
    const event = parseReadModelChangeNotification(notification.payload)
    if (!event) return
    for (const listener of this.listeners.get(keyOf(event)) ?? []) {
      try {
        listener(event)
      } catch (error) {
        console.warn('[read-model-events] subscriber failed', error)
      }
    }
  }

  private dropAndReconnect(client: PoolClient): void {
    if (this.client !== client) return
    this.client = null
    client.removeAllListeners('notification')
    client.release(true)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.start().catch((error) => {
        console.warn('[read-model-events] LISTEN reconnect failed', error)
        this.scheduleReconnect()
      })
    }, 1_000)
    this.reconnectTimer.unref()
  }
}
