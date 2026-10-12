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

export type WriteKind = 'normal' | 'placement'

export interface PlacementWriteSchedulerOptions {
  normalTrailingMs?: number
  trailingMs?: number
  minIntervalMs?: number
  maxWaitMs?: number
}

/**
 * Bounded trailing scheduler for durable placement writes.
 *
 * Repeated placements postpone the trailing edge, but never beyond maxWait.
 * Once a write has run, minInterval caps the publication rate. Normal durable
 * edits keep the bridge's short debounce and may intentionally flush a pending
 * placement early so one DiagramDoc change contains a coherent snapshot.
 */
export class PlacementWriteScheduler {
  private readonly flush: () => void
  private readonly normalTrailingMs: number
  private readonly trailingMs: number
  private readonly minIntervalMs: number
  private readonly maxWaitMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingSince: number | null = null
  private lastFlushAt: number | null = null

  constructor(
    flush: () => void,
    options: PlacementWriteSchedulerOptions = {},
  ) {
    this.flush = flush
    this.normalTrailingMs = options.normalTrailingMs ?? 150
    this.trailingMs = options.trailingMs ?? 200
    this.minIntervalMs = options.minIntervalMs ?? 500
    this.maxWaitMs = Math.max(options.maxWaitMs ?? 1_000, this.minIntervalMs)
  }

  get pending(): boolean {
    return this.pendingSince !== null
  }

  request(kind: WriteKind = 'normal'): void {
    const now = Date.now()
    if (this.pendingSince === null) this.pendingSince = now

    let dueAt: number
    if (kind === 'normal') {
      dueAt = now + this.normalTrailingMs
    } else {
      const trailingAt = now + this.trailingMs
      const maxWaitAt = this.pendingSince + this.maxWaitMs
      const rateLimitAt = this.lastFlushAt === null
        ? Number.NEGATIVE_INFINITY
        : this.lastFlushAt + this.minIntervalMs
      dueAt = Math.max(Math.min(trailingAt, maxWaitAt), rateLimitAt)
    }
    this.arm(Math.max(0, dueAt - now))
  }

  flushNow(): void {
    if (!this.pending) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.run()
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pendingSince = null
  }

  private arm(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.run()
    }, delayMs)
  }

  private run(): void {
    if (this.pendingSince === null) return
    this.pendingSince = null
    this.lastFlushAt = Date.now()
    this.flush()
  }
}
