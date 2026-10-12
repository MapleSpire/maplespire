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
import { WORKSPACE_PLACEMENT_CHANNEL } from './workspacePlacement.js'

/** One dedicated LISTEN connection. The reconciliation timer calls connect()
 * to retry a lost connection; this object never creates overlapping checkouts.
 * Notifications only invalidate: the generation-scoped SELECT is authority.
 * The callback is synchronous and must schedule, not await, its refresh.
 *
 * `channel` defaults to the placement channel (placed mode). Hash-mode cells
 * listen on `workspace_version_created` with the same object, so a workspace
 * created on another cell reaches its owner's reconciliation at commit time
 * instead of at the next timer tick (2026-10-11). */
export class PlacementInvalidationListener {
  private client: PoolClient | null = null
  private connecting: Promise<void> | null = null
  private stopping = false
  private stopFlight: Promise<void> | null = null
  private readonly released = new WeakSet<PoolClient>()
  private readonly channel: string
  private readonly invalidateOnConnect: boolean

  constructor(
    private readonly pool: Pool,
    private readonly onInvalidate: () => void,
    private readonly onError: (error: unknown) => void,
    options: {
      channel?: string
      /** Invalidate once after each (re)connect, to cover commits made while
       * disconnected. The version-created listener turns it off: its
       * connect() runs at the start of a reconciliation pass whose own SELECT
       * follows the LISTEN, so there is no blind interval, and the extra pass
       * would only shift every pass-counting assertion by one. */
      invalidateOnConnect?: boolean
    } = {},
  ) {
    this.channel = options.channel ?? WORKSPACE_PLACEMENT_CHANNEL
    this.invalidateOnConnect = options.invalidateOnConnect ?? true
    // LISTEN keeps one checkout until stop. Leave capacity for the SELECT
    // that consumes its invalidation; pg normalizes max on a real Pool.
    const maximum = pool.options?.max
    if (typeof maximum === 'number' && maximum < 2) {
      throw new Error('Workspace placement LISTEN requires a PostgreSQL pool max of at least 2')
    }
  }

  connect(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.connecting) return this.connecting
    if (this.client) return Promise.resolve()
    const running = this.performConnect().finally(() => {
      if (this.connecting === running) this.connecting = null
    })
    this.connecting = running
    return running
  }

  private report(error: unknown): void {
    try { this.onError(error) } catch (observerError) {
      console.error('[placement-invalidation] error observer failed', observerError)
    }
  }

  private invalidate(): void {
    if (this.stopping) return
    try { this.onInvalidate() } catch (error) { this.report(error) }
  }

  private destroy(client: PoolClient, error: Error): void {
    if (this.client === client) this.client = null
    if (this.released.has(client)) return
    this.released.add(client)
    // Destroy, do not return a subscribed or busy connection to the pool.
    // This also terminates a pending LISTEN, whose real promise is joined.
    client.release(error)
  }

  private async performConnect(): Promise<void> {
    const client = await this.pool.connect()
    if (this.stopping) {
      this.destroy(client, new Error('Placement listener stopped during checkout'))
      return
    }
    this.client = client
    // Install error/notification handlers before the first LISTEN await.
    client.on('notification', (message: Notification) => {
      if (this.client === client && message.channel === this.channel) this.invalidate()
    })
    client.on('error', (error: Error) => {
      this.destroy(client, error)
      if (!this.stopping) this.report(error)
    })
    client.on('end', () => {
      if (this.released.has(client)) return
      const error = new Error('Placement LISTEN connection ended')
      this.destroy(client, error)
      if (!this.stopping) this.report(error)
    })
    try {
      await client.query(`LISTEN ${this.channel}`)
      if (this.stopping || this.client !== client) return
      // Also invalidate after reconnect: commits during the disconnected
      // interval had no listener. The next SELECT covers that blind interval.
      if (this.invalidateOnConnect) this.invalidate()
    } catch (error) {
      this.destroy(client, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight
    this.stopping = true
    if (this.client) this.destroy(this.client, new Error('Placement listener stopped'))
    // A checkout already submitted can still return a client. Join it so its
    // stopped branch releases that client before the caller ends the pool.
    this.stopFlight = Promise.resolve(this.connecting).then(() => undefined, () => undefined)
    return this.stopFlight
  }
}
