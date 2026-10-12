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

import { performance } from 'node:perf_hooks'
import type { SyncCellOwnerRoute } from './ownership.js'
import { MAX_TOPOLOGY_PARTITIONS } from './topologyContract.js'

export interface OwnerRouteMapConfig {
  enabled: boolean
  refreshMs: number
  maxAgeMs: number
}

export function ownerRouteMapConfig(env: Readonly<Record<string, string | undefined>> = process.env): OwnerRouteMapConfig {
  const integer = (value: string | undefined, fallback: number, minimum: number, maximum: number): number => {
    const number = Number(value)
    return Number.isSafeInteger(number) && number >= minimum ? Math.min(number, maximum) : fallback
  }
  const refreshMs = integer(env.SYNC_CELL_ROUTE_MAP_REFRESH_MS, 1000, 50, 60_000)
  return {
    enabled: env.SYNC_CELL_ROUTE_MAP !== 'off',
    refreshMs,
    maxAgeMs: integer(env.SYNC_CELL_ROUTE_MAP_MAX_AGE_MS, Math.max(3000, refreshMs * 3), refreshMs, 300_000),
  }
}

export interface OwnerRouteMapSnapshot {
  enabled: boolean
  usable: boolean
  sampledAt: string | null
  sampleAgeMs: number | null
  sampleSequence: number
  entries: number
  refreshMs: number
  maxAgeMs: number
  refreshInFlight: boolean
  refreshCount: number
  refreshErrorCount: number
}

/** Routing hints only. Authority stays with the owner and its durable fence. */
export class OwnerRouteMap {
  private routes = new Map<number, SyncCellOwnerRoute>()
  private sampleStartedAt: number | null = null
  private sampledAt: string | null = null
  private sequence = 0
  private refreshCount = 0
  private refreshErrorCount = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private flight: Promise<void> | null = null
  private startFlight: Promise<void> | null = null
  private stopping = false

  constructor(
    private readonly load: () => Promise<ReadonlyMap<number, SyncCellOwnerRoute>>,
    private readonly config: OwnerRouteMapConfig,
    private readonly onError: (error: unknown) => void,
    private readonly clock: () => number = () => performance.now(),
    private readonly wallClock: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(config.refreshMs) || config.refreshMs <= 0
      || !Number.isSafeInteger(config.maxAgeMs) || config.maxAgeMs < config.refreshMs) {
      throw new Error('Invalid owner-route map refresh or maximum age')
    }
  }

  start(): Promise<void> {
    if (this.startFlight) return this.startFlight
    if (this.stopping || !this.config.enabled) return Promise.resolve()
    this.startFlight = this.begin()
    return this.startFlight
  }

  private async begin(): Promise<void> {
    await this.refresh()
    if (this.stopping) return
    this.timer = setInterval(() => { void this.refresh() }, this.config.refreshMs)
    this.timer.unref?.()
  }

  private refresh(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.flight) return this.flight
    const running = Promise.resolve().then(async () => {
      if (this.stopping) return
      // The age includes time spent awaiting Redis. A slow response cannot
      // reset the age of an old observation merely by arriving now.
      const startedAt = this.clock()
      const sampledAt = new Date(this.wallClock()).toISOString()
      this.refreshCount += 1
      try {
        const routes = await this.load()
        if (this.stopping) return
        if (routes.size > MAX_TOPOLOGY_PARTITIONS) throw new Error('Owner-route map exceeds partition bound')
        const replacement = new Map<number, SyncCellOwnerRoute>()
        for (const [partition, route] of routes) {
          if (!Number.isSafeInteger(partition) || partition < 0 || partition >= MAX_TOPOLOGY_PARTITIONS
            || route.partition !== partition) throw new Error('Invalid owner-route map partition')
          replacement.set(partition, { ...route })
        }
        this.routes = replacement
        this.sampleStartedAt = startedAt
        this.sampledAt = sampledAt
        this.sequence += 1
      } catch (error) {
        this.refreshErrorCount += 1
        this.onError(error)
      }
    }).finally(() => {
      if (this.flight === running) this.flight = null
    })
    this.flight = running
    return running
  }

  readSnapshot(): OwnerRouteMapSnapshot {
    const age = this.sampleStartedAt === null ? null : this.clock() - this.sampleStartedAt
    return {
      enabled: this.config.enabled,
      usable: this.config.enabled && !this.stopping && age !== null && Number.isFinite(age)
        && age >= 0 && age < this.config.maxAgeMs,
      sampledAt: this.sampledAt,
      sampleAgeMs: age,
      sampleSequence: this.sequence,
      entries: this.routes.size,
      refreshMs: this.config.refreshMs,
      maxAgeMs: this.config.maxAgeMs,
      refreshInFlight: this.flight !== null,
      refreshCount: this.refreshCount,
      refreshErrorCount: this.refreshErrorCount,
    }
  }

  resolve(partition: number): SyncCellOwnerRoute | null {
    if (!this.readSnapshot().usable) return null
    const route = this.routes.get(partition)
    return route ? { ...route } : null
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Join the real read, including when stop races the initial sample. A
    // timeout on the caller does not constitute settlement of this promise.
    await this.flight
    await this.startFlight
    this.routes.clear()
  }
}
