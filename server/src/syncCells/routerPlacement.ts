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

import type { Pool } from 'pg'
import type { SyncCellPartitionConfig } from './assignment.js'
import { PlacementInvalidationListener } from './placementInvalidation.js'
import { readWorkspacePlacement, StoredPlacementResolver } from './workspacePlacement.js'

interface PlacementListener {
  connect(): Promise<void>
  stop(): Promise<void>
}

/** The router's level read, separate from (synchronous) upgrade admission. NOTIFY is
 * only a hint to repeat this read; the interval also retries LISTEN and covers
 * notifications lost during a connection outage. */
export class RouterPlacementRefresh {
  readonly resolver: StoredPlacementResolver
  private readonly listener: PlacementListener
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private flight: Promise<void> | null = null
  private stopFlight: Promise<void> | null = null
  private dirty = false
  private stopped = false

  constructor(private readonly options: {
    db: Pool
    partition: SyncCellPartitionConfig
    intervalMs?: number
    onPublished: () => Promise<void>
    onError: (error: unknown) => void
    listenerFactory?: (invalidate: () => void, onError: (error: unknown) => void) => PlacementListener
  }) {
    this.intervalMs = options.intervalMs ?? 5_000
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1_000 || this.intervalMs > 300_000) {
      throw new Error('SYNC_CELL_RECONCILE_INTERVAL_MS must be an integer between 1000 and 300000 for the router')
    }
    this.resolver = new StoredPlacementResolver(options.partition.placementMode)
    const invalidate = () => { void this.refresh().catch(options.onError) }
    this.listener = options.listenerFactory?.(invalidate, options.onError)
      ?? (options.partition.placementMode === 'placed'
        ? new PlacementInvalidationListener(options.db, invalidate, options.onError)
        // Shadow still samples on its interval and routes by hash. It does not
        // reserve an authority listener or change the existing pool budget.
        : { connect: async () => {}, stop: async () => {} })
  }

  async start(): Promise<void> {
    if (this.stopped || this.timer) return
    try {
      await this.refresh()
    } catch (error) {
      // A shadow router still routes by its hash. A placed router must not
      // treat a failed first SELECT as a successful empty placement table.
      if (this.options.partition.placementMode === 'placed' && !this.resolver.loaded) throw error
      this.options.onError(error)
    }
    if (this.stopped || this.timer) return
    this.timer = setInterval(() => {
      // A timer faster than a slow database must not keep this flight alive
      // forever. Explicit NOTIFY still sets dirty while the SELECT is pending.
      if (!this.flight) void this.refresh().catch(this.options.onError)
    }, this.intervalMs)
    this.timer.unref?.()
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.dirty = true
    if (this.flight) return this.flight
    // Defer entry until flight has been published: connect can synchronously
    // invalidate as it establishes LISTEN, and must join rather than recurse.
    const running = Promise.resolve().then(() => this.run()).finally(() => {
      if (this.flight === running) this.flight = null
      // Also retain invalidation arriving between run's return and this
      // finalizer's microtask. A rejection itself never schedules a hot retry.
      if (this.dirty && !this.stopped) void this.refresh().catch(this.options.onError)
    })
    this.flight = running
    return running
  }

  private async run(): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false
      // A failed subscription is reported but does not suppress the interval's
      // authoritative SELECT when PostgreSQL can still answer queries.
      await this.listener.connect().catch(this.options.onError)
      if (this.stopped) return
      // Notifications received before this SELECT are covered by this read.
      this.dirty = false
      const rows = await readWorkspacePlacement(this.options.db,
        this.options.partition.topologyGeneration, this.options.partition.partitionCount)
      if (this.stopped) return
      this.resolver.publish(rows)
      await this.options.onPublished()
    }
  }

  stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight
    this.stopped = true
    this.dirty = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Stop destroys the dedicated LISTEN connection and joins its checkout.
    // The separate SELECT and the tunnel recheck are joined as well, before
    // routerMain ends the shared pool. Nothing here claims to cancel that SQL.
    this.stopFlight = Promise.allSettled([Promise.resolve().then(() => this.listener.stop()), this.flight]).then((results) => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'Router placement shutdown failed')
    })
    return this.stopFlight
  }
}
