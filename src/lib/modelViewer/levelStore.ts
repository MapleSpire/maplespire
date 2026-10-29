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

/**
 * Bounded store + warm-up scheduler for Model Viewer levels.
 *
 * The drill-down zoom is only smooth when the level it opens is already in
 * memory, so levels are fetched ahead of the click. At hundreds of thousands of
 * objects that must never become a request storm, so every resource is capped:
 *
 *  - memory   — LRU by entry count AND by weight (objects + connections);
 *  - requests — at most `concurrency` in flight; one queued slot where the
 *               LATEST intent replaces the previous one (a pointer that crossed
 *               ten tiles only cares about the one it stopped on); a queued
 *               intent expires after `queueTtlMs`;
 *  - rate     — hover intents spend a budget of `budget.count` per
 *               `budget.windowMs`; a press (`force`) is a real intent and skips it;
 *  - cancel   — `cancelExcept` aborts everything that is not the level the user
 *               just navigated to, freeing the network for the request they need;
 *  - validity — `clear` (the model changed) aborts everything and a response
 *               that left before it is discarded, never remembered.
 *
 * Pure (no React, no fetch): the caller injects the loader.
 */

export type LevelLoader<T> = (signal: AbortSignal) => Promise<T>

export interface LevelStoreOptions<T> {
  /** Most levels kept. */
  maxEntries: number
  /** Most total weight kept (the newest level is always kept, however heavy). */
  maxWeight: number
  weigh: (value: T) => number
  /** Most warm-up requests in flight at once. */
  concurrency: number
  /** How long a queued intent stays worth running. */
  queueTtlMs: number
  /** Hover intents allowed per window; presses (`force`) are exempt. */
  budget: { count: number; windowMs: number }
  now?: () => number
}

interface Running<T> {
  promise: Promise<T>
  controller: AbortController
}

export class LevelStore<T> {
  private readonly entries = new Map<string, { value: T; weight: number }>()
  private weight = 0
  private readonly running = new Map<string, Running<T>>()
  private queued: { key: string; load: LevelLoader<T>; at: number } | null = null
  private spent: number[] = []
  private gen = 0
  private readonly opts: LevelStoreOptions<T>
  private readonly now: () => number

  constructor(opts: LevelStoreOptions<T>) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
  }

  /** A remembered level (counts as a use). */
  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  put(key: string, value: T): void {
    const previous = this.entries.get(key)
    if (previous) this.weight -= previous.weight
    this.entries.delete(key)
    const weight = Math.max(0, this.opts.weigh(value))
    this.entries.set(key, { value, weight })
    this.weight += weight
    // Evict least-recently-used until both caps hold; the newest always stays.
    while (this.entries.size > 1 && (this.entries.size > this.opts.maxEntries || this.weight > this.opts.maxWeight)) {
      const oldest = this.entries.keys().next().value as string
      this.weight -= this.entries.get(oldest)?.weight ?? 0
      this.entries.delete(oldest)
    }
  }

  /** The warm-up already on its way for `key`, so a real request can join it
   * instead of duplicating it. Rejects if that warm-up is aborted or fails. */
  inflight(key: string): Promise<T> | undefined {
    return this.running.get(key)?.promise
  }

  /** Express the intent to have `key` in memory soon. Returns whether the intent
   * was accepted (started or queued) — false when already there, already coming,
   * or refused by the rate budget. */
  prefetch(key: string, load: LevelLoader<T>, opts: { force?: boolean } = {}): boolean {
    if (this.entries.has(key) || this.running.has(key)) return false
    if (this.queued?.key === key) {
      this.queued.at = this.now()
      return false
    }
    if (!opts.force && !this.takeBudget()) return false
    if (this.running.size < this.opts.concurrency) {
      this.start(key, load)
    } else {
      this.queued = { key, load, at: this.now() } // latest intent wins
    }
    return true
  }

  /** Abort every warm-up that is not `keep` (the level just navigated to). */
  cancelExcept(keep?: string): void {
    for (const [key, run] of [...this.running]) {
      if (key === keep) continue
      this.running.delete(key)
      run.controller.abort()
    }
    if (this.queued && this.queued.key !== keep) this.queued = null
  }

  /** The model changed: forget everything and abort what is coming. */
  clear(): void {
    this.entries.clear()
    this.weight = 0
    this.gen += 1
    for (const run of this.running.values()) run.controller.abort()
    this.running.clear()
    this.queued = null
  }

  /** Bumped by every `clear`: a caller that fetched on its own can tell whether
   * the model changed underneath its request before remembering the answer. */
  get generation(): number {
    return this.gen
  }

  get stats() {
    return {
      entries: this.entries.size,
      weight: this.weight,
      inflight: this.running.size,
      queued: this.queued ? 1 : 0,
    }
  }

  private takeBudget(): boolean {
    const { count, windowMs } = this.opts.budget
    const t = this.now()
    this.spent = this.spent.filter((at) => t - at < windowMs)
    if (this.spent.length >= count) return false
    this.spent.push(t)
    return true
  }

  private start(key: string, load: LevelLoader<T>): void {
    const controller = new AbortController()
    const gen = this.gen
    let promise: Promise<T>
    try {
      promise = load(controller.signal)
    } catch (error) {
      promise = Promise.reject(error)
    }
    const run: Running<T> = { promise, controller }
    this.running.set(key, run)
    promise
      .then(
        (value) => {
          if (gen === this.gen && !controller.signal.aborted) this.put(key, value)
        },
        () => {
          // best effort: the real request fetches normally and reports failures
        }
      )
      .finally(() => {
        if (this.running.get(key) === run) this.running.delete(key)
        this.drain()
      })
  }

  private drain(): void {
    while (this.queued && this.running.size < this.opts.concurrency) {
      const next = this.queued
      this.queued = null
      if (this.now() - next.at > this.opts.queueTtlMs) continue
      if (this.entries.has(next.key) || this.running.has(next.key)) continue
      this.start(next.key, next.load)
    }
  }
}
