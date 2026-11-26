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

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

export const SERVER_SHARD_RESOLVE_BATCH_SIZE = 3

/** Cold model shards perform synchronous Automerge load and change dispatch.
 * Finish one complete resolution, then admit I/O before starting the next;
 * limiting concurrent PostgreSQL requests alone does not bound that CPU burst
 * (measured on a takeover profile). */
export async function resolveCooperatively<TItem, TResult>(
  items: readonly TItem[],
  resolve: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = []
  for (const item of items) {
    if (results.length > 0) await yieldToEventLoop()
    results.push(await resolve(item))
  }
  return results
}

/** The whole resolution outlived its ceiling (`resolveWithBoundedConcurrency`). */
export class BoundedResolveDeadlineError extends Error {
  constructor(
    readonly label: string,
    readonly deadlineMs: number,
    readonly resolved: number,
    readonly total: number,
  ) {
    super(`${label}: ${resolved} of ${total} resolved when the ${deadlineMs} ms ceiling of the whole resolution passed`)
    this.name = 'BoundedResolveDeadlineError'
  }
}

/**
 * Resolve `items` with at most `concurrency` resolutions in flight, in order,
 * each STARTED only when a slot frees — so a per-item timeout inside `resolve`
 * (`findReadyDocument`'s 10 s) measures that item's own load and at most
 * `concurrency - 1` others, not the queue of every item started at once
 * (G4-16f diagnosis q1: 28 base-shard finds started together, their `A.load`
 * calls ran back to back on the event loop, and the last ones timed out on
 * the SUM). `deadlineMs` bounds the whole resolution: past it no item starts,
 * and the call rejects with {@link BoundedResolveDeadlineError} (resolutions
 * already in flight are left to their own timeouts). The first item failure
 * rejects the call the same way; nothing new starts after it.
 */
export async function resolveWithBoundedConcurrency<TItem, TResult>(
  items: readonly TItem[],
  resolve: (item: TItem, index: number) => Promise<TResult>,
  options: { concurrency: number; deadlineMs: number; label: string },
): Promise<TResult[]> {
  const concurrency = Math.max(1, Math.floor(options.concurrency))
  const results = new Array<TResult>(items.length)
  if (!items.length) return results
  let next = 0
  let resolved = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stopped = true
      reject(new BoundedResolveDeadlineError(options.label, options.deadlineMs, resolved, items.length))
    }, options.deadlineMs)
  })
  const worker = async () => {
    while (!stopped && next < items.length) {
      const index = next++
      try {
        results[index] = await resolve(items[index]!, index)
      } catch (error) {
        stopped = true
        throw error
      }
      resolved += 1
    }
  }
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker)),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
  }
  return results
}

/** Keep cold-build document reads below the default ten-connection PG pool.
 * Generic in the item type so the same bound applies to document urls and to
 * registry entries that carry one. */
export async function resolveInBatches<TItem, TResult>(
  items: readonly TItem[],
  resolve: (item: TItem) => Promise<TResult>,
  batchSize = SERVER_SHARD_RESOLVE_BATCH_SIZE,
): Promise<TResult[]> {
  const boundedSize = Math.max(1, Math.floor(batchSize))
  const results: TResult[] = []
  for (let start = 0; start < items.length; start += boundedSize) {
    results.push(...await Promise.all(items.slice(start, start + boundedSize).map(resolve)))
  }
  return results
}
