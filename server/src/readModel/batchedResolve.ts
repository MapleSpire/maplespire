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
